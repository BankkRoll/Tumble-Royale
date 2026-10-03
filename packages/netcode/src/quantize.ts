/**
 * Quantisation for everything that crosses the wire at high frequency.
 *
 * | Quantity        | Encoding                                 | Max error                  |
 * |-----------------|------------------------------------------|----------------------------|
 * | position        | 16 bit/axis inside `RoundDefinition.bounds` | extent / 131070 (≈1.5 mm per 200 m) |
 * | rotation        | smallest-three: 2-bit index + 3 × 10 bit | ≈ 0.16° (measured in tests) |
 * | rotation (yaw)  | 16-bit yaw when the body is upright      | 0.0028°                    |
 * | velocity        | 12 bit/axis in ±40 m/s (symmetric)       | 0.0098 m/s                 |
 * | yaw / facing    | 16 bit over [0, 2π)                      | 0.0028°                    |
 * | move axes       | 8-bit signed (−127…127)                  | 0.0039                     |
 */
import type { Quat, Vec3 } from '@tumble/shared';
import { dequantizeRange, quantizeRange } from './bits.ts';

/** Bits per position axis. */
export const POSITION_BITS = 16;
/** Bits per smallest-three component (plus a 2-bit index → 32 bits per quaternion). */
export const QUAT_COMPONENT_BITS = 10;
/** Total bits for a smallest-three quaternion. */
export const QUAT_BITS = 2 + 3 * QUAT_COMPONENT_BITS;
/** Bits per velocity axis. */
export const VELOCITY_BITS = 12;
/** Velocity range (± m/s) per axis; faster bodies are clamped. */
export const VELOCITY_MAX = 40;
/** Bits for a yaw angle. */
export const YAW_BITS = 16;
/** Bits per movement axis. */
export const AXIS_BITS = 8;

const TAU = Math.PI * 2;
const QUAT_RANGE = Math.SQRT1_2;
const QUAT_MASK = (1 << QUAT_COMPONENT_BITS) - 1;
/** Symmetric half-range so that 0 is exactly representable (one code point is left unused). */
const QUAT_HALF = (1 << (QUAT_COMPONENT_BITS - 1)) - 1;
const VEL_HALF = (1 << (VELOCITY_BITS - 1)) - 1;
const YAW_STEPS = 1 << YAW_BITS;

/** Axis-aligned bounds used for position quantisation (matches `RoundDefinition.bounds`). */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/**
 * Quantises positions to 16 bits per axis inside a round's bounds.
 * One instance per round; both peers must construct it from the same bounds.
 */
export class PositionQuantizer {
  readonly min: Vec3;
  readonly max: Vec3;
  /** Metres per quantisation step on each axis. */
  readonly step: Vec3;

  /** @param bounds - The round's netcode bounds. Degenerate axes are widened to 1 m. */
  constructor(bounds: Bounds) {
    const fix = (a: number, b: number): [number, number] => (b - a < 1 ? [a - 0.5, a + 0.5] : [a, b]);
    const [x0, x1] = fix(bounds.min.x, bounds.max.x);
    const [y0, y1] = fix(bounds.min.y, bounds.max.y);
    const [z0, z1] = fix(bounds.min.z, bounds.max.z);
    this.min = { x: x0, y: y0, z: z0 };
    this.max = { x: x1, y: y1, z: z1 };
    const steps = 2 ** POSITION_BITS - 1;
    this.step = { x: (x1 - x0) / steps, y: (y1 - y0) / steps, z: (z1 - z0) / steps };
  }

  /** Quantises one X coordinate. */
  qx(v: number): number {
    return quantizeRange(v, this.min.x, this.max.x, POSITION_BITS);
  }
  /** Quantises one Y coordinate. */
  qy(v: number): number {
    return quantizeRange(v, this.min.y, this.max.y, POSITION_BITS);
  }
  /** Quantises one Z coordinate. */
  qz(v: number): number {
    return quantizeRange(v, this.min.z, this.max.z, POSITION_BITS);
  }

  /** Dequantises integer coordinates into `out`. */
  dequantize(qx: number, qy: number, qz: number, out: Vec3): Vec3 {
    out.x = dequantizeRange(qx, this.min.x, this.max.x, POSITION_BITS);
    out.y = dequantizeRange(qy, this.min.y, this.max.y, POSITION_BITS);
    out.z = dequantizeRange(qz, this.min.z, this.max.z, POSITION_BITS);
    return out;
  }

  /** Worst-case absolute error per axis (half a step on the widest axis). */
  get maxError(): number {
    return Math.max(this.step.x, this.step.y, this.step.z) / 2;
  }
}

/**
 * Packs a unit quaternion with the smallest-three scheme into 32 bits:
 * `[index:2][a:10][b:10][c:10]`, where `index` is the dropped (largest) component
 * and a, b, c are the remaining components in order, each in ±1/√2.
 *
 * @returns The packed value as an unsigned 32-bit integer.
 */
export function packQuat(q: Quat): number {
  let x = q.x;
  let y = q.y;
  let z = q.z;
  let w = q.w;
  const len = Math.hypot(x, y, z, w);
  if (len > 0) {
    x /= len;
    y /= len;
    z /= len;
    w /= len;
  } else {
    w = 1;
  }
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const aw = Math.abs(w);
  let index = 3;
  let largest = aw;
  if (ax > largest) {
    index = 0;
    largest = ax;
  }
  if (ay > largest) {
    index = 1;
    largest = ay;
  }
  if (az > largest) index = 2;
  // q and -q are the same rotation; flip so the dropped component is positive and can be rebuilt with sqrt.
  const sign = (index === 0 ? x : index === 1 ? y : index === 2 ? z : w) < 0 ? -1 : 1;
  let a: number;
  let b: number;
  let c: number;
  if (index === 0) {
    a = y;
    b = z;
    c = w;
  } else if (index === 1) {
    a = x;
    b = z;
    c = w;
  } else if (index === 2) {
    a = x;
    b = y;
    c = w;
  } else {
    a = x;
    b = y;
    c = z;
  }
  const qa = quatComp(a * sign);
  const qb = quatComp(b * sign);
  const qc = quatComp(c * sign);
  return ((index << 30) | (qa << 20) | (qb << 10) | qc) >>> 0;
}

/** Unpacks a value produced by {@link packQuat} into `out`. */
export function unpackQuat(packed: number, out: Quat): Quat {
  const index = (packed >>> 30) & 3;
  const a = deq((packed >>> 20) & QUAT_MASK);
  const b = deq((packed >>> 10) & QUAT_MASK);
  const c = deq(packed & QUAT_MASK);
  const d = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  if (index === 0) {
    out.x = d;
    out.y = a;
    out.z = b;
    out.w = c;
  } else if (index === 1) {
    out.x = a;
    out.y = d;
    out.z = b;
    out.w = c;
  } else if (index === 2) {
    out.x = a;
    out.y = b;
    out.z = d;
    out.w = c;
  } else {
    out.x = a;
    out.y = b;
    out.z = c;
    out.w = d;
  }
  const len = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= len;
  out.y /= len;
  out.z /= len;
  out.w /= len;
  return out;
}

const quatComp = (v: number): number => {
  const c = v < -QUAT_RANGE ? -QUAT_RANGE : v > QUAT_RANGE ? QUAT_RANGE : v;
  return Math.round((c / QUAT_RANGE) * QUAT_HALF) + QUAT_HALF;
};
const deq = (q: number): number => ((q - QUAT_HALF) / QUAT_HALF) * QUAT_RANGE;

/** Angle in radians between two unit quaternions. */
export function quatAngle(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

/**
 * True when `q` is (numerically) a pure rotation about +Y — upright Tumblers —
 * so it can travel as a 16-bit yaw instead of a 32-bit quaternion.
 */
export function isYawOnly(q: Quat, epsilon = 1e-4): boolean {
  return Math.abs(q.x) < epsilon && Math.abs(q.z) < epsilon;
}

/** Quantises a yaw angle (any range, wrapped) to 16 bits. */
export function quantizeYaw(yaw: number): number {
  let t = yaw % TAU;
  if (t < 0) t += TAU;
  return Math.round((t / TAU) * YAW_STEPS) % YAW_STEPS;
}

/** Inverse of {@link quantizeYaw}; returns radians in (−π, π]. */
export function dequantizeYaw(q: number): number {
  const a = (q / YAW_STEPS) * TAU;
  return a > Math.PI ? a - TAU : a;
}

/** Yaw (about +Y) of a quaternion. */
export function yawOf(q: Quat): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

/** Writes the quaternion for rotation `yaw` about +Y into `out`. */
export function quatFromYawInto(yaw: number, out: Quat): Quat {
  out.x = 0;
  out.y = Math.sin(yaw / 2);
  out.z = 0;
  out.w = Math.cos(yaw / 2);
  return out;
}

/**
 * Quantises one velocity component to 12 bits in ±{@link VELOCITY_MAX}.
 * Symmetric around 0 so a body at rest decodes to exactly zero velocity
 * (otherwise idle remotes would creep during extrapolation).
 */
export function quantizeVelocity(v: number): number {
  const c = v < -VELOCITY_MAX ? -VELOCITY_MAX : v > VELOCITY_MAX ? VELOCITY_MAX : v;
  return Math.round((c / VELOCITY_MAX) * VEL_HALF) + VEL_HALF;
}

/** Inverse of {@link quantizeVelocity}. */
export function dequantizeVelocity(q: number): number {
  return ((q - VEL_HALF) / VEL_HALF) * VELOCITY_MAX;
}

/** Quantises a movement axis in [-1, 1] to a signed 8-bit integer (−127…127). */
export function quantizeAxis(v: number): number {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(c * 127);
}

/** Inverse of {@link quantizeAxis}. */
export function dequantizeAxis(q: number): number {
  return q / 127;
}
