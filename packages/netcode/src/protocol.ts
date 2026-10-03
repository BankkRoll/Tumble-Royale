/**
 * Wire protocol: message type ids, handshake and clock-sync codecs, and the
 * low-frequency msgpackr messages. See `PROTOCOL.md` for the full layout and
 * bit budgets. Every binary message starts with one byte: {@link MsgType}.
 */
import { Packr } from 'msgpackr';
import type { RoundPhaseId, ShowPhaseId } from '@tumble/shared';
import type { MatchPlayerInfo } from './simTypes.ts';
import type { BitReader, BitWriter } from './bits.ts';
import type { Bounds } from './quantize.ts';

/** Bumped on any incompatible wire change; peers with different versions are rejected in the handshake. */
export const PROTOCOL_VERSION = 2;

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
  /** This client's player/entity id (0–63). */
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
   * Show mutator (`@tumble/sim/mutators` id) the server applies; predicting
   * clients must pass it to their sim. Absent or null: none.
   */
  mutatorId?: string | null;
  /** Round timer multiplier the server applies (0.5–2). Absent: 1. */
  roundTimeScale?: number;
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
}

/** Union of low-frequency messages. `t` is the discriminant. */
export type LowFreqMessage =
  | JoinRoundMsg
  | { t: 'playerList'; players: NetPlayerInfo[] }
  | { t: 'roundResults'; roundId: string; results: RoundResultEntry[] }
  | { t: 'showSummary'; winners: number[]; rounds: { roundId: string; qualified: number[] }[] }
  | { t: 'chat'; from: number; text: string }
  /** Client → server: finished loading the round. */
  | { t: 'loaded'; roundId: string }
  /** Client → server: who to spectate (drives interest management). */
  | { t: 'spectate'; target: number }
  /** Server → client: lobby countdown before the show fills with bots. */
  | { t: 'lobby'; humans: number; capacity: number; startsInMs: number }
  | { t: 'showPhase'; phase: ShowPhaseId }
  | { t: 'roundPhase'; phase: RoundPhaseId; time: number }
  | ShowInfoMsg
  | ShowRewardsMsg;

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
