import { DoubleSide, Mesh, MeshBasicNodeMaterial, PlaneGeometry, type Color } from 'three/webgpu';
import {
  cameraPosition,
  cos,
  float,
  instancedBufferAttribute,
  mix,
  normalize,
  positionGeometry,
  rotate,
  select,
  sin,
  smoothstep,
  step,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { InstanceRing } from './instanceRing.ts';
import { analyticOffset, MIN_DRAG } from './motion.ts';

/**
 * Confetti pool: tumbling paper pieces, one instanced draw call.
 *
 * Responsibilities:
 * - Per-instance ring storage (start, velocity, timing, colour, tumble/flutter).
 * - Vertex shader: drag-limited ballistic fall, side-to-side flutter that kicks
 *   in once the burst slows, and a 3-axis tumble via `rotate()`.
 * - Fragment: rectangles, discs and long streamers; brightness follows how
 *   squarely the piece faces the camera, with a glint when it flips flat-on.
 *
 * Layout (20 floats): 0 p0.xyz, seed | 4 v0.xyz, drag | 8 spawn, life, size,
 * aspect | 12 rgb, shape | 16 gravity, spin, flutterAmp, flutterFreq.
 */

const STRIDE = 20;

/** Confetti piece shapes. */
export const ConfettiShape = { rect: 0, disc: 1, streamer: 2 } as const;

/** Mutable spawn description for {@link ConfettiPool.emit}. */
export class ConfettiSpec {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  drag = 2.2;
  gravity = 9;
  delay = 0;
  life = 3;
  /** Piece height in metres. */
  size = 0.09;
  /** Width / height. */
  aspect = 0.6;
  r = 1;
  g = 1;
  b = 1;
  shape = 0;
  /** Tumble speed (rad/s). */
  spin = 9;
  /** Sideways flutter amplitude (m). */
  flutter = 0.25;
  /** Flutter frequency (rad/s). */
  flutterFreq = 5;

  /**
   * Sets the paper colour.
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
 * GPU-animated confetti.
 *
 * @example
 * const confetti = new ConfettiPool(1500, timeUniform);
 * confetti.emit(spec, now);
 */
export class ConfettiPool {
  /** The single draw call. */
  readonly object: Mesh;
  private readonly ring: InstanceRing;
  private readonly material: MeshBasicNodeMaterial;

  /**
   * @param capacity - Slots to allocate.
   * @param time - Shared effect-time uniform.
   */
  constructor(capacity: number, time: UniformNode<'float', number>) {
    this.ring = new InstanceRing(capacity, STRIDE);
    this.material = buildMaterial(this.ring, time);
    this.object = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.object.name = 'vfx-confetti';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
  }

  /**
   * Changes the live-piece budget (clamped to the allocation). Drops live pieces.
   *
   * @param n - New capacity.
   */
  setCapacity(n: number): void {
    this.ring.setCapacity(n);
    this.clear();
  }

  /** Active ring size. */
  get capacity(): number {
    return this.ring.capacity;
  }

  /**
   * Writes one piece.
   *
   * @param s - Spawn description.
   * @param now - Current effect time.
   */
  emit(s: ConfettiSpec, now: number): void {
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
    d[o + 10] = s.size;
    d[o + 11] = s.aspect;
    d[o + 12] = s.r;
    d[o + 13] = s.g;
    d[o + 14] = s.b;
    d[o + 15] = s.shape;
    d[o + 16] = s.gravity;
    d[o + 17] = s.spin;
    d[o + 18] = s.flutter;
    d[o + 19] = s.flutterFreq;
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

  /** Kills every piece. */
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

function buildMaterial(ring: InstanceRing, time: UniformNode<'float', number>): MeshBasicNodeMaterial {
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
  const shrink = float(1).sub(smoothstep(life.sub(0.35), life, t));

  // Flutter ramps in as drag bleeds off the burst, so the launch reads as a clean pop.
  const flutterRamp = smoothstep(0.15, 0.9, t);
  const fphase = t.mul(a4.w).add(seed.mul(41));
  const flutter = vec3(sin(fphase), 0, cos(fphase.mul(0.83).add(seed.mul(7)))).mul(a4.z.mul(flutterRamp));
  const centre = a0.xyz.add(analyticOffset(a1.xyz, a1.w, a4.x, t)).add(flutter);

  const spin = a4.y.mul(t);
  const euler = vec3(spin.mul(1.3).add(seed.mul(9.1)), spin.mul(0.71).add(seed.mul(4.3)), spin.mul(0.37).add(seed.mul(2.7)));
  const streamer = a3.w.greaterThan(1.5);
  // Streamers ripple along their length so they read as ribbon rather than card.
  const ripple = select(streamer, sin(positionGeometry.y.mul(9).add(t.mul(14)).add(seed.mul(20))).mul(0.18), float(0));
  const size = a2.z.mul(shrink).mul(alive);
  const local = vec3(positionGeometry.x.mul(a2.w).add(ripple.mul(a2.w)), positionGeometry.y, 0).mul(size);
  const rotated = rotate(local, euler);

  const normal = rotate(vec3(0, 0, 1), euler);
  const facing = normal.dot(normalize(cameraPosition.sub(centre))).abs();

  const material = new MeshBasicNodeMaterial({ side: DoubleSide });
  material.positionNode = centre.add(rotated);
  material.alphaTest = 0.5;
  material.fog = true;

  const vFacing = varying(facing);
  const c = uv().mul(2).sub(1);
  const disc = float(1).sub(smoothstep(0.92, 1, c.length()));
  const mask = select(a3.w.greaterThan(0.5).and(streamer.not()), disc, float(1));
  const bright = mix(float(0.58), float(1.12), vFacing);
  const glint = smoothstep(0.93, 1, vFacing).mul(0.45);
  material.colorNode = vec4(a3.xyz.mul(bright).add(glint), mask);
  return material;
}
