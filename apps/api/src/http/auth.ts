/**
 * Request authentication: bearer access tokens, ban enforcement and the
 * internal-HMAC guard. Admin routes use `requireStaff` (`staff/auth.ts`).
 */
import { createHmac } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { isErased } from '../accounts/tombstone.ts';
import {
  inspectInternal,
  internalSigningString,
  INTERNAL_SIG_VERSION_HEADER,
  INTERNAL_SIG_WINDOW_MS,
  type InternalTarget,
} from '@tumble/shared/liveops-client';
import { verifyAccessToken } from '../auth/tokens.ts';
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

/** Header names of the internal HMAC scheme. */
export const HMAC_HEADERS = {
  timestamp: 'x-tumble-timestamp',
  nonce: 'x-tumble-nonce',
  signature: 'x-tumble-signature',
  version: INTERNAL_SIG_VERSION_HEADER,
} as const;

/** Accepted clock skew / replay window for signed internal calls. */
export const HMAC_WINDOW_MS = INTERNAL_SIG_WINDOW_MS;

/**
 * Computes an internal request signature (scheme v2, see `signInternal` in
 * `@tumble/shared/liveops-client`):
 * `hex(HMAC-SHA256(secret, "METHOD\npath\ntimestamp\nnonce\nrawBody"))`.
 *
 * @param secret - `INTERNAL_HMAC_SECRET` (or `GAME_SERVER_HMAC_SECRET`).
 * @param timestamp - Unix epoch milliseconds, as sent in `x-tumble-timestamp`.
 * @param nonce - Random string (16–128 chars), as sent in `x-tumble-nonce`.
 * @param body - Exact request body bytes as a UTF-8 string.
 * @param target - Method and route path of the request.
 * @example
 * const ts = String(Date.now()); const nonce = randomUUID();
 * const sig = signInternal(secret, ts, nonce, body, { method: 'POST', path: '/internal/liveops' });
 */
export function signInternal(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
  target: InternalTarget,
): string {
  return createHmac('sha256', secret)
    .update(internalSigningString(target, timestamp, nonce, body))
    .digest('hex');
}

/** Callers with a key of their own, besides holders of the shared `INTERNAL_HMAC_SECRET`. */
export type InternalCaller = 'game-server';

/** Options for {@link requireInternalSignature}. */
export interface InternalSignatureOptions {
  /**
   * Narrow keys also accepted on this route. Holders of the shared key are
   * always accepted; a game server's own key only where listed here.
   */
  callers?: readonly InternalCaller[];
}

/**
 * Verifies a service request signed with {@link signInternal}: bound to this
 * method and path, timestamp within ±5 min, nonce unseen in that window,
 * constant-time signature match.
 *
 * SECURITY: trust boundary for every `/internal/*` route that services (not
 * staff) call. `GAME_SERVER_HMAC_SECRET` is honoured only on routes that list
 * `game-server`, so a leaked game-server key cannot look up bans or reach
 * other service-only routes.
 *
 * @returns Which kind of key signed the request.
 * @throws {ApiError} 401 `bad_signature` / `stale_request` / `replayed_request`.
 */
export async function requireInternalSignature(
  ctx: AppContext,
  req: FastifyRequest,
  opts: InternalSignatureOptions = {},
): Promise<'shared' | InternalCaller> {
  const keys = [ctx.config.internalHmacSecret];
  if (opts.callers?.includes('game-server')) keys.push(ctx.config.gameServerHmacSecret ?? '');
  const r = inspectInternal(keys, req.headers, req.rawBody ?? '', ctx.now().getTime(), {
    method: req.method,
    path: req.url.split('?')[0] ?? req.url,
    windowMs: HMAC_WINDOW_MS,
    allowV1: ctx.config.internalHmacAllowV1,
  });
  if (!('ok' in r)) {
    if (r.problem === 'stale')
      throw new ApiError(401, 'stale_request', 'Request timestamp outside the replay window');
    throw new ApiError(
      401,
      'bad_signature',
      r.problem === 'missing'
        ? 'Missing signature headers'
        : r.problem === 'malformed'
          ? 'Malformed signature headers'
          : 'Signature mismatch',
    );
  }
  if (!(await ctx.kv.setNX(`nonce:${r.ok.nonce}`, '1', HMAC_WINDOW_MS * 2))) {
    throw new ApiError(401, 'replayed_request', 'Nonce already used');
  }
  return r.ok.key === 0 ? 'shared' : 'game-server';
}
