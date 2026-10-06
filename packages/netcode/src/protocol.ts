/**
 * Wire protocol: message type ids, handshake and clock-sync codecs, and the
 * low-frequency msgpackr messages. See `PROTOCOL.md` for the full layout and
 * bit budgets. Every binary message starts with one byte: {@link MsgType}.
 */
import { Packr } from 'msgpackr';
import type { RoundDefinitionInput, RoundPhaseId, ShowPhaseId } from '@tumble/shared';
import type { MatchPlayerInfo } from './simTypes.ts';
import type { BitReader, BitWriter } from './bits.ts';
import type { Bounds } from './quantize.ts';

/** Bumped on any incompatible wire change; peers with different versions are rejected in the handshake. */
export const PROTOCOL_VERSION = 7;

/**
 * WebSocket close reason (with code 1000) a client sends when the player chose
 * to leave the show, so the server frees the seat at once instead of holding
 * it for a resume like a dropped connection.
 */
export const LEAVE_CLOSE_REASON = 'bye';

/** First byte of every binary message. Values are stable wire ids. */
export const MsgType = {
  Hello: 1,
  Welcome: 2,
  InputBatch: 3,
  Snapshot: 4,
  Reliable: 5,
  Ping: 6,
  Pong: 7,
  Kick: 8,
} as const;

/** Numeric message type id. */
export type MsgTypeId = (typeof MsgType)[keyof typeof MsgType];

/** Why the server closed a session. */
export const KickReason = {
  VersionMismatch: 1,
  RateLimited: 2,
  BadMessage: 3,
  ServerFull: 4,
  ResumeExpired: 5,
  Shutdown: 6,
  /** Missing, invalid or expired join ticket. */
  BadTicket: 7,
  /** A private show's host removed the player (relayed by the matchmaker). */
  RemovedByHost: 8,
} as const;

/** Numeric kick reason. */
export type KickReasonId = (typeof KickReason)[keyof typeof KickReason];

/** Peeks the message type of a raw message without consuming it. */
export function peekType(data: Uint8Array): number {
  return data.length > 0 ? data[0]! : 0;
}

// -----------------------------------------------------------------------------
// Handshake
// -----------------------------------------------------------------------------

/** Client → server: first message on a connection (also used to resume). */
export interface HelloMsg {
  version: number;
  name: string;
  /** Resume token from a previous Welcome, or empty for a fresh join. */
  resumeToken: string;
  /** Opaque cosmetic loadout id/blob forwarded to other players (≤ 255 bytes). */
  loadout: string;
  /**
   * Matchmaker join ticket (HS256 JWT) placing the player into a specific
   * match. Empty/absent for unticketed dev joins; ignored when resuming.
   */
  ticket?: string;
}

/** Server → client: session accepted. */
export interface WelcomeMsg {
  version: number;
  /** This client's player/entity id (below `MAX_ENTITIES`; spectators sit above the player range). */
  playerId: number;
  /** Present it in a later Hello within the resume window to reclaim the player. */
  resumeToken: string;
  roomId: string;
  /** Server network tick at the time of sending. */
  serverTick: number;
  /** Server clock (ms) at which network tick 0 happened; tick T happened at `tickEpochMs + T * tickMs`. */
  tickEpochMs: number;
  /** Network tick length in ms (1000 / SERVER_TICK_HZ). */
  tickMs: number;
  /** True when this Welcome reattached an existing player. */
  resumed: boolean;
}

/** Longest join ticket a Hello carries; longer ones are truncated (and then fail verification). */
export const MAX_TICKET_BYTES = 2048;

/** Writes a Hello. */
export function writeHello(w: BitWriter, m: HelloMsg): void {
  w.writeBits(MsgType.Hello, 8);
  w.writeBits(m.version, 16);
  w.writeString(m.name, 32);
  w.writeString(m.resumeToken, 64);
  w.writeString(m.loadout, 255);
  w.writeString(m.ticket ?? '', MAX_TICKET_BYTES);
}

/** Reads a Hello after its type byte. */
export function readHello(r: BitReader): HelloMsg {
  return {
    version: r.readBits(16),
    name: r.readString(),
    resumeToken: r.readString(),
    loadout: r.readString(),
    ticket: r.readString(),
  };
}

/** Writes a Welcome. */
export function writeWelcome(w: BitWriter, m: WelcomeMsg): void {
  w.writeBits(MsgType.Welcome, 8);
  w.writeBits(m.version, 16);
  w.writeBits(m.playerId, 8);
  w.writeString(m.resumeToken, 64);
  w.writeString(m.roomId, 64);
  w.writeBits(m.serverTick, 32);
  w.writeFloat64(m.tickEpochMs);
  w.writeFloat64(m.tickMs);
  w.writeBool(m.resumed);
}

/** Reads a Welcome after its type byte. */
export function readWelcome(r: BitReader): WelcomeMsg {
  return {
    version: r.readBits(16),
    playerId: r.readBits(8),
    resumeToken: r.readString(),
    roomId: r.readString(),
    serverTick: r.readBits(32),
    tickEpochMs: r.readFloat64(),
    tickMs: r.readFloat64(),
    resumed: r.readBool(),
  };
}

/** Writes a Kick (server → client, followed by close). */
export function writeKick(w: BitWriter, reason: KickReasonId, detail: string): void {
  w.writeBits(MsgType.Kick, 8);
  w.writeBits(reason, 8);
  w.writeString(detail, 200);
}

/** Reads a Kick after its type byte. */
export function readKick(r: BitReader): { reason: number; detail: string } {
  return { reason: r.readBits(8), detail: r.readString() };
}

// -----------------------------------------------------------------------------
// Clock sync (NTP-style)
// -----------------------------------------------------------------------------

/** Writes a Ping carrying the client send time t0 (client clock, ms). */
export function writePing(w: BitWriter, t0: number): void {
  w.writeBits(MsgType.Ping, 8);
  w.writeFloat64(t0);
}

/** Reads a Ping's t0 after its type byte. */
export function readPing(r: BitReader): number {
  return r.readFloat64();
}

/** Writes a Pong: t0 echoed, t1 server receive, t2 server send (server clock, ms). */
export function writePong(w: BitWriter, t0: number, t1: number, t2: number): void {
  w.writeBits(MsgType.Pong, 8);
  w.writeFloat64(t0);
  w.writeFloat64(t1);
  w.writeFloat64(t2);
}

/** Reads a Pong after its type byte. */
export function readPong(r: BitReader): { t0: number; t1: number; t2: number } {
  return { t0: r.readFloat64(), t1: r.readFloat64(), t2: r.readFloat64() };
}

// -----------------------------------------------------------------------------
// Low-frequency messages (msgpackr, carried on the reliable channel)
// -----------------------------------------------------------------------------

/** Public player entry for lobby lists, nameplates and the player wall. */
export interface NetPlayerInfo {
  id: number;
  name: string;
  isBot: boolean;
  /** Opaque loadout blob from Hello (bots: generated). */
  loadout: string;
  connected: boolean;
  /**
   * Account id from the join ticket, for profile cards, friend requests,
   * reports and client-side block/mute. Absent for bots and dev joins.
   */
  userId?: string;
  /** Duos/squads party id (teammates share fates and the Crown); absent in solo shows. */
  partyId?: number;
}

/** Everything a client needs to build the round locally and decode its snapshots. */
export interface JoinRoundMsg {
  t: 'joinRound';
  roundId: string;
  seed: number;
  stage: number;
  players: MatchPlayerInfo[];
  /** Index → obstacle id table used by snapshot obstacle states. */
  obstacleIds: string[];
  bounds: Bounds;
  /** Snapshot epoch for this round; snapshots from other epochs are ignored. */
  epoch: number;
  /** Server network tick at which the round's sim was created. */
  startTick: number;
  /** 0-based round index within the show. */
  roundIndex: number;
  /** The show's final round (one winner). */
  isFinal: boolean;
  /** Players the round qualifies (1 in a final). */
  qualifyTarget: number;
  /** Seeded (or forced) layout variation id; null when the round has none. */
  variationId: string | null;
  /**
   * v3: the pre-show lobby platform (`PRE_SHOW_LOBBY_ROUND`), not a show round.
   * Players join and leave it live; it never produces results.
   */
  lobby?: boolean;
  /**
   * Show mutator (`@tumble/sim/mutators` id) the server applies; predicting
   * clients must pass it to their sim. Absent or null: none.
   */
  mutatorId?: string | null;
  /** Round timer multiplier the server applies (0.5–2). Absent: 1. */
  roundTimeScale?: number;
  /**
   * A shared custom round (`custom:<CODE>` ids) is not in any client build:
   * the server sends the exact definition it plays. Clients validate it with
   * the same rules before building it.
   */
  round?: RoundDefinitionInput;
}

/** Show context, sent once per connection right after Welcome. */
export interface ShowInfoMsg {
  t: 'showInfo';
  /** Matchmaker match id; null in an unticketed dev room. */
  matchId: string | null;
  playlistId: string;
  /** Playlist display name. */
  showName: string;
  queue: 'casual' | 'ranked' | 'custom' | 'dev';
  /** Estimated rounds (the real count depends on results). */
  roundCount: number;
  /**
   * v7: whether this connection may chat into the show. False for a private
   * show's spectator seat unless the host allowed spectator chat; older
   * servers leave it out (treated as allowed).
   */
  canChat?: boolean;
}

/**
 * Client → server: who or where a spectator watches (drives interest
 * management). Sent when the followed player changes and, with `target` -1,
 * while a free or overview camera moves (v7, at most 2 Hz).
 */
export interface SpectateMsg {
  t: 'spectate';
  /** Followed player id, or -1 for a camera not tied to anyone. */
  target: number;
  /** v7: world point `[x, y, z]` (whole metres) a camera not tied to anyone looks at. */
  focus?: [number, number, number];
}

/** One labelled reward line (the API's `RewardLine`). */
export interface RewardLineMsg {
  label: string;
  amount: number;
}

/** The parts of the API's `PlayerRewardSummary` the client renders. */
export interface PlayerRewardMsg {
  placement: number;
  crowned: boolean;
  roundsQualified: number;
  xp: { total: number; lines: RewardLineMsg[] };
  level: { before: number; after: number };
  gumballs: { total: number; lines: RewardLineMsg[] };
  crownShards: number;
  crownsFromShards: number;
  pass: { xp: number; tierBefore: number; tierAfter: number };
  challenges: { title: string; before: number; progress: number; target: number; completed: boolean }[];
  /** Achievements this show unlocked (their XP and currency are already in the lines above). */
  achievements?: { id: string; title: string; description: string; hidden: boolean }[];
  /** Limited-time events this show counted toward (the API's `EventShowUpdate`). */
  events?: {
    eventId: string;
    name: string;
    gained: number;
    pointsBefore: number;
    pointsAfter: number;
    tierBefore: number;
    tierAfter: number;
    tiers: number;
    challenges: { title: string; before: number; progress: number; target: number; completed: boolean }[];
  }[];
  ranked: {
    rpBefore: number;
    rpAfter: number;
    rpDelta: number;
    label: string;
    placementsLeft: number;
  } | null;
  wallet: { gumballs: number; gems: number };
}

/**
 * Server → client after the show: the account API's grant for this player,
 * forwarded once the game server posted the results. `reward` is null when
 * nothing was recorded (API unreachable, spectator); the client then falls
 * back to its local estimate.
 */
export interface ShowRewardsMsg {
  t: 'showRewards';
  matchId: string;
  reward: PlayerRewardMsg | null;
}

/** Per-player outcome of a round. */
export interface RoundResultEntry {
  id: number;
  status: number;
  place: number;
  score: number;
  /** v3: eliminated but carried into the next round by a qualifying teammate (duos/squads). */
  carried?: boolean;
}

/**
 * In-show chat. Client → server: either `text` or a quick-chat preset id in
 * `quick` (`from` is ignored). Server → client: the relayed message; `text` has
 * slurs masked, `masked` (when present) is the fully filtered variant for
 * players with the chat filter on.
 */
export interface ChatMsg {
  t: 'chat';
  from: number;
  text: string;
  masked?: string;
  /** Quick-chat preset id (`@tumble/shared` QUICK_CHAT). */
  quick?: string;
}

/**
 * Client → server, about every 500 ms while the client builds a round. It is
 * a heartbeat as much as a progress report: the server keeps waiting for a
 * player while these arrive and gives up on one that goes quiet.
 */
export interface LoadProgressMsg {
  t: 'loadProgress';
  roundId: string;
  /** Local build progress, 0..1. */
  pct: number;
}

/** Most player ids a {@link LoadingStatusMsg} lists. */
export const LOADING_STATUS_MAX_WAITING = 8;

/** Server → client, at most 2 Hz while the round is in LOADING. */
export interface LoadingStatusMsg {
  t: 'loadingStatus';
  roundId: string;
  /** Human entrants who finished loading. */
  loaded: number;
  /** Human entrants still in the show. */
  total: number;
  /** Connected players the round is still waiting for (at most {@link LOADING_STATUS_MAX_WAITING}). */
  waitingOn: number[];
}

/** Most options a round-vote ballot carries. */
export const VOTE_MAX_OPTIONS = 4;

/**
 * Server → client (v6), per connection: the ballot for the next round
 * opened. Also re-sent on (re)attach while a ballot is running, so a player
 * who reconnected mid-vote sees it again with their own ballot marked.
 */
export interface VoteOptionsMsg {
  t: 'voteOptions';
  /** Round the ballot is for. */
  roundIndex: number;
  /** The ballot is for the final (playlists that vote on finals). */
  isFinal: boolean;
  /** Candidate round ids, in display order (at most {@link VOTE_MAX_OPTIONS}). */
  options: string[];
  /** Raw ballots per option so far. */
  counts: number[];
  /** Ballots cast so far. */
  voted: number;
  /** Players allowed to vote. */
  eligible: number;
  /** Time until the ballot closes at the latest. */
  closesInMs: number;
  /** This connection's player may vote (false for eliminated players and spectators). */
  canVote: boolean;
  /** This player's current ballot (option index), or -1. */
  yourVote: number;
  /** Bot ballots count for less than a human's. */
  botsDiscounted: boolean;
}

/**
 * Client → server (v6): vote for (or change to) an option. Ignored unless
 * the ballot for `roundIndex` is open and the sender may vote.
 */
export interface CastVoteMsg {
  t: 'castVote';
  roundIndex: number;
  /** Option index in {@link VoteOptionsMsg.options}. */
  option: number;
}

/** Server → client (v6), at most 4 Hz while ballots change. */
export interface VoteTallyMsg {
  t: 'voteTally';
  roundIndex: number;
  /** Raw ballots per option. */
  counts: number[];
  /** Ballots cast. */
  voted: number;
}

/** Server → client (v6): the ballot closed. */
export interface VoteResultMsg {
  t: 'voteResult';
  roundIndex: number;
  /** Winning option index, or -1 when the vote was called off (the show ended). */
  winner: number;
  /** Winning round id ('' when called off). */
  roundId: string;
  /** Final raw ballots per option. */
  counts: number[];
  /** How it was decided: most votes, a seeded tie-break, or a seeded pick with no votes. */
  reason: 'votes' | 'tie' | 'noVotes' | 'cancelled';
}

/** Union of low-frequency messages. `t` is the discriminant. */
export type LowFreqMessage =
  | JoinRoundMsg
  | { t: 'playerList'; players: NetPlayerInfo[] }
  | { t: 'roundResults'; roundId: string; results: RoundResultEntry[] }
  | { t: 'showSummary'; winners: number[]; rounds: { roundId: string; qualified: number[] }[] }
  | ChatMsg
  /** Client → server: finished loading the round (scene built and shaders compiled). */
  | { t: 'loaded'; roundId: string }
  | LoadProgressMsg
  | LoadingStatusMsg
  | SpectateMsg
  /** Server → client: lobby countdown before the show fills with bots. */
  | { t: 'lobby'; humans: number; capacity: number; startsInMs: number }
  /** `startsInMs` (v3, PreShow only): time until round 1 is selected. */
  | { t: 'showPhase'; phase: ShowPhaseId; startsInMs?: number }
  | { t: 'roundPhase'; phase: RoundPhaseId; time: number }
  | ShowInfoMsg
  | ShowRewardsMsg
  | VoteOptionsMsg
  | CastVoteMsg
  | VoteTallyMsg
  | VoteResultMsg;

/** Low-frequency message type discriminant. */
export type LowFreqType = LowFreqMessage['t'];

// Plain msgpack (no record extension): readable by any msgpack decoder and stateless between messages.
const packr = new Packr({ useRecords: false, moreTypes: false });

/** Serialises a low-frequency message with msgpackr. */
export function packLowFreq(msg: LowFreqMessage): Uint8Array {
  return packr.pack(msg);
}

/**
 * Deserialises a low-frequency message. Validates only the discriminant; each
 * consumer validates the fields it trusts (the server never trusts clients).
 *
 * @returns The message, or `null` if malformed.
 */
export function unpackLowFreq(bytes: Uint8Array): LowFreqMessage | null {
  try {
    const v: unknown = packr.unpack(bytes);
    if (typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string')
      return v as LowFreqMessage;
  } catch {
    // Malformed payloads are reported as null below.
  }
  return null;
}
