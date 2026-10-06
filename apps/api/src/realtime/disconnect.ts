/**
 * Cluster-wide "close this user's realtime sockets" orders.
 *
 * A gateway socket is authenticated once, at the handshake, so on its own it
 * would outlive the account's deletion or a sign-out. Whoever ends access
 * publishes an order on {@link DISCONNECT_CHANNEL}; every API instance closes
 * the matching sockets it holds. Clients reconnect with a fresh token, which
 * the handshake then judges again. Bans reach the gateway through the ban
 * cache invalidation channel instead (`http/auth.ts`), which every ban change
 * already publishes.
 */
import { eq } from 'drizzle-orm';
import { sha256 } from '../auth/tokens.ts';
import type { DbOrTx } from '../db/client.ts';
import { sessions } from '../db/schema.ts';
import type { KV } from '../kv/index.ts';

/** KV channel carrying {@link DisconnectOrder}s. */
export const DISCONNECT_CHANNEL = 'realtime:disconnect';

/** Why a user's sockets are being closed; also picks the close code. */
export type DisconnectReason = 'erased' | 'signed_out';

/** One order on {@link DISCONNECT_CHANNEL}. */
export interface DisconnectOrder {
  userId: string;
  reason: DisconnectReason;
  /** Only sockets opened with tokens of these sessions; absent = every socket of the user. */
  sessionIds?: string[];
}

/** WebSocket close codes the gateway uses when it ends a session itself. */
export const GATEWAY_CLOSE = {
  /** The access token expired; reconnect with a fresh one. */
  tokenExpired: 4401,
  /** Signed out, account deleted or suspended. */
  accessEnded: 4403,
  /** Too many sockets for this account or address. */
  tooMany: 4429,
  /** The socket kept sending past its frame budget. */
  flooding: 4008,
} as const;

/**
 * Closes a user's sockets on every API instance.
 *
 * @param kv - Shared KV (pub/sub).
 * @param order - Whose sockets, and why.
 * @example
 * await disconnectUser(ctx.kv, { userId, reason: 'erased' });
 */
export async function disconnectUser(kv: KV, order: DisconnectOrder): Promise<void> {
  await kv.publish(DISCONNECT_CHANNEL, JSON.stringify(order));
}

/**
 * Closes the sockets of every session in the refresh family of a refresh
 * token or session id (what sign-out revokes).
 *
 * @param db - Database.
 * @param kv - Shared KV.
 * @param by - The refresh token or session id sign-out was given.
 */
export async function disconnectSessionFamily(
  db: DbOrTx,
  kv: KV,
  by: { refreshToken: string } | { sessionId: string },
): Promise<void> {
  const [row] = await db
    .select({ familyId: sessions.familyId, userId: sessions.userId })
    .from(sessions)
    .where(
      'refreshToken' in by ? eq(sessions.tokenHash, sha256(by.refreshToken)) : eq(sessions.id, by.sessionId),
    );
  if (!row) return;
  const family = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.familyId, row.familyId));
  await disconnectUser(kv, {
    userId: row.userId,
    reason: 'signed_out',
    sessionIds: family.map((s) => s.id),
  });
}

/**
 * Parses an order from the channel; null for anything malformed.
 *
 * @param raw - Message text.
 */
export function parseDisconnectOrder(raw: string): DisconnectOrder | null {
  try {
    const o = JSON.parse(raw) as Partial<DisconnectOrder>;
    if (typeof o.userId !== 'string' || (o.reason !== 'erased' && o.reason !== 'signed_out')) return null;
    if (
      o.sessionIds !== undefined &&
      !(Array.isArray(o.sessionIds) && o.sessionIds.every((s) => typeof s === 'string'))
    )
      return null;
    return { userId: o.userId, reason: o.reason, ...(o.sessionIds ? { sessionIds: o.sessionIds } : {}) };
  } catch {
    return null;
  }
}
