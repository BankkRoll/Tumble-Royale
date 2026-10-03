/**
 * Presence in KV with a TTL: a user is online while their gateway connection
 * keeps refreshing the key. Missing key = offline.
 *
 * Responsibilities:
 * - store the effective status (plus playlist / private-show code) per user;
 * - build the {@link PresenceView} friends see, including whether the user's
 *   party can be joined right now.
 */
import type { KV } from '../kv/index.ts';
import type { PresenceStatus, PresenceView } from '../realtime/notifier.ts';

/** Presence TTL; the gateway refreshes at a third of this. */
export const PRESENCE_TTL_MS = 90_000;

// Mirrors party.ts `MAX_PARTY_SIZE`; importing it would close a cycle (party → friends → presence).
const PARTY_CAP = 4;

/** Stored presence. */
export interface Presence {
  status: PresenceStatus;
  /** Epoch ms of the last update. */
  at: number;
  playlistId?: string;
  lobbyCode?: string;
}

/** Optional details reported with a status. */
export interface PresenceDetails {
  playlistId?: string | undefined;
  lobbyCode?: string | undefined;
}

const key = (userId: string) => `presence:${userId}`;

/** Sets (or clears, with `offline`) a user's presence. */
export async function setPresence(
  kv: KV,
  userId: string,
  status: PresenceStatus,
  now: number,
  details: PresenceDetails = {},
): Promise<void> {
  if (status === 'offline') {
    await kv.del(key(userId));
    return;
  }
  const value: Presence = {
    status,
    at: now,
    ...(details.playlistId ? { playlistId: details.playlistId } : {}),
    ...(details.lobbyCode ? { lobbyCode: details.lobbyCode } : {}),
  };
  await kv.set(key(userId), JSON.stringify(value), PRESENCE_TTL_MS);
}

/** Reads one user's presence (`offline` when absent). */
export async function getPresence(kv: KV, userId: string): Promise<Presence> {
  const raw = await kv.get(key(userId));
  return raw ? (JSON.parse(raw) as Presence) : { status: 'offline', at: 0 };
}

/** Reads presence for many users. */
export async function getPresenceMany(kv: KV, userIds: readonly string[]): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>();
  await Promise.all(userIds.map(async (id) => out.set(id, await getPresence(kv, id))));
  return out;
}

/**
 * Size of the party a user is in (KV keys owned by `PartyService`).
 *
 * @returns Member count, 1 when solo.
 */
async function partySize(kv: KV, userId: string): Promise<number> {
  const id = await kv.get(`user-party:${userId}`);
  const raw = id ? await kv.get(`party:${id}`) : null;
  if (!raw) return 1;
  const p = JSON.parse(raw) as { members?: { userId: string }[] };
  return p.members?.some((m) => m.userId === userId) ? p.members.length : 1;
}

/**
 * What friends see for a user right now.
 *
 * @param kv - Store.
 * @param userId - Whose presence.
 * @param p - Already-read presence (saves a lookup).
 */
export async function presenceView(kv: KV, userId: string, p?: Presence): Promise<PresenceView> {
  const cur = p ?? (await getPresence(kv, userId));
  const view: PresenceView = { status: cur.status };
  if (cur.playlistId && (cur.status === 'in_queue' || cur.status === 'in_match'))
    view.playlistId = cur.playlistId;
  if (cur.lobbyCode && cur.status !== 'offline') view.lobbyCode = cur.lobbyCode;
  if (cur.status === 'online' || cur.status === 'in_menu')
    view.joinable = (await partySize(kv, userId)) < PARTY_CAP;
  return view;
}

/** {@link presenceView} for many users. */
export async function presenceViews(kv: KV, userIds: readonly string[]): Promise<Map<string, PresenceView>> {
  const raw = await getPresenceMany(kv, userIds);
  const out = new Map<string, PresenceView>();
  await Promise.all(userIds.map(async (id) => out.set(id, await presenceView(kv, id, raw.get(id)))));
  return out;
}

/** Sort weight: most available first. */
export const PRESENCE_RANK: Readonly<Record<PresenceStatus, number>> = {
  in_menu: 0,
  online: 0,
  in_queue: 1,
  in_match: 2,
  offline: 3,
};
