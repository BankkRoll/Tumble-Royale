/**
 * The Tumbler character controller.
 *
 * Responsibilities:
 * - Owns one Rapier dynamic capsule and drives it by velocity targeting
 *   (never raw force spam), camera-relative, with separate ground/air response.
 * - Ground detection by downward shape-cast; slope limit, snap-to-ground,
 *   step-up, and exact riding of kinematic/dynamic platforms (including spin).
 * - Jump (coyote, buffer, variable height, apex hang), dive → belly slide →
 *   get-up, grabs (players, props, ledges), ledge hang/climb, stun/tumble,
 *   bounce pads, emotes, frozen/ghost/fate modes, gameplay surfaces.
 * - Full state capture/restore for rewind + replay.
 *
 * Determinism: no wall clock, no Math.random, no per-step allocations in the
 * steady state (events and Rapier hit objects aside). Given the same world and
 * inputs it produces bit-identical results.
 *
 * Ordering contract with the rest of the sim, per fixed step:
 * 1. obstacles set their next kinematic pose (`setNextKinematic*`),
 * 2. `controller.step(input, ctx)` for every Tumbler,
 * 3. `world.step()`,
 * 4. `controller.postStep(ctx)` for every Tumbler.
 * Platform riding reads the kinematic pose delta set in (1), so riding is exact
 * with zero lag and no drift on spinning discs.
 */
import type { Collider, RigidBody, TempContactManifold, World } from '@dimforge/rapier3d-compat';
import {
  CollisionGroup,
  InteractionGroups,
  angleDelta,
  clamp,
  groups,
  quatFromYaw,
  quatSlerp,
  yawFromQuat,
  type Quat,
  type Vec3,
} from '@tumble/shared';
import type { Rapier } from '../physics/rapier.ts';
import type { SurfaceInfo, SurfaceKind } from '../physics/surfaces.ts';
import { createCharacterExtState } from './state.ts';
import { resolveTuning, type CharacterTuning, type SurfaceTuning } from './tuning.ts';
import {
  Button,
  CharacterFlag,
  CharacterState,
  type CharacterFullState,
  type CharacterInput,
  type CharacterStateId,
  type CharacterStepContext,
  type CreateControllerOptions,
  type CreateTumblerController,
  type TumblerControllerLike,
} from './types.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Controller latch bits stored in `ext.latches`. */
const Latch = {
  Frozen: 1 << 0,
  /** One dive per airtime. */
  DiveUsed: 1 << 1,
  /** Ghost until explicitly cleared (finished, spectating). */
  GhostLocked: 1 << 2,
  /** The current ledge hang was entered by holding Grab, so releasing Grab drops. */
  LedgeByButton: 1 << 3,
} as const;

/** What `grabTarget` refers to. */
export const GrabKind = { None: 0, Player: 1, Prop: 2, Ledge: 3 } as const;

const BodyKind = { None: 0, Fixed: 1, Kinematic: 2, Dynamic: 3 } as const;

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
const EXCLUDE_SENSORS = 8;

/** Grab query: players and props only; ledges use their own ray probe. */
const GRAB_QUERY_GROUPS = groups(0xffff, CollisionGroup.Player | CollisionGroup.DynamicProp);
/** Ledge and step probes: world geometry only. */
const WORLD_QUERY_GROUPS = groups(0xffff, CollisionGroup.Static | CollisionGroup.KinematicObstacle);

/** Probe ball is slightly thinner than the capsule so walls brushing its side never read as ground. */
const PROBE_INSET = 0.03;
/** The probe starts this far above the lower hemisphere centre so slight penetration still reports a hit. */
const PROBE_LIFT = 0.1;
/** Relative upward speed (m/s) above which the Tumbler is considered to be leaving the ground. */
const LEAVE_GROUND_SPEED = 2;
/** Wall normals with |y| below this count as vertical faces for step-up and ledges. */
const WALL_NORMAL_Y = 0.3;
/**
 * Step-up nudges the body this far forward so the probe ball's footprint lands on the step
 * top rather than its corner (whose slanted normal would read as unwalkable for a frame).
 */
const STEP_FORWARD = 0.3;
const STEP_CLEARANCE = 0.02;
/** Sideways speed (m/s) used to squirt a Tumbler out from under a crushing obstacle. */
const CRUSH_ESCAPE_SPEED = 10;
/** Contact normals within ~45° of a bounce pad's up axis count as landing on its top. */
const PAD_TOP_DOT = 0.7;
/** Speed (m/s) of the nudge from touching a bounce pad's side or rim. */
const PAD_SIDE_BUMP = 2.5;

const LOCOMOTION_STATES: ReadonlySet<number> = new Set<number>([
  CharacterState.Idle,
  CharacterState.Run,
  CharacterState.Jump,
  CharacterState.Fall,
  CharacterState.Bounce,
  CharacterState.Slime,
  CharacterState.Carry,
  CharacterState.Grab,
  CharacterState.Emote,
]);

const AIR_DISPLAY_STATES: ReadonlySet<number> = new Set<number>([
  CharacterState.Jump,
  CharacterState.Fall,
  CharacterState.Bounce,
]);

const isLocomotion = (s: number): boolean => LOCOMOTION_STATES.has(s);

const decay = (halfLife: number, dt: number): number => (halfLife <= 0 ? 0 : Math.pow(0.5, dt / halfLife));

// -----------------------------------------------------------------------------
// Ground probe scratch
// -----------------------------------------------------------------------------

/** Result of a downward ground probe. Reused every step; never escapes the controller. */
interface GroundProbe {
  hit: boolean;
  handle: number;
  /** Gap between capsule bottom and the hit (m); slightly negative when resting. */
  gap: number;
  nx: number;
  ny: number;
  nz: number;
  px: number;
  py: number;
  pz: number;
  walkable: boolean;
  steep: boolean;
  /** Velocity of the support at the contact point, plus conveyor belt velocity. */
  vx: number;
  vy: number;
  vz: number;
  /** Support yaw rotation this step (rad), for turning with spinning platforms. */
  yawDelta: number;
  bodyKind: number;
  body: RigidBody | null;
  kind: SurfaceKind;
  info: SurfaceInfo | undefined;
  grounded: boolean;
}

const createProbe = (): GroundProbe => ({
  hit: false,
  handle: -1,
  gap: Infinity,
  nx: 0,
  ny: 1,
  nz: 0,
  px: 0,
  py: 0,
  pz: 0,
  walkable: false,
  steep: false,
  vx: 0,
  vy: 0,
  vz: 0,
  yawDelta: 0,
  bodyKind: BodyKind.None,
  body: null,
  kind: 'normal',
  info: undefined,
  grounded: false,
});

/**
 * Live debug readout, updated every `postStep`. Read-only for callers; the
 * object identity is stable so a debug panel can bind to it once.
 */
export interface TumblerDebugInfo {
  /** Gap under the capsule from the last probe (m). */
  gap: number;
  groundNormal: Vec3;
  /** Velocity of the supporting surface (m/s). */
  supportVel: Vec3;
  surface: SurfaceKind | 'air';
  /** Planar speed relative to the support (m/s). */
  planarSpeed: number;
  /** Last impact speed considered for stun (m/s). */
  lastImpact: number;
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

/**
 * Options for {@link TumblerController}. Identical to the contract's
 * `CreateControllerOptions`, with typed tuning overrides.
 */
export interface TumblerControllerOptions extends Omit<CreateControllerOptions, 'tuning'> {
  /** Partial tuning overrides. Omitted fields use {@link DEFAULT_TUNING}. */
  tuning?: Partial<CharacterTuning> | Record<string, unknown>;
  /**
   * Adopt an existing body and collider instead of creating them, e.g. after
   * `World.restoreSnapshot` rebuilt the world. `position` and `yaw` are then
   * ignored; follow with `setState`.
   */
  attach?: { body: RigidBody; collider: Collider };
}

/**
 * A Tumbler: one Rapier dynamic capsule plus the gameplay state machine that
 * drives it. Positions passed to the constructor and `teleport` are FEET
 * positions (spawn points sit on the floor); `getState().pos` is the raw body
 * centre for exact restore.
 *
 * @example
 * const c = new TumblerController({ R, world, id: 0, position: { x: 0, y: 0, z: 0 }, yaw: 0 });
 * c.step(input, ctx); world.step(); c.postStep(ctx);
 */
export class TumblerController implements TumblerControllerLike {
  readonly id: number;
  readonly body: RigidBody;
  readonly collider: Collider;
  /** Live tuning. Mutate fields in place for hot-reload; radius/halfHeight/mass need a new controller. */
  readonly tuning: CharacterTuning;
  /** Debug readout refreshed each `postStep`. */
  readonly debug: TumblerDebugInfo = {
    gap: 0,
    groundNormal: { x: 0, y: 1, z: 0 },
    supportVel: { x: 0, y: 0, z: 0 },
    surface: 'air',
    planarSpeed: 0,
    lastImpact: 0,
  };

  private readonly R: Rapier;
  private readonly world: World;
  private readonly gravityY: number;

  // --- Restorable state (mirrors CharacterFullState) -------------------------
  private _state: CharacterStateId = CharacterState.Fall;
  private _stateTime = 0;
  private _facing = 0;
  private _grounded = false;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private jumpHeld = false;
  private prevButtons = 0;
  private grabStamina = 1;
  private grabTarget = -1;
  private stunTimer = 0;
  private ghostTimer = 0;
  private _emote = 0;
  private flags = 0;
  private readonly ext = createCharacterExtState();

  // --- Derived body configuration (re-applied on restore) --------------------
  private appliedRotLocked = true;
  private appliedFriction = 0;
  private appliedGroups: number = InteractionGroups.player;
  private appliedEnabled = true;

  // --- Per-step scratch (never carried across steps) -------------------------
  private readonly pos = { x: 0, y: 0, z: 0 };
  private readonly vel = { x: 0, y: 0, z: 0 };
  private readonly vSet = { x: 0, y: 0, z: 0 };
  private readonly rot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly qA = { x: 0, y: 0, z: 0, w: 1 };
  private readonly qB = { x: 0, y: 0, z: 0, w: 1 };
  private readonly tA = { x: 0, y: 0, z: 0 };
  private readonly tB = { x: 0, y: 0, z: 0 };
  private readonly tmp = { x: 0, y: 0, z: 0 };
  private readonly tmp2 = { x: 0, y: 0, z: 0 };
  private readonly normalScratch = { x: 0, y: 0, z: 0 };
  private readonly pre = createProbe();
  private readonly post = createProbe();
  private probeBall: InstanceType<Rapier['Ball']>;
  private probeBallRadius: number;
  private grabBall: InstanceType<Rapier['Ball']>;
  private grabBallRadius: number;
  private readonly headroom: InstanceType<Rapier['Capsule']>;
  private readonly ray: InstanceType<Rapier['Ray']>;
  /** Pre-step support velocity, re-used by the post-step probe when the support is unchanged. */
  private preSupportHandle = -1;
  private stepCtx: CharacterStepContext | null = null;
  private contactOther: Collider | null = null;
  private contactImpact = 0;
  private readonly contactImpactDir = { x: 0, y: 0, z: 0 };
  private contactHazard = false;
  private contactBumper = 0;
  private readonly contactBumperDir = { x: 0, y: 0, z: 0 };
  private contactBumperOwner: string | undefined = undefined;
  /** Bounce pad whose (tilted) top we touched this step. */
  private contactPad: SurfaceInfo | undefined = undefined;
  private contactTackle = 0;
  private contactCrush = false;
  private readonly contactCrushDir = { x: 0, y: 0, z: 0 };
  private readonly contactTackleDir = { x: 0, y: 0, z: 0 };
  private grabBest: Collider | null = null;
  private grabBestDist = Infinity;
  private grabBestIsPlayer = false;
  private readonly grabCenter = { x: 0, y: 0, z: 0 };

  private readonly onContactPair: (other: Collider) => void;
  private readonly onManifold: (m: TempContactManifold, flipped: boolean) => void;
  private readonly onGrabCandidate: (c: Collider) => boolean;

  constructor(opts: TumblerControllerOptions) {
    this.R = opts.R;
    this.world = opts.world;
    this.id = opts.id;
    this.tuning = resolveTuning(opts.tuning);
    this.gravityY = this.world.gravity.y;
    const t = this.tuning;
    const R = this.R;

    const foot = t.halfHeight + t.radius;
    this._facing = opts.yaw;
    quatFromYaw(opts.yaw, this.rot);
    if (opts.attach) {
      this.body = opts.attach.body;
      this.collider = opts.attach.collider;
    } else {
      const bodyDesc = R.RigidBodyDesc.dynamic()
        .setTranslation(opts.position.x, opts.position.y + foot, opts.position.z)
        .setRotation(this.rot)
        .lockRotations()
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setLinearDamping(0)
        .setAngularDamping(1.2);
      this.body = this.world.createRigidBody(bodyDesc);
      const colDesc = R.ColliderDesc.capsule(t.halfHeight, t.radius)
        .setMass(t.mass)
        // Zero friction: the controller owns tangential motion, so walls never "grab" a jumping Tumbler.
        .setFriction(0)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0)
        .setRestitutionCombineRule(R.CoefficientCombineRule.Min)
        .setCollisionGroups(InteractionGroups.player);
      this.collider = this.world.createCollider(colDesc, this.body);
    }

    this.probeBallRadius = t.radius - PROBE_INSET;
    this.probeBall = new R.Ball(this.probeBallRadius);
    this.grabBallRadius = t.grabRadius;
    this.grabBall = new R.Ball(this.grabBallRadius);
    this.headroom = new R.Capsule(t.halfHeight, t.radius - 0.04);
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    this.onContactPair = (other) => {
      this.contactOther = other;
      this.world.contactPair(this.collider, other, this.onManifold);
    };
    this.onManifold = (m, flipped) => this.handleManifold(m, flipped);
    this.onGrabCandidate = (c) => this.considerGrabCandidate(c);
  }

  // ---------------------------------------------------------------------------
  // Public read-only surface
  // ---------------------------------------------------------------------------

  /** Current high-level state. */
  get state(): CharacterStateId {
    return this._state;
  }

  /** Seconds in the current state. */
  get stateTime(): number {
    return this._stateTime;
  }

  /** True when standing on walkable ground after the last `postStep`. */
  get grounded(): boolean {
    return this._grounded;
  }

  /** Facing yaw (radians); forward is `(sin, 0, cos)`. */
  get facing(): number {
    return this._facing;
  }

  /** Emote slot playing (1–4) or 0. */
  get emote(): number {
    return this._emote;
  }

  /** {@link CharacterFlag} bitfield. */
  get characterFlags(): number {
    return this.flags;
  }

  /** Grab stamina in [0, 1]. */
  get stamina(): number {
    return this.grabStamina;
  }

  /** Id of the held/holding player, carried prop id, or -1. */
  get grabTargetId(): number {
    return this.grabTarget;
  }

  /** What {@link grabTargetId} refers to; see {@link GrabKind}. */
  get grabKind(): number {
    return this.ext.grabKind;
  }

  /** Whether the Tumbler is frozen on a start gate. */
  get frozen(): boolean {
    return (this.ext.latches & Latch.Frozen) !== 0;
  }

  /** Feet position written into `out`. */
  getFeet(out: Vec3): Vec3 {
    this.body.translation(out);
    out.y -= this.tuning.halfHeight + this.tuning.radius;
    return out;
  }

  /** Body linear velocity written into `out`. */
  getVelocity(out: Vec3): Vec3 {
    this.body.linvel(out);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Step (before world.step)
  // ---------------------------------------------------------------------------

  /** Applies input: state logic and velocity targeting. Call before `world.step()`. */
  step(input: CharacterInput, ctx: CharacterStepContext): void {
    const t = this.tuning;
    const dt = ctx.dt;
    const ext = this.ext;
    const buttons = input.buttons | 0;
    const pressed = buttons & ~this.prevButtons;
    this.prevButtons = buttons;
    if (!this.appliedEnabled) return;
    this.stepCtx = ctx;
    this.refreshShapes();

    // Timers
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    if (pressed & Button.Jump) this.jumpBufferTimer = t.jumpBufferTime;
    if (this.ghostTimer > 0) {
      this.ghostTimer = Math.max(0, this.ghostTimer - dt);
      if (this.ghostTimer === 0) this.syncGhostFlag();
    }
    ext.grabCooldown = Math.max(0, ext.grabCooldown - dt);
    ext.knockTimer = Math.max(0, ext.knockTimer - dt);
    ext.bounceCooldown = Math.max(0, ext.bounceCooldown - dt);
    if (ext.grabKind !== GrabKind.Player) {
      this.grabStamina = Math.min(1, this.grabStamina + t.grabStaminaRegen * dt);
    }
    const pushDecay = decay(t.pushHalfLife, dt);
    ext.extVel.x *= pushDecay;
    ext.extVel.y *= pushDecay;
    ext.extVel.z *= pushDecay;

    this.body.translation(this.pos);
    this.body.linvel(this.vel);

    // Camera-relative move direction. Quantised axes can exceed the unit disc; clamp the magnitude.
    let mx = clamp(Number.isFinite(input.moveX) ? input.moveX : 0, -1, 1);
    let mz = clamp(Number.isFinite(input.moveZ) ? input.moveZ : 0, -1, 1);
    let mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
      mag = 1;
    }
    if (mag < 0.08 || this.frozen) {
      mx = 0;
      mz = 0;
      mag = 0;
    }
    const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    // forward = (sin, 0, cos), right = (-cos, 0, sin)
    let dirX = sy * mz - cy * mx;
    let dirZ = cy * mz + sy * mx;
    if (mag > 0) {
      const l = Math.hypot(dirX, dirZ);
      dirX /= l;
      dirZ /= l;
    }

    this.probeGround(this.pre, true);
    this.pre.grounded = this.evalGrounded(this.pre, this._grounded);
    this.preSupportHandle = this.pre.hit ? this.pre.handle : -1;
    const g = this.pre;

    if (!g.grounded) {
      const k = decay(t.carryHalfLife, dt);
      ext.carryVel.x *= k;
      ext.carryVel.z *= k;
    }

    // Variable jump height: releasing early cuts the rise.
    if (this.jumpHeld && !(buttons & Button.Jump)) {
      this.jumpHeld = false;
      if (this._state === CharacterState.Jump && this.vel.y > g.vy) {
        this.vel.y = g.vy + (this.vel.y - g.vy) * t.jumpCutMultiplier;
      }
    }

    switch (this._state) {
      case CharacterState.Stunned:
        this.stepStunned(dt);
        break;
      case CharacterState.GetUp:
        this.stepGetUp(dt);
        break;
      case CharacterState.Dive:
        this.stepDive(dirX, dirZ, mag, dt);
        break;
      case CharacterState.DiveSlide:
        this.stepDiveSlide(dirX, dirZ, mag, dt);
        break;
      case CharacterState.Grabbed:
        this.stepGrabbed(dirX, dirZ, mag, pressed, ctx);
        break;
      case CharacterState.LedgeHang:
        this.stepLedgeHang(dirX, dirZ, mag, buttons, pressed, ctx);
        break;
      case CharacterState.LedgeClimb:
        this.stepLedgeClimb(dt);
        break;
      case CharacterState.Respawning:
        this.vel.x = 0;
        this.vel.y = 0;
        this.vel.z = 0;
        break;
      case CharacterState.Finished:
        this.stepLocomotion(0, 0, 0, 0, dt);
        break;
      default:
        this.stepActive(input, dirX, dirZ, mag, buttons, pressed, ctx);
        break;
    }

    this.applyGravityScale();
    if (this.vel.y < -t.maxFallSpeed) this.vel.y = -t.maxFallSpeed;

    if (this.isUpright()) {
      this.body.setRotation(quatFromYaw(this._facing, this.rot), false);
    }
    this.body.setLinvel(this.vel, true);
    this.vSet.x = this.vel.x;
    this.vSet.y = this.vel.y;
    this.vSet.z = this.vel.z;
  }

  /** Locomotion-family states: emote, grab, dive, jump, then movement. */
  private stepActive(
    input: CharacterInput,
    dirX: number,
    dirZ: number,
    mag: number,
    buttons: number,
    pressed: number,
    ctx: CharacterStepContext,
  ): void {
    const t = this.tuning;
    const g = this.pre;
    const dt = ctx.dt;
    const ext = this.ext;
    const frozen = this.frozen;

    // Emote: cancels on movement or action, otherwise stand still.
    if (this._state === CharacterState.Emote) {
      const cancel =
        mag > t.emoteCancelInput ||
        (pressed & (Button.Jump | Button.Dive)) !== 0 ||
        (buttons & Button.Grab) !== 0 ||
        this._stateTime >= t.emoteTime ||
        !g.grounded;
      if (cancel) this.setStateId(g.grounded ? CharacterState.Idle : CharacterState.Fall);
    } else if (
      input.emote >= 1 &&
      input.emote <= 4 &&
      g.grounded &&
      ext.grabKind === GrabKind.None &&
      (this._state === CharacterState.Idle ||
        this._state === CharacterState.Run ||
        this._state === CharacterState.Slime)
    ) {
      this.setStateId(CharacterState.Emote);
      this._emote = input.emote | 0;
      ctx.events.push({ type: 'emote', player: this.id, emote: this._emote });
    }
    if (this._state === CharacterState.Emote) {
      this.stepLocomotion(0, 0, 0, 1, dt);
      return;
    }

    // Grabs
    // Ghosts pass through players and props, so they cannot grab them either.
    const grabHeld = (buttons & Button.Grab) !== 0 && !frozen && (this.flags & CharacterFlag.Ghost) === 0;
    if (ext.grabKind === GrabKind.Player) {
      this.updateHoldPlayer(grabHeld, ctx);
    } else if (ext.grabKind === GrabKind.Prop) {
      this.updateCarry(grabHeld, ctx);
    }
    if (ext.grabKind === GrabKind.None && grabHeld && ext.grabCooldown <= 0 && this.grabStamina > 0.1) {
      if (!g.grounded && this.tryLedgeGrab(this.facingX(), this.facingZ(), ctx)) {
        ext.latches |= Latch.LedgeByButton;
        this.stepLedgeHang(0, 0, 0, buttons, 0, ctx);
        return;
      }
      this.tryGrabQuery(ctx);
    }

    // Dive
    if (pressed & Button.Dive && !frozen && ext.grabKind !== GrabKind.Player) {
      const airborne = !g.grounded && this.coyoteTimer <= 0;
      if (!(airborne && ext.latches & Latch.DiveUsed)) {
        if (ext.grabKind === GrabKind.Prop) this.dropProp('release', ctx);
        this.startDive(dirX, dirZ, mag, ctx);
        return;
      }
    }

    // Jump
    if (this.jumpBufferTimer > 0 && this.canJump() && ext.grabKind !== GrabKind.Player) {
      this.startJump(ctx);
    }

    // Auto ledge catch: falling into a grabbable wall while pushing toward it.
    if (
      t.autoLedgeGrab &&
      !g.grounded &&
      mag > 0.5 &&
      ext.grabKind === GrabKind.None &&
      ext.grabCooldown <= 0 &&
      this.tryLedgeGrab(dirX, dirZ, ctx)
    ) {
      ext.latches &= ~Latch.LedgeByButton;
      this.stepLedgeHang(0, 0, 0, buttons, 0, ctx);
      return;
    }

    let speedMul = 1;
    if (ext.grabKind === GrabKind.Player) speedMul = t.grabberSpeedMul;
    else if (ext.grabKind === GrabKind.Prop) speedMul = t.carrySpeedMul;
    else if (grabHeld) speedMul = t.reachSpeedMul;
    this.stepLocomotion(dirX, dirZ, mag, speedMul, dt);
  }

  private canJump(): boolean {
    return (this.pre.grounded || this.coyoteTimer > 0) && !this.frozenBlocksJump();
  }

  /** Frozen Tumblers may hop in place, but only from the ground. */
  private frozenBlocksJump(): boolean {
    return this.frozen && !this.pre.grounded;
  }

  // ---------------------------------------------------------------------------
  // Locomotion
  // ---------------------------------------------------------------------------

  /**
   * Velocity targeting for walking, running and air control.
   *
   * Planar velocity is handled relative to a reference frame: the support's
   * point velocity on the ground (platforms, conveyors), or decaying carried
   * momentum in the air, plus decaying external pushes. That makes riding,
   * jumping off platforms and wind all fall out of the same code.
   */
  private stepLocomotion(dirX: number, dirZ: number, mag: number, speedMul: number, dt: number): void {
    const t = this.tuning;
    const g = this.pre;
    const ext = this.ext;
    const grounded = g.grounded;
    const surf = this.surfaceTuning(g);

    let maxSpeed = t.maxSpeed * speedMul * (grounded ? surf.speedMul : 1);
    const refX = (grounded ? g.vx : ext.carryVel.x) + ext.extVel.x;
    const refZ = (grounded ? g.vz : ext.carryVel.z) + ext.extVel.z;

    let relX: number;
    let relZ: number;
    if (grounded) {
      this.tangentRel(refX, refZ);
      relX = this.tmp.x;
      relZ = this.tmp.z;
    } else {
      relX = this.vel.x - refX;
      relZ = this.vel.z - refZ;
    }
    const relSpeed = Math.hypot(relX, relZ);
    const hasInput = mag > 0;

    let targetSpeed = mag * maxSpeed;
    let rate: number;
    if (grounded) {
      if (hasInput) {
        const opposing = relX * dirX + relZ * dirZ < 0;
        rate = (opposing ? t.turnAccel : t.groundAccel) * surf.accelMul;
      } else {
        rate = t.groundDecel * surf.decelMul;
      }
      // Overspeed (landing from a bounce, slides): bleed it at the surface's decel rather than snapping to max.
      if (hasInput && relSpeed > targetSpeed && (relX * dirX + relZ * dirZ) / (relSpeed || 1) > 0.5) {
        targetSpeed = Math.max(targetSpeed, relSpeed - t.groundDecel * surf.decelMul * 0.5 * dt);
      }
    } else {
      rate = hasInput ? t.airAccel : t.airDecel;
      if (hasInput && relSpeed > targetSpeed) {
        targetSpeed = Math.max(targetSpeed, relSpeed - t.airOverspeedDrag * dt);
      }
    }
    if (ext.knockTimer > 0) rate *= t.knockControlMul;
    if (grounded && g.kind === 'slide') maxSpeed = t.slideSurfaceMaxSpeed;

    // moveToward on the planar relative velocity
    const dx = dirX * targetSpeed - relX;
    const dz = dirZ * targetSpeed - relZ;
    const dl = Math.hypot(dx, dz);
    const maxDelta = rate * dt;
    if (dl <= maxDelta) {
      relX += dx;
      relZ += dz;
    } else if (dl > 0) {
      relX += (dx / dl) * maxDelta;
      relZ += (dz / dl) * maxDelta;
    }

    if (grounded) {
      const slideAmount = surf.slopeSlide;
      if (slideAmount > 0) {
        this.addSlopeSlide(slideAmount, dt);
        relX += this.tmp2.x;
        relZ += this.tmp2.z;
      }
      if (g.kind === 'slide' || slideAmount > 0) {
        const s = Math.hypot(relX, relZ);
        const cap = g.kind === 'slide' ? maxSpeed : Math.max(maxSpeed, t.slideSurfaceMaxSpeed);
        if (s > cap) {
          relX *= cap / s;
          relZ *= cap / s;
        }
      }
      this.writeGrounded(relX, relZ, refX, refZ, hasInput ? dirX : 0, hasInput ? dirZ : 0, dt);
      this.applyWeight(dt);
    } else {
      this.vel.x = relX + refX;
      this.vel.z = relZ + refZ;
      this.blockSteepClimb();
    }

    // Facing
    if (hasInput) {
      const turn = (grounded ? t.turnSpeed * surf.turnMul : t.airTurnSpeed) * dt;
      this.turnFacingToward(Math.atan2(dirX, dirZ), turn);
    }
    if (grounded) this._facing += g.yawDelta;
  }

  /**
   * Converts the body's along-surface velocity back into a planar "intent"
   * vector (direction of travel, magnitude = speed along the slope), written
   * to `tmp`. Writing it back through {@link writeGrounded} is lossless, so
   * running uphill does not decay speed step after step.
   */
  private tangentRel(refX: number, refZ: number): void {
    const g = this.pre;
    let rx = this.vel.x - refX;
    let ry = this.vel.y - g.vy;
    let rz = this.vel.z - refZ;
    const dn = rx * g.nx + ry * g.ny + rz * g.nz;
    rx -= dn * g.nx;
    ry -= dn * g.ny;
    rz -= dn * g.nz;
    const tangent = Math.hypot(rx, ry, rz);
    const planar = Math.hypot(rx, rz);
    if (planar > 1e-6) {
      this.tmp.x = (rx / planar) * tangent;
      this.tmp.z = (rz / planar) * tangent;
    } else {
      this.tmp.x = 0;
      this.tmp.z = 0;
    }
  }

  /** Downhill acceleration for this step, written to `tmp2` (planar). */
  private addSlopeSlide(amount: number, dt: number): void {
    const g = this.pre;
    const h = Math.hypot(g.nx, g.nz);
    if (h < 1e-4) {
      this.tmp2.x = 0;
      this.tmp2.z = 0;
      return;
    }
    // |g|·sinθ along the fall line; sinθ = horizontal component of the unit normal.
    const a = -this.gravityY * h * amount * dt;
    this.tmp2.x = (g.nx / h) * a;
    this.tmp2.z = (g.nz / h) * a;
  }

  /**
   * Writes a grounded velocity: planar intent projected onto the ground plane
   * (speed preserved along the slope), plus support velocity, plus snap or step-up.
   */
  private writeGrounded(
    relX: number,
    relZ: number,
    refX: number,
    refZ: number,
    dirX: number,
    dirZ: number,
    dt: number,
  ): void {
    const g = this.pre;
    const planar = Math.hypot(relX, relZ);
    let ry = -(g.nx * relX + g.nz * relZ) / g.ny;
    let sx = relX;
    let sz = relZ;
    if (planar > 1e-6) {
      const scale = planar / Math.hypot(relX, ry, relZ);
      sx *= scale;
      sz *= scale;
      ry *= scale;
    }
    this.vel.x = sx + refX;
    this.vel.z = sz + refZ;
    this.vel.y = ry + g.vy;

    const rise = dirX !== 0 || dirZ !== 0 ? this.tryStepUp(dirX, dirZ) : 0;
    if (rise > 0) {
      // Pop onto the step (already headroom-checked). Velocity-based lifting fights snap-to-ground
      // because the probe still sees the lower floor until the body is over the lip.
      this.pos.x += dirX * STEP_FORWARD;
      this.pos.y += rise + STEP_CLEARANCE;
      this.pos.z += dirZ * STEP_FORWARD;
      this.body.setTranslation(this.pos, true);
      this.vel.y = g.vy;
    } else if (g.gap > 0.005) {
      this.vel.y -= Math.min(g.gap, this.tuning.snapDistance) / dt;
    }
  }

  /** Press our weight into dynamic supports so seesaws and tilt platforms react. */
  private applyWeight(dt: number): void {
    const g = this.pre;
    if (g.bodyKind !== BodyKind.Dynamic || !g.body) return;
    this.tA.x = 0;
    this.tA.y = this.tuning.mass * this.gravityY * dt;
    this.tA.z = 0;
    this.tB.x = g.px;
    this.tB.y = g.py;
    this.tB.z = g.pz;
    g.body.applyImpulseAtPoint(this.tA, this.tB, true);
  }

  /**
   * Airborne against a too-steep slope: remove the into-slope planar velocity so
   * the solver cannot convert it into an upward climb.
   */
  private blockSteepClimb(): void {
    const g = this.pre;
    if (!g.hit || !g.steep || g.gap > 0.08) return;
    const h = Math.hypot(g.nx, g.nz);
    if (h < 1e-4) return;
    const hx = g.nx / h;
    const hz = g.nz / h;
    const into = this.vel.x * hx + this.vel.z * hz;
    if (into < 0) {
      this.vel.x -= hx * into;
      this.vel.z -= hz * into;
    }
  }

  /**
   * Detects a low obstacle ahead that can be stepped onto.
   *
   * 1. Low horizontal ray finds a near-vertical face just ahead of the feet.
   * 2. Downward ray just past that face finds a walkable top.
   * 3. Capsule overlap at the raised position confirms headroom.
   *
   * @returns Height to rise (m), or 0 when there is no step.
   */
  private tryStepUp(dirX: number, dirZ: number): number {
    const t = this.tuning;
    const feetY = this.pos.y - t.halfHeight - t.radius;
    const ray = this.ray;
    ray.origin.x = this.pos.x;
    ray.origin.y = feetY + 0.06;
    ray.origin.z = this.pos.z;
    ray.dir.x = dirX;
    ray.dir.y = 0;
    ray.dir.z = dirZ;
    const wall = this.world.castRayAndGetNormal(
      ray,
      t.radius + 0.22,
      true,
      EXCLUDE_SENSORS,
      InteractionGroups.groundQuery,
      this.collider,
    );
    if (!wall || Math.abs(wall.normal.y) > WALL_NORMAL_Y) return 0;
    if (wall.normal.x * dirX + wall.normal.z * dirZ > -0.3) return 0;
    const hitX = ray.origin.x + dirX * wall.timeOfImpact;
    const hitZ = ray.origin.z + dirZ * wall.timeOfImpact;

    ray.origin.x = hitX + dirX * 0.08;
    ray.origin.y = feetY + t.stepHeight + 0.05;
    ray.origin.z = hitZ + dirZ * 0.08;
    ray.dir.x = 0;
    ray.dir.y = -1;
    ray.dir.z = 0;
    const top = this.world.castRayAndGetNormal(
      ray,
      t.stepHeight + 0.05,
      true,
      EXCLUDE_SENSORS,
      InteractionGroups.groundQuery,
      this.collider,
    );
    if (!top || top.timeOfImpact <= 0) return 0;
    if (top.normal.y < Math.cos((t.maxSlopeDeg * Math.PI) / 180)) return 0;
    const rise = ray.origin.y - top.timeOfImpact - feetY;
    if (rise <= 0.03 || rise > t.stepHeight) return 0;

    this.tA.x = this.pos.x + dirX * STEP_FORWARD;
    this.tA.y = this.pos.y + rise + STEP_CLEARANCE + 0.01;
    this.tA.z = this.pos.z + dirZ * STEP_FORWARD;
    const blocked = this.world.intersectionWithShape(
      this.tA,
      IDENTITY,
      this.headroom,
      EXCLUDE_SENSORS,
      InteractionGroups.groundQuery,
      this.collider,
    );
    return blocked ? 0 : rise;
  }

  private turnFacingToward(target: number, maxStep: number): void {
    const d = angleDelta(this._facing, target);
    this._facing += Math.abs(d) <= maxStep ? d : Math.sign(d) * maxStep;
    this._facing = wrapAngle(this._facing);
  }

  private facingX(): number {
    return Math.sin(this._facing);
  }

  private facingZ(): number {
    return Math.cos(this._facing);
  }

  private surfaceTuning(g: GroundProbe): SurfaceTuning {
    return this.tuning.surfaces[g.grounded ? g.kind : 'normal'] ?? this.tuning.surfaces.normal;
  }

  // ---------------------------------------------------------------------------
  // Jump & dive
  // ---------------------------------------------------------------------------

  private startJump(ctx: CharacterStepContext): void {
    const t = this.tuning;
    const g = this.pre;
    const ext = this.ext;
    if (g.grounded) {
      ext.carryVel.x = g.vx;
      ext.carryVel.z = g.vz;
    }
    const surf = this.surfaceTuning(g);
    const supportUp = g.grounded ? Math.max(0, g.vy) : 0;
    this.vel.y = supportUp + t.jumpSpeed * surf.jumpMul;
    this.jumpHeld = true;
    this.jumpBufferTimer = 0;
    this.coyoteTimer = 0;
    // The rest of this step must treat us as airborne, or grounded locomotion would cancel the launch.
    g.grounded = false;
    ext.latches &= ~Latch.DiveUsed;
    this.setStateId(CharacterState.Jump);
    ctx.events.push({ type: 'jump', player: this.id, pos: this.feetCopy() });
  }

  private startDive(dirX: number, dirZ: number, mag: number, ctx: CharacterStepContext): void {
    const t = this.tuning;
    const g = this.pre;
    const ext = this.ext;
    let dx = dirX;
    let dz = dirZ;
    if (mag <= 0.2) {
      dx = this.facingX();
      dz = this.facingZ();
    }
    const refX = (g.grounded ? g.vx : ext.carryVel.x) + ext.extVel.x;
    const refZ = (g.grounded ? g.vz : ext.carryVel.z) + ext.extVel.z;
    const relX = this.vel.x - refX;
    const relZ = this.vel.z - refZ;
    const forward = Math.max(0, relX * dx + relZ * dz);
    const speed = Math.min(Math.max(forward + t.diveBoost, t.diveSpeed), t.diveMaxSpeed);
    this.vel.x = refX + dx * speed;
    this.vel.z = refZ + dz * speed;
    if (g.grounded) {
      ext.carryVel.x = g.vx;
      ext.carryVel.z = g.vz;
      this.vel.y = Math.max(0, g.vy) + t.diveUpSpeed;
    } else {
      this.vel.y = clamp(this.vel.y + t.diveAirUpSpeed, t.diveAirUpSpeed * 0.55, t.diveAirUpSpeed + 1.5);
    }
    this._facing = Math.atan2(dx, dz);
    this.jumpHeld = false;
    this.jumpBufferTimer = 0;
    this.coyoteTimer = 0;
    ext.latches |= Latch.DiveUsed;
    this.setStateId(CharacterState.Dive);
    ctx.events.push({ type: 'dive', player: this.id, pos: this.feetCopy() });
  }

  private stepDive(dirX: number, dirZ: number, mag: number, dt: number): void {
    const t = this.tuning;
    const ext = this.ext;
    const refX = ext.carryVel.x + ext.extVel.x;
    const refZ = ext.carryVel.z + ext.extVel.z;
    let relX = this.vel.x - refX;
    let relZ = this.vel.z - refZ;
    const speed = Math.hypot(relX, relZ);
    if (mag > 0 && speed > 0.5) {
      // Committed dive: input only rotates the heading, slowly, never adds speed.
      const cur = Math.atan2(relX, relZ);
      const d = angleDelta(cur, Math.atan2(dirX, dirZ));
      const step = t.diveSteer * dt;
      const h = cur + (Math.abs(d) <= step ? d : Math.sign(d) * step);
      relX = Math.sin(h) * speed;
      relZ = Math.cos(h) * speed;
    }
    this.vel.x = relX + refX;
    this.vel.z = relZ + refZ;
    if (speed > 0.5) this._facing = Math.atan2(relX, relZ);
    this.blockSteepClimb();
  }

  private stepDiveSlide(dirX: number, dirZ: number, mag: number, dt: number): void {
    const t = this.tuning;
    const g = this.pre;
    if (!g.grounded) return;
    const surf = this.surfaceTuning(g);
    const refX = g.vx + this.ext.extVel.x;
    const refZ = g.vz + this.ext.extVel.z;
    this.tangentRel(refX, refZ);
    let relX = this.tmp.x;
    let relZ = this.tmp.z;
    let speed = Math.hypot(relX, relZ);
    if (speed > 1e-4) {
      let h = Math.atan2(relX, relZ);
      if (mag > 0) {
        const d = angleDelta(h, Math.atan2(dirX, dirZ));
        const step = t.slideSteer * dt;
        h += Math.abs(d) <= step ? d : Math.sign(d) * step;
      }
      speed = Math.max(0, speed - t.slideFriction * surf.decelMul * dt);
      relX = Math.sin(h) * speed;
      relZ = Math.cos(h) * speed;
    }
    // Belly slides always pick up some speed downhill.
    this.addSlopeSlide(Math.max(surf.slopeSlide, 0.5), dt);
    relX += this.tmp2.x;
    relZ += this.tmp2.z;
    this.writeGrounded(relX, relZ, refX, refZ, 0, 0, dt);
    if (Math.hypot(relX, relZ) > 0.5) this._facing = Math.atan2(relX, relZ);
    this._facing += g.yawDelta;
  }

  private stepGetUp(dt: number): void {
    const t = this.tuning;
    const g = this.pre;
    if (!g.grounded) return;
    const surf = this.surfaceTuning(g);
    const refX = g.vx + this.ext.extVel.x;
    const refZ = g.vz + this.ext.extVel.z;
    this.tangentRel(refX, refZ);
    let relX = this.tmp.x;
    let relZ = this.tmp.z;
    const speed = Math.hypot(relX, relZ);
    const next = Math.max(0, speed - t.groundDecel * 0.6 * surf.decelMul * dt);
    if (speed > 1e-6) {
      relX *= next / speed;
      relZ *= next / speed;
    }
    if (surf.slopeSlide > 0) {
      this.addSlopeSlide(surf.slopeSlide, dt);
      relX += this.tmp2.x;
      relZ += this.tmp2.z;
    }
    this.writeGrounded(relX, relZ, refX, refZ, 0, 0, dt);
    this._facing += g.yawDelta;
  }

  // ---------------------------------------------------------------------------
  // Stun / tumble
  // ---------------------------------------------------------------------------

  private stepStunned(dt: number): void {
    const t = this.tuning;
    this.stunTimer = Math.max(0, this.stunTimer - dt);
    if (this.stunTimer > t.stunRecoverTime) return;

    // Recovery: rotations are locked again (see applyBodyMode); ease back upright.
    this.applyBodyMode(false);
    this.body.rotation(this.qA);
    const yaw = yawFromQuat(this.qA);
    quatFromYaw(yaw, this.qB);
    const remaining = Math.max(this.stunTimer, dt);
    quatSlerp(this.qA, this.qB, Math.min(1, dt / remaining), this.rot);
    this.body.setRotation(this.rot, true);
    this.body.setAngvel(ZERO, true);
    this._facing = yaw;
    // Lying down puts the centre below standing height; lift smoothly instead of letting the solver pop us.
    const g = this.pre;
    if (g.hit && g.gap < 0) this.vel.y = Math.max(this.vel.y, Math.min(-g.gap / remaining, 8));

    if (this.stunTimer <= 0) {
      quatFromYaw(yaw, this.rot);
      this.body.setRotation(this.rot, true);
      if (g.grounded || (g.hit && g.gap < this.tuning.snapDistance)) this.enterGetUp();
      else this.setStateId(CharacterState.Fall);
    }
  }

  private enterGetUp(): void {
    this.setStateId(CharacterState.GetUp);
    this.stepCtx?.events.push({ type: 'getUp', player: this.id });
  }

  private enterStun(strength: number, dirX: number, dirZ: number): void {
    const s = this._state;
    if (
      s === CharacterState.Finished ||
      s === CharacterState.Spectating ||
      s === CharacterState.Eliminated ||
      s === CharacterState.Respawning
    ) {
      return;
    }
    const t = this.tuning;
    const ctx = this.stepCtx;
    this.releaseAllGrabs(ctx, 'broken');
    const k = clamp(
      (strength - t.stunImpactThreshold) / Math.max(1e-3, t.stunMaxStrength - t.stunImpactThreshold),
      0,
      1,
    );
    this.stunTimer = t.stunMinTime + (t.stunMaxTime - t.stunMinTime) * k;
    this.jumpHeld = false;
    this.setStateId(CharacterState.Stunned);
    this.applyBodyMode(false);
    // Tumble about the axis perpendicular to the hit, so the Tumbler falls away from it.
    let ax = dirZ;
    let az = -dirX;
    const al = Math.hypot(ax, az);
    if (al < 1e-4) {
      ax = Math.cos(this._facing);
      az = -Math.sin(this._facing);
    } else {
      ax /= al;
      az /= al;
    }
    const spin = t.stunSpin * (0.6 + 0.4 * k);
    this.tA.x = ax * spin;
    this.tA.y = (k - 0.5) * 2;
    this.tA.z = az * spin;
    this.body.setAngvel(this.tA, true);
    this.body.translation(this.tB);
    ctx?.events.push({
      type: 'stun',
      player: this.id,
      pos: { x: this.tB.x, y: this.tB.y - t.halfHeight - t.radius, z: this.tB.z },
      strength,
    });
  }

  // ---------------------------------------------------------------------------
  // Grab: players & props
  // ---------------------------------------------------------------------------

  private tryGrabQuery(ctx: CharacterStepContext): void {
    const t = this.tuning;
    this.grabCenter.x = this.pos.x + this.facingX() * t.grabRange;
    this.grabCenter.y = this.pos.y + 0.1;
    this.grabCenter.z = this.pos.z + this.facingZ() * t.grabRange;
    this.grabBest = null;
    this.grabBestDist = Infinity;
    this.grabBestIsPlayer = false;
    this.world.intersectionsWithShape(
      this.grabCenter,
      IDENTITY,
      this.grabBall,
      this.onGrabCandidate,
      EXCLUDE_SENSORS,
      GRAB_QUERY_GROUPS,
      this.collider,
    );
    const best = this.grabBest as Collider | null;
    if (!best) return;
    if (this.grabBestIsPlayer) {
      const other = ctx.controllerByCollider(best.handle);
      if (other instanceof TumblerController) this.beginHoldPlayer(other, ctx);
    } else {
      const propId = ctx.propIdByCollider?.(best.handle);
      if (propId !== undefined) this.beginCarry(best, propId, ctx);
    }
  }

  /** Intersection callback: keeps the nearest valid target, ties broken by handle for determinism. */
  private considerGrabCandidate(c: Collider): boolean {
    const ctx = this.stepCtx;
    if (!ctx) return false;
    let isPlayer = false;
    const other = ctx.controllerByCollider(c.handle);
    if (other) {
      if (!(other instanceof TumblerController) || other === this || !other.canBeGrabbed(this.id))
        return true;
      isPlayer = true;
    } else if (ctx.propIdByCollider?.(c.handle) === undefined) {
      return true;
    }
    c.translation(this.tA);
    const d = Math.hypot(
      this.tA.x - this.grabCenter.x,
      this.tA.y - this.grabCenter.y,
      this.tA.z - this.grabCenter.z,
    );
    const best = this.grabBest;
    if (d < this.grabBestDist || (d === this.grabBestDist && best !== null && c.handle < best.handle)) {
      this.grabBest = c;
      this.grabBestDist = d;
      this.grabBestIsPlayer = isPlayer;
    }
    return true;
  }

  /** Whether `byId` may start holding this Tumbler. */
  private canBeGrabbed(byId: number): boolean {
    if (this.flags & CharacterFlag.Ghost) return false;
    if (this.ext.grabKind === GrabKind.Player && this.grabTarget === byId) return false;
    const s = this._state;
    return (
      s !== CharacterState.Grabbed &&
      s !== CharacterState.LedgeHang &&
      s !== CharacterState.LedgeClimb &&
      s !== CharacterState.Finished &&
      s !== CharacterState.Spectating &&
      s !== CharacterState.Eliminated &&
      s !== CharacterState.Respawning
    );
  }

  private beginHoldPlayer(other: TumblerController, ctx: CharacterStepContext): void {
    const ext = this.ext;
    ext.grabKind = GrabKind.Player;
    ext.partnerCollider = other.collider.handle;
    this.grabTarget = other.id;
    other.becomeGrabbed(this.id, this.collider.handle, ctx);
    this.setStateId(CharacterState.Grab);
    ctx.events.push({ type: 'grabStart', player: this.id, target: other.id, targetKind: 'player' });
  }

  /** Called by the grabber. Puts this Tumbler into Grabbed. */
  private becomeGrabbed(byId: number, byCollider: number, ctx: CharacterStepContext): void {
    if (this.ext.grabKind !== GrabKind.None) this.releaseAllGrabs(ctx, 'broken');
    this.ext.grabKind = GrabKind.Player;
    this.ext.partnerCollider = byCollider;
    this.ext.breakFree = 0;
    this.grabTarget = byId;
    this.jumpHeld = false;
    this.setStateId(CharacterState.Grabbed);
  }

  private updateHoldPlayer(grabHeld: boolean, ctx: CharacterStepContext): void {
    const t = this.tuning;
    const ext = this.ext;
    if (!grabHeld) {
      this.endHoldPlayer('release', ctx);
      return;
    }
    this.grabStamina = Math.max(0, this.grabStamina - ctx.dt / Math.max(0.1, t.grabStaminaTime));
    if (this.grabStamina <= 0) {
      this.endHoldPlayer('stamina', ctx);
      return;
    }
    const other = ctx.controllerByCollider(ext.partnerCollider);
    if (
      !(other instanceof TumblerController) ||
      other._state !== CharacterState.Grabbed ||
      other.grabTarget !== this.id
    ) {
      this.endHoldPlayer('broken', ctx);
      return;
    }
    // Soft distance constraint at the velocity level; the grabber is "heavier" so it drags.
    other.body.translation(this.tA);
    other.body.linvel(this.tB);
    let dx = this.tA.x - this.pos.x;
    let dz = this.tA.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-4) {
      dx /= dist;
      dz /= dist;
      this.turnFacingToward(Math.atan2(dx, dz), t.turnSpeed * 0.5 * ctx.dt);
    }
    if (dist > t.grabHoldDistance) {
      const closing = -Math.min((dist - t.grabHoldDistance) * t.grabPull, t.grabMaxPull);
      const rel = (this.tB.x - this.vel.x) * dx + (this.tB.z - this.vel.z) * dz;
      if (rel > closing) {
        const fix = closing - rel;
        this.tB.x += dx * fix * 0.8;
        this.tB.z += dz * fix * 0.8;
        other.body.setLinvel(this.tB, true);
        this.vel.x -= dx * fix * 0.2;
        this.vel.z -= dz * fix * 0.2;
      }
    }
  }

  private endHoldPlayer(reason: 'release' | 'broken' | 'stamina', ctx: CharacterStepContext | null): void {
    const ext = this.ext;
    const target = this.grabTarget;
    const other = ctx?.controllerByCollider(ext.partnerCollider);
    if (
      other instanceof TumblerController &&
      other._state === CharacterState.Grabbed &&
      other.grabTarget === this.id
    ) {
      other.releaseFromGrab();
    }
    ext.grabKind = GrabKind.None;
    ext.partnerCollider = -1;
    this.grabTarget = -1;
    ext.grabCooldown = this.tuning.grabCooldown;
    if (this._state === CharacterState.Grab)
      this.setStateId(this.pre.grounded ? CharacterState.Idle : CharacterState.Fall);
    ctx?.events.push({ type: 'grabEnd', player: this.id, target, reason });
  }

  /** Called on the held Tumbler when its grabber lets go. */
  private releaseFromGrab(): void {
    this.ext.grabKind = GrabKind.None;
    this.ext.partnerCollider = -1;
    this.ext.breakFree = 0;
    this.grabTarget = -1;
    this.ext.grabCooldown = this.tuning.grabCooldown;
    this.setStateId(this._grounded ? CharacterState.Idle : CharacterState.Fall);
  }

  private stepGrabbed(
    dirX: number,
    dirZ: number,
    mag: number,
    pressed: number,
    ctx: CharacterStepContext,
  ): void {
    const t = this.tuning;
    const ext = this.ext;
    const grabber = ctx.controllerByCollider(ext.partnerCollider);
    if (
      !(grabber instanceof TumblerController) ||
      grabber.ext.grabKind !== GrabKind.Player ||
      grabber.grabTarget !== this.id
    ) {
      this.releaseFromGrab();
      this.stepLocomotion(dirX, dirZ, mag, 1, ctx.dt);
      return;
    }
    ext.breakFree = Math.max(0, ext.breakFree - t.breakFreeDecay * ctx.dt);
    if (pressed & (Button.Jump | Button.Dive | Button.Grab)) ext.breakFree += 1;
    if (ext.breakFree >= t.breakFreeMashes) {
      // Break free with a little hop away from the grabber. The grabber notices next step and emits grabEnd.
      grabber.body.translation(this.tA);
      let ax = this.pos.x - this.tA.x;
      let az = this.pos.z - this.tA.z;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      this.releaseFromGrab();
      this.vel.x += ax * 4;
      this.vel.z += az * 4;
      this.vel.y = Math.max(this.vel.y, 4);
      this.setStateId(CharacterState.Jump);
      return;
    }
    this.jumpBufferTimer = 0;
    this.stepLocomotion(dirX, dirZ, mag, t.grabbedSpeedMul, ctx.dt);
  }

  private beginCarry(c: Collider, propId: number, ctx: CharacterStepContext): void {
    const ext = this.ext;
    ext.grabKind = GrabKind.Prop;
    ext.partnerCollider = c.handle;
    this.grabTarget = propId;
    this.flags |= CharacterFlag.Carrying;
    ctx.events.push({ type: 'grabStart', player: this.id, target: propId, targetKind: 'prop' });
    ctx.events.push({ type: 'propPickup', player: this.id, prop: propId });
  }

  private updateCarry(grabHeld: boolean, ctx: CharacterStepContext): void {
    const t = this.tuning;
    const ext = this.ext;
    const col = this.world.getCollider(ext.partnerCollider);
    const body = col?.parent();
    if (!grabHeld || !col || !body || !body.isDynamic()) {
      this.dropProp(grabHeld ? 'broken' : 'release', ctx);
      return;
    }
    // Spring the prop toward a hold point in front of the chest, matching our velocity.
    body.translation(this.tA);
    const hx = this.pos.x + this.facingX() * t.carryDistance;
    const hy = this.pos.y + t.carryHeight;
    const hz = this.pos.z + this.facingZ() * t.carryDistance;
    const k = 0.35 / ctx.dt;
    this.tB.x = this.vel.x + (hx - this.tA.x) * k;
    this.tB.y = this.vel.y + (hy - this.tA.y) * k - this.gravityY * ctx.dt;
    this.tB.z = this.vel.z + (hz - this.tA.z) * k;
    body.setLinvel(this.tB, true);
    body.angvel(this.tA);
    this.tA.x *= 0.8;
    this.tA.y *= 0.8;
    this.tA.z *= 0.8;
    body.setAngvel(this.tA, true);
  }

  private dropProp(reason: 'release' | 'broken' | 'stamina', ctx: CharacterStepContext | null): void {
    const ext = this.ext;
    const prop = this.grabTarget;
    ext.grabKind = GrabKind.None;
    ext.partnerCollider = -1;
    this.grabTarget = -1;
    this.flags &= ~CharacterFlag.Carrying;
    ext.grabCooldown = this.tuning.grabCooldown * 0.5;
    if (this._state === CharacterState.Carry)
      this.setStateId(this.pre.grounded ? CharacterState.Idle : CharacterState.Fall);
    ctx?.events.push({ type: 'propDrop', player: this.id, prop });
    ctx?.events.push({ type: 'grabEnd', player: this.id, target: prop, reason });
  }

  /** Ends whatever grab relationship exists (stun, teleport, fate). */
  private releaseAllGrabs(ctx: CharacterStepContext | null, reason: 'release' | 'broken'): void {
    const ext = this.ext;
    if (ext.grabKind === GrabKind.Player) {
      if (this._state === CharacterState.Grabbed) this.releaseFromGrab();
      else this.endHoldPlayer(reason, ctx);
    } else if (ext.grabKind === GrabKind.Prop) {
      this.dropProp(reason, ctx);
    } else if (ext.grabKind === GrabKind.Ledge) {
      this.endLedge(ctx);
    }
  }

  // ---------------------------------------------------------------------------
  // Ledges
  // ---------------------------------------------------------------------------

  /**
   * Looks for a grabbable ledge in direction (dx, dz).
   *
   * 1. Horizontal ray at hip height finds a near-vertical grabbable face.
   * 2. Downward ray just behind the face finds the ledge top.
   * 3. The top must be within hand reach of the body centre.
   */
  private tryLedgeGrab(dx: number, dz: number, ctx: CharacterStepContext): boolean {
    const t = this.tuning;
    const g = this.pre;
    if (this.vel.y - g.vy > t.ledgeMaxRiseSpeed) return false;
    const ray = this.ray;
    ray.origin.x = this.pos.x;
    ray.origin.y = this.pos.y + t.ledgeReachMin - 0.05;
    ray.origin.z = this.pos.z;
    ray.dir.x = dx;
    ray.dir.y = 0;
    ray.dir.z = dz;
    const wall = this.world.castRayAndGetNormal(
      ray,
      t.radius + t.ledgeProbe,
      true,
      EXCLUDE_SENSORS,
      WORLD_QUERY_GROUPS,
      this.collider,
    );
    if (!wall || Math.abs(wall.normal.y) > WALL_NORMAL_Y) return false;
    if (!ctx.surfaces.get(wall.collider.handle)?.grabbable) return false;
    let nx = wall.normal.x;
    let nz = wall.normal.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-4) return false;
    nx /= nl;
    nz /= nl;
    if (nx * dx + nz * dz > -0.4) return false;
    const hitX = ray.origin.x + dx * wall.timeOfImpact;
    const hitZ = ray.origin.z + dz * wall.timeOfImpact;

    const startY = this.pos.y + t.ledgeReachMax + 0.15;
    ray.origin.x = hitX - nx * 0.12;
    ray.origin.y = startY;
    ray.origin.z = hitZ - nz * 0.12;
    ray.dir.x = 0;
    ray.dir.y = -1;
    ray.dir.z = 0;
    const top = this.world.castRayAndGetNormal(
      ray,
      t.ledgeReachMax - t.ledgeReachMin + 0.15,
      true,
      EXCLUDE_SENSORS,
      WORLD_QUERY_GROUPS,
      this.collider,
    );
    if (!top || top.timeOfImpact <= 0 || top.normal.y < 0.75) return false;
    const topY = startY - top.timeOfImpact;
    const rel = topY - this.pos.y;
    if (rel < t.ledgeReachMin || rel > t.ledgeReachMax) return false;

    const ext = this.ext;
    ext.ledgePoint.x = hitX;
    ext.ledgePoint.y = topY;
    ext.ledgePoint.z = hitZ;
    ext.ledgeNormal.x = nx;
    ext.ledgeNormal.y = 0;
    ext.ledgeNormal.z = nz;
    ext.grabKind = GrabKind.Ledge;
    ext.partnerCollider = wall.collider.handle;
    this.grabTarget = wall.collider.handle;
    this._facing = Math.atan2(-nx, -nz);
    this.jumpHeld = false;
    this.ledgeHangPosition(this.tA);
    this.body.setTranslation(this.tA, true);
    this.pos.x = this.tA.x;
    this.pos.y = this.tA.y;
    this.pos.z = this.tA.z;
    this.setStateId(CharacterState.LedgeHang);
    ctx.events.push({
      type: 'grabStart',
      player: this.id,
      target: wall.collider.handle,
      targetKind: 'ledge',
    });
    return true;
  }

  private ledgeHangPosition(out: Vec3): Vec3 {
    const t = this.tuning;
    const e = this.ext;
    out.x = e.ledgePoint.x + e.ledgeNormal.x * (t.radius + 0.02);
    out.y = e.ledgePoint.y - t.ledgeHangOffset;
    out.z = e.ledgePoint.z + e.ledgeNormal.z * (t.radius + 0.02);
    return out;
  }

  private stepLedgeHang(
    dirX: number,
    dirZ: number,
    mag: number,
    buttons: number,
    pressed: number,
    ctx: CharacterStepContext,
  ): void {
    const ext = this.ext;
    this.vel.x = 0;
    this.vel.y = 0;
    this.vel.z = 0;
    const pullAway = mag > 0.5 && dirX * ext.ledgeNormal.x + dirZ * ext.ledgeNormal.z > 0.6;
    const released = (ext.latches & Latch.LedgeByButton) !== 0 && !(buttons & Button.Grab);
    if (pressed & Button.Jump) {
      this.jumpBufferTimer = 0;
      this.setStateId(CharacterState.LedgeClimb);
      ctx.events.push({ type: 'jump', player: this.id, pos: this.feetCopy() });
      this.stepLedgeClimb(ctx.dt);
      return;
    }
    if (pressed & Button.Dive || pullAway || released) {
      this.endLedge(ctx);
      this.setStateId(CharacterState.Fall);
      this.ext.grabCooldown = 0.35;
      this.vel.x = ext.ledgeNormal.x * 2;
      this.vel.z = ext.ledgeNormal.z * 2;
      return;
    }
    // Hold exactly at the hang point so solver jitter cannot accumulate.
    this.ledgeHangPosition(this.tA);
    this.vel.x = (this.tA.x - this.pos.x) / ctx.dt;
    this.vel.y = (this.tA.y - this.pos.y) / ctx.dt;
    this.vel.z = (this.tA.z - this.pos.z) / ctx.dt;
  }

  /** Scripted climb: rise beside the wall, then step forward over the lip. */
  private stepLedgeClimb(dt: number): void {
    const t = this.tuning;
    const e = this.ext;
    const tau = Math.min(1, (this._stateTime + dt) / Math.max(0.05, t.ledgeClimbTime));
    this.ledgeHangPosition(this.tA);
    const standY = e.ledgePoint.y + t.halfHeight + t.radius + 0.04;
    const endX = e.ledgePoint.x - e.ledgeNormal.x * (t.radius + 0.2);
    const endZ = e.ledgePoint.z - e.ledgeNormal.z * (t.radius + 0.2);
    const split = 0.55;
    let tx: number;
    let ty: number;
    let tz: number;
    if (tau < split) {
      const u = tau / split;
      const ease = 1 - (1 - u) * (1 - u);
      tx = this.tA.x;
      tz = this.tA.z;
      ty = this.tA.y + (standY - this.tA.y) * ease;
    } else {
      const u = (tau - split) / (1 - split);
      const ease = u * u * (3 - 2 * u);
      tx = this.tA.x + (endX - this.tA.x) * ease;
      tz = this.tA.z + (endZ - this.tA.z) * ease;
      ty = standY;
    }
    this.vel.x = (tx - this.pos.x) / dt;
    this.vel.y = (ty - this.pos.y) / dt;
    this.vel.z = (tz - this.pos.z) / dt;
  }

  private endLedge(ctx: CharacterStepContext | null): void {
    const ext = this.ext;
    const target = this.grabTarget;
    const wasLedge = ext.grabKind === GrabKind.Ledge;
    ext.grabKind = GrabKind.None;
    ext.partnerCollider = -1;
    ext.latches &= ~Latch.LedgeByButton;
    this.grabTarget = -1;
    if (wasLedge) ctx?.events.push({ type: 'grabEnd', player: this.id, target, reason: 'release' });
  }

  // ---------------------------------------------------------------------------
  // Post step (after world.step)
  // ---------------------------------------------------------------------------

  /** Ground detection, impacts, state transitions and events. Call after `world.step()`. */
  postStep(ctx: CharacterStepContext): void {
    if (!this.appliedEnabled) return;
    const t = this.tuning;
    const dt = ctx.dt;
    const ext = this.ext;
    this.stepCtx = ctx;
    this.body.translation(this.pos);
    this.body.linvel(this.vel);

    this.scanContacts(ctx);

    this.probeGround(this.post, false);
    const g = this.post;
    const wasGrounded = this._grounded;
    let grounded = this.evalGrounded(g, wasGrounded);
    if (this._state === CharacterState.LedgeHang || this._state === CharacterState.LedgeClimb)
      grounded = false;

    // Bounce pads under our feet
    const bouncy =
      grounded && g.info !== undefined && (g.info.kind === 'bouncy' || (g.info.bounceImpulse ?? 0) > 0);
    if (bouncy && ext.bounceCooldown <= 0 && g.walkable) {
      const pad = g.info?.bounceVelocity;
      if (pad) {
        this.setPadLaunch(pad);
      } else {
        const speed = g.info?.bounceImpulse ?? t.bounceSpeed;
        this.vel.x += g.nx * speed;
        this.vel.y = g.vy + g.ny * speed;
        this.vel.z += g.nz * speed;
        this.body.setLinvel(this.vel, true);
      }
      ext.carryVel.x = g.vx;
      ext.carryVel.z = g.vz;
      grounded = false;
      this.enterBounce(g.info?.ownerId, ctx);
    }

    if (grounded) {
      this.coyoteTimer = t.coyoteTime;
      ext.latches &= ~Latch.DiveUsed;
      if (this.preSupportHandle === g.handle) {
        ext.carryVel.x = g.vx;
        ext.carryVel.z = g.vz;
      }
    } else if (!wasGrounded) {
      // The step we walk off a ledge keeps the full window; it counts down from the next one.
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }

    const justLanded = grounded && !wasGrounded;
    if (justLanded) {
      const impact = Math.max(0, g.vy - this.vSet.y);
      ctx.events.push({ type: 'land', player: this.id, pos: this.feetCopy(), impact });
    }
    this._grounded = grounded;
    // Computed before transitions read it; a value carried over from the last step would not survive a rewind.
    this.debug.planarSpeed = Math.hypot(
      this.vel.x - (grounded ? g.vx : 0),
      this.vel.z - (grounded ? g.vz : 0),
    );
    this.updateStateAfterStep(grounded, justLanded);

    // Flags and debug readout
    let f = this.flags & ~(CharacterFlag.OnIce | CharacterFlag.InSlime);
    if (grounded && g.kind === 'ice') f |= CharacterFlag.OnIce;
    if (grounded && (g.kind === 'slime' || g.kind === 'sticky')) f |= CharacterFlag.InSlime;
    this.flags = f;
    const d = this.debug;
    d.gap = g.gap;
    d.groundNormal.x = g.nx;
    d.groundNormal.y = g.ny;
    d.groundNormal.z = g.nz;
    d.supportVel.x = g.vx;
    d.supportVel.y = g.vy;
    d.supportVel.z = g.vz;
    d.surface = grounded ? g.kind : 'air';

    this._stateTime += dt;
  }

  private updateStateAfterStep(grounded: boolean, justLanded: boolean): void {
    const t = this.tuning;
    const s = this._state;
    const g = this.post;
    switch (s) {
      case CharacterState.Dive:
        if (grounded && this._stateTime > 0.05) this.setStateId(CharacterState.DiveSlide);
        return;
      case CharacterState.DiveSlide: {
        if (!grounded && this.coyoteTimer <= 0) {
          this.setStateId(CharacterState.Dive);
          return;
        }
        const surf = this.tuning.surfaces[g.kind] ?? this.tuning.surfaces.normal;
        const maxTime = t.slideMaxTime / Math.max(0.25, Math.min(1, surf.decelMul));
        const speed = this.debug.planarSpeed;
        if ((this._stateTime >= t.slideMinTime && speed < t.slideStopSpeed) || this._stateTime >= maxTime) {
          this.enterGetUp();
        }
        return;
      }
      case CharacterState.GetUp:
        if (this._stateTime >= t.getUpTime)
          this.setStateId(grounded ? CharacterState.Idle : CharacterState.Fall);
        return;
      case CharacterState.LedgeClimb:
        if (this._stateTime + this.stepDt() >= t.ledgeClimbTime) {
          this.endLedge(this.stepCtx);
          this.setStateId(CharacterState.Idle);
          this.vel.x = 0;
          this.vel.z = 0;
          this.vel.y = Math.min(this.vel.y, 0);
          this.body.setLinvel(this.vel, true);
        }
        return;
      case CharacterState.Stunned:
      case CharacterState.LedgeHang:
      case CharacterState.Respawning:
      case CharacterState.Finished:
      case CharacterState.Spectating:
      case CharacterState.Eliminated:
        return;
      case CharacterState.Grabbed:
        return;
      case CharacterState.Emote:
        if (!grounded) this.setStateId(CharacterState.Fall);
        return;
      default:
        break;
    }
    if (!isLocomotion(s)) return;

    const ext = this.ext;
    if (grounded) {
      if (s === CharacterState.Bounce && !justLanded && this._stateTime < 0.1) return;
      let next: CharacterStateId;
      if (ext.grabKind === GrabKind.Player) next = CharacterState.Grab;
      else if (ext.grabKind === GrabKind.Prop) next = CharacterState.Carry;
      else if (this.prevButtons & Button.Grab && !this.frozen) next = CharacterState.Grab;
      else if (g.kind === 'slime' || g.kind === 'sticky') next = CharacterState.Slime;
      else next = this.debug.planarSpeed > t.runThreshold ? CharacterState.Run : CharacterState.Idle;
      this.setStateId(next);
    } else {
      if (ext.grabKind === GrabKind.Player) {
        this.setStateId(CharacterState.Grab);
        return;
      }
      if ((s === CharacterState.Jump || s === CharacterState.Bounce) && this.vel.y > 0) return;
      if (!AIR_DISPLAY_STATES.has(s) || this.vel.y <= 0) this.setStateId(CharacterState.Fall);
    }
  }

  private stepDt(): number {
    return this.stepCtx?.dt ?? 1 / 60;
  }

  /**
   * Walks every touching collider to find stun impacts, hazards, bumpers and
   * dive tackles. Only moving obstacles and other Tumblers can stun: running
   * into a static wall or landing never does.
   */
  private scanContacts(ctx: CharacterStepContext): void {
    const t = this.tuning;
    this.contactImpact = 0;
    this.contactHazard = false;
    this.contactBumper = 0;
    this.contactBumperOwner = undefined;
    this.contactPad = undefined;
    this.contactTackle = 0;
    this.contactCrush = false;
    this.world.contactPairsWith(this.collider, this.onContactPair);
    this.contactOther = null;
    this.debug.lastImpact = Math.max(this.contactImpact, this.contactTackle);

    const s = this._state;
    const immune =
      s === CharacterState.Stunned ||
      s === CharacterState.Finished ||
      s === CharacterState.Respawning ||
      s === CharacterState.LedgeClimb;

    if (!immune) {
      if (this.contactHazard) {
        this.enterStun(t.hazardStunStrength, this.contactImpactDir.x, this.contactImpactDir.z);
      } else if (this.contactImpact > t.stunImpactThreshold) {
        this.enterStun(this.contactImpact, this.contactImpactDir.x, this.contactImpactDir.z);
      } else if (this.contactTackle > 0) {
        const d = this.contactTackleDir;
        this.vel.x += d.x * this.contactTackle * 0.5;
        this.vel.z += d.z * this.contactTackle * 0.5;
        this.vel.y = Math.max(this.vel.y, 2.5);
        this.body.setLinvel(this.vel, true);
        this.enterStun(t.stunImpactThreshold + this.contactTackle, d.x, d.z);
      }
    }

    if (this.contactCrush && s !== CharacterState.Finished && s !== CharacterState.Respawning) {
      // Squashed between a moving obstacle and the ground: the solver cannot resolve that, so
      // squirt out sideways every step until free. No stun: tumble friction would pin us in place.
      const d = this.contactCrushDir;
      this.vel.x = d.x * CRUSH_ESCAPE_SPEED;
      this.vel.z = d.z * CRUSH_ESCAPE_SPEED;
      this.body.setLinvel(this.vel, true);
      this.ext.knockTimer = t.knockControlTime;
    }

    // Set from the contact-pair callback above, which TS control flow cannot see.
    const pad = this.contactPad as SurfaceInfo | undefined;
    if (
      pad?.bounceVelocity &&
      this.ext.bounceCooldown <= 0 &&
      s !== CharacterState.Finished &&
      s !== CharacterState.Respawning
    ) {
      // Tilted pad top: too steep for the ground probe, but still a landing on the pad face.
      this.setPadLaunch(pad.bounceVelocity);
      this.enterBounce(pad.ownerId, ctx);
    } else if (this.contactBumper > 0 && this.ext.bounceCooldown <= 0) {
      const d = this.contactBumperDir;
      const into = this.vel.x * d.x + this.vel.y * d.y + this.vel.z * d.z;
      const add = this.contactBumper - Math.min(0, into);
      this.vel.x += d.x * add;
      this.vel.y += d.y * add;
      this.vel.z += d.z * add;
      this.body.setLinvel(this.vel, true);
      this.ext.bounceCooldown = t.bounceCooldown;
      this.ext.knockTimer = t.knockControlTime;
      ctx.events.push({
        type: 'bounce',
        player: this.id,
        pos: this.feetCopy(),
        obstacle: this.contactBumperOwner,
      });
    }
  }

  private handleManifold(m: TempContactManifold, flipped: boolean): void {
    const other = this.contactOther;
    const ctx = this.stepCtx;
    if (!other || !ctx || m.numContacts() === 0) return;
    let touching = false;
    for (let i = 0, n = m.numContacts(); i < n; i++) {
      if (m.contactDist(i) < 0.02) {
        touching = true;
        break;
      }
    }
    if (!touching) return;
    const n = m.normal(this.normalScratch);
    // The manifold normal points from collider1 to collider2; we want the push direction onto us.
    const sgn = flipped ? 1 : -1;
    const nx = n.x * sgn;
    const ny = n.y * sgn;
    const nz = n.z * sgn;
    const info = ctx.surfaces.get(other.handle);
    if (info?.stunOnTouch) {
      this.contactHazard = true;
      this.contactImpactDir.x = nx;
      this.contactImpactDir.y = ny;
      this.contactImpactDir.z = nz;
    }
    // Floors are handled by the ground probe; only walls and ceilings count as bumpers and impacts.
    if (ny >= 0.7) return;
    if (info?.bounceVelocity) {
      const up = info.bounceUp;
      const facing = up ? nx * up.x + ny * up.y + nz * up.z : ny;
      if (facing >= PAD_TOP_DOT) {
        this.contactPad = info;
      } else {
        // Pad rim or side: launching here would fire the authored vertical launch sideways at full
        // speed and fling climbers off the level, so it is only a soft nudge away from the pad.
        const h = Math.hypot(nx, nz);
        if (h > 1e-3 && PAD_SIDE_BUMP > this.contactBumper) {
          this.contactBumper = PAD_SIDE_BUMP;
          this.contactBumperDir.x = nx / h;
          this.contactBumperDir.y = 0;
          this.contactBumperDir.z = nz / h;
          this.contactBumperOwner = info.ownerId;
        }
      }
    } else if (info && (info.kind === 'bouncy' || (info.bounceImpulse ?? 0) > 0)) {
      const imp = info.bounceImpulse ?? this.tuning.bounceSpeed * 0.75;
      if (imp > this.contactBumper) {
        this.contactBumper = imp;
        this.contactBumperDir.x = nx;
        this.contactBumperDir.y = ny;
        this.contactBumperDir.z = nz;
        this.contactBumperOwner = info.ownerId;
      }
    }
    const parent = other.parent();
    if (parent && parent.isKinematic() && ny < -0.6 && (this.pre.grounded || this.pre.gap < 0.1)) {
      parent.translation(this.tA);
      let dx = this.pos.x - this.tA.x;
      let dz = this.pos.z - this.tA.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) {
        dx = -Math.sin(this._facing);
        dz = -Math.cos(this._facing);
      } else {
        dx /= l;
        dz /= l;
      }
      this.contactCrush = true;
      this.contactCrushDir.x = dx;
      this.contactCrushDir.y = 0;
      this.contactCrushDir.z = dz;
    }
    if (parent && parent.isKinematic()) {
      // Pushed hard by a moving obstacle: both the outgoing speed and the change must be large,
      // so standing still against a slow pusher never stuns.
      const out = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
      const dv =
        (this.vel.x - this.vSet.x) * nx + (this.vel.y - this.vSet.y) * ny + (this.vel.z - this.vSet.z) * nz;
      const impact = Math.min(out, dv);
      if (impact > this.contactImpact) {
        this.contactImpact = impact;
        this.contactImpactDir.x = nx;
        this.contactImpactDir.y = ny;
        this.contactImpactDir.z = nz;
      }
    } else if (parent && parent.isDynamic()) {
      const ctrl = ctx.controllerByCollider(other.handle);
      if (ctrl && (ctrl.state === CharacterState.Dive || ctrl.state === CharacterState.DiveSlide)) {
        const dv = (this.vel.x - this.vSet.x) * nx + (this.vel.z - this.vSet.z) * nz;
        if (dv > this.tuning.diveHitThreshold && dv > this.contactTackle) {
          this.contactTackle = dv;
          const h = Math.hypot(nx, nz) || 1;
          this.contactTackleDir.x = nx / h;
          this.contactTackleDir.y = 0;
          this.contactTackleDir.z = nz / h;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Ground probe
  // ---------------------------------------------------------------------------

  /**
   * Shape-casts a ball down from the lower hemisphere and fills `out` with the
   * hit, gap, normal, support velocity and surface.
   *
   * @param pre - True before `world.step` (kinematic support velocity comes from
   *   the pose delta about to be applied); false after (re-uses the pre-step
   *   support velocity when the support is unchanged).
   */
  private probeGround(out: GroundProbe, pre: boolean): void {
    const t = this.tuning;
    const ctx = this.stepCtx;
    const reach = PROBE_LIFT + PROBE_INSET + Math.max(t.snapDistance, t.stepHeight) + 0.1;
    this.tA.x = this.pos.x;
    this.tA.y = this.pos.y - t.halfHeight + PROBE_LIFT;
    this.tA.z = this.pos.z;
    const excludeBody =
      this.ext.grabKind === GrabKind.Prop
        ? (this.world.getCollider(this.ext.partnerCollider)?.parent() ?? undefined)
        : undefined;
    const hit = this.world.castShape(
      this.tA,
      IDENTITY,
      DOWN,
      this.probeBall,
      0,
      reach,
      false,
      EXCLUDE_SENSORS,
      // Ghosts fall through props physically, so they must not stand on them either.
      this.flags & CharacterFlag.Ghost ? WORLD_QUERY_GROUPS : InteractionGroups.groundQuery,
      this.collider,
      excludeBody,
    );
    if (!hit) {
      out.hit = false;
      out.handle = -1;
      out.gap = Infinity;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.walkable = false;
      out.steep = false;
      out.vx = out.vy = out.vz = 0;
      out.yawDelta = 0;
      out.bodyKind = BodyKind.None;
      out.body = null;
      out.kind = 'normal';
      out.info = undefined;
      out.grounded = false;
      return;
    }
    const c = hit.collider;
    out.hit = true;
    out.handle = c.handle;
    out.gap = hit.time_of_impact - PROBE_LIFT - (t.radius - this.probeBallRadius);
    const nl = Math.hypot(hit.normal1.x, hit.normal1.y, hit.normal1.z) || 1;
    out.nx = hit.normal1.x / nl;
    out.ny = hit.normal1.y / nl;
    out.nz = hit.normal1.z / nl;
    out.px = hit.witness1.x;
    out.py = hit.witness1.y;
    out.pz = hit.witness1.z;
    const cosLimit = Math.cos((t.maxSlopeDeg * Math.PI) / 180);
    out.walkable = out.ny >= cosLimit;
    out.steep = !out.walkable && out.ny > 0.05;
    out.info = ctx?.surfaces.get(c.handle);
    out.kind = out.info?.kind ?? 'normal';

    const body = c.parent();
    out.body = body;
    out.vx = out.vy = out.vz = 0;
    out.yawDelta = 0;
    if (!body || body.isFixed()) {
      out.bodyKind = BodyKind.Fixed;
    } else if (body.isKinematic()) {
      out.bodyKind = BodyKind.Kinematic;
      if (pre) {
        this.kinematicPointVelocity(body, out);
      } else if (this.preSupportHandle === c.handle) {
        out.vx = this.pre.vx;
        out.vy = this.pre.vy;
        out.vz = this.pre.vz;
        out.yawDelta = this.pre.yawDelta;
      }
    } else {
      out.bodyKind = BodyKind.Dynamic;
      this.tB.x = out.px;
      this.tB.y = out.py;
      this.tB.z = out.pz;
      body.velocityAtPoint(this.tB, this.tmp2);
      out.vx = this.tmp2.x;
      out.vy = this.tmp2.y;
      out.vz = this.tmp2.z;
      body.angvel(this.tmp2);
      out.yawDelta = this.tmp2.y * (ctx?.dt ?? 1 / 60);
    }
    const belt = out.info?.conveyorVelocity;
    if (belt) {
      out.vx += belt.x;
      out.vy += belt.y;
      out.vz += belt.z;
    }
  }

  /**
   * Exact velocity of the support point over the coming step, from the
   * kinematic body's current pose to the next pose its owner already set. Using
   * the true rotation (not ω×r) means Tumblers on spinning discs never drift outward.
   */
  private kinematicPointVelocity(body: RigidBody, out: GroundProbe): void {
    const dt = this.stepCtx?.dt ?? 1 / 60;
    body.translation(this.tA);
    body.rotation(this.qA);
    body.nextTranslation(this.tB);
    body.nextRotation(this.qB);
    // Point relative to the current pose, in body-local space: conj(qA) * (p - tA)
    const lx = this.pos.x - this.tA.x;
    const ly = out.py - this.tA.y;
    const lz = this.pos.z - this.tA.z;
    invRotate(this.qA, lx, ly, lz, this.tmp2);
    rotate(this.qB, this.tmp2.x, this.tmp2.y, this.tmp2.z, this.tmp2);
    out.vx = (this.tmp2.x + this.tB.x - this.pos.x) / dt;
    out.vy = (this.tmp2.y + this.tB.y - out.py) / dt;
    out.vz = (this.tmp2.z + this.tB.z - this.pos.z) / dt;
    // Yaw of the delta rotation qB * conj(qA)
    const ax = -this.qA.x;
    const ay = -this.qA.y;
    const az = -this.qA.z;
    const aw = this.qA.w;
    const b = this.qB;
    const dx = b.w * ax + b.x * aw + b.y * az - b.z * ay;
    const dy = b.w * ay - b.x * az + b.y * aw + b.z * ax;
    const dz = b.w * az + b.x * ay - b.y * ax + b.z * aw;
    const dw = b.w * aw - b.x * ax - b.y * ay - b.z * az;
    this.qB.x = dx;
    this.qB.y = dy;
    this.qB.z = dz;
    this.qB.w = dw;
    out.yawDelta = yawFromQuat(this.qB);
  }

  private evalGrounded(g: GroundProbe, wasGrounded: boolean): boolean {
    if (!g.hit || !g.walkable) return false;
    const s = this._state;
    if (s === CharacterState.LedgeHang || s === CharacterState.LedgeClimb) return false;
    const relVy = this.vel.y - g.vy;
    if (relVy > LEAVE_GROUND_SPEED) return false;
    if (this.ext.extVel.y > 1.5) return false;
    if (g.gap <= this.tuning.groundEpsilon) return true;
    return wasGrounded && g.gap <= this.tuning.snapDistance && relVy <= 0.5 && s !== CharacterState.Stunned;
  }

  // ---------------------------------------------------------------------------
  // Body configuration
  // ---------------------------------------------------------------------------

  private isUpright(): boolean {
    return this._state !== CharacterState.Stunned;
  }

  private applyGravityScale(): void {
    const t = this.tuning;
    const s = this._state;
    let scale: number;
    if (
      s === CharacterState.LedgeHang ||
      s === CharacterState.LedgeClimb ||
      s === CharacterState.Respawning ||
      (this.pre.grounded &&
        s !== CharacterState.Stunned &&
        s !== CharacterState.Jump &&
        s !== CharacterState.Dive &&
        s !== CharacterState.Bounce)
    ) {
      scale = 0;
    } else if (s === CharacterState.Dive) {
      scale = t.diveGravityScale;
    } else if (s === CharacterState.Stunned) {
      scale = 1;
    } else {
      const vy = this.vel.y;
      // Early jump release is handled by cutting velocity, so any rise (jump, bounce, knock) uses rise gravity.
      if (this.jumpHeld && Math.abs(vy) < t.apexThreshold) scale = t.apexGravityScale;
      else scale = vy > 0 ? t.riseGravityScale : t.fallGravityScale;
    }
    if (this.body.gravityScale() !== scale) this.body.setGravityScale(scale, true);
  }

  /**
   * Brings rotation lock, friction, collision groups and enabled flag in line
   * with the logical state.
   *
   * With `force` (restore paths) the cached values are re-read from the body
   * rather than blindly re-applied: touching groups/enabled/friction on a
   * restored world makes Rapier rebuild contact pairs and drop the solver's
   * warm-start cache, which breaks bit-exact replay.
   */
  private applyBodyMode(force: boolean): void {
    const s = this._state;
    const t = this.tuning;
    if (force) {
      this.appliedFriction = this.collider.friction();
      this.appliedGroups = this.collider.collisionGroups();
      this.appliedEnabled = this.body.isEnabled();
    }
    const tumbling = s === CharacterState.Stunned && this.stunTimer > t.stunRecoverTime;
    const rotLocked = !tumbling;
    if (force || rotLocked !== this.appliedRotLocked) {
      this.body.lockRotations(rotLocked, true);
      this.appliedRotLocked = rotLocked;
    }
    const friction = tumbling ? t.stunFriction : 0;
    if (friction !== this.appliedFriction) {
      this.collider.setFriction(friction);
      this.collider.setFrictionCombineRule(
        tumbling ? this.R.CoefficientCombineRule.Average : this.R.CoefficientCombineRule.Min,
      );
      this.appliedFriction = friction;
    }
    const ghost = (this.flags & CharacterFlag.Ghost) !== 0;
    const grp = ghost ? InteractionGroups.playerGhost : InteractionGroups.player;
    if (grp !== this.appliedGroups) {
      this.collider.setCollisionGroups(grp);
      this.appliedGroups = grp;
    }
    const enabled = s !== CharacterState.Spectating && s !== CharacterState.Eliminated;
    if (enabled !== this.appliedEnabled) {
      this.body.setEnabled(enabled);
      this.appliedEnabled = enabled;
    }
  }

  private syncGhostFlag(): void {
    const ghost = this.ghostTimer > 0 || (this.ext.latches & Latch.GhostLocked) !== 0;
    if (ghost) this.flags |= CharacterFlag.Ghost;
    else this.flags &= ~CharacterFlag.Ghost;
    this.applyBodyMode(false);
  }

  private setStateId(s: CharacterStateId): void {
    if (s === this._state) return;
    const prev = this._state;
    this._state = s;
    this._stateTime = 0;
    if (prev === CharacterState.Emote) this._emote = 0;
    if (prev === CharacterState.Stunned || s === CharacterState.Stunned) this.applyBodyMode(false);
  }

  /** Recreates query shapes when tuning radii change in the debug panel. */
  private refreshShapes(): void {
    const t = this.tuning;
    const pr = t.radius - PROBE_INSET;
    if (pr !== this.probeBallRadius) {
      this.probeBallRadius = pr;
      this.probeBall = new this.R.Ball(pr);
    }
    if (t.grabRadius !== this.grabBallRadius) {
      this.grabBallRadius = t.grabRadius;
      this.grabBall = new this.R.Ball(t.grabRadius);
    }
  }

  /**
   * Leaves a bounce pad with exactly its authored velocity. The change is also
   * booked as an external push, the same way the pad module applies it, so air
   * control does not immediately fight the launch's horizontal component and
   * the pad's own (later) launch call sees nothing left to add.
   */
  private setPadLaunch(v: Vec3): void {
    const e = this.ext.extVel;
    e.x += v.x - this.vel.x;
    e.y += v.y - this.vel.y;
    e.z += v.z - this.vel.z;
    this.vel.x = v.x;
    this.vel.y = v.y;
    this.vel.z = v.z;
    this.body.setLinvel(this.vel, true);
  }

  /** State bookkeeping shared by every launch off a bouncy surface. */
  private enterBounce(owner: string | undefined, ctx: CharacterStepContext): void {
    const ext = this.ext;
    ext.bounceCooldown = this.tuning.bounceCooldown;
    ext.latches &= ~Latch.DiveUsed;
    this.jumpHeld = false;
    this.coyoteTimer = 0;
    if (this._state !== CharacterState.Stunned) {
      if (ext.grabKind === GrabKind.Player && this._state !== CharacterState.Grabbed)
        this.endHoldPlayer('broken', ctx);
      if (this._state !== CharacterState.Grabbed) this.setStateId(CharacterState.Bounce);
    }
    ctx.events.push({ type: 'bounce', player: this.id, pos: this.feetCopy(), obstacle: owner });
  }

  private feetCopy(): Vec3 {
    this.body.translation(this.tB);
    return { x: this.tB.x, y: this.tB.y - this.tuning.halfHeight - this.tuning.radius, z: this.tB.z };
  }

  // ---------------------------------------------------------------------------
  // External API
  // ---------------------------------------------------------------------------

  /**
   * Knockback. `impulse` is a velocity change (m/s), independent of mass, so
   * obstacle authors can reason in speeds.
   */
  knock(impulse: Vec3, stun: boolean): void {
    if (!this.appliedEnabled) return;
    const s = this._state;
    if (s === CharacterState.Finished || s === CharacterState.Respawning) return;
    this.body.linvel(this.vel);
    this.vel.x += impulse.x;
    this.vel.y += impulse.y;
    this.vel.z += impulse.z;
    this.body.setLinvel(this.vel, true);
    const mag = Math.hypot(impulse.x, impulse.y, impulse.z);
    if (s === CharacterState.LedgeHang || s === CharacterState.LedgeClimb) {
      this.endLedge(this.stepCtx);
      this.setStateId(CharacterState.Fall);
    }
    if (stun || mag >= this.tuning.knockStunThreshold) {
      if (s !== CharacterState.Stunned) {
        const h = Math.hypot(impulse.x, impulse.z) || 1;
        this.enterStun(Math.max(mag, this.tuning.stunImpactThreshold), impulse.x / h, impulse.z / h);
      }
    } else {
      this.ext.knockTimer = this.tuning.knockControlTime;
    }
  }

  /** Adds a velocity change (fans, wind). Accumulates into a decaying push the controller does not fight. */
  push(deltaVelocity: Vec3): void {
    if (!this.appliedEnabled) return;
    const e = this.ext.extVel;
    e.x += deltaVelocity.x;
    e.y += deltaVelocity.y;
    e.z += deltaVelocity.z;
    this.body.linvel(this.vel);
    this.vel.x += deltaVelocity.x;
    this.vel.y += deltaVelocity.y;
    this.vel.z += deltaVelocity.z;
    this.body.setLinvel(this.vel, true);
  }

  /**
   * Moves the Tumbler to a FEET position, upright, at rest, in Fall. Ends grabs,
   * stun and emotes. Frozen and ghost settings are kept.
   */
  teleport(pos: Vec3, yaw?: number): void {
    const t = this.tuning;
    this.releaseAllGrabs(this.stepCtx, 'release');
    if (yaw !== undefined) this._facing = yaw;
    this.tA.x = pos.x;
    this.tA.y = pos.y + t.halfHeight + t.radius;
    this.tA.z = pos.z;
    this.body.setTranslation(this.tA, true);
    this.body.setRotation(quatFromYaw(this._facing, this.rot), true);
    this.body.setLinvel(ZERO, true);
    this.body.setAngvel(ZERO, true);
    this.vel.x = this.vel.y = this.vel.z = 0;
    const e = this.ext;
    e.carryVel.x = e.carryVel.y = e.carryVel.z = 0;
    e.extVel.x = e.extVel.y = e.extVel.z = 0;
    e.knockTimer = 0;
    e.bounceCooldown = 0;
    e.breakFree = 0;
    e.latches &= Latch.Frozen | Latch.GhostLocked;
    this.stunTimer = 0;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.jumpHeld = false;
    this._grounded = false;
    const s = this._state;
    if (s !== CharacterState.Finished && s !== CharacterState.Spectating && s !== CharacterState.Eliminated) {
      this._state = CharacterState.Fall;
      this._stateTime = 0;
      this._emote = 0;
    }
    this.applyBodyMode(true);
  }

  /** Ghost: no player/prop collisions. `seconds` → timed; omitted → until cleared. */
  setGhost(ghost: boolean, seconds?: number): void {
    if (ghost) {
      if (seconds !== undefined && seconds > 0) this.ghostTimer = Math.max(this.ghostTimer, seconds);
      else this.ext.latches |= Latch.GhostLocked;
    } else {
      this.ghostTimer = 0;
      this.ext.latches &= ~Latch.GhostLocked;
    }
    this.syncGhostFlag();
  }

  /** Start-gate freeze: no movement, dive or grab; jumping in place and emotes still work. */
  setFrozen(frozen: boolean): void {
    if (frozen) {
      this.ext.latches |= Latch.Frozen;
      if (this.ext.grabKind !== GrabKind.None) this.releaseAllGrabs(this.stepCtx, 'release');
    } else {
      this.ext.latches &= ~Latch.Frozen;
    }
  }

  /**
   * Finished: ghost, keeps standing (celebration). Spectating / Eliminated:
   * removed from the simulation. Respawning: held still as a ghost until
   * `teleport`. Any other state revives the Tumbler into that state.
   */
  setFate(state: CharacterStateId): void {
    this.releaseAllGrabs(this.stepCtx, 'release');
    const e = this.ext;
    switch (state) {
      case CharacterState.Finished:
        e.latches |= Latch.GhostLocked;
        break;
      case CharacterState.Spectating:
        e.latches |= Latch.GhostLocked;
        break;
      case CharacterState.Eliminated:
        e.latches |= Latch.GhostLocked;
        this.flags |= CharacterFlag.Eliminated;
        break;
      case CharacterState.Respawning:
        e.latches |= Latch.GhostLocked;
        this.body.setLinvel(ZERO, true);
        break;
      default:
        e.latches &= ~Latch.GhostLocked;
        this.flags &= ~CharacterFlag.Eliminated;
        break;
    }
    if (this._state === CharacterState.Stunned && state !== CharacterState.Stunned) {
      this.stunTimer = 0;
      this.body.rotation(this.qA);
      this._facing = yawFromQuat(this.qA);
      this.body.setRotation(quatFromYaw(this._facing, this.rot), true);
    }
    this._state = state;
    this._stateTime = 0;
    this._emote = 0;
    const ghost = this.ghostTimer > 0 || (e.latches & Latch.GhostLocked) !== 0;
    if (ghost) this.flags |= CharacterFlag.Ghost;
    else this.flags &= ~CharacterFlag.Ghost;
    this.applyBodyMode(true);
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  /** Captures everything needed to reproduce the next step exactly. */
  getState(out: CharacterFullState): CharacterFullState {
    this.body.translation(out.pos);
    this.body.rotation(out.rot);
    this.body.linvel(out.vel);
    this.body.angvel(out.angVel);
    out.state = this._state;
    out.stateTime = this._stateTime;
    out.facing = this._facing;
    out.grounded = this._grounded;
    out.coyoteTimer = this.coyoteTimer;
    out.jumpBufferTimer = this.jumpBufferTimer;
    out.jumpHeld = this.jumpHeld;
    out.prevButtons = this.prevButtons;
    out.grabStamina = this.grabStamina;
    out.grabTarget = this.grabTarget;
    out.stunTimer = this.stunTimer;
    out.ghostTimer = this.ghostTimer;
    out.emote = this._emote;
    out.flags = this.flags;
    const o = (out.ext ??= createCharacterExtState());
    const e = this.ext;
    copy3(e.carryVel, o.carryVel);
    copy3(e.extVel, o.extVel);
    copy3(e.ledgePoint, o.ledgePoint);
    copy3(e.ledgeNormal, o.ledgeNormal);
    o.latches = e.latches;
    o.grabKind = e.grabKind;
    o.partnerCollider = e.partnerCollider;
    o.grabCooldown = e.grabCooldown;
    o.breakFree = e.breakFree;
    o.knockTimer = e.knockTimer;
    o.bounceCooldown = e.bounceCooldown;
    return out;
  }

  /**
   * Restores a snapshot from {@link getState}. Body pose, velocities, every
   * timer/latch, and the derived body configuration (rotation lock, friction,
   * collision groups, enabled) are all re-applied.
   */
  setState(s: CharacterFullState): void {
    this._state = s.state;
    this._stateTime = s.stateTime;
    this._facing = s.facing;
    this._grounded = s.grounded;
    this.coyoteTimer = s.coyoteTimer;
    this.jumpBufferTimer = s.jumpBufferTimer;
    this.jumpHeld = s.jumpHeld;
    this.prevButtons = s.prevButtons;
    this.grabStamina = s.grabStamina;
    this.grabTarget = s.grabTarget;
    this.stunTimer = s.stunTimer;
    this.ghostTimer = s.ghostTimer;
    this._emote = s.emote;
    this.flags = s.flags;
    const e = this.ext;
    if (s.ext) {
      const o = s.ext;
      copy3(o.carryVel, e.carryVel);
      copy3(o.extVel, e.extVel);
      copy3(o.ledgePoint, e.ledgePoint);
      copy3(o.ledgeNormal, e.ledgeNormal);
      e.latches = o.latches;
      e.grabKind = o.grabKind;
      e.partnerCollider = o.partnerCollider;
      e.grabCooldown = o.grabCooldown;
      e.breakFree = o.breakFree;
      e.knockTimer = o.knockTimer;
      e.bounceCooldown = o.bounceCooldown;
    } else {
      // Remote snapshot without internals: reset to neutral rather than keep stale data.
      Object.assign(e, createCharacterExtState());
    }
    this.applyBodyMode(true);
    // Only write what differs: Rapier renormalises rotations on write, so re-setting an
    // identical quaternion perturbs a free-tumbling body and breaks bit-exact replay.
    const b = this.body;
    if (!same3(b.translation(this.tA), s.pos)) b.setTranslation(s.pos, true);
    const q = b.rotation(this.qA);
    if (q.x !== s.rot.x || q.y !== s.rot.y || q.z !== s.rot.z || q.w !== s.rot.w) b.setRotation(s.rot, true);
    if (!same3(b.linvel(this.tA), s.vel)) b.setLinvel(s.vel, true);
    if (!same3(b.angvel(this.tA), s.angVel)) b.setAngvel(s.angVel, true);
    this.preSupportHandle = -1;
  }

  /** Removes the body and collider from the world. The controller must not be used afterwards. */
  /**
   * Starts holding `other` as if this step's grab query had found it. Used by
   * the server's lag-compensated hit assist when the client saw the target in
   * reach; every rule of a normal grab (cooldown, stamina, ghosting, freezes,
   * the target's own state) still applies.
   *
   * @returns True when the grab started.
   */
  assistGrab(other: TumblerControllerLike, ctx: CharacterStepContext): boolean {
    if (!(other instanceof TumblerController) || other === this) return false;
    const ext = this.ext;
    const s = this._state;
    // Grab with nothing held is the empty-handed reach pose.
    const free =
      s === CharacterState.Idle ||
      s === CharacterState.Run ||
      s === CharacterState.Jump ||
      s === CharacterState.Fall ||
      s === CharacterState.Grab;
    if (
      !free ||
      ext.grabKind !== GrabKind.None ||
      ext.grabCooldown > 0 ||
      this.grabStamina <= 0.1 ||
      this.frozen ||
      (this.flags & CharacterFlag.Ghost) !== 0 ||
      !other.canBeGrabbed(this.id)
    )
      return false;
    this.beginHoldPlayer(other, ctx);
    return true;
  }

  /**
   * Applies a dive tackle exactly like the contact scan does when a diving
   * Tumbler hits this one (server hit assist).
   *
   * @param dirX - Horizontal push direction (unit, away from the diver).
   * @param dirZ - Horizontal push direction.
   * @param strength - Impact Δv in m/s (at least the dive-hit threshold).
   * @returns True when the tackle stunned this Tumbler.
   */
  applyTackle(dirX: number, dirZ: number, strength: number): boolean {
    const s = this._state;
    if (
      s === CharacterState.Stunned ||
      s === CharacterState.Finished ||
      s === CharacterState.Respawning ||
      s === CharacterState.LedgeClimb ||
      s === CharacterState.Eliminated ||
      s === CharacterState.Spectating ||
      (this.flags & CharacterFlag.Ghost) !== 0
    )
      return false;
    const dv = Math.max(strength, this.tuning.diveHitThreshold);
    this.body.linvel(this.vel);
    this.vel.x += dirX * dv * 0.5;
    this.vel.z += dirZ * dv * 0.5;
    this.vel.y = Math.max(this.vel.y, 2.5);
    this.body.setLinvel(this.vel, true);
    this.enterStun(this.tuning.stunImpactThreshold + dv, dirX, dirZ);
    return true;
  }

  dispose(): void {
    if (this.body.isValid()) this.world.removeRigidBody(this.body);
    this.stepCtx = null;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 }) as Vec3;

function copy3(src: Vec3, out: Vec3): void {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
}

function same3(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function wrapAngle(a: number): number {
  if (a > Math.PI || a < -Math.PI) return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
  return a;
}

/** out = q * v */
function rotate(q: Quat, vx: number, vy: number, vz: number, out: Vec3): void {
  const ix = q.w * vx + q.y * vz - q.z * vy;
  const iy = q.w * vy + q.z * vx - q.x * vz;
  const iz = q.w * vz + q.x * vy - q.y * vx;
  const iw = -q.x * vx - q.y * vy - q.z * vz;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
}

/** out = conj(q) * v */
function invRotate(q: Quat, vx: number, vy: number, vz: number, out: Vec3): void {
  const cx = -q.x;
  const cy = -q.y;
  const cz = -q.z;
  const w = q.w;
  const ix = w * vx + cy * vz - cz * vy;
  const iy = w * vy + cz * vx - cx * vz;
  const iz = w * vz + cx * vy - cy * vx;
  const iw = -cx * vx - cy * vy - cz * vz;
  out.x = ix * w + iw * -cx + iy * -cz - iz * -cy;
  out.y = iy * w + iw * -cy + iz * -cx - ix * -cz;
  out.z = iz * w + iw * -cz + ix * -cy - iy * -cx;
}

/**
 * Factory matching the contract's {@link CreateTumblerController}.
 *
 * @example
 * const c = createTumblerController({ R, world, id: 3, position: spawn, yaw: 0 });
 */
export const createTumblerController: CreateTumblerController = (opts) => new TumblerController(opts);
