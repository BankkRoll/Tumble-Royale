/**
 * Camera poses for the spectator cameras, free of three.js so the free cam,
 * the overview framing and the mode transitions are unit-tested in Node.
 *
 * Responsibilities:
 * - {@link CamPose}: a position plus yaw/pitch in the gameplay rig's
 *   convention (forward is `(sin yaw · cos pitch, −sin pitch, cos yaw · cos pitch)`,
 *   positive pitch looks down), so a pose read off the follow camera and one
 *   written by the free cam mean the same thing;
 * - converting to and from look-at targets and directions;
 * - {@link CameraTransition}: eased blends between two poses, with
 *   {@link transitionSeconds} deciding when a blend would sweep too far or
 *   turn too fast and a straight cut is kinder.
 */

/** Plain 3D vector. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A camera position and orientation (no roll). */
export interface CamPose {
  x: number;
  y: number;
  z: number;
  /** Heading: forward is `(sin yaw, 0, cos yaw)` on the ground plane. */
  yaw: number;
  /** Positive looks down (radians). */
  pitch: number;
}

/** Steepest pitch any spectator camera uses, just short of straight down/up. */
export const PITCH_LIMIT = 1.45;

/**
 * A fresh pose.
 *
 * @example
 * const p = pose(0, 10, -20, 0, 0.3);
 */
export function pose(x = 0, y = 0, z = 0, yaw = 0, pitch = 0): CamPose {
  return { x, y, z, yaw, pitch };
}

/**
 * Copies `src` into `out`.
 *
 * @returns `out`.
 */
export function copyPose(src: CamPose, out: CamPose): CamPose {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  out.yaw = src.yaw;
  out.pitch = src.pitch;
  return out;
}

/**
 * Wraps an angle into (−π, π].
 *
 * @param a - Radians.
 */
export function wrapAngle(a: number): number {
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
}

/**
 * The pose's unit forward vector.
 *
 * @param p - Pose.
 * @param out - Written and returned.
 */
export function forwardOf(p: Pick<CamPose, 'yaw' | 'pitch'>, out: Vec3): Vec3 {
  const c = Math.cos(p.pitch);
  out.x = Math.sin(p.yaw) * c;
  out.y = -Math.sin(p.pitch);
  out.z = Math.cos(p.yaw) * c;
  return out;
}

/**
 * The yaw/pitch that looks along `dir` (need not be unit length).
 *
 * @param dir - Direction.
 * @param out - Pose whose yaw and pitch are written (position untouched).
 * @returns `out`.
 */
export function aimAlong(dir: Vec3, out: CamPose): CamPose {
  const flat = Math.hypot(dir.x, dir.z);
  if (flat > 1e-9 || Math.abs(dir.y) > 1e-9) {
    if (flat > 1e-9) out.yaw = Math.atan2(dir.x, dir.z);
    out.pitch = clampPitch(Math.atan2(-dir.y, flat));
  }
  return out;
}

/**
 * A pose at `from` looking at `target`.
 *
 * @example
 * poseLookingAt({ x: 0, y: 10, z: -10 }, { x: 0, y: 0, z: 0 }); // pitch π/4, yaw 0
 */
export function poseLookingAt(from: Vec3, target: Vec3, out: CamPose = pose()): CamPose {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  return aimAlong({ x: target.x - from.x, y: target.y - from.y, z: target.z - from.z }, out);
}

/**
 * Clamps pitch to ±{@link PITCH_LIMIT}.
 *
 * @param p - Radians.
 */
export function clampPitch(p: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
}

/**
 * Smooth start and stop over t ∈ [0, 1].
 *
 * @param t - Progress (clamped).
 */
export function easeInOutCubic(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/**
 * Interpolates two poses (yaw the short way round).
 *
 * @param a - From.
 * @param b - To.
 * @param t - 0 → `a`, 1 → `b` (not eased here).
 * @param out - Written and returned (may alias `a` or `b`).
 */
export function blendPose(a: CamPose, b: CamPose, t: number, out: CamPose): CamPose {
  const yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * t;
  const pitch = a.pitch + (b.pitch - a.pitch) * t;
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.yaw = wrapAngle(yaw);
  out.pitch = pitch;
  return out;
}

/** Limits that keep camera moves comfortable to watch. */
export const TRANSITION = Object.freeze({
  /** Shortest blend (s). */
  minSeconds: 0.45,
  /** Longest blend (s); anything that would need longer cuts instead. */
  maxSeconds: 1.4,
  /** Average travel speed a blend may reach (m/s). */
  maxSpeed: 70,
  /** Average turn rate a blend may reach (rad/s). */
  maxTurnRate: 2.2,
});

/**
 * How long a move from `a` to `b` should blend, or 0 for a straight cut: when
 * Reduce Motion is on, or when the camera would have to fly or turn faster
 * than {@link TRANSITION} allows (a long sweep across the course reads as a
 * whip pan; a cut is easier on the eyes).
 *
 * @param a - Current pose.
 * @param b - Pose to reach.
 * @param reduceMotion - Settings → Accessibility → Reduce motion.
 * @returns Seconds, 0 = cut.
 */
export function transitionSeconds(a: CamPose, b: CamPose, reduceMotion: boolean): number {
  if (reduceMotion) return 0;
  const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const turn = Math.max(Math.abs(wrapAngle(b.yaw - a.yaw)), Math.abs(b.pitch - a.pitch));
  const need = Math.max(TRANSITION.minSeconds, dist / TRANSITION.maxSpeed, turn / TRANSITION.maxTurnRate);
  return need > TRANSITION.maxSeconds ? 0 : need;
}

/**
 * An eased blend from a frozen start pose to a moving target pose.
 *
 * @example
 * const tr = new CameraTransition();
 * tr.start(currentPose, transitionSeconds(currentPose, targetPose, reduceMotion));
 * // per frame, after computing the target:
 * tr.apply(target, dt, out); // out = blended pose (or target once done)
 */
export class CameraTransition {
  private readonly from = pose();
  private elapsed = 0;
  private duration = 0;

  /** True while a blend is running. */
  get active(): boolean {
    return this.elapsed < this.duration;
  }

  /**
   * Starts a blend from `from` (copied).
   *
   * @param from - Pose the camera is at now.
   * @param seconds - Blend length; 0 or less cuts.
   */
  start(from: CamPose, seconds: number): void {
    copyPose(from, this.from);
    this.elapsed = 0;
    this.duration = Math.max(0, seconds);
  }

  /** Ends any blend (the next {@link apply} returns the target). */
  stop(): void {
    this.elapsed = this.duration = 0;
  }

  /**
   * Advances the blend and writes the pose to show.
   *
   * @param target - Where the camera wants to be this frame.
   * @param dt - Frame delta (s).
   * @param out - Written and returned (may alias `target`).
   */
  apply(target: CamPose, dt: number, out: CamPose): CamPose {
    if (!this.active) return out === target ? out : copyPose(target, out);
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    return blendPose(this.from, target, easeInOutCubic(this.elapsed / this.duration), out);
  }
}
