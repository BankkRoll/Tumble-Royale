import type { World } from '@dimforge/rapier3d-compat';
import type { Quat, RoundDefinition, RoundPhaseId, Vec3 } from '@tumble/shared';
import type { CharacterFullState, CharacterInput } from '../character/types.ts';
import type { EventSink } from '../events.ts';
import type { Rapier } from '../physics/rapier.ts';
import type { RoundRulesOptions } from '../rounds/types.ts';

/** A participant in a match. */
export interface MatchPlayerInfo {
  id: number;
  name: string;
  isBot: boolean;
  /** Team index for team rounds, else -1. */
  team: number;
  /** Bot skill tier when `isBot`. */
  botSkill?: 'clumsy' | 'average' | 'sharp';
}

/** Per-player round status. */
export const PlayerRoundStatus = {
  Playing: 0,
  Qualified: 1,
  Eliminated: 2,
  Spectating: 3,
} as const;

/** Numeric player round status. */
export type PlayerRoundStatusId = (typeof PlayerRoundStatus)[keyof typeof PlayerRoundStatus];

/** Snapshot of round progress for HUD, netcode and the show director. */
export interface RoundStatus {
  phase: RoundPhaseId;
  /** Seconds since PLAYING began (negative during countdown). */
  time: number;
  /** Seconds remaining on the round timer, or -1 if untimed. */
  timeLeft: number;
  qualifiedCount: number;
  /** How many may qualify this round. */
  qualifyTarget: number;
  eliminatedCount: number;
  /** Team scores for team rounds, else empty. */
  teamScores: number[];
  /** Per-player status keyed by player id. */
  players: Map<
    number,
    {
      status: PlayerRoundStatusId;
      score: number;
      progress: number;
      place: number;
      /** Team index (team rounds), else -1. */
      team?: number;
      /** Holding the hunt item (tail). */
      hasItem?: boolean;
    }
  >;
  /** True once the round has decided everyone's fate. */
  finished: boolean;
}

/** Options for creating a match simulation. */
export interface MatchSimOptions {
  R: Rapier;
  round: RoundDefinition;
  /** Show seed; combined with round/obstacle ids for all randomness. */
  seed: number;
  /** 0-based index of this round within the show (drives speedScaleByStage). */
  stage: number;
  players: MatchPlayerInfo[];
  /**
   * `authority`: server — simulates every player, runs rules, emits fate events.
   * `predict`: client — simulates only `localPlayerId` dynamically; others are
   * kinematic proxies positioned from interpolated snapshots; rules are display-only.
   * `offline`: single-player/dev — authority rules + bots, no network.
   */
  mode: 'authority' | 'predict' | 'offline';
  localPlayerId?: number;
  /** Overrides the qualification target (show director shrink curve). Ignored by finals. */
  qualifyTarget?: number;
  /** Forces a variation id instead of the seeded weighted pick (custom lobbies, tests). */
  variationId?: string;
  /** Rule variants not expressed in the round definition. */
  rules?: RoundRulesOptions;
  /**
   * Show mutator id (`@tumble/sim/mutators`), e.g. `moon-bounce`. Every peer
   * simulating the round (server, predicting clients, offline) must pass the
   * same id. Unknown ids are ignored with a warning.
   */
  mutatorId?: string | null;
  /**
   * Multiplier on the round timer and overtime, clamped to 0.5–2 (see
   * `clampRoundTimeScale`). Must match on every peer. Defaults to 1.
   */
  roundTimeScale?: number;
}

/**
 * One round's simulation: level geometry, obstacles, characters, triggers,
 * round rules and bots inside a Rapier world. The server and the client both
 * drive it with identical `step()` calls.
 */
export interface MatchSim {
  readonly world: World;
  readonly events: EventSink;
  readonly round: RoundDefinition;
  /** Fixed steps taken since creation. */
  readonly tick: number;
  /** Match time in seconds (0 = PLAYING starts). */
  readonly time: number;
  /** Current round phase. */
  readonly phase?: RoundPhaseId;
  /** Seeded variation applied to this round, or null when the round has none. */
  readonly variationId?: string | null;
  /** Show mutator applied to this round, or null. */
  readonly mutatorId?: string | null;

  /** Feed the input to use for `playerId` on the next `step()`. Bots generate their own. */
  setInput(playerId: number, input: CharacterInput): void;
  /** Advance one fixed step (SIM_DT). */
  step(): void;
  /** Force phase (server drives LOADING→…→RESULTS; client mirrors from the wire). */
  setPhase(phase: RoundPhaseId, time?: number): void;
  /** Jump match time, snapping kinematic obstacles straight to `pose(time)` (prediction rewind). */
  setTime?(time: number): void;

  getPlayerState(playerId: number, out: CharacterFullState): boolean;
  setPlayerState(playerId: number, state: CharacterFullState): void;
  /** Predict mode: position a remote player's kinematic proxy. */
  setRemoteProxy(playerId: number, pos: Vec3, rot: Quat, vel: Vec3, state: number): void;

  /** Replicated non-pure obstacle state, keyed by obstacle id. */
  getObstacleNetStates(): Map<string, number[]>;
  setObstacleNetState(obstacleId: string, state: readonly number[]): void;

  getStatus(): RoundStatus;
  /** Player ids in current race order / score order, for HUD and spectating. */
  getStandings(): number[];

  dispose(): void;
}
