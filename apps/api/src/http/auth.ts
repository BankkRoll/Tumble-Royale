/**
 * Request authentication: bearer access tokens, ban enforcement, admin and
 * internal-HMAC guards.
 */
import { createHmac } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { isErased } from '../accounts/tombstone.ts';
import { safeEqual, verifyAccessToken } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import { bans } from '../db/schema.ts';
import { ApiError, unauthorized } from './errors.ts';

/** Authenticated caller. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** `name#tag` at token issue time. */
  name: string;
  region: string;
  guest: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body (JSON routes), kept for signature verification. */
    rawBody?: string;
  }
}

/** Active ban summary. */
export interface ActiveBan {
  scope: string;
  reason: string;
  expiresAt: Date | null;
}

const BAN_CACHE_MS = 15_000;

/** KV channel carrying user ids whose cached ban state every API instance must drop. */
export const BAN_INVALIDATION_CHANNEL = 'bans:invalidate';

interface BanCache {
  entries: Map<string, { at: number; bans: ActiveBan[] }>;
  /** Resolves once this instance listens for invalidations. */
  subscribed: Promise<void>;
}

// One cache per app instance (context), so instances in one process, like
// tests running two APIs, behave like separate servers.
const banCaches = new WeakMap<AppContext, BanCache>();

/**
 * The instance's ban cache, subscribing to cluster-wide invalidations on first
 * use. Nothing is cached before the subscription is live, so no invalidation
 * can be missed; the KV's `close()` drops the subscription with the app.
 */
async function banCache(ctx: AppContext): Promise<BanCache> {
  let cache = banCaches.get(ctx);
  if (!cache) {
    const entries = new Map<string, { at: number; bans: ActiveBan[] }>();
    const subscribed = ctx.kv
      .subscribe(BAN_INVALIDATION_CHANNEL, (userId) => {
        entries.delete(userId);
      })
      .then(() => undefined);
    cache = { entries, subscribed };
    banCaches.set(ctx, cache);
  }
  await cache.subscribed;
  return cache;
}

/**
 * Active bans for a user, cached briefly so authenticated hot paths do not hit
 * the database on every request. Every ban change goes through
 * {@link invalidateBanCache}, which clears this cache on every instance.
 */
export async function activeBans(ctx: AppContext, userId: string, fresh = false): Promise<ActiveBan[]> {
  const now = ctx.now();
  const { entries } = await banCache(ctx);
  const hit = entries.get(userId);
  if (!fresh && hit && now.getTime() - hit.at < BAN_CACHE_MS) return hit.bans;
  const rows = await ctx.db
    .select({ scope: bans.scope, reason: bans.reason, expiresAt: bans.expiresAt })
    .from(bans)
    .where(
      and(
        eq(bans.userId, userId),
        isNull(bans.revokedAt),
        or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
      ),
    );
  entries.set(userId, { at: now.getTime(), bans: rows });
  if (entries.size > 50_000) entries.clear();
  return rows;
}

/**
 * Drops a user's cached ban state on every API instance, after a ban is
 * created, lifted or re-applied. Call it after the change is committed, or
 * another instance may re-cache the old state before it becomes visible.
 *
 * @param ctx - Shared services (the KV fans the invalidation out).
 * @param userId - Whose bans changed.
 */
export async function invalidateBanCache(ctx: AppContext, userId: string): Promise<void> {
  banCaches.get(ctx)?.entries.delete(userId);
  await ctx.kv.publish(BAN_INVALIDATION_CHANNEL, userId);
}

/** Extracts the bearer token from an Authorization header. */
export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/**
 * Authenticates the request. Rejects banned users (scope `all`).
 *
 * @throws {ApiError} 401 without a valid token, 403 `banned`.
 */
export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<AuthContext> {
  const auth = await optionalUser(ctx, req);
  if (!auth) throw unauthorized();
  return auth;
}

/** Like {@link requireUser} but returns null for anonymous requests. Invalid tokens still 401. */
export async function optionalUser(ctx: AppContext, req: FastifyRequest): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;
  const claims = await verifyAccessToken(ctx.config.jwtSecret, token, Math.floor(ctx.now().getTime() / 1000));
  if (!claims) throw unauthorized('Invalid or expired access token');
  if (await isErased(ctx.kv, claims.sub)) throw unauthorized('This account was deleted');
  const banned = (await activeBans(ctx, claims.sub)).find((b) => b.scope === 'all');
  if (banned) {
    throw new ApiError(403, 'banned', 'This account is suspended', {
      reason: banned.reason,
      expiresAt: banned.expiresAt?.toISOString() ?? null,
    });
  }
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    name: claims.name,
    region: claims.region,
    guest: claims.guest,
  };
}

/**
 * The account behind an access token that did not come in a header (the
 * analytics beacon carries it in its body). Unlike {@link optionalUser} it
 * never throws: an expired, forged, erased or suspended token just means
 * "anonymous", because a page that is closing cannot refresh and retry.
 *
 * @param ctx - Shared services.
 * @param token - Access token, or undefined.
 * @returns The account id, or null.
 */
export async function userIdFromToken(ctx: AppContext, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const claims = await verifyAccessToken(ctx.config.jwtSecret, token, Math.floor(ctx.now().getTime() / 1000));
  if (!claims || (await isErased(ctx.kv, claims.sub))) return null;
  if ((await activeBans(ctx, claims.sub)).some((b) => b.scope === 'all')) return null;
  return claims.sub;
}

/**
 * Guards admin routes with the static `ADMIN_TOKEN`.
 *
 * @throws {ApiError} 503 when no admin token is configured, 401 on mismatch.
 */
export function requireAdmin(ctx: AppContext, req: FastifyRequest): void {
  if (!ctx.config.adminToken)
    throw new ApiError(503, 'admin_disabled', 'Admin routes are disabled (set ADMIN_TOKEN)');
  const token = bearer(req);
  if (!token || !safeEqual(token, ctx.config.adminToken)) throw unauthorized('Invalid admin token');
}

/** Header names of the internal HMAC scheme. */
export const HMAC_HEADERS = {
  timestamp: 'x-tumble-timestamp',
  nonce: 'x-tumble-nonce',
  signature: 'x-tumble-signature',
} as const;

/** Accepted clock skew / replay window for signed internal calls. */
export const HMAC_WINDOW_MS = 5 * 60 * 1000;

/**
 * Computes the internal request signature:
 * `hex(HMAC-SHA256(secret, "<timestamp>.<nonce>.<rawBody>"))`.
 *
 * @param secret - `INTERNAL_HMAC_SECRET`.
 * @param timestamp - Unix epoch milliseconds, as sent in `x-tumble-timestamp`.
 * @param nonce - Random string (16–128 chars), as sent in `x-tumble-nonce`.
 * @param body - Exact request body bytes as a UTF-8 string.
 * @example
 * const ts = String(Date.now()); const nonce = randomUUID();
 * const sig = signInternal(secret, ts, nonce, body);
 */
export function signInternal(secret: string, timestamp: string, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

/**
 * Verifies a game-server request signed with {@link signInternal}: timestamp
 * within ±5 min, nonce unseen in that window, constant-time signature match.
 *
 * @throws {ApiError} 401 `bad_signature` / `stale_request` / `replayed_request`.
 */
export async function requireInternalSignature(ctx: AppContext, req: FastifyRequest): Promise<void> {
  const ts = req.headers[HMAC_HEADERS.timestamp];
  const nonce = req.headers[HMAC_HEADERS.nonce];
  const sig = req.headers[HMAC_HEADERS.signature];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    throw new ApiError(401, 'bad_signature', 'Missing signature headers');
  }
  if (!/^\d{10,16}$/.test(ts) || nonce.length < 16 || nonce.length > 128) {
    throw new ApiError(401, 'bad_signature', 'Malformed signature headers');
  }
  if (Math.abs(ctx.now().getTime() - Number(ts)) > HMAC_WINDOW_MS) {
    throw new ApiError(401, 'stale_request', 'Request timestamp outside the replay window');
  }
  const expected = signInternal(ctx.config.internalHmacSecret, ts, nonce, req.rawBody ?? '');
  if (!safeEqual(expected, sig.toLowerCase())) throw new ApiError(401, 'bad_signature', 'Signature mismatch');
  if (!(await ctx.kv.setNX(`nonce:${nonce}`, '1', HMAC_WINDOW_MS * 2))) {
    throw new ApiError(401, 'replayed_request', 'Nonce already used');
  }
}
