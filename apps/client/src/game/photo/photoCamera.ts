/**
 * Photo mode camera maths, free of three.js and the DOM so it is unit tested:
 * an orbit around a movable focus point, clamped so the camera never flips
 * over the pole, zooms through the focus or wanders off the level.
 */

/** A point in world space. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Orbit camera state. */
export interface PhotoCameraState {
  /** Point the camera orbits and looks at. */
  target: Vec3Like;
  /** Orbit angle around +Y (rad); 0 puts the camera on +Z of the target. */
  yaw: number;
  /** Elevation (rad); positive looks down from above. */
  pitch: number;
  /** Distance from the target (m). */
  distance: number;
  /** Vertical field of view (degrees). */
  fov: number;
}

/** Limits applied by {@link clampPhotoCamera}. */
export interface PhotoLimits {
  minPitch: number;
  maxPitch: number;
  minDistance: number;
  maxDistance: number;
  minFov: number;
  maxFov: number;
  /** How far the focus may travel from where photo mode started (m). */
  maxTravel: number;
}

/** Defaults: just short of straight up/down, close-ups to wide establishing shots. */
export const PHOTO_LIMITS: Readonly<PhotoLimits> = Object.freeze({
  minPitch: -0.35,
  maxPitch: 1.45,
  minDistance: 1.2,
  maxDistance: 40,
  minFov: 20,
  maxFov: 100,
  maxTravel: 35,
});

/** One frame of photo controls, already merged across devices. */
export interface PhotoControls {
  /** Orbit (rad): + turns right / looks further down. */
  orbitYaw: number;
  orbitPitch: number;
  /** Zoom factor steps: + moves closer. */
  zoom: number;
  /** Focus movement in camera-relative metres: x right, z forward, y up. */
  moveX: number;
  moveY: number;
  moveZ: number;
  /** FOV change (degrees). */
  fov: number;
}

/** No input. */
export const NO_PHOTO_CONTROLS: Readonly<PhotoControls> = Object.freeze({
  orbitYaw: 0,
  orbitPitch: 0,
  zoom: 0,
  moveX: 0,
  moveY: 0,
  moveZ: 0,
  fov: 0,
});

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Keeps a state inside the limits, in place.
 *
 * @param s - State to clamp.
 * @param anchor - Where the focus started; it may roam `maxTravel` from here.
 * @param limits - Limits.
 * @returns `s`.
 */
export function clampPhotoCamera(
  s: PhotoCameraState,
  anchor: Vec3Like,
  limits: PhotoLimits = PHOTO_LIMITS,
): PhotoCameraState {
  s.pitch = clamp(Number.isFinite(s.pitch) ? s.pitch : 0, limits.minPitch, limits.maxPitch);
  s.distance = clamp(
    Number.isFinite(s.distance) ? s.distance : limits.minDistance,
    limits.minDistance,
    limits.maxDistance,
  );
  s.fov = clamp(Number.isFinite(s.fov) ? s.fov : 60, limits.minFov, limits.maxFov);
  if (!Number.isFinite(s.yaw)) s.yaw = 0;
  // Keep yaw small so it never loses float precision after long spins.
  s.yaw = Math.atan2(Math.sin(s.yaw), Math.cos(s.yaw));
  const dx = s.target.x - anchor.x;
  const dy = s.target.y - anchor.y;
  const dz = s.target.z - anchor.z;
  const d = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(d)) {
    s.target.x = anchor.x;
    s.target.y = anchor.y;
    s.target.z = anchor.z;
  } else if (d > limits.maxTravel) {
    const k = limits.maxTravel / d;
    s.target.x = anchor.x + dx * k;
    s.target.y = anchor.y + dy * k;
    s.target.z = anchor.z + dz * k;
  }
  return s;
}

/**
 * Applies one frame of controls, then clamps.
 *
 * @param s - State (mutated).
 * @param c - Controls.
 * @param anchor - Travel anchor.
 * @param limits - Limits.
 */
export function stepPhotoCamera(
  s: PhotoCameraState,
  c: PhotoControls,
  anchor: Vec3Like,
  limits: PhotoLimits = PHOTO_LIMITS,
): PhotoCameraState {
  s.yaw -= c.orbitYaw;
  s.pitch += c.orbitPitch;
  s.distance *= Math.pow(0.9, c.zoom);
  s.fov += c.fov;
  // Forward is from the camera towards the target, flattened onto the ground.
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  s.target.x += fx * c.moveZ - fz * c.moveX;
  s.target.z += fz * c.moveZ + fx * c.moveX;
  s.target.y += c.moveY;
  return clampPhotoCamera(s, anchor, limits);
}

/**
 * Camera position for a state.
 *
 * @param s - State.
 * @param out - Receives the position.
 * @returns `out`.
 */
export function photoCameraPosition(s: PhotoCameraState, out: Vec3Like): Vec3Like {
  const c = Math.cos(s.pitch);
  out.x = s.target.x + Math.sin(s.yaw) * c * s.distance;
  out.y = s.target.y + Math.sin(s.pitch) * s.distance;
  out.z = s.target.z + Math.cos(s.yaw) * c * s.distance;
  return out;
}

/**
 * The orbit state that reproduces an existing camera: the focus sits
 * `distance` metres along its view direction.
 *
 * @param pos - Camera position.
 * @param forward - Unit view direction.
 * @param fov - Camera FOV (degrees).
 * @param distance - Orbit radius to use.
 */
export function photoStateFromCamera(
  pos: Vec3Like,
  forward: Vec3Like,
  fov: number,
  distance = 6,
): PhotoCameraState {
  const target = {
    x: pos.x + forward.x * distance,
    y: pos.y + forward.y * distance,
    z: pos.z + forward.z * distance,
  };
  const pitch = Math.asin(clamp(-forward.y, -1, 1));
  const yaw = Math.atan2(-forward.x, -forward.z);
  return { target, yaw, pitch, distance, fov };
}

/** Photo filters (CSS filter syntax, also valid for a 2D canvas `filter`). */
export const PHOTO_FILTERS = {
  none: 'none',
  warm: 'sepia(0.22) saturate(1.3) hue-rotate(-8deg) brightness(1.04)',
  mono: 'grayscale(1) contrast(1.15)',
  vivid: 'saturate(1.65) contrast(1.08)',
} as const;

/** A photo filter id. */
export type PhotoFilterId = keyof typeof PHOTO_FILTERS;

/**
 * Download name for a photo taken at `date` (local time, sortable).
 *
 * @example
 * photoFilename(new Date(2026, 9, 3, 14, 5, 9)); // 'tumble-royale-2026-10-03-140509.png'
 */
export function photoFilename(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `tumble-royale-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.png`
  );
}
