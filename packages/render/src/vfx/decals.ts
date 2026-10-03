import { Mesh, MeshBasicNodeMaterial, PlaneGeometry, type Color } from 'three/webgpu';
import {
  abs,
  atan,
  float,
  fract,
  instancedBufferAttribute,
  max,
  mix,
  positionGeometry,
  select,
  sin,
  smoothstep,
  step,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { InstanceRing } from './instanceRing.ts';
import { hash11 } from './motion.ts';

/**
 * Ground decals: flat, procedurally masked quads in one instanced draw call.
 *
 * Responsibilities:
 * - Expanding rings (bounce, teleport), soft shock rings (hard landings),
 *   growing crack webs (tile warnings) and glossy goo splats.
 * - Every mask is computed from `uv()` in the fragment shader; no textures.
 * - Cracks can be cut short (`kill`) when the tile actually falls.
 *
 * Layout (16 floats): 0 pos.xyz, seed | 4 spawn, life, size0, size1 |
 * 8 rgb, kind | 12 alpha, thickness, -, -.
 */

const STRIDE = 16;
const TAU = Math.PI * 2;

/** Decal kinds. */
export const DecalKind = { ring: 0, shock: 1, crack: 2, splat: 3 } as const;

/** Mutable spawn description for {@link DecalPool.emit}. */
export class DecalSpec {
  x = 0;
  y = 0;
  z = 0;
  delay = 0;
  life = 0.6;
  /** Radius at spawn (m). */
  size0 = 0.3;
  /** Radius at end (m). */
  size1 = 1.5;
  r = 1;
  g = 1;
  b = 1;
  kind = 0;
  alpha = 1;
  /** Ring band width as a fraction of the radius. */
  thickness = 0.12;

  /**
   * Sets the tint.
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
 * Instanced ground-decal pool.
 *
 * @example
 * const slot = decals.emit(spec, now);
 * decals.kill(slot, now); // fade it out early
 */
export class DecalPool {
  /** The single draw call. */
  readonly object: Mesh;
  private readonly ring: InstanceRing;
  private readonly material: MeshBasicNodeMaterial;

  /**
   * @param capacity - Max live decals.
   * @param time - Shared effect-time uniform.
   */
  constructor(capacity: number, time: UniformNode<'float', number>) {
    this.ring = new InstanceRing(capacity, STRIDE);
    this.material = buildMaterial(this.ring, time);
    this.object = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.object.name = 'vfx-decals';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    this.object.renderOrder = 2;
  }

  /**
   * Writes one decal.
   *
   * @param s - Spawn description.
   * @param now - Current effect time.
   * @returns Slot handle for {@link kill}.
   */
  emit(s: DecalSpec, now: number): number {
    const start = now + s.delay;
    const o = this.ring.alloc(start + s.life);
    const d = this.ring.data;
    d[o] = s.x;
    d[o + 1] = s.y;
    d[o + 2] = s.z;
    d[o + 3] = Math.random();
    d[o + 4] = start;
    d[o + 5] = Math.max(0.05, s.life);
    d[o + 6] = s.size0;
    d[o + 7] = s.size1;
    d[o + 8] = s.r;
    d[o + 9] = s.g;
    d[o + 10] = s.b;
    d[o + 11] = s.kind;
    d[o + 12] = s.alpha;
    d[o + 13] = s.thickness;
    d[o + 14] = 0;
    d[o + 15] = 0;
    return o;
  }

  /**
   * Fades a decal out over ~0.2 s, if its slot has not been recycled since.
   *
   * @param slot - Value returned by {@link emit}.
   * @param spawnTime - The decal's start time (`now + delay` at emit), to detect recycling.
   * @param now - Current effect time.
   */
  kill(slot: number, spawnTime: number, now: number): void {
    const d = this.ring.data;
    if (d[slot + 4] !== Math.fround(spawnTime)) return;
    const remaining = spawnTime + (d[slot + 5] ?? 0) - now;
    if (remaining <= 0.2) return;
    d[slot + 5] = Math.max(0.05, now - spawnTime + 0.2);
    this.ring.touch(slot);
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

  /** Removes every decal. */
  clear(): void {
    this.ring.reset();
    this.object.count = 0;
    this.object.visible = false;
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}

/**
 * Crack web: N jagged radial branches of random length plus one wobbly
 * concentric fracture, revealed outward over the first 0.35 s.
 */
function crackMask(c: Node<'vec2'>, r: Node<'float'>, seed: Node<'float'>, t: Node<'float'>): Node<'float'> {
  const branches = 7;
  const ang = atan(c.y, c.x).div(TAU).add(0.5);
  const jag = sin(r.mul(23).add(seed.mul(10))).mul(0.045).add(sin(r.mul(57).add(seed.mul(3))).mul(0.02));
  const a = ang.mul(branches).add(jag).add(seed.mul(7));
  const cell = a.floor();
  const reach = float(0.5).add(hash11(cell.add(seed.mul(13))).mul(0.45));
  const grow = smoothstep(0, 0.35, t);
  const arc = abs(fract(a).sub(0.5)).mul(r).mul(TAU / branches);
  const width = mix(float(0.03), float(0.008), r);
  const radial = float(1)
    .sub(smoothstep(width, width.add(0.012), arc))
    .mul(step(r, reach.mul(grow)))
    .mul(step(0.06, r));
  const ringR = float(0.42).add(sin(ang.mul(TAU * 5).add(seed.mul(11))).mul(0.04));
  const concentric = float(1)
    .sub(smoothstep(0.008, 0.02, abs(r.sub(ringR))))
    .mul(step(0.5, hash11(a.mul(1.7).floor().add(seed))))
    .mul(smoothstep(0.15, 0.35, t));
  const pit = float(1).sub(smoothstep(0.04, 0.09, r));
  return max(max(radial, concentric), pit);
}

function buildMaterial(ring: InstanceRing, time: UniformNode<'float', number>): MeshBasicNodeMaterial {
  const buf = ring.buffer;
  const a0 = instancedBufferAttribute(buf, 'vec4', STRIDE, 0) as Node<'vec4'>;
  const a1 = instancedBufferAttribute(buf, 'vec4', STRIDE, 4) as Node<'vec4'>;
  const a2 = instancedBufferAttribute(buf, 'vec4', STRIDE, 8) as Node<'vec4'>;
  const a3 = instancedBufferAttribute(buf, 'vec4', STRIDE, 12) as Node<'vec4'>;

  const kind = a2.w;
  const life = a1.y;
  const age = time.sub(a1.x);
  const t = age.clamp(0, life) as Node<'float'>;
  const tn = t.div(life);
  const alive = step(0, age).mul(step(age, life));

  const easeOut = float(1).sub(float(1).sub(tn).pow(3));
  const splatGrow = smoothstep(0, 0.12, t);
  const grow = select(kind.lessThan(1.5), easeOut, select(kind.lessThan(2.5), float(1), splatGrow));
  const radius = mix(a1.z, a1.w, grow).mul(alive);

  const material = new MeshBasicNodeMaterial();
  material.positionNode = a0.xyz.add(vec3(positionGeometry.x, 0.03, positionGeometry.y.negate()).mul(vec3(radius, 1, radius)));
  material.transparent = true;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -4;
  material.fog = true;

  const vT = varying(t);
  const vTn = varying(tn);
  const seed = a0.w;
  const c = uv().mul(2).sub(1) as Node<'vec2'>;
  const r = c.length();
  const tint = a2.xyz;

  const band = a3.y.mul(float(1).sub(vTn.mul(0.5)));
  const ringMask = float(1).sub(smoothstep(band.mul(0.45), band.mul(0.5).add(0.03), abs(r.sub(0.86))));
  const ringAlpha = ringMask.mul(float(1).sub(vTn).pow(1.4));

  const shockMask = smoothstep(0.35, 0.85, r).mul(float(1).sub(smoothstep(0.88, 1, r)));
  const shockAlpha = shockMask.mul(float(1).sub(vTn).pow(2)).mul(0.75);

  const crackAlpha = crackMask(c, r, seed, vT).mul(float(1).sub(smoothstep(life.sub(0.25), life, vT)));
  // Warning tint pulses under the crack so a falling tile also reads from afar.
  const pulse = sin(vT.mul(16)).mul(0.5).add(0.5);
  const glowUnder = float(1).sub(smoothstep(0.2, 0.75, r)).mul(pulse).mul(0.28).mul(smoothstep(0, 0.2, vT));

  const ang = atan(c.y, c.x);
  const edge = float(0.6).add(sin(ang.mul(7).add(seed.mul(20))).mul(0.09)).add(sin(ang.mul(13).add(seed.mul(7))).mul(0.045));
  const blob = float(1).sub(smoothstep(edge.sub(0.03), edge, r));
  const dropletsAt = sin(ang.mul(9).add(seed.mul(40))).greaterThan(0.72);
  const droplets = select(dropletsAt, float(1).sub(smoothstep(0.035, 0.06, abs(r.sub(0.82)))), float(0));
  const splatAlpha = max(blob, droplets).mul(float(1).sub(smoothstep(0.65, 1, vTn)));
  const gloss = float(1).sub(smoothstep(0.08, 0.16, c.sub(vec2(-0.18, 0.2)).length())).mul(blob).mul(0.45);

  const alpha = select(
    kind.lessThan(0.5),
    ringAlpha,
    select(kind.lessThan(1.5), shockAlpha, select(kind.lessThan(2.5), max(crackAlpha, glowUnder), splatAlpha)),
  );
  const crackColour = mix(vec3(1, 0.42, 0.18), tint, step(glowUnder, crackAlpha));
  const splatColour = tint.mul(float(0.85).add(blob.mul(0.15))).add(gloss);
  const rgb = select(kind.lessThan(1.5), tint, select(kind.lessThan(2.5), crackColour, splatColour));
  material.colorNode = vec4(rgb, alpha.mul(a3.x).clamp(0, 1));
  return material;
}
