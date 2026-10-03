/**
 * Contracts between a {@link Room} and the collaborators the integrator wires:
 * the match simulation factory, round loading, the show director and bots.
 * Everything gameplay-specific is injected so the room (netcode, pacing,
 * sessions) is testable with fakes and runs standalone with the dev sim.
 */
import type {
  MatchPlayerInfo,
  MatchSim,
  MatchSimOptions,
  PlayerRoundStatusId,
  RoundResultEntry,
  RoundStatus,
} from '@tumble/netcode';
import type { CharacterInput, Rapier } from '@tumble/sim';
import type { RoundDefinition, RoundPhaseId, ShowPhaseId } from '@tumble/shared';
import type { ResultsSink } from '../results.ts';
import type { TicketCustomSettings } from '../tickets.ts';

/** A matchmade show: what the join tickets said about it. */
export interface MatchSettings {
  /** Matchmaker match id (the API's results idempotency key). */
  matchId: string;
  playlistId: string;
  queue: 'casual' | 'ranked' | 'custom';
  region: string;
  /** Humans the matchmaker placed in this match. */
  humans: number;
  /** Bots to fill with. */
  bots: number;
  /** Custom lobby settings (host-picked rounds, bots on/off). */
  custom: TicketCustomSettings | null;
}

/** One round the show wants played. */
export interface ShowRoundPlan {
  roundId: string;
  /** 0-based round index within the show. */
  index?: number;
  /** The show's final round. */
  isFinal?: boolean;
  /** Difficulty stage (round index + playlist offset). */
  stage: number;
  /** Show seed for this round. */
  seed: number;
  /** Players entering the round (qualified survivors of the previous one). */
  playerIds: readonly number[];
  /** Overrides the round's qualification target. */
  qualifyTarget?: number;
  /** Forced variation id (custom lobbies). */
  variationId?: string;
  /** The round definition when the controller already has it (skips {@link RoomDeps.loadRound}). */
  round?: RoundDefinition;
}

/** Things the show director asks the room to do, drained once per tick. */
export type ShowEvent =
  | { type: 'showPhase'; phase: ShowPhaseId }
  /** Build a new MatchSim for this plan (disposing the previous one) and tell clients to load it. */
  | { type: 'roundStart'; plan: ShowRoundPlan }
  /** Force the round phase (sim.setPhase) and mirror it to clients. */
  | { type: 'roundPhase'; phase: RoundPhaseId; time?: number }
  /** The round is over; results go to clients. */
  | { type: 'roundEnd'; roundId: string; results: RoundResultEntry[] }
  /** The show is over; the room winds down. */
  | { type: 'showEnd'; winners: number[]; rounds: { roundId: string; qualified: number[] }[] };

/** What the show director can see each tick. */
export interface ShowTickContext {
  /** The running round's status, or null between rounds. */
  status: RoundStatus | null;
  /** Ids of players currently connected or bots (disconnected-but-resumable humans count as present). */
  presentPlayers: ReadonlySet<number>;
}

/**
 * Show flow (round selection, phase timing, qualification across rounds).
 * The match team's ShowDirector implements this; {@link SimpleShowController}
 * is the built-in single-round loop.
 */
export interface ShowController {
  /** Current show phase. */
  readonly showPhase: ShowPhaseId;
  /** Begins the show with the final roster. */
  start(players: readonly MatchPlayerInfo[], seed: number): void;
  /** Called once per server tick after the sim steps. */
  onTick(dt: number, ctx: ShowTickContext): void;
  /** A fate decided by the sim (from `qualified` / `eliminated` SimEvents). */
  onPlayerFate(playerId: number, status: PlayerRoundStatusId, place: number): void;
  /** A player left for good (resume window expired). */
  onPlayerLeft(playerId: number): void;
  /** A human finished loading the current round (client `loaded` message). */
  onPlayerLoaded?(playerId: number): void;
  /** The round being played, or null. */
  currentRound(): ShowRoundPlan | null;
  /** Returns and clears pending events. */
  drainEvents(): ShowEvent[];
}

/** Creates a show controller for a room (`match` is null for unticketed dev rooms). */
export type ShowControllerFactory = (ctx: { roomId: string; match?: MatchSettings | null }) => ShowController;

/** Produces inputs for one server-driven bot through the same path as human inputs. */
export interface ServerBotBrain {
  /**
   * Writes this step's input.
   *
   * @param sim - The authoritative sim (read-only use).
   * @param playerId - The bot's id.
   */
  think(sim: MatchSim, playerId: number, out: CharacterInput): void;
}

/** Creates a bot brain for a bot player. */
export type ServerBotFactory = (info: MatchPlayerInfo, seed: number) => ServerBotBrain;

/** Collaborators injected into every room. */
export interface RoomDeps {
  R: Rapier;
  /** Real: `(opts) => createMatchSim(opts, matchDeps)` from `@tumble/sim/match`. */
  createMatchSim: (opts: MatchSimOptions) => MatchSim;
  /** Real: validated round from `@tumble/content`. */
  loadRound: (roundId: string) => RoundDefinition;
  /** Real: wraps the match team's ShowDirector. */
  createShowController: ShowControllerFactory;
  /**
   * Bots that need external input (e.g. the dev sim). Return null to let the
   * MatchSim drive the bot itself (the real sim has built-in bot brains).
   */
  createBot?: ServerBotFactory | null;
  /** Monotonic clock in ms. */
  now: () => number;
  /** Random 32-bit seed source for shows and resume tokens. */
  randomSeed: () => number;
  /** Logger. */
  log?: (msg: string) => void;
  /** Posts matchmade show results to the account API; null/absent disables reporting. */
  results?: ResultsSink | null;
  /** Playlist display name and round estimate for the `showInfo` message. */
  describePlaylist?: (
    playlistId: string | null,
    players: number,
  ) => { id: string; name: string; roundCount: number };
}

/** Room tuning. */
export interface RoomConfig {
  /** Show size including bots. */
  capacity: number;
  /** After the first human joins, fill with bots and start after this long. */
  fillWaitMs: number;
  /** Start immediately once this many humans are in (≤ capacity). */
  startAtHumans: number;
  /** Disconnected players can resume within this window. */
  resumeWindowMs: number;
  /** Snapshot byte budget. */
  snapshotByteBudget: number;
  /** Snapshots are sent every N server ticks (SERVER_TICK_HZ / SNAPSHOT_HZ). */
  snapshotEvery: number;
  /** Close the room this long after the show ends or the last human leaves. */
  idleCloseMs: number;
  /** Matchmade rooms start once every ticketed human joined, or after this long. */
  ticketedFillWaitMs: number;
}

/** Defaults per SPEC §3.1. */
export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  capacity: 40,
  fillWaitMs: 25_000,
  startAtHumans: 40,
  resumeWindowMs: 30_000,
  snapshotByteBudget: 1200,
  snapshotEvery: 1,
  idleCloseMs: 30_000,
  ticketedFillWaitMs: 15_000,
};
