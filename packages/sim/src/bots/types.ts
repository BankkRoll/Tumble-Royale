import type { RoundDefinition, RoundPhaseId, Vec3 } from '@tumble/shared';
import type { CharacterInput, CharacterStateId } from '../character/types.ts';
import type { PlayerRoundStatusId } from '../match/types.ts';

/** Bot skill tiers. */
export type BotSkill = 'clumsy' | 'average' | 'sharp';

/** The bot's own character, refreshed by the match before every `think`. */
export interface BotSelfView {
  readonly pos: Vec3;
  readonly vel: Vec3;
  grounded: boolean;
  state: CharacterStateId;
  /** Facing yaw in radians. */
  facing: number;
  status: PlayerRoundStatusId;
  team: number;
  hasItem: boolean;
  /** Highest checkpoint index reached. */
  checkpoint: number;
}

/** Another participant as bots see them. `RulesPlayer` satisfies this. */
export interface BotPeer {
  readonly id: number;
  readonly team: number;
  readonly pos: Vec3;
  readonly hasItem: boolean;
  readonly status: PlayerRoundStatusId;
}

/**
 * What a bot may ask of the world. Implemented by the match sim on top of
 * Rapier queries and the obstacle modules' pure `pose(t)` functions, so bots
 * read the same physics humans play against and never peek at private state.
 */
export interface BotWorldView {
  readonly round: RoundDefinition;
  readonly phase: RoundPhaseId;
  /** Match time in seconds (0 = PLAYING began). */
  readonly time: number;
  readonly tick: number;
  readonly dt: number;
  /** Every participant, including the bot itself. */
  readonly peers: readonly BotPeer[];
  /**
   * Distance from `point` to obstacle `obstacleId`'s solid geometry `ahead`
   * seconds from now, predicted from the module's `pose(t)` when possible.
   * Present-time queries (`ahead <= 0`) also include the obstacle's fixed
   * parts (frames, hubs, posts); predictions cover moving parts and hazard
   * sensors only, since fixed parts never open.
   *
   * @returns Infinity when the obstacle is unknown or has no solid geometry.
   */
  obstacleClearance(obstacleId: string, point: Vec3, ahead: number): number;
  /**
   * Distance from `point` to the nearest moving obstacle collider or hazard
   * sensor (lasers, goo) `ahead` seconds from now (searching within `maxDist`).
   *
   * @param outClosest - Receives the closest point on that geometry (current pose).
   * @returns Infinity when nothing is within `maxDist`.
   */
  hazardDistance(point: Vec3, maxDist: number, ahead: number, outClosest?: Vec3): number;
  /** @returns True if a walkable surface lies within `depth` below `point`. */
  groundBelow(point: Vec3, depth: number): boolean;
  /**
   * Asks obstacles that know a safe spot (pattern tiles, intact falling
   * tiles, behind a jump-rope beam). On entry `out` holds the bot's hint
   * point (its position nudged toward where it would like to go); when
   * several obstacles answer, the spot nearest the hint wins.
   *
   * @returns True and writes `out` when some obstacle offered one.
   */
  safeSpot(out: Vec3): boolean;
  /** Number of loose dynamic props (eggs, balls) currently tracked. */
  propCount(): number;
  /** Writes prop `index`'s position. */
  propPosition(index: number, out: Vec3): void;
}

/** A bot's decision maker: turns world observations into one input per step. */
export interface BotBrainLike {
  readonly id: number;
  readonly skill: BotSkill;
  /** Writes this step's input into `out`. Must not allocate in steady state. */
  think(view: BotWorldView, self: BotSelfView, out: CharacterInput): void;
  /** The character was teleported to a respawn point. */
  onRespawn?(): void;
}

/** Options for creating a bot brain. */
export interface BotBrainOptions {
  id: number;
  skill: BotSkill;
  /** Per-bot seed; the default brain derives it from show seed, round id and player id. */
  seed: number;
  round: RoundDefinition;
}

/** Factory signature for bot brains (built-in: `createBotBrain`). */
export type BotBrainFactory = (opts: BotBrainOptions) => BotBrainLike;
