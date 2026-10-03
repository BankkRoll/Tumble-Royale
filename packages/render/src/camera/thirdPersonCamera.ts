/**
 * Third-person camera rig for the Tumbler.
 *
 * Responsibilities:
 * - Spring-arm orbit (yaw/pitch from mouse, stick or touch) around a smoothed pivot.
 * - Follow with look-ahead in the move direction and vertical damping that
 *   ignores jump arcs but follows falls and climbs.
 * - Auto-recentre behind movement after a period without look input.
 * - Collision via a caller-supplied ray/shape cast so the rig stays physics-agnostic.
 * - Trauma-based shake (capped, accessibility-scaled) and FOV kicks.
 * - Modes: orbit, sideFixed, topDownTilt, spectate, flyover (Catmull-Rom), orbitAround.
 *
 * Yaw convention matches the sim: camera forward is `(sin yaw, 0, cos yaw)`,
 * so `rig.yaw` can be passed straight into `CharacterInput.yaw`.
 */
import { CatmullRomCurve3, MathUtils, Vector3, type PerspectiveCamera } from 'three/webgpu';

/** Plain vector accepted by the rig (sim and three vectors both fit). */
export interface CameraVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Collision probe: distance along `dir` (unit) from `origin` to the first
 * blocking surface, or `maxDist` (or more) when clear. Typically a Rapier
 * ball shape-cast against static + kinematic groups.
 */
export type CameraCollisionFn = (origin: CameraVec3, dir: CameraVec3, maxDist: number) => number;

/** Per-frame description of what the camera follows. */
export interface CameraFollowTarget {
  /** Feet position of the followed Tumbler. */
  position: CameraVec3;
  /** World velocity (m/s), for look-ahead, recentring and speed FOV. */
  velocity: CameraVec3;
  /** Whether the target stands on ground; airborne targets do not drag the camera up. */
  grounded: boolean;
}

/** Camera behaviour presets. */
export type CameraMode = 'orbit' | 'sideFixed' | 'topDownTilt' | 'spectate' | 'flyover' | 'orbitAround';

/** Authored intro/outro camera path. */
export interface FlyoverPath {
  /** Camera positions; at least 2. Interpolated with a centripetal Catmull-Rom spline. */
  points: CameraVec3[];
  /** Look-at targets, same count as `points` (or 1 for a fixed target). */
  lookAts: CameraVec3[];
  /** Total duration in seconds. */
  duration: number;
  /** Mode to return to when finished. Defaults to the mode active before the flyover. */
  then?: Exclude<CameraMode, 'flyover'>;
  /** Called once when the path completes or is skipped. */
  onDone?: () => void;
}

/** Tunable rig settings. Mutate in place; read every frame. */
export interface ThirdPersonCameraSettings {
  /** Preferred arm length (m). */
  distance: number;
  /** Closest the arm may be pushed in by collision (m). */
  minDistance: number;
  /** Height of the orbit pivot above the feet (m). */
  pivotHeight: number;
  /** Lowest pitch (rad; negative looks up). */
  pitchMin: number;
  /** Highest pitch (rad; positive looks down). */
  pitchMax: number;
  /** Pitch the rig starts at and recentres toward. */
  defaultPitch: number;
  /** Look sensitivity multiplier applied to all look deltas. */
  sensitivity: number;
  /** Invert vertical look. */
  invertY: boolean;
  /** Horizontal follow half-life (s). Small = tight. */
  followHalfLife: number;
  /** Vertical follow half-life while grounded (s). */
  verticalHalfLife: number;
  /** Height gained in the air before the camera starts rising with the target (m). */
  jumpAllowance: number;
  /** Look-ahead time (s): pivot leads by velocity × this. */
  lookAheadTime: number;
  /** Look-ahead cap (m). */
  lookAheadMax: number;
  /** Look-ahead smoothing half-life (s). */
  lookAheadHalfLife: number;
  /** Auto-recentre behind movement. */
  autoRecenter: boolean;
  /** Seconds without look input before recentring starts. */
  recenterDelay: number;
  /** Max recentre rate (rad/s) at full run speed. */
  recenterSpeed: number;
  /** Clearance kept between the camera and geometry (m). */
  collisionRadius: number;
  /** Half-life for the arm to extend again after a collision pulled it in (s). */
  collisionReleaseHalfLife: number;
  /** Accessibility multiplier for shake, 0 disables. */
  shakeScale: number;
  /** Max shake rotation (rad) at full trauma. */
  shakeMaxAngle: number;
  /** Max shake offset (m) at full trauma. */
  shakeMaxOffset: number;
  /** Trauma lost per second. */
  traumaDecay: number;
  /** Base vertical FOV (deg). */
  fov: number;
  /** Extra FOV (deg) at `fovSpeedMax` planar speed. */
  fovSpeedKick: number;
  /** Speed (m/s) where speed FOV starts. */
  fovSpeedMin: number;
  /** Speed (m/s) for the full speed FOV kick. */
  fovSpeedMax: number;
  /** FOV smoothing half-life (s). */
  fovHalfLife: number;
  /** Fixed yaw for `sideFixed` (rad). */
  sideYaw: number;
  /** Arm length for `sideFixed`. */
  sideDistance: number;
  /** Pitch for `topDownTilt` (rad). */
  topDownPitch: number;
  /** Arm length for `topDownTilt`. */
  topDownDistance: number;
  /** Spin speed for `orbitAround` (rad/s). */
  orbitAroundSpeed: number;
  /** Arm length for `orbitAround`. */
  orbitAroundDistance: number;
}

/** Default settings, tuned for a 1.8 m Tumbler. */
export const DEFAULT_CAMERA_SETTINGS: Readonly<ThirdPersonCameraSettings> = Object.freeze({
  distance: 7.5,
  minDistance: 1.2,
  pivotHeight: 1.6,
  pitchMin: -0.35,
  pitchMax: 1.2,
  defaultPitch: 0.32,
  sensitivity: 1,
  invertY: false,
  followHalfLife: 0.035,
  verticalHalfLife: 0.12,
  jumpAllowance: 2.2,
  lookAheadTime: 0.22,
  lookAheadMax: 1.8,
  lookAheadHalfLife: 0.35,
  autoRecenter: true,
  recenterDelay: 1.6,
  recenterSpeed: 1.6,
  collisionRadius: 0.25,
  collisionReleaseHalfLife: 0.25,
  shakeScale: 1,
  shakeMaxAngle: 0.05,
  shakeMaxOffset: 0.25,
  traumaDecay: 1.3,
  fov: 60,
  fovSpeedKick: 7,
  fovSpeedMin: 8.5,
  fovSpeedMax: 13,
  fovHalfLife: 0.18,
  sideYaw: Math.PI / 2,
  sideDistance: 12,
  topDownPitch: 1.05,
  topDownDistance: 15,
  orbitAroundSpeed: 0.45,
  orbitAroundDistance: 5,
});

const UP = new Vector3(0, 1, 0);

/** Exponential smoothing factor for a half-life. */
const damp = (halfLife: number, dt: number): number => (halfLife <= 0 ? 1 : 1 - Math.pow(0.5, dt / halfLife));

/** Smooth pseudo-noise in [-1, 1]; three detuned sines avoid visible periodicity. */
const wobble = (t: number, seed: number): number =>
  (Math.sin(t * 17.3 + seed) + Math.sin(t * 23.9 + seed * 2.1) * 0.6 + Math.sin(t * 7.1 + seed * 3.7) * 0.4) /
  2;

/**
 * Third-person spring-arm camera.
 *
 * @example
 * const rig = new ThirdPersonCamera(camera, { collide });
 * rig.addLook(dx, dy);            // per frame, from input
 * rig.update(dt, { position, velocity, grounded });
 * input.yaw = rig.yaw;            // movement is camera-relative
 */
export class ThirdPersonCamera {
  readonly camera: PerspectiveCamera;
  readonly settings: ThirdPersonCameraSettings;
  /** Collision probe; null disables collision. */
  collide: CameraCollisionFn | null;
  /** Orbit yaw; feed into `CharacterInput.yaw`. */
  yaw = 0;
  /** Orbit pitch (rad, positive looks down). */
  pitch: number;

  private _mode: CameraMode = 'orbit';
  private prevMode: Exclude<CameraMode, 'flyover'> = 'orbit';
  private readonly pivot = new Vector3();
  private anchorY = 0;
  private readonly lookAhead = new Vector3();
  private armLength: number;
  private idleLook = 0;
  private trauma = 0;
  private fovKick = 0;
  private fovCurrent: number;
  private time = 0;
  private initialised = false;

  private flyCurve: CatmullRomCurve3 | null = null;
  private flyLook: CatmullRomCurve3 | null = null;
  private readonly flyLookFixed = new Vector3();
  private flyDuration = 1;
  private flyTime = 0;
  private flyDone: (() => void) | undefined = undefined;

  private readonly desired = new Vector3();
  private readonly dir = new Vector3();
  private readonly lookTarget = new Vector3();
  private readonly tmp = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly probeOrigin = { x: 0, y: 0, z: 0 };
  private readonly probeDir = { x: 0, y: 0, z: 0 };

  /**
   * @param camera - The perspective camera to drive.
   * @param opts - Optional collision probe and settings overrides.
   */
  constructor(
    camera: PerspectiveCamera,
    opts: { collide?: CameraCollisionFn; settings?: Partial<ThirdPersonCameraSettings>; yaw?: number } = {},
  ) {
    this.camera = camera;
    this.settings = { ...DEFAULT_CAMERA_SETTINGS, ...opts.settings };
    this.collide = opts.collide ?? null;
    this.yaw = opts.yaw ?? 0;
    this.pitch = this.settings.defaultPitch;
    this.armLength = this.settings.distance;
    this.fovCurrent = this.settings.fov;
  }

  /** Active mode. */
  get mode(): CameraMode {
    return this._mode;
  }

  /**
   * Switches mode. `orbitAround` and `spectate` follow whatever target is passed
   * to {@link update}; use {@link playFlyover} for `flyover`.
   */
  setMode(mode: Exclude<CameraMode, 'flyover'>): void {
    if (this._mode === 'flyover') this.finishFlyover(false);
    this._mode = mode;
    this.prevMode = mode;
  }

  /**
   * Applies look input. Deltas are radians before sensitivity (the input layer
   * converts pixels / stick deflection). Positive `dPitch` looks down.
   */
  addLook(dYaw: number, dPitch: number): void {
    const s = this.settings;
    if (this._mode !== 'orbit' && this._mode !== 'spectate') return;
    if (dYaw === 0 && dPitch === 0) return;
    this.yaw -= dYaw * s.sensitivity;
    this.pitch = MathUtils.clamp(
      this.pitch + dPitch * s.sensitivity * (s.invertY ? -1 : 1),
      s.pitchMin,
      s.pitchMax,
    );
    this.idleLook = 0;
  }

  /** Adds camera shake trauma in [0, 1]; shake intensity is trauma². */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  /** Transient FOV punch in degrees (e.g. +8 on dive), decays smoothly. */
  kickFov(degrees: number): void {
    this.fovKick = Math.max(this.fovKick, degrees);
  }

  /** Snaps smoothing state to the target (after teleports and respawns). */
  snapTo(target: CameraFollowTarget): void {
    this.pivot.set(target.position.x, target.position.y + this.settings.pivotHeight, target.position.z);
    this.anchorY = target.position.y;
    this.lookAhead.set(0, 0, 0);
    this.armLength = this.settings.distance;
    this.initialised = true;
  }

  /**
   * Plays an authored path, then returns to the previous (or `then`) mode.
   *
   * @example
   * rig.playFlyover({ points, lookAts: [finish], duration: 6, onDone: startCountdown });
   */
  playFlyover(path: FlyoverPath): void {
    if (path.points.length < 2) throw new Error('Flyover needs at least 2 points');
    if (this._mode !== 'flyover') this.prevMode = path.then ?? (this._mode as Exclude<CameraMode, 'flyover'>);
    else if (path.then) this.prevMode = path.then;
    const toV = (p: CameraVec3): Vector3 => new Vector3(p.x, p.y, p.z);
    this.flyCurve = new CatmullRomCurve3(path.points.map(toV), false, 'centripetal');
    if (path.lookAts.length >= 2) {
      this.flyLook = new CatmullRomCurve3(path.lookAts.map(toV), false, 'centripetal');
    } else {
      this.flyLook = null;
      const l = path.lookAts[0] ?? path.points[path.points.length - 1]!;
      this.flyLookFixed.set(l.x, l.y, l.z);
    }
    this.flyDuration = Math.max(0.1, path.duration);
    this.flyTime = 0;
    this.flyDone = path.onDone;
    this._mode = 'flyover';
  }

  /** Ends a flyover early (e.g. player pressed skip). */
  skipFlyover(): void {
    if (this._mode === 'flyover') this.finishFlyover(true);
  }

  /**
   * Advances the rig and writes the camera transform.
   *
   * @param dt - Frame delta (s).
   * @param target - What to follow. Ignored during flyovers.
   */
  update(dt: number, target: CameraFollowTarget): void {
    const s = this.settings;
    this.time += dt;
    if (!this.initialised) this.snapTo(target);

    this.trauma = Math.max(0, this.trauma - s.traumaDecay * dt);
    this.fovKick *= 1 - damp(0.22, dt);

    if (this._mode === 'flyover') {
      this.updateFlyover(dt);
    } else {
      this.updateFollow(dt, target);
    }

    // FOV: base + speed + transient kick
    const speed = Math.hypot(target.velocity.x, target.velocity.z);
    const speedT = MathUtils.clamp(
      (speed - s.fovSpeedMin) / Math.max(0.01, s.fovSpeedMax - s.fovSpeedMin),
      0,
      1,
    );
    const fovTarget = s.fov + s.fovSpeedKick * speedT + this.fovKick;
    this.fovCurrent += (fovTarget - this.fovCurrent) * damp(s.fovHalfLife, dt);
    if (Math.abs(this.camera.fov - this.fovCurrent) > 1e-3) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    this.applyShake();
  }

  private updateFollow(dt: number, target: CameraFollowTarget): void {
    const s = this.settings;
    const p = target.position;
    const v = target.velocity;

    // Vertical anchor: follow the ground height, ignore jump arcs, follow falls and big climbs.
    if (target.grounded) {
      this.anchorY += (p.y - this.anchorY) * damp(s.verticalHalfLife, dt);
    } else if (p.y < this.anchorY) {
      this.anchorY += (p.y - this.anchorY) * damp(s.verticalHalfLife * 0.6, dt);
    } else if (p.y > this.anchorY + s.jumpAllowance) {
      this.anchorY += (p.y - s.jumpAllowance - this.anchorY) * damp(s.verticalHalfLife, dt);
    }

    // Look-ahead leads the pivot in the move direction; it shrinks for camera-facing motion so you can see what chases you.
    this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.tmp.set(v.x * s.lookAheadTime, 0, v.z * s.lookAheadTime);
    const towardCam = -this.tmp.dot(this.fwd);
    if (towardCam > 0) this.tmp.addScaledVector(this.fwd, towardCam * 0.6);
    if (this.tmp.length() > s.lookAheadMax) this.tmp.setLength(s.lookAheadMax);
    if (this._mode === 'orbitAround') this.tmp.set(0, 0, 0);
    this.lookAhead.lerp(this.tmp, damp(s.lookAheadHalfLife, dt));

    const k = damp(this._mode === 'spectate' ? s.followHalfLife * 4 : s.followHalfLife, dt);
    this.pivot.x += (p.x + this.lookAhead.x - this.pivot.x) * k;
    this.pivot.z += (p.z + this.lookAhead.z - this.pivot.z) * k;
    this.pivot.y = this.anchorY + s.pivotHeight;

    let yaw = this.yaw;
    let pitch = this.pitch;
    let dist = s.distance;
    switch (this._mode) {
      case 'sideFixed':
        yaw = s.sideYaw;
        pitch = 0.18;
        dist = s.sideDistance;
        break;
      case 'topDownTilt':
        pitch = s.topDownPitch;
        dist = s.topDownDistance;
        break;
      case 'orbitAround':
        this.yaw += s.orbitAroundSpeed * dt;
        yaw = this.yaw;
        pitch = 0.22;
        dist = s.orbitAroundDistance;
        break;
      case 'orbit':
        this.recenter(dt, v);
        yaw = this.yaw;
        pitch = this.pitch;
        break;
      default:
        break;
    }

    // Camera sits behind the pivot: pivot − forward·cos(pitch)·d + up·sin(pitch)·d
    this.dir
      .set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      .normalize();
    let arm = dist;
    if (this.collide) {
      this.probeOrigin.x = this.pivot.x;
      this.probeOrigin.y = this.pivot.y;
      this.probeOrigin.z = this.pivot.z;
      this.probeDir.x = this.dir.x;
      this.probeDir.y = this.dir.y;
      this.probeDir.z = this.dir.z;
      const hit = this.collide(this.probeOrigin, this.probeDir, dist + s.collisionRadius);
      if (hit < dist + s.collisionRadius) arm = Math.max(s.minDistance, hit - s.collisionRadius);
    }
    // Pull in instantly (never see through walls); ease back out.
    if (arm < this.armLength) this.armLength = arm;
    else this.armLength += (arm - this.armLength) * damp(s.collisionReleaseHalfLife, dt);

    this.desired.copy(this.pivot).addScaledVector(this.dir, this.armLength);
    this.camera.position.copy(this.desired);
    this.lookTarget.copy(this.pivot);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.lookTarget);
  }

  /** Swings yaw behind the direction of travel after the player stops steering the camera. */
  private recenter(dt: number, v: CameraVec3): void {
    const s = this.settings;
    this.idleLook += dt;
    if (!s.autoRecenter || this.idleLook < s.recenterDelay) return;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 2) return;
    const moveYaw = Math.atan2(v.x, v.z);
    let d = moveYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    // Running at the camera: leave it be rather than whipping around 180°.
    if (Math.abs(d) > 2.3) return;
    const rate = s.recenterSpeed * MathUtils.clamp(speed / 8, 0, 1) * dt;
    this.yaw += MathUtils.clamp(d, -rate, rate);
    this.pitch += (s.defaultPitch - this.pitch) * damp(1.2, dt);
  }

  private updateFlyover(dt: number): void {
    const curve = this.flyCurve;
    if (!curve) return;
    this.flyTime += dt;
    const u = MathUtils.clamp(this.flyTime / this.flyDuration, 0, 1);
    const e = u * u * (3 - 2 * u);
    curve.getPointAt(e, this.desired);
    if (this.flyLook) this.flyLook.getPointAt(e, this.lookTarget);
    else this.lookTarget.copy(this.flyLookFixed);
    this.camera.position.copy(this.desired);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.lookTarget);
    if (u >= 1) this.finishFlyover(true);
  }

  private finishFlyover(notify: boolean): void {
    const done = this.flyDone;
    this.flyCurve = null;
    this.flyLook = null;
    this.flyDone = undefined;
    this._mode = this.prevMode;
    // Hand back with the arm aligned to where the flyover ended, avoiding a pop.
    this.initialised = false;
    if (notify) done?.();
  }

  private applyShake(): void {
    const s = this.settings;
    const shake = this.trauma * this.trauma * s.shakeScale;
    if (shake <= 1e-4) return;
    const t = this.time;
    this.right.setFromMatrixColumn(this.camera.matrix, 0);
    this.tmp.setFromMatrixColumn(this.camera.matrix, 1);
    const off = s.shakeMaxOffset * shake;
    this.camera.position
      .addScaledVector(this.right, wobble(t, 1.3) * off)
      .addScaledVector(this.tmp, wobble(t, 4.7) * off);
    this.camera.rotateZ(wobble(t, 9.1) * s.shakeMaxAngle * shake);
    this.camera.rotateX(wobble(t, 2.9) * s.shakeMaxAngle * 0.5 * shake);
  }
}
