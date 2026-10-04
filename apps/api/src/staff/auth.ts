/**
 * Staff authentication for admin routes and the admin console.
 *
 * Two credentials reach the `/internal/*` admin routes:
 *
 * - the static `ADMIN_TOKEN` (the `pnpm admin` CLI), acting as `admin`;
 * - a short-lived console session (`tra_…`), minted by `POST /admin/session`
 *   for a signed-in, non-guest account listed in `staff_members`.
 *
 * Console sessions live only in the KV (keyed by the token's SHA-256) with a
 * fixed lifetime of {@link STAFF_SESSION_TTL_MS}. Every request re-reads the
 * account's staff row and ban state, so revoking a role or suspending the
 * account takes effect on the next request on every instance.
 */
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { isErased } from '../accounts/tombstone.ts';
import { randomToken, safeEqual, sha256 } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import { profiles, staffMembers } from '../db/schema.ts';
import { activeBans, bearer } from '../http/auth.ts';
import { ApiError, forbidden, unauthorized } from '../http/errors.ts';

/** Staff roles, least privileged first. */
export const STAFF_ROLES = ['moderator', 'admin'] as const;

/** A staff role. */
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Lifetime of a console session. Fixed, not sliding: a stolen token dies on schedule. */
export const STAFF_SESSION_TTL_MS = 30 * 60_000;

/** Prefix that tells console session tokens apart from `ADMIN_TOKEN` and access tokens. */
export const STAFF_TOKEN_PREFIX = 'tra_';

/** Who is performing an admin action. */
export interface StaffActor {
  /** `token` for `ADMIN_TOKEN`, `staff` for a console session. */
  kind: 'token' | 'staff';
  /** Staff account id; null for the static token. */
  userId: string | null;
  /** `name#tag`, or `operator token`. */
  label: string;
  role: StaffRole;
  /** SHA-256 of the console session token, for sign-out. */
  sessionHash?: string;
}

interface StoredSession {
  userId: string;
  expiresAt: number;
}

const sessionKey = (hash: string) => `staff-session:${hash}`;

/** True when `role` grants at least `min`. */
export function roleAtLeast(role: StaffRole, min: StaffRole): boolean {
  return STAFF_ROLES.indexOf(role) >= STAFF_ROLES.indexOf(min);
}

/**
 * The account's staff role and label, or null when it holds none.
 *
 * @param ctx - Shared services.
 * @param userId - Account to check.
 */
export async function staffRoleOf(
  ctx: AppContext,
  userId: string,
): Promise<{ role: StaffRole; label: string } | null> {
  const [row] = await ctx.db
    .select({ role: staffMembers.role, name: profiles.displayName, tag: profiles.tag })
    .from(staffMembers)
    .innerJoin(profiles, eq(profiles.userId, staffMembers.userId))
    .where(eq(staffMembers.userId, userId));
  if (!row || !(STAFF_ROLES as readonly string[]).includes(row.role)) return null;
  return { role: row.role as StaffRole, label: `${row.name}#${row.tag}` };
}

/**
 * Mints a console session for a staff account.
 *
 * @param ctx - Shared services.
 * @param userId - A staff account (the caller has checked the role).
 * @returns The bearer token (shown once) and its expiry.
 */
export async function createStaffSession(
  ctx: AppContext,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = `${STAFF_TOKEN_PREFIX}${randomToken(32)}`;
  const expiresAt = new Date(ctx.now().getTime() + STAFF_SESSION_TTL_MS);
  const stored: StoredSession = { userId, expiresAt: expiresAt.getTime() };
  await ctx.kv.set(sessionKey(sha256(token)), JSON.stringify(stored), STAFF_SESSION_TTL_MS);
  return { token, expiresAt };
}

/**
 * Ends a console session.
 *
 * @param ctx - Shared services.
 * @param sessionHash - {@link StaffActor.sessionHash}.
 */
export async function endStaffSession(ctx: AppContext, sessionHash: string): Promise<void> {
  await ctx.kv.del(sessionKey(sessionHash));
}

async function sessionActor(ctx: AppContext, token: string): Promise<StaffActor> {
  const hash = sha256(token);
  const raw = await ctx.kv.get(sessionKey(hash));
  let stored: StoredSession | null;
  try {
    stored = raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    stored = null;
  }
  // The KV TTL is the primary expiry; the stored deadline also holds under a fake clock or a KV without TTLs.
  if (!stored || stored.expiresAt <= ctx.now().getTime())
    throw unauthorized('Console session expired; sign in again');
  const staff = await staffRoleOf(ctx, stored.userId);
  const suspended =
    (await isErased(ctx.kv, stored.userId)) ||
    (await activeBans(ctx, stored.userId)).some((b) => b.scope === 'all');
  if (!staff || suspended) {
    await ctx.kv.del(sessionKey(hash));
    throw unauthorized('This account no longer has console access');
  }
  return { kind: 'staff', userId: stored.userId, label: staff.label, role: staff.role, sessionHash: hash };
}

/**
 * Guards an admin route: accepts `ADMIN_TOKEN` (as `admin`) or a console
 * session whose account holds at least `min`.
 *
 * @param ctx - Shared services.
 * @param req - Incoming request.
 * @param min - Least role allowed (default `admin`).
 * @returns The actor, for the audit log.
 * @throws {ApiError} 401 bad or expired credentials, 403 `insufficient_role`,
 *   503 `admin_disabled` when neither credential kind can exist.
 * @example
 * const actor = await requireStaff(ctx, req, 'moderator');
 */
export async function requireStaff(
  ctx: AppContext,
  req: FastifyRequest,
  min: StaffRole = 'admin',
): Promise<StaffActor> {
  const token = bearer(req);
  // SECURITY: ADMIN_TOKEN is compared in constant time; console sessions are
  // only ever found by the hash of the presented token, never by the token.
  let actor: StaffActor;
  if (token && ctx.config.adminToken && safeEqual(token, ctx.config.adminToken)) {
    actor = { kind: 'token', userId: null, label: 'operator token', role: 'admin' };
  } else if (token?.startsWith(STAFF_TOKEN_PREFIX)) {
    actor = await sessionActor(ctx, token);
  } else if (!ctx.config.adminToken) {
    throw new ApiError(503, 'admin_disabled', 'Admin routes are disabled (set ADMIN_TOKEN)');
  } else {
    throw unauthorized('Invalid admin token');
  }
  if (!roleAtLeast(actor.role, min))
    throw forbidden('insufficient_role', `This action needs the ${min} role`);
  return actor;
}
