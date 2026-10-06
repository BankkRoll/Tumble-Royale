/**
 * First-admin bootstrap and one-time staff sign-in links.
 *
 * A fresh server has no sign-in method an operator can rely on (SMTP and the
 * OAuth apps may not exist yet), so `pnpm admin staff bootstrap` creates or
 * finds a full account for an email address, makes it `admin` and returns a
 * one-time link that signs that account in to the game, and from there to
 * the console, without any provider.
 *
 * Links:
 * - are minted only with `ADMIN_TOKEN` (routes in `staff/routes.ts`) or by
 *   the development seed, and only for staff accounts;
 * - live {@link STAFF_LINK_TTL_MS} in the KV under the token's SHA-256, never
 *   the token itself;
 * - work once: redeeming deletes them, and minting a new one for the same
 *   account invalidates the previous one.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createAccount } from '../accounts/accounts.ts';
import { isErased } from '../accounts/tombstone.ts';
import { randomToken, sha256 } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { authIdentities, staffMembers, users } from '../db/schema.ts';
import { ApiError, badRequest, notFound } from '../http/errors.ts';
import { checkDisplayName } from '../names/display-name.ts';
import { writeAuditRow, type AuditEntry } from './audit.ts';
import type { StaffActor } from './auth.ts';

/** How long a staff sign-in link works. */
export const STAFF_LINK_TTL_MS = 15 * 60_000;

/** Path of the client page that redeems a link. */
export const STAFF_LINK_PATH = '/auth/staff';

const linkKey = (hash: string) => `staff-link:${hash}`;
const latestKey = (userId: string) => `staff-link-user:${userId}`;

interface StoredLink {
  userId: string;
  expiresAt: number;
}

/** A freshly minted link; `url` holds the only copy of the token. */
export interface StaffLink {
  url: string;
  expiresAt: Date;
}

/**
 * Mints a one-time sign-in link for a staff account, replacing any earlier
 * unused link for it.
 *
 * @param ctx - Shared services.
 * @param userId - A staff account (the caller has checked).
 * @returns The link to hand to the operator, and when it stops working.
 */
export async function issueStaffLink(ctx: AppContext, userId: string): Promise<StaffLink> {
  const token = randomToken(32);
  const hash = sha256(token);
  const expiresAt = new Date(ctx.now().getTime() + STAFF_LINK_TTL_MS);
  const previous = await ctx.kv.get(latestKey(userId));
  if (previous) await ctx.kv.del(linkKey(previous));
  const stored: StoredLink = { userId, expiresAt: expiresAt.getTime() };
  await ctx.kv.set(linkKey(hash), JSON.stringify(stored), STAFF_LINK_TTL_MS);
  await ctx.kv.set(latestKey(userId), hash, STAFF_LINK_TTL_MS);
  return { url: `${ctx.config.publicWebUrl}${STAFF_LINK_PATH}?token=${token}`, expiresAt };
}

/**
 * Consumes a link token.
 *
 * @param ctx - Shared services.
 * @param token - The token from the link.
 * @returns The account it signs in, with its current staff role.
 * @throws {ApiError} 400 `invalid_token` when unknown, used, expired, or the
 *   account is no longer staff or was deleted.
 */
export async function redeemStaffLink(
  ctx: AppContext,
  token: string,
): Promise<{ userId: string; role: string }> {
  const hash = sha256(token);
  const raw = await ctx.kv.getDel(linkKey(hash));
  const invalid = new ApiError(400, 'invalid_token', 'Sign-in link expired or already used');
  if (!raw) throw invalid;
  let stored: StoredLink;
  try {
    stored = JSON.parse(raw) as StoredLink;
  } catch {
    throw invalid;
  }
  if ((await ctx.kv.get(latestKey(stored.userId))) === hash) await ctx.kv.del(latestKey(stored.userId));
  // The KV TTL is the primary expiry; the stored deadline also holds under a fake clock.
  if (stored.expiresAt <= ctx.now().getTime()) throw invalid;
  const [staff] = await ctx.db
    .select({ role: staffMembers.role, isGuest: users.isGuest })
    .from(staffMembers)
    .innerJoin(users, eq(users.id, staffMembers.userId))
    .where(eq(staffMembers.userId, stored.userId));
  if (!staff || staff.isGuest || (await isErased(ctx.kv, stored.userId))) throw invalid;
  return { userId: stored.userId, role: staff.role };
}

/** Result of {@link bootstrapAdmin}. */
export interface BootstrapResult {
  userId: string;
  /** True when the account was created for this address. */
  created: boolean;
  /** Role the account held before (null: none). */
  previousRole: string | null;
}

/**
 * Finds the full account using `email` (or creates one with that address as
 * its email sign-in) and makes it `admin`, recording both in the audit log.
 *
 * @param ctx - Shared services.
 * @param input - Lowercased address and an optional display name for a new account.
 * @param actor - Who asked (the operator token or the dev seed).
 * @param audit - Writes an audit row inside the transaction.
 * @returns The account and whether it was created.
 * @throws {ApiError} 400 `invalid_name` for an unacceptable `displayName`.
 */
export async function bootstrapAdmin(
  ctx: AppContext,
  input: { email: string; displayName?: string },
  actor: StaffActor,
  audit: (entry: AuditEntry, tx: DbOrTx) => Promise<void>,
): Promise<BootstrapResult> {
  if (input.displayName !== undefined) {
    const check = checkDisplayName(input.displayName);
    if (!check.ok)
      throw badRequest('invalid_name', `Name rejected: ${check.reason}`, { reason: check.reason });
  }
  const email = input.email.toLowerCase();
  return ctx.db.transaction(async (tx) => {
    const [byEmail] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email));
    const [byIdentity] = byEmail
      ? []
      : await tx
          .select({ id: authIdentities.userId })
          .from(authIdentities)
          .where(and(eq(authIdentities.provider, 'email'), eq(authIdentities.subject, email)));
    let userId = byEmail?.id ?? byIdentity?.id;
    const created = !userId;
    if (!userId) {
      // NOTE: the email identity is the operator's word, not a verified
      // address; it lets the account use magic links once SMTP is set up.
      const account = await createAccount(tx, ctx.catalog, {
        isGuest: false,
        email,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        identity: { provider: 'email', subject: email },
      });
      userId = account.userId;
    } else {
      // A guest that somehow holds the address becomes a full account: staff
      // must be able to sign in again from any device.
      await tx.update(users).set({ isGuest: false }).where(eq(users.id, userId));
    }
    const [before] = await tx
      .select({ role: staffMembers.role })
      .from(staffMembers)
      .where(eq(staffMembers.userId, userId));
    const now = ctx.now();
    await tx
      .insert(staffMembers)
      .values({ userId, role: 'admin', grantedBy: actor.label, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: staffMembers.userId,
        set: { role: 'admin', grantedBy: actor.label, updatedAt: now },
      });
    await audit(
      {
        action: 'staff.bootstrap',
        targetType: 'user',
        targetId: userId,
        details: { email, created, previousRole: before?.role ?? null },
      },
      tx,
    );
    return { userId, created, previousRole: before?.role ?? null };
  });
}

/**
 * The staff role of a non-guest account, for minting a link.
 *
 * @throws {ApiError} 404 when the user does not exist, 400 `not_staff` when it
 *   holds no role (links are for staff only, never a way into player accounts).
 */
export async function requireLinkableStaff(ctx: AppContext, userId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ isGuest: users.isGuest, role: staffMembers.role })
    .from(users)
    .leftJoin(staffMembers, eq(staffMembers.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) throw notFound('User');
  if (!row.role || row.isGuest)
    throw badRequest('not_staff', 'Sign-in links are only for staff; grant a role first');
  return row.role;
}

/** Minimal logger the development seed writes to. */
export interface SeedLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Development convenience (`DEV_ADMIN_EMAIL`): while no staff exist, make the
 * account with that address admin; whenever it is staff, log a fresh one-time
 * sign-in link. The config refuses the variable in production.
 *
 * @param ctx - Shared services.
 * @param log - Where the link is printed.
 * @returns The link, or null when nothing was done.
 */
export async function seedDevAdmin(ctx: AppContext, log: SeedLogger): Promise<StaffLink | null> {
  const email = ctx.config.devAdminEmail;
  if (!email || ctx.config.env !== 'development') return null;
  const actor: StaffActor = { kind: 'token', userId: null, label: 'dev seed', role: 'admin' };
  const [anyStaff] = await ctx.db.select({ userId: staffMembers.userId }).from(staffMembers).limit(1);
  let userId: string | undefined;
  if (!anyStaff) {
    const result = await bootstrapAdmin(ctx, { email, displayName: 'DevAdmin' }, actor, (entry, tx) =>
      writeAuditRow(tx, actor, entry, null, ctx.now()),
    );
    userId = result.userId;
    log.info(`[dev] ${email} is now an admin (${result.created ? 'new account' : 'existing account'})`);
  } else {
    const [mine] = await ctx.db
      .select({ userId: staffMembers.userId })
      .from(staffMembers)
      .innerJoin(users, eq(users.id, staffMembers.userId))
      .where(eq(sql`lower(${users.email})`, email));
    userId = mine?.userId;
    if (!userId) {
      log.warn(`[dev] DEV_ADMIN_EMAIL=${email} is not staff and other staff exist; not seeding`);
      return null;
    }
  }
  const link = await issueStaffLink(ctx, userId);
  await writeAuditRow(
    ctx.db,
    actor,
    {
      action: 'staff.link_issue',
      targetType: 'user',
      targetId: userId,
      details: { expiresAt: link.expiresAt.toISOString() },
    },
    null,
    ctx.now(),
  );
  log.info(`[dev] one-time admin sign-in link (15 min): ${link.url}`);
  return link;
}
