import {
  BufferAttribute,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  SphereGeometry,
  type BufferGeometry,
  type Color,
  type MeshToonNodeMaterial,
} from 'three/webgpu';
import {
  attribute,
  cos,
  float,
  instancedBufferAttribute,
  mix,
  normalize,
  normalView,
  positionGeometry,
  rotate,
  sin,
  smoothstep,
  step,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createToonMaterial } from '../materials/toon.ts';
import { InstanceRing } from './instanceRing.ts';
import { analyticOffset, analyticOffsetCpu, MIN_DRAG, type MutableVec3 } from './motion.ts';

/**
 * Elimination balloons: toon-lit latex balloons that drift up, sway, then pop.
 *
 * Responsibilities:
 * - Builds one merged balloon mesh (egg body + knot + string) shared by all instances.
 * - GPU-analytic rise (buoyancy against drag), sway and tilt, a squash-and-stretch
 *   inflate at the end of life and then a hard cut to zero: the "pop".
 * - {@link balloonEndPosition} mirrors the shader so recipes can schedule the
 *   pop sparkles at exactly the right place and time at spawn.
 *
 * Layout (20 floats): 0 p0.xyz, seed | 4 v0.xyz, drag | 8 spawn, life, size, - |
 * 12 rgb, - | 16 gravity, swayAmp, swayFreq, -.
 */

const STRIDE = 20;
/** Sway reaches full amplitude after this many seconds. */
const SWAY_RAMP = 0.5;

/** Mutable spawn description for {@link BalloonPool.emit}. */
export class BalloonSpec {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 1.5;
  vz = 0;
  drag = 1.2;
  /** Negative = buoyant. */
  gravity = -3.2;
  delay = 0;
  life = 1.8;
  /** Body radius-ish scale (1 ≈ 0.5 m radius). */
  size = 0.45;
  r = 1;
  g = 0.3;
  b = 0.5;
  swayAmp = 0.22;
  swayFreq = 3.2;
  /** Written by `emit`; read back by {@link balloonEndPosition}. */
  seed = 0;

  /**
   * Sets the balloon colour.
   *
   * @param c - Linear colour.
   * @returns `this`.
   */
  color(c: Color): this {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    return this;
  }
}

/**
 * Where a balloon spawned from `s` pops (end of its life), matching the shader.
 *
 * @param s - The spec after `emit` (its `seed` is set).
 * @param out - Receives the world position.
 * @returns `out`.
 */
export function balloonEndPosition(s: BalloonSpec, out: MutableVec3): MutableVec3 {
  const t = s.life;
  analyticOffsetCpu(s.vx, s.vy, s.vz, s.drag < MIN_DRAG ? 0 : s.drag, s.gravity, t, out);
  const ramp = Math.min(1, t / SWAY_RAMP);
  const amp = s.swayAmp * ramp * ramp * (3 - 2 * ramp);
  out.x += s.x + Math.sin(t * s.swayFreq + s.seed * 9) * amp;
  out.y += s.y;
  out.z += s.z + Math.cos(t * s.swayFreq * 0.7 + s.seed * 5) * amp;
  return out;
}

/**
 * Instanced balloon pool, one draw call.
 *
 * @example
 * const balloons = new BalloonPool(64, timeUniform);
 * balloons.emit(spec.color(c), now);
 */
export class BalloonPool {
  /** The single draw call. */
  readonly object: Mesh;
  private readonly ring: InstanceRing;
  private readonly material: MeshToonNodeMaterial;

  /**
   * @param capacity - Max live balloons.
   * @param time - Shared effect-time uniform.
   */
  constructor(capacity: number, time: UniformNode<'float', number>) {
    this.ring = new InstanceRing(capacity, STRIDE);
    this.material = buildMaterial(this.ring, time);
    this.object = new Mesh(buildBalloonGeometry(), this.material);
    this.object.name = 'vfx-balloons';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
  }

  /**
   * Writes one balloon and stores its random seed back into `s.seed`.
   *
   * @param s - Spawn description.
   * @param now - Current effect time.
   */
  emit(s: BalloonSpec, now: number): void {
    const start = now + s.delay;
    const o = this.ring.alloc(start + s.life);
    const d = this.ring.data;
    s.seed = Math.random();
    d[o] = s.x;
    d[o + 1] = s.y;
    d[o + 2] = s.z;
    d[o + 3] = s.seed;
    d[o + 4] = s.vx;
    d[o + 5] = s.vy;
    d[o + 6] = s.vz;
    d[o + 7] = s.drag < MIN_DRAG ? 0 : s.drag;
    d[o + 8] = start;
    d[o + 9] = Math.max(0.2, s.life);
    d[o + 10] = s.size;
    d[o + 11] = 0;
    d[o + 12] = s.r;
    d[o + 13] = s.g;
    d[o + 14] = s.b;
    d[o + 15] = 0;
    d[o + 16] = s.gravity;
    d[o + 17] = s.swayAmp;
    d[o + 18] = s.swayFreq;
    d[o + 19] = 0;
  }

  /**
   * Uploads this frame's spawns; hides the draw call when idle.
   *
   * @param now - Current effect time.
   */
  update(now: number): void {
    this.ring.flush();
    const active = this.ring.isActive(now);
    this.object.visible = active;
    this.object.count = active ? this.ring.drawCount : 0;
  }

  /** Kills every balloon. */
  clear(): void {
    this.ring.reset();
    this.object.count = 0;
    this.object.visible = false;
  }

  /** Frees GPU resources (the toon ramp texture is shared and survives). */
  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}

function tagged(geo: BufferGeometry, isString: number): BufferGeometry {
  const n = geo.getAttribute('position').count;
  geo.setAttribute('aString', new BufferAttribute(new Float32Array(n).fill(isString), 1));
  return geo;
}

function buildBalloonGeometry(): BufferGeometry {
  const body = new SphereGeometry(0.5, 20, 14);
  const p = body.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    // Egg profile: taller, and narrower toward the knot.
    const taper = y < 0 ? 1 + y * 0.42 : 1 + y * 0.06;
    p.setXYZ(i, p.getX(i) * taper, y * 1.16, p.getZ(i) * taper);
  }
  body.computeVertexNormals();

  const knot = new ConeGeometry(0.075, 0.1, 8);
  knot.translate(0, -0.62, 0);
  const string = new CylinderGeometry(0.008, 0.008, 0.75, 4, 1, true);
  string.translate(0, -1.04, 0);
  const merged = mergeGeometries([tagged(body, 0), tagged(knot, 0), tagged(string, 1)]);
  body.dispose();
  knot.dispose();
  string.dispose();
  if (!merged) throw new Error('vfx: balloon geometry merge failed');
  return merged;
}

function buildMaterial(ring: InstanceRing, time: UniformNode<'float', number>): MeshToonNodeMaterial {
  const buf = ring.buffer;
  const a0 = instancedBufferAttribute(buf, 'vec4', STRIDE, 0) as Node<'vec4'>;
  const a1 = instancedBufferAttribute(buf, 'vec4', STRIDE, 4) as Node<'vec4'>;
  const a2 = instancedBufferAttribute(buf, 'vec4', STRIDE, 8) as Node<'vec4'>;
  const a3 = instancedBufferAttribute(buf, 'vec4', STRIDE, 12) as Node<'vec4'>;
  const a4 = instancedBufferAttribute(buf, 'vec4', STRIDE, 16) as Node<'vec4'>;

  const seed = a0.w;
  const life = a2.y;
  const age = time.sub(a2.x);
  const t = age.clamp(0, life) as Node<'float'>;
  const alive = step(0, age).mul(step(age, life));

  const rise = analyticOffset(a1.xyz, a1.w, a4.x, t);

  const swayPhase = t.mul(a4.z).add(seed.mul(9));
  const swayPhase2 = t.mul(a4.z).mul(0.7).add(seed.mul(5));
  const amp = a4.y.mul(smoothstep(0, 0.5, t));
  const sway = vec3(sin(swayPhase), 0, cos(swayPhase2)).mul(amp);
  const centre = a0.xyz.add(rise).add(sway);

  // Tilt leans with the sway velocity (derivative of the offset), like a balloon on a breeze.
  const tilt = vec3(sin(swayPhase2).mul(0.32), seed.mul(6.283).add(t.mul(0.7)), cos(swayPhase).mul(-0.32));

  const appear = smoothstep(0, 0.22, t).mul(float(1).add(sin(smoothstep(0, 0.4, t).mul(Math.PI)).mul(0.15)));
  const inflate = smoothstep(life.sub(0.18), life.sub(0.02), t);
  const squash = vec3(
    float(1).add(inflate.mul(0.4)),
    float(1).add(inflate.mul(0.22)),
    float(1).add(inflate.mul(0.4)),
  );
  const scale = a2.z.mul(appear).mul(alive);
  const local = positionGeometry.mul(squash).mul(scale);

  const material = createToonMaterial({ color: '#ffffff', rimStrength: 0.55 });
  material.positionNode = centre.add(rotate(local, tilt));

  const isString = attribute('aString', 'float') as Node<'float'>;
  material.colorNode = vec4(mix(a3.xyz, vec3(0.95, 0.95, 0.98), isString), 1);

  // Latex gloss: a tight view-space highlight added on top of the toon rim.
  const highlight = smoothstep(0.86, 0.93, normalView.dot(normalize(vec3(-0.45, 0.55, 0.7))))
    .mul(float(1).sub(isString))
    .mul(0.55);
  const withEmissive = material as MeshToonNodeMaterial & { emissiveNode: Node | null };
  const rim = withEmissive.emissiveNode as Node<'vec3'> | null;
  withEmissive.emissiveNode = rim
    ? rim.add(vec3(highlight, highlight, highlight))
    : vec3(highlight, highlight, highlight);
  return material;
}
