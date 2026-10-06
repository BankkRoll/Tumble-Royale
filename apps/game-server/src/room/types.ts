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
import {
  DEFAULT_SHOW_PLAYERS,
  type RoundDefinition,
  type RoundPhaseId,
  type ShowPhaseId,
} from '@tumble/shared';
import type { ResultsSink } from '../results.ts';
import type { VoiceTeamsSink } from '../voiceTeams.ts';
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
  /** Matchmaker party size (1 solo, 2 duos, 4 squads). */
  teamSize?: number;
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
  /**
   * Entrants as the show built them (team rounds keep parties on one team);
   * the room falls back to its roster with `team: -1` when absent.
   */
  players?: readonly MatchPlayerInfo[];
  /** Show mutator id (`@tumble/sim/mutators`); forwarded to the sim and to clients in `joinRound`. */
  mutatorId?: string | null;
  /** Round timer multiplier (0.5–2); forwarded to the sim and to clients in `joinRound`. */
  roundTimeScale?: number;
}

/** How a round vote was decided (`cancelled`: called off, no winner). */
export type ShowVoteReason = 'votes' | 'tie' | 'noVotes' | 'cancelled';

/** A round-vote ballot as the room mirrors it to clients. */
export interface ShowVote {
  /** Round the ballot is for. */
  roundIndex: number;
  /** The ballot is for the final. */
  isFinal: boolean;
  /** Candidate round ids in display order. */
  options: string[];
  /** Raw ballots per option. */
  counts: number[];
  /** Ballots cast. */
  voted: number;
  /** Players allowed to vote. */
  eligible: number;
  /** Seconds until the ballot closes at the latest (0 once closed). */
  closesIn: number;
  /** Bot ballots count for less than a human's. */
  botsDiscounted: boolean;
  /** Set once closed. */
  result: { winner: number; roundId: string; counts: number[]; reason: ShowVoteReason } | null;
}

/** Things the show director asks the room to do, drained once per tick. */
export type ShowEvent =
  | { type: 'showPhase'; phase: ShowPhaseId }
  /** Build a new MatchSim for this plan (disposing the previous one) and tell clients to load it. */
  | { type: 'roundStart'; plan: ShowRoundPlan }
  /** Force the round phase (sim.setPhase) and mirror it to clients. */
  | { type: 'roundPhase'; phase: RoundPhaseId; time?: number }
  /** Eliminate a player from the running round (e.g. gave up waiting for them to load). */
  | { type: 'forfeit'; playerId: number }
  /** The round is over; results go to clients. */
  | { type: 'roundEnd'; roundId: string; results: RoundResultEntry[] }
  /** The show is over; the room winds down. */
  | { type: 'showEnd'; winners: number[]; rounds: { roundId: string; qualified: number[] }[] }
  /** A ballot for the next round opened: offer it to every client. */
  | { type: 'voteOpen'; vote: ShowVote }
  /** Ballots changed: mirror the counts (the room throttles these). */
  | { type: 'voteTally'; roundIndex: number; counts: number[]; voted: number }
  /** The ballot closed (`winner` -1 when it was called off). */
  | {
      type: 'voteResult';
      roundIndex: number;
      winner: number;
      roundId: string;
      counts: number[];
      reason: ShowVoteReason;
    };

/** The LOADING roster mirrored to clients as `loadingStatus`. */
export interface ShowLoadingStatus {
  roundId: string;
  /** Human entrants who finished loading. */
  loaded: number;
  /** Human entrants still in the show. */
  total: number;
  /** Connected players the round is still waiting for. */
  waitingOn: number[];
}

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
  /** A human is still building the current round (client `loadProgress` heartbeat). */
  onPlayerLoadProgress?(playerId: number, pct: number): void;
  /** A human's connection dropped (`false`) or was (re)attached (`true`). */
  onPlayerConnection?(playerId: number, connected: boolean): void;
  /** Who the round is waiting on while it loads; null outside LOADING. Allocates: poll at ≤ 2 Hz. */
  loadingStatus?(): ShowLoadingStatus | null;
  /** The round being played, or null. */
  currentRound(): ShowRoundPlan | null;
  /**
   * A player's round-vote ballot (client `castVote`). The controller ignores
   * anything it cannot accept: wrong round, closed ballot, bad option, a
   * player who may not vote.
   */
  castVote?(playerId: number, roundIndex: number, option: number): void;
  /** The running ballot, for a client that (re)attached mid-vote; null when none. Allocates. */
  currentVote?(): ShowVote | null;
  /** True if the player may vote in the running ballot. */
  canVote?(playerId: number): boolean;
  /** The player's ballot in the running vote (option index), or -1. */
  ballotOf?(playerId: number): number;
  /** Playlist party size (duos 2, squads 4); the room assigns party ids with it. */
  readonly partySize?: number;
  /** Playlist bot skill weights; the room seeds bot tiers with it. */
  readonly botSkillMix?: Readonly<Record<'clumsy' | 'average' | 'sharp', number>>;
  /** Length of the pre-show countdown before round 1, in seconds. */
  readonly preShowSeconds?: number;
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
   * Async work a matchmade show needs before it may start (fetching a private
   * show's custom rounds). Returns null when there is none. The room holds the
   * show in its lobby until the promise settles, then builds its show
   * controller again; the promise must settle on its own (bounded timeouts).
   */
  prepareMatch?: (match: MatchSettings) => Promise<unknown> | null;
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
  /** Tells the account API who is on which team in team rounds (team voice); null/absent disables it. */
  voiceTeams?: VoiceTeamsSink | null;
  /** Playlist display name and round estimate for the `showInfo` message. */
  describePlaylist?: (
    playlistId: string | null,
    players: number,
  ) => { id: string; name: string; roundCount: number };
  /**
   * The pre-show lobby platform. When set, the room runs it as a live,
   * rule-less match sim (`lobby: true`) from the first join until round 1,
   * so everyone on the platform sees each other move, grab and emote.
   * Null/absent keeps the old purely local pre-show.
   */
  lobbyRound?: RoundDefinition | null;
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
  /**
   * Seats of ticketed humans who have not arrived are held until round 1
   * starts loading plus this long; then the seat forfeits like a quitter.
   */
  lateJoinGraceMs: number;
  /** Snapshots go out every N × {@link snapshotEvery} ticks on the pre-show platform (bandwidth). */
  lobbySnapshotDivisor: number;
  /**
   * Spectators one room takes at most (late joiners plus private spectator
   * seats). Each costs one snapshot encode per tick, like a player, so this
   * bounds what watchers add to the tick.
   */
  maxSpectators: number;
}

/** Defaults per SPEC §3.1. */
export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  capacity: DEFAULT_SHOW_PLAYERS,
  fillWaitMs: 25_000,
  startAtHumans: DEFAULT_SHOW_PLAYERS,
  resumeWindowMs: 30_000,
  snapshotByteBudget: 1200,
  snapshotEvery: 1,
  idleCloseMs: 30_000,
  ticketedFillWaitMs: 15_000,
  lateJoinGraceMs: 10_000,
  lobbySnapshotDivisor: 2,
  maxSpectators: 16,
};
