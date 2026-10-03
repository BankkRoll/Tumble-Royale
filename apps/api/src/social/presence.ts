/**
 * Presence in KV with a TTL: a user is online while their gateway connection
 * keeps refreshing the key. Missing key = offline.
 */
import type { KV } from '../kv/index.ts';
import type { PresenceStatus } from '../realtime/notifier.ts';

/** Presence TTL; the gateway refreshes at a third of this. */
export const PRESENCE_TTL_MS = 90_000;

/** Stored presence. */
export interface Presence {
  status: PresenceStatus;
  /** Epoch ms of the last update. */
  at: number;
}

const key = (userId: string) => `presence:${userId}`;

/** Sets (or clears, with `offline`) a user's presence. */
export async function setPresence(
  kv: KV,
  userId: string,
  status: PresenceStatus,
  now: number,
): Promise<void> {
  if (status === 'offline') await kv.del(key(userId));
  else await kv.set(key(userId), JSON.stringify({ status, at: now } satisfies Presence), PRESENCE_TTL_MS);
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
