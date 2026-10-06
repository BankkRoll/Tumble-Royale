/**
 * Voice chat protocol: the vocabulary the API, the game servers and the
 * browser agree on for opt-in WebRTC voice between party members and, in team
 * rounds, teammates.
 *
 * Audio flows peer to peer (a full mesh, Opus only); the API realtime gateway
 * only relays signalling between members of the same voice room, and the API
 * alone decides who is in which room.
 *
 * Responsibilities:
 * - the wire shapes in both directions ({@link VoiceClientMessage},
 *   {@link VoiceRoomEvent}, {@link VoiceSignalEvent}, {@link VoiceOffEvent});
 * - limits shared by the client sender and the gateway ({@link VOICE_LIMITS});
 * - {@link sanitizeVoiceMessage}: the single validation step the gateway
 *   applies before acting on a client message (size caps, audio-only SDP);
 * - {@link voiceSquads}: how a team is split into mesh-sized squads with
 *   parties kept together;
 * - {@link voiceOfferer}: which side of a pair makes the offer, so two peers
 *   never offer at once.
 *
 * Pure: no DOM, no Node APIs.
 */

/** Client → server message types. */
export const VOICE_CLIENT_TYPES = ['voice_join', 'voice_leave', 'voice_signal'] as const;
/** A client → server message type. */
export type VoiceClientType = (typeof VOICE_CLIENT_TYPES)[number];

/** Limits shared by the client and the gateway. */
export const VOICE_LIMITS = {
  /** Most peers in a party room (the party size cap). */
  maxPartyPeers: 4,
  /** Most players in one team voice squad (a mesh beyond this costs too much upload). */
  maxSquad: 8,
  /** Largest raw signalling message (UTF-16 code units of the JSON text). */
  maxMessageBytes: 12_000,
  /** Largest SDP blob. An audio-only offer is 2–4 KB; candidates trickle separately. */
  maxSdpLength: 10_000,
  /** Largest ICE candidate line. */
  maxCandidateLength: 512,
  /** Token-bucket burst of signalling messages per user. */
  signalBurst: 60,
  /** Token-bucket refill (messages per second) per user. */
  signalPerSecond: 20,
  /** Joins (including credential refreshes) allowed per user per minute. */
  joinsPerMinute: 12,
  /** How long an opted-in user stays in voice without a keep-alive (the realtime ping). */
  presenceTtlMs: 90_000,
} as const;

/** Lifetime of the TURN credentials the API hands out (seconds). */
export const VOICE_CREDENTIAL_TTL_SEC = 4 * 3600;

/** What kind of room a player is talking in. */
export type VoiceRoomKind = 'party' | 'team';

/** Why the server ended a player's voice session. */
export const VOICE_OFF_REASONS = ['disabled', 'muted', 'banned', 'replaced', 'expired'] as const;
/** A reason the server ended a player's voice session. */
export type VoiceOffReason = (typeof VOICE_OFF_REASONS)[number];

/** Signal kinds relayed between two peers. */
export const VOICE_SIGNAL_KINDS = ['offer', 'answer', 'ice', 'restart'] as const;
/** A signal kind; `restart` asks the offerer for an ICE restart. */
export type VoiceSignalKind = (typeof VOICE_SIGNAL_KINDS)[number];

/** An ICE candidate as `RTCIceCandidateInit` carries it; `candidate: ''` is end-of-candidates. */
export interface VoiceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

/**
 * Opts in (or refreshes credentials). `cid` names the browser tab: voice runs
 * in one tab at a time and a join from another tab replaces it.
 */
export interface VoiceJoinMessage {
  type: 'voice_join';
  cid: string;
  /** Also talk to teammates outside the party in team rounds. */
  team: boolean;
}

/** Opts out. */
export interface VoiceLeaveMessage {
  type: 'voice_leave';
  cid: string;
}

/** A signal for one peer. */
export interface VoiceSignalMessage {
  type: 'voice_signal';
  cid: string;
  /** Recipient user id. */
  to: string;
  kind: VoiceSignalKind;
  /** Offer/answer SDP. */
  sdp?: string;
  /** Trickled candidate. */
  candidate?: VoiceCandidate;
}

/** Every client → server voice message. */
export type VoiceClientMessage = VoiceJoinMessage | VoiceLeaveMessage | VoiceSignalMessage;

/** One `RTCIceServer` as the client passes it to `RTCPeerConnection`. */
export interface VoiceIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** A peer in the recipient's room (never someone either side blocked). */
export interface VoicePeer {
  userId: string;
  name: string;
  tag: string;
}

/**
 * The recipient's current room, pushed on join and whenever membership
 * changes (party join/leave/kick, a block, a sanction, a team round
 * starting or ending). The peer list is authoritative: the client connects to
 * exactly these peers and drops every other connection.
 */
export interface VoiceRoomEvent {
  type: 'voice_room';
  /** The tab that owns the session; other tabs ignore the event. */
  cid: string;
  /** Null while opted in but alone (no party, no team squad). */
  room: { id: string; kind: VoiceRoomKind } | null;
  peers: VoicePeer[];
  ice: {
    servers: VoiceIceServer[];
    /** Epoch ms when the TURN credentials stop working (0 when there is no TURN). */
    expiresAt: number;
    /** A TURN relay is configured, so "relay only" can work. */
    relay: boolean;
  };
}

/** A signal from a peer in the same room. */
export interface VoiceSignalEvent {
  type: 'voice_signal';
  from: string;
  roomId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: VoiceCandidate;
}

/** The server ended the session: close every connection and release the mic. */
export interface VoiceOffEvent {
  type: 'voice_off';
  /** The tab whose session ended; absent means every tab. */
  cid?: string;
  reason: VoiceOffReason;
}

/** Every server → client voice event. */
export type VoiceServerEvent = VoiceRoomEvent | VoiceSignalEvent | VoiceOffEvent;

/** What `GET /voice/config` answers. */
export interface VoiceConfigResponse {
  /** Voice can be switched on right now (flag on, server configured, not sanctioned). */
  available: boolean;
  /** Why not, when unavailable. */
  reason: 'flag_off' | 'not_configured' | 'muted' | null;
  /** A TURN relay is configured ("relay only" works). */
  relay: boolean;
  /** Team voice with players outside the party is allowed for this account. */
  teamVoice: boolean;
}

const CID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for an SDP blob whose every media section is audio. A peer that slips
 * in video or a data channel is refused before the other browser sees it.
 *
 * @param sdp - Untrusted SDP text.
 * @returns Whether it is an audio-only session description.
 * @example
 * isAudioOnlySdp('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'); // true
 */
export function isAudioOnlySdp(sdp: string): boolean {
  if (!sdp.startsWith('v=0')) return false;
  const media = sdp.split(/\r?\n/).filter((l) => l.startsWith('m='));
  return media.length > 0 && media.every((l) => l.startsWith('m=audio '));
}

function sanitizeCandidate(raw: unknown): VoiceCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.candidate !== 'string' || c.candidate.length > VOICE_LIMITS.maxCandidateLength) return null;
  if (c.candidate !== '' && !c.candidate.startsWith('candidate:')) return null;
  const mid = c.sdpMid ?? null;
  const index = c.sdpMLineIndex ?? null;
  if (mid !== null && (typeof mid !== 'string' || mid.length > 32)) return null;
  if (index !== null && (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 16))
    return null;
  const out: VoiceCandidate = { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: index as number | null };
  const frag = c.usernameFragment;
  if (typeof frag === 'string' && frag.length <= 64) out.usernameFragment = frag;
  return out;
}

/**
 * Validates a client voice message. Anything malformed, oversized, aimed at
 * a non-uuid, or carrying non-audio media is rejected whole.
 *
 * @param raw - Parsed JSON from the socket.
 * @returns The message with only known fields, or null.
 * @example
 * sanitizeVoiceMessage({ type: 'voice_leave', cid: 'tab_12345678' }); // { type: 'voice_leave', cid: 'tab_12345678' }
 */
export function sanitizeVoiceMessage(raw: unknown): VoiceClientMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.cid !== 'string' || !CID_RE.test(m.cid)) return null;
  if (m.type === 'voice_join') return { type: 'voice_join', cid: m.cid, team: m.team === true };
  if (m.type === 'voice_leave') return { type: 'voice_leave', cid: m.cid };
  if (m.type !== 'voice_signal') return null;
  if (typeof m.to !== 'string' || !UUID_RE.test(m.to)) return null;
  const kind = m.kind;
  if (typeof kind !== 'string' || !(VOICE_SIGNAL_KINDS as readonly string[]).includes(kind)) return null;
  const out: VoiceSignalMessage = {
    type: 'voice_signal',
    cid: m.cid,
    to: m.to,
    kind: kind as VoiceSignalKind,
  };
  if (kind === 'offer' || kind === 'answer') {
    if (typeof m.sdp !== 'string' || m.sdp.length > VOICE_LIMITS.maxSdpLength || !isAudioOnlySdp(m.sdp))
      return null;
    out.sdp = m.sdp;
  } else if (kind === 'ice') {
    const c = sanitizeCandidate(m.candidate);
    if (!c) return null;
    out.candidate = c;
  }
  return out;
}

/**
 * Whether `self` makes the offer to `other`. The smaller id offers, so both
 * sides agree without talking and never offer at the same time.
 *
 * @param self - This player's id.
 * @param other - The peer's id.
 * @returns True when `self` is the offerer.
 */
export function voiceOfferer(self: string, other: string): boolean {
  return self < other;
}

/** A player as {@link voiceSquads} sees them. */
export interface SquadCandidate {
  userId: string;
  team: number;
  /** Queue party, so friends who queued together land in one squad. */
  partyId?: string | null;
}

/**
 * Splits each team into squads of at most `size`, keeping parties together:
 * parties go in first (largest first), each into the first squad of its team
 * with room, then solo players fill the gaps. Input order breaks ties so the
 * same roster always yields the same squads.
 *
 * @param players - Humans in the round with their team (negative = no team, skipped).
 * @param size - Squad cap (default {@link VOICE_LIMITS.maxSquad}).
 * @returns Squads per team; each squad is a list of user ids.
 * @example
 * voiceSquads([{ userId: 'a', team: 0 }, { userId: 'b', team: 0 }], 8); // Map { 0 => [['a', 'b']] }
 */
export function voiceSquads(
  players: readonly SquadCandidate[],
  size: number = VOICE_LIMITS.maxSquad,
): Map<number, string[][]> {
  const cap = Math.max(1, Math.floor(size));
  const out = new Map<number, string[][]>();
  const byTeam = new Map<number, SquadCandidate[]>();
  for (const p of players) {
    if (p.team < 0 || !Number.isInteger(p.team)) continue;
    byTeam.set(p.team, [...(byTeam.get(p.team) ?? []), p]);
  }
  for (const [team, members] of [...byTeam].sort((a, b) => a[0] - b[0])) {
    const groups = new Map<string, string[]>();
    const solos: string[] = [];
    for (const p of members) {
      if (p.partyId) groups.set(p.partyId, [...(groups.get(p.partyId) ?? []), p.userId]);
      else solos.push(p.userId);
    }
    const units = [...groups.values()].sort((a, b) => b.length - a.length);
    const squads: string[][] = [];
    for (const unit of units) {
      // A party bigger than a squad (never, with the 4-player party cap) is split rather than dropped.
      for (let i = 0; i < unit.length; i += cap) {
        const part = unit.slice(i, i + cap);
        const home = squads.find((s) => s.length + part.length <= cap);
        if (home) home.push(...part);
        else squads.push(part);
      }
    }
    for (const id of solos) {
      const home = squads.find((s) => s.length < cap);
      if (home) home.push(id);
      else squads.push([id]);
    }
    out.set(team, squads);
  }
  return out;
}
