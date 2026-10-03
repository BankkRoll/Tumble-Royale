import {
  AddEquation,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Sprite,
  SpriteNodeMaterial,
  type Color,
} from 'three/webgpu';
import {
  atan,
  cos,
  exp,
  float,
  instancedBufferAttribute,
  max,
  mix,
  modelViewMatrix,
  normalize,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { InstanceRing } from './instanceRing.ts';
import { analyticOffset, MIN_DRAG } from './motion.ts';

/**
 * Billboard particle pools: one instanced sprite draw call each, with all
 * motion evaluated analytically on the GPU.
 *
 * Responsibilities:
 * - `ParticleSpec`: reusable, mutable spawn description (no per-spawn objects).
 * - `ParticlePool` in two flavours:
 *   - `glow`: light-emitting sparkles, 4-point stars, rings, stretched streaks and
 *     flashes, shape picked per particle in the fragment shader.
 *   - `puff`: cut-out cartoon puffs/droplets with fake top lighting; they
 *     write depth so overlapping puffs sort correctly without CPU sorting.
 *
 * Per-instance layout (24 floats, six vec4s):
 *   0 p0.xyz, seed | 4 v0.xyz, drag | 8 spawnTime, life, size0, size1 |
 *   12 rgb, shape | 16 gravity, spin, stretch, twinkle | 20 orbitR, orbitW, alpha, -
 */

/** Glow pool shapes. */
export const GlowShape = { dot: 0, star: 1, ring: 2, streak: 3, flash: 4 } as const;
/** Puff pool shapes. */
export const PuffShape = { cloud: 0, droplet: 1, smoke: 2 } as const;

const STRIDE = 24;
/** How much a glow particle darkens what is behind it (0 = pure additive, 1 = normal blend). */
const GLOW_OCCLUSION = 0.6;
const TAU = Math.PI * 2;

/**
 * Mutable spawn description. Recipes keep one instance, call {@link reset},
 * fill fields and hand it to {@link ParticlePool.emit} repeatedly.
 */
export class ParticleSpec {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Linear drag (1/s). Below `MIN_DRAG` counts as none. */
  drag = 0;
  /** m/s², positive falls, negative rises. */
  gravity = 0;
  /** Seconds before the particle appears (GPU-side). */
  delay = 0;
  life = 1;
  size0 = 0.2;
  size1 = 0.2;
  r = 1;
  g = 1;
  b = 1;
  /** `GlowShape` / `PuffShape` id. */
  shape = 0;
  /** Billboard spin (rad/s). Ignored for stretched particles. */
  spin = 0;
  /** Seconds of velocity smeared into the sprite length (streaks); 0 = round. */
  stretch = 0;
  /** 0..1 flicker amount. */
  twinkle = 0;
  /** Horizontal orbit radius around the moving centre (spirals). */
  orbitRadius = 0;
  /** Orbit angular speed (rad/s). */
  orbitSpeed = 0;
  /** Opacity multiplier (glow pool only). */
  alpha = 1;

  /**
   * Restores defaults.
   *
   * @returns `this`, for chaining.
   */
  reset(): this {
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.drag = this.gravity = this.delay = 0;
    this.life = 1;
    this.size0 = this.size1 = 0.2;
    this.r = this.g = this.b = 1;
    this.shape = 0;
    this.spin = this.stretch = this.twinkle = 0;
    this.orbitRadius = this.orbitSpeed = 0;
    this.alpha = 1;
    return this;
  }

  /**
   * Sets the tint.
   *
   * @param c - Linear colour.
   * @param boost - Multiplier (values > 1 push additive sparkles toward white-hot).
   * @returns `this`.
   */
  color(c: Color, boost = 1): this {
    this.r = c.r * boost;
    this.g = c.g * boost;
    this.b = c.b * boost;
    return this;
  }
}

/** Which look a {@link ParticlePool} renders. */
export type ParticlePoolMode = 'glow' | 'puff';

/**
 * One instanced-sprite particle pool.
 *
 * @example
 * const sparks = new ParticlePool('glow', 2048, timeUniform);
 * scene.add(sparks.object);
 * spec.reset(); spec.life = 0.6; sparks.emit(spec, now);
 */
export class ParticlePool {
  /** The single draw call. */
  readonly object: Sprite;
  private readonly ring: InstanceRing;
  private readonly material: SpriteNodeMaterial;

  /**
   * @param mode - Visual flavour.
   * @param capacity - Slots to allocate (hard maximum).
   * @param time - Shared effect-time uniform (seconds).
   */
  constructor(
    readonly mode: ParticlePoolMode,
    capacity: number,
    time: UniformNode<'float', number>,
  ) {
    this.ring = new InstanceRing(capacity, STRIDE);
    this.material =
      mode === 'glow' ? buildMaterial(this.ring, time, true) : buildMaterial(this.ring, time, false);
    this.object = new Sprite(this.material);
    this.object.name = mode === 'glow' ? 'vfx-glow' : 'vfx-puffs';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    // Additive glow reads best on top of the alpha-tested puffs it decorates.
    this.object.renderOrder = mode === 'glow' ? 20 : 0;
  }

  /** Active ring size. */
  get capacity(): number {
    return this.ring.capacity;
  }

  /**
   * Changes the live-particle budget (clamped to the allocation). Drops live particles.
   *
   * @param n - New capacity.
   */
  setCapacity(n: number): void {
    this.ring.setCapacity(n);
    this.object.count = 0;
    this.object.visible = false;
  }

  /**
   * Writes one particle. Never allocates.
   *
   * @param s - Spawn description (read, not retained).
   * @param now - Current effect time.
   */
  emit(s: ParticleSpec, now: number): void {
    const start = now + s.delay;
    const o = this.ring.alloc(start + s.life);
    const d = this.ring.data;
    d[o] = s.x;
    d[o + 1] = s.y;
    d[o + 2] = s.z;
    d[o + 3] = Math.random();
    d[o + 4] = s.vx;
    d[o + 5] = s.vy;
    d[o + 6] = s.vz;
    d[o + 7] = s.drag < MIN_DRAG ? 0 : s.drag;
    d[o + 8] = start;
    d[o + 9] = Math.max(0.01, s.life);
    d[o + 10] = s.size0;
    d[o + 11] = s.size1;
    d[o + 12] = s.r;
    d[o + 13] = s.g;
    d[o + 14] = s.b;
    d[o + 15] = s.shape;
    d[o + 16] = s.gravity;
    d[o + 17] = s.spin;
    d[o + 18] = s.stretch;
    d[o + 19] = s.twinkle;
    d[o + 20] = s.orbitRadius;
    d[o + 21] = s.orbitSpeed;
    d[o + 22] = s.alpha;
    d[o + 23] = 0;
  }

  /**
   * Uploads this frame's spawns and hides the draw call when nothing is alive.
   *
   * @param now - Current effect time.
   */
  update(now: number): void {
    this.ring.flush();
    const active = this.ring.isActive(now);
    this.object.visible = active;
    this.object.count = active ? this.ring.drawCount : 0;
  }

  /** Kills every particle. */
  clear(): void {
    this.ring.reset();
    this.object.count = 0;
    this.object.visible = false;
  }

  /** Frees the material. The sprite geometry is three's shared quad and must survive. */
  dispose(): void {
    this.material.dispose();
    this.object.removeFromParent();
  }
}

/**
 * Builds the node graph for either pool flavour.
 *
 * Vertex: age → analytic position (+ optional orbit) → size envelope →
 * billboard rotation (spin, or aligned to view-space velocity when stretched).
 * Fragment: procedural shape mask from `uv()`.
 */
function buildMaterial(
  ring: InstanceRing,
  time: UniformNode<'float', number>,
  glow: boolean,
): SpriteNodeMaterial {
  const buf = ring.buffer;
  const a0 = instancedBufferAttribute(buf, 'vec4', STRIDE, 0) as Node<'vec4'>;
  const a1 = instancedBufferAttribute(buf, 'vec4', STRIDE, 4) as Node<'vec4'>;
  const a2 = instancedBufferAttribute(buf, 'vec4', STRIDE, 8) as Node<'vec4'>;
  const a3 = instancedBufferAttribute(buf, 'vec4', STRIDE, 12) as Node<'vec4'>;
  const a4 = instancedBufferAttribute(buf, 'vec4', STRIDE, 16) as Node<'vec4'>;
  const a5 = instancedBufferAttribute(buf, 'vec4', STRIDE, 20) as Node<'vec4'>;

  const seed = a0.w;
  const drag = a1.w;
  const life = a2.y;
  const gravity = a4.x;
  const age = time.sub(a2.x);
  const t = age.clamp(0, life) as Node<'float'>;
  const tn = t.div(life);
  const alive = step(0, age).mul(step(age, life));

  const phase = seed.mul(TAU).add(a5.y.mul(t));
  const orbit = vec3(cos(phase), 0, sin(phase)).mul(a5.x);
  const position = a0.xyz.add(analyticOffset(a1.xyz, drag, gravity, t)).add(orbit);

  const noDrag = drag.lessThan(MIN_DRAG);
  const decay = select(noDrag, float(1), exp(drag.negate().mul(t)));
  const fall = select(
    noDrag,
    t,
    float(1)
      .sub(decay)
      .div(max(drag, float(MIN_DRAG))),
  );
  const velocity = a1.xyz.mul(decay).sub(vec3(0, gravity.mul(fall), 0));
  const viewVel = modelViewMatrix.mul(vec4(velocity, 0)).xy;
  const speed = viewVel.length();

  const easeOut = float(1).sub(float(1).sub(tn).mul(float(1).sub(tn)));
  const baseSize = mix(a2.z, a2.w, easeOut);
  const envelope = glow
    ? smoothstep(0, 0.05, t)
    : smoothstep(0, 0.14, t)
        .mul(float(1).add(sin(smoothstep(0, 0.3, t).mul(Math.PI)).mul(0.18)))
        .mul(float(1).sub(smoothstep(0.55, 1, tn)));
  const size = baseSize.mul(envelope).mul(alive);
  const stretched = a4.z.greaterThan(0);
  const length = size.add(a4.z.mul(speed).mul(alive));

  const material = new SpriteNodeMaterial();
  material.positionNode = position;
  material.scaleNode = vec2(select(stretched, length, size), size);
  material.rotationNode = select(stretched, atan(viewVel.y, viewVel.x), a4.y.mul(t).add(seed.mul(TAU)));
  material.depthWrite = !glow;

  const vTn = varying(tn);
  const vAge = varying(age);
  const c = uv().mul(2).sub(1);
  const r = c.length();
  const shape = a3.w;
  const tint = a3.xyz;

  if (glow) {
    material.transparent = true;
    // Premultiplied "additive-over": rgb adds like light while alpha partly
    // occludes. Pure additive washes to white against the bright candy sky.
    material.blending = CustomBlending;
    material.blendEquation = AddEquation;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    // NOTE: three's fog mixes rgb toward the fog colour but keeps alpha, which
    // turns distant additive sparkles into fog-coloured blobs. Glow skips fog.
    material.fog = false;

    const soft = float(1).sub(smoothstep(0, 1, r));
    const core = exp(r.mul(r).mul(-26));
    const dot = soft.mul(soft).add(core.mul(0.6));
    const astroid = sqrt(c.x.abs()).add(sqrt(c.y.abs()));
    const star = float(1)
      .sub(smoothstep(0.5, 1, astroid))
      .mul(float(1).sub(smoothstep(0.85, 1, r)))
      .add(core.mul(0.7));
    const ring = float(1)
      .sub(smoothstep(0, 0.13, r.sub(0.8).abs()))
      .add(soft.mul(0.12));
    const across = float(1).sub(smoothstep(0, 1, c.y.abs()));
    const along = smoothstep(-1, 0.55, c.x).mul(float(1).sub(smoothstep(0.75, 1, c.x)));
    const streak = across.mul(across).mul(along);
    const flash = float(1)
      .sub(smoothstep(0.15, 1, r))
      .add(core);

    const mask = select(
      shape.lessThan(0.5),
      dot,
      select(
        shape.lessThan(1.5),
        star,
        select(shape.lessThan(2.5), ring, select(shape.lessThan(3.5), streak, flash)),
      ),
    );
    const flicker = float(1).sub(
      a4.w.mul(
        sin(vAge.mul(23).add(seed.mul(57)))
          .mul(0.5)
          .add(0.5),
      ),
    );
    const fade = float(1).sub(smoothstep(0.55, 1, vTn));
    const hot = mix(tint, vec3(1, 1, 1), core.mul(0.4));
    const alpha = mask.mul(fade).mul(flicker).mul(a5.z).clamp(0, 1);
    material.colorNode = vec4(hot.mul(alpha), alpha.mul(GLOW_OCCLUSION));
  } else {
    material.transparent = false;
    material.alphaTest = 0.5;
    material.fog = true;

    const ang = atan(c.y, c.x);
    const lumps = select(
      shape.lessThan(0.5),
      sin(ang.mul(5).add(seed.mul(31)))
        .mul(0.07)
        .add(sin(ang.mul(9).add(seed.mul(13))).mul(0.03)),
      select(
        shape.lessThan(1.5),
        float(0),
        sin(ang.mul(4).add(seed.mul(17)))
          .mul(0.1)
          .add(sin(ang.mul(7)).mul(0.05)),
      ),
    );
    const edge = float(0.88).add(lumps);
    const mask = float(1).sub(smoothstep(edge.sub(0.05), edge, r));

    const nz = sqrt(max(float(1).sub(r.mul(r)), float(0)));
    const n = vec3(c.x, c.y, nz);
    const lightDir = normalize(vec3(-0.35, 0.8, 0.5));
    const lambert = n.dot(lightDir);
    const lit = smoothstep(0.12, 0.26, lambert);
    const shadowTint = vec3(0.74, 0.74, 0.9);
    const shaded = tint.mul(mix(shadowTint, vec3(1, 1, 1), lit));
    const glossAmount = select(
      shape.lessThan(0.5),
      float(0.18),
      select(shape.lessThan(1.5), float(0.75), float(0.05)),
    );
    const gloss = smoothstep(0.86, 0.92, lambert).mul(glossAmount);
    const rim = smoothstep(0.55, 0.8, r).mul(float(1).sub(lit)).mul(0.12);
    material.colorNode = vec4(shaded.add(gloss).add(rim), mask);
  }

  return material;
}
