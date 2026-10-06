/**
 * Voice rooms: who may talk to whom. The API is the only authority; clients
 * are told their peers and connect to exactly those.
 *
 * Responsibilities:
 * - sessions: a player opts in from one tab (`voice-on:<user>`, kept alive
 *   by the realtime ping, gone after {@link VOICE_LIMITS.presenceTtlMs});
 * - rooms: a team squad during a team round when the player opted into team
 *   voice (reported by the game server, see {@link setTeamRooms}), else the
 *   current party, else none;
 * - peers: room members who are also in voice, in the same room, not blocked
 *   either way and not voice-muted or suspended;
 * - pushing `voice_room` whenever any of that changes, to everyone it touches
 *   (both sides of a block, everyone a leaver was connected to);
 * - relaying signalling only between two players who are each other's peers;
 * - ending sessions on a voice mute or suspension, on every instance at once
 *   (the notifier and the ban cache are both cluster-wide);
 * - remembering who shared a room with whom for an hour, so a voice report
 *   carries room and time metadata. No audio is recorded anywhere.
 *
 * Everything lives in the KV, so any API instance can answer for any player.
 */
import { eq, inArray } from 'drizzle-orm';
import {
  VOICE_CREDENTIAL_TTL_SEC,
  VOICE_LIMITS,
  voiceSquads,
  type SquadCandidate,
  type VoiceConfigResponse,
  type VoiceOffReason,
  type VoicePeer,
  type VoiceRoomKind,
  type VoiceSignalMessage,
} from '@tumble/shared';
import type { AppContext } from '../context.ts';
import { profiles, users } from '../db/schema.ts';
import { activeBans } from '../http/auth.ts';
import { ApiError, forbidden } from '../http/errors.ts';
import { serverFlag } from '../liveops/state.ts';
import type { EvidenceLine } from '../social/chatEvidence.ts';
import { blockedEitherWay, isBlockedEitherWay } from '../social/friends.ts';
import { PartyService } from '../social/party.ts';
import { iceServersFor } from './turn.ts';

/** Accounts must be this old (days) before team voice puts them with strangers. */
export const VOICE_TEAM_MIN_ACCOUNT_AGE_DAYS = 3;
/** How long a team-round assignment outlives a game server that never cleared it. */
export const VOICE_TEAM_TTL_MS = 20 * 60_000;
/** How long "who shared a room with whom" is kept for reports. */
export const VOICE_SEEN_TTL_MS = 60 * 60_000;
const SEEN_MAX = 50;

/** A player's voice session as stored. */
export interface VoiceSession {
  /** Tab that owns it. */
  cid: string;
  /** Opted into team voice (and allowed to). */
  team: boolean;
  /** Epoch ms of the opt-in. */
  since: number;
  /** Room and peers last pushed, so a change can tell the ones left behind. */
  roomId: string | null;
  peers: string[];
  /** Expiry of the TURN credentials last pushed (epoch ms, 0 without TURN). */
  iceExpiresAt: number;
}

/** A resolved room. */
export interface VoiceRoom {
  id: string;
  kind: VoiceRoomKind;
  /** Everyone who belongs in it (not only those in voice). */
  members: string[];
}

interface TeamAssignment {
  matchId: string;
  roomId: string;
  members: string[];
}

interface SeenEntry {
  roomId: string;
  kind: VoiceRoomKind;
  firstAt: number;
  lastAt: number;
}

/** Why a signal was not relayed (tests and metrics). */
export type VoiceSignalOutcome = 'relayed' | 'not_in_voice' | 'disabled' | 'restricted' | 'not_peer';

const sessionKey = (userId: string) => `voice-on:${userId}`;
const teamKey = (userId: string) => `voice-team:${userId}`;
const matchKey = (matchId: string) => `voice-match:${matchId}`;
const seenKey = (userId: string) => `voice-seen:${userId}`;

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The player's voice session, if they are in voice.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 */
export async function voiceSession(ctx: AppContext, userId: string): Promise<VoiceSession | null> {
  return parse<VoiceSession>(await ctx.kv.get(sessionKey(userId)));
}

async function saveSession(ctx: AppContext, userId: string, s: VoiceSession): Promise<void> {
  await ctx.kv.set(sessionKey(userId), JSON.stringify(s), VOICE_LIMITS.presenceTtlMs);
}

/**
 * The sanction keeping a player out of voice, if any: a voice mute or a
 * suspension.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 * @returns `muted`, `banned` or null.
 */
export async function voiceRestriction(ctx: AppContext, userId: string): Promise<'muted' | 'banned' | null> {
  const bans = await activeBans(ctx, userId);
  if (bans.some((b) => b.scope === 'all')) return 'banned';
  if (bans.some((b) => b.scope === 'voice')) return 'muted';
  return null;
}

/** Voice is switched on by the operator and the server can serve it. */
async function voiceEnabled(ctx: AppContext): Promise<boolean> {
  return ctx.config.voice.available && (await serverFlag(ctx, 'voice.enabled'));
}

/**
 * Whether team voice may put this account with players outside its party:
 * never for guests (no recovery, no friction to replace after a sanction),
 * and only once the account is {@link VOICE_TEAM_MIN_ACCOUNT_AGE_DAYS} old.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 */
export async function teamVoiceAllowed(ctx: AppContext, userId: string): Promise<boolean> {
  const [u] = await ctx.db
    .select({ guest: users.isGuest, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.guest) return false;
  return ctx.now().getTime() - u.createdAt.getTime() >= VOICE_TEAM_MIN_ACCOUNT_AGE_DAYS * 86_400_000;
}

/**
 * What the client needs to decide whether to show voice at all.
 *
 * @param ctx - Shared services.
 * @param userId - Caller.
 * @returns See {@link VoiceConfigResponse}.
 */
export async function voiceAvailability(ctx: AppContext, userId: string): Promise<VoiceConfigResponse> {
  const relay = ctx.config.voice.turnUrls.length > 0;
  const teamVoice = await teamVoiceAllowed(ctx, userId);
  if (!ctx.config.voice.available) return { available: false, reason: 'not_configured', relay, teamVoice };
  if (!(await serverFlag(ctx, 'voice.enabled')))
    return { available: false, reason: 'flag_off', relay, teamVoice };
  if (await voiceRestriction(ctx, userId)) return { available: false, reason: 'muted', relay, teamVoice };
  return { available: true, reason: null, relay, teamVoice };
}

/**
 * The room a player in voice belongs to right now.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 * @param session - Their session.
 * @returns The room, or null when alone.
 */
export async function resolveRoom(
  ctx: AppContext,
  userId: string,
  session: VoiceSession,
): Promise<VoiceRoom | null> {
  if (session.team) {
    const t = parse<TeamAssignment>(await ctx.kv.get(teamKey(userId)));
    if (t && t.members.includes(userId) && t.members.length > 1)
      return { id: t.roomId, kind: 'team', members: t.members };
  }
  const party = await new PartyService(ctx).current(userId);
  if (party && party.members.length > 1)
    return { id: `party:${party.id}`, kind: 'party', members: party.members.map((m) => m.userId) };
  return null;
}

/**
 * The peers a player may connect to in a room: members in voice, in that
 * same room, not blocked either way, not sanctioned.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 * @param room - Their room.
 * @returns Peers with names, in member order.
 */
export async function voicePeers(ctx: AppContext, userId: string, room: VoiceRoom): Promise<VoicePeer[]> {
  const hidden = await blockedEitherWay(ctx.db, userId);
  const ids: string[] = [];
  for (const id of room.members) {
    if (id === userId || hidden.has(id)) continue;
    const s = await voiceSession(ctx, id);
    if (!s || (await voiceRestriction(ctx, id))) continue;
    if ((await resolveRoom(ctx, id, s))?.id !== room.id) continue;
    ids.push(id);
  }
  if (!ids.length) return [];
  const rows = await ctx.db
    .select({ id: profiles.userId, name: profiles.displayName, tag: profiles.tag })
    .from(profiles)
    .where(inArray(profiles.userId, ids));
  return ids.flatMap((id) => {
    const p = rows.find((r) => r.id === id);
    return p ? [{ userId: id, name: p.name, tag: p.tag }] : [];
  });
}

async function remember(ctx: AppContext, userId: string, room: VoiceRoom, peers: string[]): Promise<void> {
  if (!peers.length) return;
  const now = ctx.now().getTime();
  const seen = parse<Record<string, SeenEntry>>(await ctx.kv.get(seenKey(userId))) ?? {};
  for (const id of peers) {
    const prev = seen[id];
    seen[id] =
      prev && prev.roomId === room.id
        ? { ...prev, lastAt: now }
        : { roomId: room.id, kind: room.kind, firstAt: now, lastAt: now };
  }
  const kept = Object.entries(seen)
    .sort((a, b) => b[1].lastAt - a[1].lastAt)
    .slice(0, SEEN_MAX);
  await ctx.kv.set(seenKey(userId), JSON.stringify(Object.fromEntries(kept)), VOICE_SEEN_TTL_MS);
}

/**
 * Recomputes one player's room and pushes it when it changed (or `force`).
 *
 * @returns Everyone whose view may have changed with it: old and new peers.
 */
async function refreshOne(ctx: AppContext, userId: string, force: boolean): Promise<string[]> {
  const s = await voiceSession(ctx, userId);
  if (!s) return [];
  const restricted = await voiceRestriction(ctx, userId);
  if (restricted || !(await voiceEnabled(ctx))) {
    await endSession(ctx, userId, s, restricted ?? 'disabled');
    return s.peers;
  }
  const room = await resolveRoom(ctx, userId, s);
  const peers = room ? await voicePeers(ctx, userId, room) : [];
  const ids = peers.map((p) => p.userId);
  const now = ctx.now().getTime();
  const same =
    s.roomId === (room?.id ?? null) &&
    s.peers.length === ids.length &&
    s.peers.every((id, i) => id === ids[i]) &&
    // Credentials are re-minted well before they lapse.
    (s.iceExpiresAt === 0 || s.iceExpiresAt - now > (VOICE_CREDENTIAL_TTL_SEC * 1000) / 2);
  const affected = [...new Set([...s.peers, ...ids])];
  if (same && !force) return affected;
  const ice = iceServersFor(ctx.config.voice, userId, room?.id ?? null, now);
  await saveSession(ctx, userId, { ...s, roomId: room?.id ?? null, peers: ids, iceExpiresAt: ice.expiresAt });
  await ctx.notifier.notifyUser(userId, {
    type: 'voice_room',
    cid: s.cid,
    room: room ? { id: room.id, kind: room.kind } : null,
    peers,
    ice: { ...ice, relay: ctx.config.voice.turnUrls.length > 0 },
  });
  if (room) await remember(ctx, userId, room, ids);
  return affected;
}

/**
 * Re-evaluates voice for these players and everyone they were or will be
 * connected to, pushing `voice_room` to each whose room or peers changed.
 * Cheap for players not in voice (one KV read each).
 *
 * @param ctx - Shared services.
 * @param userIds - Players whose party, team, blocks or sanctions changed.
 * @param force - Push to `userIds` even when nothing changed (a fresh join).
 */
export async function refreshVoice(ctx: AppContext, userIds: Iterable<string>, force = false): Promise<void> {
  const first = [...new Set(userIds)];
  const second = new Set<string>();
  for (const id of first) for (const other of await refreshOne(ctx, id, force)) second.add(other);
  for (const id of first) second.delete(id);
  for (const id of second) await refreshOne(ctx, id, false);
}

async function endSession(
  ctx: AppContext,
  userId: string,
  s: VoiceSession,
  reason: VoiceOffReason | null,
): Promise<void> {
  await ctx.kv.del(sessionKey(userId));
  if (reason) await ctx.notifier.notifyUser(userId, { type: 'voice_off', cid: s.cid, reason });
}

/**
 * Opts a player in from one tab, or refreshes that tab's credentials. A join
 * from another tab replaces the old one, which is told `replaced`.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 * @param cid - Tab id.
 * @param team - Wants team voice in team rounds.
 * @throws {ApiError} 503 `voice_disabled`, 403 `voice_muted`, 429 `voice_rate`.
 */
export async function joinVoice(ctx: AppContext, userId: string, cid: string, team: boolean): Promise<void> {
  if (!(await voiceEnabled(ctx))) throw new ApiError(503, 'voice_disabled', 'Voice chat is switched off');
  if (await voiceRestriction(ctx, userId))
    throw forbidden('voice_muted', 'Voice chat is disabled on this account');
  const now = ctx.now().getTime();
  const minute = Math.floor(now / 60_000);
  if ((await ctx.kv.incr(`voice-join-rate:${userId}:${minute}`, 120_000)) > VOICE_LIMITS.joinsPerMinute)
    throw new ApiError(429, 'voice_rate', 'Slow down a little');
  const prev = await voiceSession(ctx, userId);
  if (prev && prev.cid !== cid)
    await ctx.notifier.notifyUser(userId, { type: 'voice_off', cid: prev.cid, reason: 'replaced' });
  const sameTab = prev?.cid === cid;
  await saveSession(ctx, userId, {
    cid,
    team: team && (await teamVoiceAllowed(ctx, userId)),
    since: sameTab ? prev.since : now,
    roomId: sameTab ? prev.roomId : null,
    peers: prev?.peers ?? [],
    iceExpiresAt: 0,
  });
  await refreshVoice(ctx, [userId], true);
}

/**
 * Opts a player out. With a `cid`, only when that tab still owns the session
 * (a stale tab closing must not end the session another tab took over).
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 * @param cid - Tab that is leaving, or null for any.
 */
export async function leaveVoice(ctx: AppContext, userId: string, cid: string | null): Promise<void> {
  const s = await voiceSession(ctx, userId);
  if (!s || (cid !== null && s.cid !== cid)) return;
  await endSession(ctx, userId, s, null);
  await refreshVoice(ctx, s.peers);
}

/**
 * Ends a player's voice at once after a voice mute or suspension: their tabs
 * drop every connection and their peers are told to forget them.
 *
 * @param ctx - Shared services.
 * @param userId - Sanctioned player.
 * @param reason - `muted` or `banned`.
 */
export async function endVoiceForSanction(
  ctx: AppContext,
  userId: string,
  reason: 'muted' | 'banned',
): Promise<void> {
  const s = await voiceSession(ctx, userId);
  // Tabs that never opted in still hear it, so a voice toggle in Settings can grey out.
  await ctx.notifier.notifyUser(userId, { type: 'voice_off', reason });
  if (!s) return;
  await ctx.kv.del(sessionKey(userId));
  await refreshVoice(ctx, s.peers);
}

/**
 * Keeps a session alive (the realtime ping) and notices an operator switching
 * voice off.
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 */
export async function voiceKeepAlive(ctx: AppContext, userId: string): Promise<void> {
  const s = await voiceSession(ctx, userId);
  if (!s) return;
  if (!(await voiceEnabled(ctx))) {
    await endSession(ctx, userId, s, 'disabled');
    await refreshVoice(ctx, s.peers);
    return;
  }
  await saveSession(ctx, userId, s);
  if (s.roomId && s.peers.length) {
    const room = await resolveRoom(ctx, userId, s);
    if (room?.id === s.roomId) await remember(ctx, userId, room, s.peers);
  }
}

/**
 * Relays one signal, only between two players who are each other's peers
 * right now. Membership is re-read for every signal, so a kick, block or
 * mute takes effect on the very next one.
 *
 * @param ctx - Shared services.
 * @param userId - Authenticated sender.
 * @param msg - Validated signal.
 * @returns What happened to it.
 */
export async function relayVoiceSignal(
  ctx: AppContext,
  userId: string,
  msg: VoiceSignalMessage,
): Promise<VoiceSignalOutcome> {
  if (msg.to === userId) return 'not_peer';
  const s = await voiceSession(ctx, userId);
  if (!s || s.cid !== msg.cid) return 'not_in_voice';
  if (!(await voiceEnabled(ctx))) return 'disabled';
  if (await voiceRestriction(ctx, userId)) return 'restricted';
  // SECURITY: the room comes from server state, never from the message.
  const room = await resolveRoom(ctx, userId, s);
  if (!room || !room.members.includes(msg.to)) return 'not_peer';
  const t = await voiceSession(ctx, msg.to);
  if (!t || (await voiceRestriction(ctx, msg.to))) return 'not_peer';
  if ((await resolveRoom(ctx, msg.to, t))?.id !== room.id) return 'not_peer';
  if (await isBlockedEitherWay(ctx.db, userId, msg.to)) return 'not_peer';
  await ctx.notifier.notifyUser(msg.to, {
    type: 'voice_signal',
    from: userId,
    roomId: room.id,
    kind: msg.kind,
    ...(msg.sdp !== undefined ? { sdp: msg.sdp } : {}),
    ...(msg.candidate !== undefined ? { candidate: msg.candidate } : {}),
  });
  return 'relayed';
}

/**
 * Stores a team round's voice squads (or clears them with no players) and
 * moves everyone affected between their party and team rooms.
 *
 * @param ctx - Shared services.
 * @param matchId - Game room / match id.
 * @param round - Round index (squads are per round).
 * @param players - Humans with their team and queue party; empty when the round ended.
 */
export async function setTeamRooms(
  ctx: AppContext,
  matchId: string,
  round: number,
  players: readonly SquadCandidate[],
): Promise<void> {
  const before = parse<string[]>(await ctx.kv.get(matchKey(matchId))) ?? [];
  for (const id of before) {
    const t = parse<TeamAssignment>(await ctx.kv.get(teamKey(id)));
    if (t?.matchId === matchId) await ctx.kv.del(teamKey(id));
  }
  const now: string[] = [];
  for (const [team, squads] of voiceSquads(players)) {
    for (const [i, members] of squads.entries()) {
      const assignment: TeamAssignment = {
        matchId,
        roomId: `team:${matchId}:${round}:${team}:${i}`,
        members,
      };
      for (const id of members) {
        await ctx.kv.set(teamKey(id), JSON.stringify(assignment), VOICE_TEAM_TTL_MS);
        now.push(id);
      }
    }
  }
  if (now.length) await ctx.kv.set(matchKey(matchId), JSON.stringify(now), VOICE_TEAM_TTL_MS);
  else await ctx.kv.del(matchKey(matchId));
  await refreshVoice(ctx, [...before, ...now]);
}

/**
 * The voice metadata a report carries: whether and when the reporter shared
 * a voice room with the target in the last hour. No audio exists to attach.
 *
 * @param ctx - Shared services.
 * @param reporterId - Who is reporting.
 * @param targetId - Reported player.
 * @returns One `voice` evidence line, or null when they never shared a room.
 */
export async function voiceEvidence(
  ctx: AppContext,
  reporterId: string,
  targetId: string,
): Promise<EvidenceLine | null> {
  const mine = parse<Record<string, SeenEntry>>(await ctx.kv.get(seenKey(reporterId)))?.[targetId];
  const theirs = parse<Record<string, SeenEntry>>(await ctx.kv.get(seenKey(targetId)))?.[reporterId];
  const e = mine ?? theirs;
  if (!e) return null;
  const minutes = Math.max(1, Math.round((e.lastAt - e.firstAt) / 60_000));
  return {
    channel: 'voice',
    text: `Shared a ${e.kind} voice room for about ${minutes} min (no audio is recorded)`,
    at: e.lastAt,
    room: e.roomId,
    from: e.firstAt,
  };
}

/**
 * Drops everything voice keeps about a player (account deletion).
 *
 * @param ctx - Shared services.
 * @param userId - Player.
 */
export async function forgetVoice(ctx: AppContext, userId: string): Promise<void> {
  const s = await voiceSession(ctx, userId);
  await ctx.kv.del(sessionKey(userId), teamKey(userId), seenKey(userId));
  if (s) await refreshVoice(ctx, s.peers);
}
