import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import type { Quat, Rng, Vec3 } from '@tumble/shared';
import type { z } from 'zod';
import type { EventSink } from '../events.ts';
import type { Rapier } from '../physics/rapier.ts';
import type { SurfaceRegistry } from '../physics/surfaces.ts';

/** Every obstacle kind in the library. Stable string ids: they appear in round data. */
export type ObstacleType =
  | 'spinwheel'
  | 'pendulumHammer'
  | 'sweeperArm'
  | 'bumperPillar'
  | 'punchWall'
  | 'doorGauntlet'
  | 'conveyorBelt'
  | 'tiltPlatform'
  | 'seesaw'
  | 'fanZone'
  | 'bouncePad'
  | 'fallingTiles'
  | 'risingSlime'
  | 'boulderLane'
  | 'spinningDisc'
  | 'movingPlatform'
  | 'slideRamp'
  | 'iceFloor'
  | 'stickyGoo'
  | 'popupBlocks'
  | 'laserSweep'
  | 'cannon'
  | 'bumperCar'
  | 'rollingDrum'
  | 'collapsingBridge'
  | 'jumpRopeBeam'
  | 'teleporterPair'
  | 'climbWall'
  | 'checkpointGate'
  | 'finishLine'
  | 'startGate'
  | 'voidTrigger'
  | 'propSpawner'
  | 'paintGrid'
  | 'patternBoard'
  | 'goalZone'
  | 'cometField'
  | 'sunbeamZones'
  | 'puzzleFloor';

/**
 * Placement of one obstacle in a round. `rotation` is yaw/pitch/roll in DEGREES
 * (what level designers type); modules convert once at build time.
 */
export interface ObstacleInstance<P = Record<string, unknown>> {
  /** Unique within the round, e.g. "spin-2". Used for event attribution and net ids. */
  id: string;
  type: ObstacleType;
  position: Vec3;
  /** Yaw, pitch, roll in degrees. */
  rotation?: { yaw?: number; pitch?: number; roll?: number };
  params: P;
}

/** Everything an obstacle needs to build itself into a world. */
export interface ObstacleBuildContext {
  R: Rapier;
  world: World;
  surfaces: SurfaceRegistry;
  events: EventSink;
  /** Seeded generator for this instance (show seed ⊕ round ⊕ instance id). Same on every machine. */
  rng: Rng;
  /** Show-stage speed multiplier from the round's difficulty knobs (1 = base). */
  speedScale: number;
  /**
   * Players starting the round, the same on server and clients (prediction
   * sims hold every entrant as a proxy). Objective counts scale with it.
   * Absent in bare harnesses: treat as unknown.
   */
  entrants?: number;
  /**
   * False in a client's prediction sim: round mechanics that hand out points
   * or decide seats leave that to the server's replicated state. Absent = true.
   */
  authoritative?: boolean;
}

/** A player as seen by obstacle logic (triggers, impulses). */
export interface ObstacleActor {
  id: number;
  body: RigidBody;
  /** Applies a knockback that may stun if above threshold. */
  knock(impulse: Vec3, stun: boolean): void;
  /** Apply a continuous force-like velocity change this step (fans, conveyors handled by surfaces). */
  push(deltaVelocity: Vec3): void;
  /** Hard-move the player (teleporters, respawn). */
  teleport(pos: Vec3, yaw?: number): void;
  isGhost: boolean;
}

/** Per-step context while the round runs. */
export interface ObstacleStepContext {
  /** Synchronised match time in seconds since round PLAYING began (negative during countdown). */
  t: number;
  dt: number;
  tick: number;
  events: EventSink;
  /** Players currently inside this obstacle's trigger volumes are reported via onTrigger. */
  actors: readonly ObstacleActor[];
}

/** Live obstacle inside a sim world. */
export interface ObstacleRuntime {
  readonly instance: ObstacleInstance;
  /** Colliders owned by this runtime, for trigger/contact routing. */
  readonly colliders: readonly Collider[];
  /** Advance to time `ctx.t`: set next kinematic poses from `pose(t)`, run timers. */
  update(ctx: ObstacleStepContext): void;
  /** A player's collider started/stopped intersecting one of our sensor colliders. */
  onTrigger?(actor: ObstacleActor, collider: Collider, entered: boolean, ctx: ObstacleStepContext): void;
  /** A player touched one of our solid colliders this step. Server-authoritative effects go here. */
  onContact?(actor: ObstacleActor, collider: Collider, ctx: ObstacleStepContext): void;
  /**
   * Replicated state for obstacles that are NOT pure functions of time
   * (falling tiles, tilt platforms, doors broken). Packed as small int arrays.
   */
  getNetState?(): number[];
  setNetState?(state: readonly number[]): void;
  /** Visual warning intensity 0–1 at time `t` (pulses before activation). */
  telegraph?(t: number): number;
  dispose(): void;
}

/** One pose sample produced by a pure pose function. */
export interface PoseSample {
  pos: Vec3;
  rot: Quat;
}

/**
 * An obstacle module. Server builds runtimes; the client builds the SAME runtime
 * for prediction, plus a visual (in @tumble/render) that mirrors `pose(t)`.
 */
export interface ObstacleModule<P = Record<string, unknown>> {
  type: ObstacleType;
  /** Zod schema validating `params` (with defaults applied). */
  schema: z.ZodType<P>;
  /** Human-facing name (original IP). */
  displayName: string;
  /**
   * Pure pose function: kinematic part transforms at time t, relative to the
   * instance origin. Must not read anything but its arguments.
   */
  pose?(t: number, params: P, out: PoseSample[], speedScale: number): void;
  /** Number of samples `pose()` writes for these params (size of the `out` buffer to allocate). */
  poseCount?(params: P, speedScale: number): number;
  create(instance: ObstacleInstance<P>, ctx: ObstacleBuildContext): ObstacleRuntime;
  /** Named audio cues this obstacle can emit via `obstacleCue` events. */
  audioCues?: readonly string[];
}
