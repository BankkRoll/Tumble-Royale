/** Plain 3-vector used across package boundaries (renderer- and physics-agnostic). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Plain quaternion used across package boundaries. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** @returns A new vector. */
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** @returns A new identity quaternion. */
export const quatIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

/** Copies `src` into `out`. */
export const copyVec = (src: Vec3, out: Vec3): Vec3 => {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  return out;
};

/** Copies `src` into `out`. */
export const copyQuat = (src: Quat, out: Quat): Quat => {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  out.w = src.w;
  return out;
};

/** Clamps `v` to [min, max]. */
export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Where `v` sits between `a` and `b`, unclamped. */
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));

/** Remaps `v` from [a0, a1] to [b0, b1], clamped. */
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  lerp(b0, b1, clamp(invLerp(a0, a1, v), 0, 1));

/** Hermite smoothstep on [0, 1]. */
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Ease in-out sine on [0, 1]. */
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;

/**
 * Frame-rate independent exponential smoothing factor.
 *
 * @param halfLife - Seconds for the remaining distance to halve.
 * @param dt - Elapsed seconds.
 * @returns The blend factor to pass to `lerp(current, target, factor)`.
 */
export const damp = (halfLife: number, dt: number): number => 1 - Math.pow(0.5, dt / Math.max(halfLife, 1e-5));

/** Moves `current` toward `target` by at most `maxDelta`. */
export const moveToward = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/** Shortest signed difference between two angles in radians. */
export const angleDelta = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Quaternion for a rotation of `angle` radians about the Y axis. */
export const quatFromYaw = (angle: number, out: Quat = quatIdentity()): Quat => {
  const h = angle * 0.5;
  out.x = 0;
  out.y = Math.sin(h);
  out.z = 0;
  out.w = Math.cos(h);
  return out;
};

/** Quaternion from an axis (need not be normalised) and angle in radians. */
export const quatFromAxisAngle = (
  ax: number,
  ay: number,
  az: number,
  angle: number,
  out: Quat = quatIdentity(),
): Quat => {
  const len = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(angle * 0.5) / len;
  out.x = ax * s;
  out.y = ay * s;
  out.z = az * s;
  out.w = Math.cos(angle * 0.5);
  return out;
};

/** Quaternion from intrinsic Y-X-Z Euler angles (yaw, pitch, roll) — the order level designers think in. */
export const quatFromEulerYXZ = (yaw: number, pitch: number, roll: number, out: Quat = quatIdentity()): Quat => {
  const c1 = Math.cos(pitch / 2);
  const c2 = Math.cos(yaw / 2);
  const c3 = Math.cos(roll / 2);
  const s1 = Math.sin(pitch / 2);
  const s2 = Math.sin(yaw / 2);
  const s3 = Math.sin(roll / 2);
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 - s1 * s2 * c3;
  out.w = c1 * c2 * c3 + s1 * s2 * s3;
  return out;
};

/** Hamilton product `a * b`, written into `out` (may alias). */
export const quatMul = (a: Quat, b: Quat, out: Quat = quatIdentity()): Quat => {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
};

/** Rotates vector `v` by unit quaternion `q`, written into `out` (may alias). */
export const rotateVec = (q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 => {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
  return out;
};

/** Spherical interpolation between unit quaternions, written into `out` (may alias `a`). */
export const quatSlerp = (a: Quat, b: Quat, t: number, out: Quat = quatIdentity()): Quat => {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  out.x = s0 * a.x + s1 * bx;
  out.y = s0 * a.y + s1 * by;
  out.z = s0 * a.z + s1 * bz;
  out.w = s0 * a.w + s1 * bw;
  const len = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= len;
  out.y /= len;
  out.z /= len;
  out.w /= len;
  return out;
};

/** Yaw (rotation about +Y) extracted from a quaternion. */
export const yawFromQuat = (q: Quat): number =>
  Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
