/**
 * The spectator fly camera: a drone that moves relative to where it looks,
 * rises and sinks on its own axis, accelerates smoothly, and stays inside the
 * level's bounds and above its kill plane.
 *
 * Pure (no three.js, DOM or store) so its bounds and motion are unit-tested;
 * the spectator controller feeds it input and writes its pose to the camera.
 */
import { clampPitch, copyPose, pose, wrapAngle, type CamPose, type Vec3 } from './cameraMath.ts';

/** Where the free camera may go. */
export interface FreeCamBounds {
  min: Vec3;
  max: Vec3;
}

/** Tuning for {@link FreeCam}. */
export const FREE_CAM = Object.freeze({
  /** Cruise speed (m/s). */
  speed: 14,
  /** Speed multiplier while the speed modifier is held. */
  boost: 3,
  /** Velocity smoothing half-life (s): short enough to stop on a dime, long enough not to jolt. */
  halfLife: 0.12,
  /** Room left around the level's netcode bounds horizontally (m). */
  marginXZ: 25,
  /** Room above the level's bounds (m), for high wide shots. */
  marginTop: 40,
  /** Height kept above the kill plane (m): the camera never dips into the void. */
  aboveKill: 1.5,
});

/** One frame of fly input, in camera space. */
export interface FlyInput {
  /** Strafe, −1 left … 1 right. */
  x: number;
  /** Sink/rise, −1 down … 1 up. */
  y: number;
  /** Back/forward, −1 … 1. */
  z: number;
  /** Speed modifier held. */
  boost: boolean;
  /** Look delta (rad) as the input layer reports it: positive yaw turns right. */
  lookYaw: number;
  /** Positive looks down. */
  lookPitch: number;
}

/**
 * Bounds for a round: its netcode bounds widened by {@link FREE_CAM}'s
 * margins, with the floor just above the kill plane (or the bounds' floor
 * when that is higher).
 *
 * @param round - The round's `bounds` and `killY`.
 * @example
 * cam.step(input, dt, freeCamBounds(round));
 */
export function freeCamBounds(round: { bounds: { min: Vec3; max: Vec3 }; killY: number }): FreeCamBounds {
  const { min, max } = round.bounds;
  const floor = Math.max(round.killY, min.y) + FREE_CAM.aboveKill;
  return {
    min: { x: min.x - FREE_CAM.marginXZ, y: floor, z: min.z - FREE_CAM.marginXZ },
    max: {
      x: max.x + FREE_CAM.marginXZ,
      y: Math.max(floor + 1, max.y + FREE_CAM.marginTop),
      z: max.z + FREE_CAM.marginXZ,
    },
  };
}

/**
 * Clamps a position into `b`.
 *
 * @returns `p`, modified.
 */
export function clampToBounds<T extends Vec3>(p: T, b: FreeCamBounds): T {
  p.x = Math.min(b.max.x, Math.max(b.min.x, p.x));
  p.y = Math.min(b.max.y, Math.max(b.min.y, p.y));
  p.z = Math.min(b.max.z, Math.max(b.min.z, p.z));
  return p;
}

/** A neutral {@link FlyInput}. */
export function idleFlyInput(): FlyInput {
  return { x: 0, y: 0, z: 0, boost: false, lookYaw: 0, lookPitch: 0 };
}

/**
 * Fly camera state.
 *
 * @example
 * const cam = new FreeCam(currentPose);
 * cam.step(input, dt, freeCamBounds(round)); // → pose to show
 */
export class FreeCam {
  /** Current pose (read after {@link step}). */
  readonly pose: CamPose = pose();
  /** Current velocity (m/s). */
  readonly vel: Vec3 = { x: 0, y: 0, z: 0 };

  /** @param start - Pose to take off from (usually where the camera is now). */
  constructor(start?: CamPose) {
    if (start) this.reset(start);
  }

  /**
   * Teleports to `p` and stops.
   *
   * @param p - New pose (copied).
   */
  reset(p: CamPose): void {
    copyPose(p, this.pose);
    this.pose.pitch = clampPitch(this.pose.pitch);
    this.vel.x = this.vel.y = this.vel.z = 0;
  }

  /**
   * Advances one frame: look first, then fly in the new heading, then clamp
   * into `bounds` (cancelling velocity into a wall so it does not stick).
   *
   * @param input - This frame's fly input.
   * @param dt - Real frame delta (s); the camera ignores slow-mo.
   * @param bounds - Where it may go.
   * @returns The new pose.
   */
  step(input: FlyInput, dt: number, bounds: FreeCamBounds): CamPose {
    const p = this.pose;
    p.yaw = wrapAngle(p.yaw - input.lookYaw);
    p.pitch = clampPitch(p.pitch + input.lookPitch);
    const sy = Math.sin(p.yaw);
    const cy = Math.cos(p.yaw);
    let mx = clampAxis(input.x);
    let mz = clampAxis(input.z);
    const flat = Math.hypot(mx, mz);
    if (flat > 1) {
      mx /= flat;
      mz /= flat;
    }
    const speed = FREE_CAM.speed * (input.boost ? FREE_CAM.boost : 1);
    // Forward follows the look direction on the ground plane; right = (−cos, 0, sin), as the sim moves Tumblers.
    const tx = (sy * mz - cy * mx) * speed;
    const tz = (cy * mz + sy * mx) * speed;
    const ty = clampAxis(input.y) * speed;
    const k = dt <= 0 ? 0 : 1 - Math.pow(0.5, dt / FREE_CAM.halfLife);
    this.vel.x = settle(this.vel.x + (tx - this.vel.x) * k, tx);
    this.vel.y = settle(this.vel.y + (ty - this.vel.y) * k, ty);
    this.vel.z = settle(this.vel.z + (tz - this.vel.z) * k, tz);
    p.x += this.vel.x * dt;
    p.y += this.vel.y * dt;
    p.z += this.vel.z * dt;
    const bx = p.x;
    const by = p.y;
    const bz = p.z;
    clampToBounds(p, bounds);
    if (p.x !== bx) this.vel.x = 0;
    if (p.y !== by) this.vel.y = 0;
    if (p.z !== bz) this.vel.z = 0;
    return p;
  }
}

/** Snaps a decaying velocity to rest so the camera stops instead of creeping forever. */
function settle(v: number, target: number): number {
  return target === 0 && Math.abs(v) < 0.05 ? 0 : v;
}

function clampAxis(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}
