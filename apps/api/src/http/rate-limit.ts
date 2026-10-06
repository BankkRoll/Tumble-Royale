/**
 * Rate-limit bucket keys.
 *
 * Signed-in players get a bucket per account so players behind one NAT do not
 * share a limit; everyone else, including callers presenting a bearer token
 * that does not verify, shares the bucket of their IP.
 */
import type { FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import type { KV } from '../kv/index.ts';
import { bearer } from './auth.ts';
import { ApiError } from './errors.ts';

/**
 * Bucket key for the caller's IP address.
 *
 * @param req - Incoming request.
 */
export function ipRateKey(req: FastifyRequest): string {
  return `ip:${req.ip}`;
}

/**
 * Bucket key for the global limiter: `u:<userId>` for a verified access token,
 * else `ip:<address>`.
 *
 * @param jwtSecret - Access token secret.
 * @param req - Incoming request.
 * @param now - Clock, for token expiry.
 */
export async function rateLimitKey(jwtSecret: string, req: FastifyRequest, now: () => Date): Promise<string> {
  const token = bearer(req);
  if (!token) return ipRateKey(req);
  // SECURITY: keying on the raw header would hand every made-up token a fresh
  // bucket; only a token this API signed earns a per-account one.
  const claims = await verifyAccessToken(jwtSecret, token, Math.floor(now().getTime() / 1000));
  return claims ? `u:${claims.sub}` : ipRateKey(req);
}

/**
 * Counts one hit in a fixed window on the shared KV, so every API instance
 * enforces the same budget.
 *
 * @param kv - Shared KV.
 * @param key - Bucket, e.g. `guest:ip:<addr>`.
 * @param max - Hits allowed per window.
 * @param windowMs - Window length.
 * @param now - Epoch ms.
 * @returns True while the bucket is within `max`.
 * @example
 * if (!(await hitWindow(ctx.kv, `ws:ip:${ip}`, 60, 60_000, Date.now()))) refuse();
 */
export async function hitWindow(
  kv: KV,
  key: string,
  max: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const window = Math.floor(now / windowMs);
  return (await kv.incr(`win:${key}:${window}`, windowMs + 1000)) <= max;
}

/**
 * Refuses a new guest account once the caller's IP minted
 * `GUEST_SIGNUPS_PER_IP_HOUR` of them this hour. Returning guests (a known
 * device token) are not counted.
 *
 * @param ctx - Shared services.
 * @param ip - Client address (`request.ip`, TRUST_PROXY aware).
 * @throws {ApiError} 429 `guest_limit`.
 */
export async function limitGuestSignups(ctx: AppContext, ip: string): Promise<void> {
  // SECURITY: every guest gets fresh per-account budgets (chat, reports,
  // friend requests), so minting them must be scarce per address.
  const ok = await hitWindow(
    ctx.kv,
    `guest:ip:${ip}`,
    ctx.config.abuse.guestSignupsPerIpHour,
    3_600_000,
    ctx.now().getTime(),
  );
  if (!ok) throw new ApiError(429, 'guest_limit', 'Too many new guest accounts from this network; try later');
}

/**
 * Route config for sign-in style endpoints: always limited per IP, whatever
 * token the caller presents, so account creation and email sends cannot be
 * multiplied by rotating credentials.
 */
export const AUTH_RATE = {
  rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: ipRateKey },
};
