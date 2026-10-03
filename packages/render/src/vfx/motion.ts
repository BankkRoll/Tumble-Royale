import { exp, float, max, select, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Closed-form particle motion shared by the GPU pools and the CPU recipes that
 * need to know where a particle will be (firework apex, balloon pop point).
 *
 * Responsibilities:
 * - Linear-drag ballistic displacement, in TSL and in plain JS, kept in sync.
 * - A cheap shader hash for per-instance variation.
 *
 * Model: dv/dt = -k·v - g·ŷ, which integrates to
 *   p(t) = p0 + v0·f(t) - ŷ·g·(t - f(t))/k,   f(t) = (1 - e^(-k·t))/k.
 * Negative `g` is buoyancy (balloons, smoke). Drag reaches a terminal velocity
 * of g/k, which is what makes confetti flutter down instead of dropping.
 */

/**
 * Drags below this snap to zero. Near k = 0 the `(t - f)/k` gravity term
 * cancels catastrophically in float32, so tiny drags are treated as none.
 */
export const MIN_DRAG = 0.05;

/**
 * TSL displacement from the spawn point after `t` seconds.
 *
 * @param v0 - Initial velocity (m/s).
 * @param k - Linear drag (1/s); values below {@link MIN_DRAG} mean no drag.
 * @param g - Gravity (m/s², positive pulls down).
 * @param t - Age in seconds, already clamped to [0, life].
 * @returns World-space offset node.
 */
export function analyticOffset(
  v0: Node<'vec3'>,
  k: Node<'float'>,
  g: Node<'float'>,
  t: Node<'float'>,
): Node<'vec3'> {
  const noDrag = k.lessThan(MIN_DRAG);
  const kk = max(k, float(MIN_DRAG));
  const f = select(
    noDrag,
    t,
    float(1)
      .sub(exp(kk.negate().mul(t)))
      .div(kk),
  );
  const gt = select(noDrag, t.mul(t).mul(0.5), t.sub(f).div(kk));
  return v0.mul(f).sub(vec3(0, g.mul(gt), 0));
}

/** Plain displacement output for {@link analyticOffsetCpu}. */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * CPU mirror of {@link analyticOffset}.
 *
 * @param vx - Initial velocity x.
 * @param vy - Initial velocity y.
 * @param vz - Initial velocity z.
 * @param k - Drag.
 * @param g - Gravity.
 * @param t - Age in seconds.
 * @param out - Receives the displacement.
 * @returns `out`.
 */
export function analyticOffsetCpu(
  vx: number,
  vy: number,
  vz: number,
  k: number,
  g: number,
  t: number,
  out: MutableVec3,
): MutableVec3 {
  let f: number;
  let gt: number;
  if (k < MIN_DRAG) {
    f = t;
    gt = 0.5 * t * t;
  } else {
    f = (1 - Math.exp(-k * t)) / k;
    gt = (t - f) / k;
  }
  out.x = vx * f;
  out.y = vy * f - g * gt;
  out.z = vz * f;
  return out;
}

/**
 * Time (seconds) at which a drag-free projectile launched upward reaches its apex.
 *
 * @param vy - Upward launch speed.
 * @param g - Gravity (positive).
 */
export function apexTime(vy: number, g: number): number {
  return g > 0 ? Math.max(0, vy / g) : 0;
}

/**
 * Cheap per-instance shader hash in [0, 1).
 *
 * @param x - Any float node (seed, seed + constant, …).
 */
export function hash11(x: Node<'float'>): Node<'float'> {
  return x.mul(12.9898).sin().mul(43758.5453).fract();
}
