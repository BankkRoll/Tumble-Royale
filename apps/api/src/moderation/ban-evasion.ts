/**
 * Bans that survive account deletion.
 *
 * Responsibilities:
 * - At erasure ({@link retainBans}), store every active ban of the account once
 *   per stable identifier the account had: each linked OAuth identity
 *   (provider + subject), each email address (lowercased: the email identity
 *   and `users.email`) and each guest device secret (already stored as its
 *   SHA-256 by `auth_identities`). Only a keyed hash of each identifier is
 *   kept, with the ban's scope, reason and expiry; no user id.
 * - At sign-in and account creation ({@link reapplyRetainedBans}), hash the
 *   identifiers the new or returning account presents and, on a match, give
 *   that account an equivalent ban (same scope, reason and expiry). Re-applying
 *   rather than refusing the sign-in keeps the original scope: a chat or
 *   ranked ban still lets the player in, an `all` ban refuses every session.
 *
 * Hash key: `INTERNAL_HMAC_SECRET` (domain-separated with `ban-evasion:v1`).
 * WARNING: rotating that secret orphans every existing mark; re-hash cannot
 * happen because the raw identifiers are gone by design.
 *
 * Lifting a re-applied ban (`DELETE /internal/bans/:id`) revokes the marks it
 * came from, so a pardon also covers accounts the player creates later.
 */
import { createHmac } from 'node:crypto';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { IdentityProvider } from '../accounts/accounts.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { authIdentities, banEvasionMarks, bans, users } from '../db/schema.ts';

/** An identifier that can tie a new account to a deleted one. */
export type StableIdentifier =
  { kind: 'identity'; provider: IdentityProvider; subject: string } | { kind: 'email'; email: string };

/**
 * Keyed hash of one identifier. Email identities and verified addresses hash
 * alike, so an address that came in through Google matches one linked by
 * magic link.
 *
 * @param secret - `INTERNAL_HMAC_SECRET`.
 * @param id - The identifier.
 * @example
 * identifierHash(secret, { kind: 'email', email: 'Ann@Example.com' });
 */
export function identifierHash(secret: string, id: StableIdentifier): string {
  const value =
    id.kind === 'email' || id.provider === 'email'
      ? `email:${(id.kind === 'email' ? id.email : id.subject).trim().toLowerCase()}`
      : `${id.provider}:${id.subject}`;
  return createHmac('sha256', secret).update(`ban-evasion:v1:${value}`).digest('hex');
}

async function accountIdentifiers(tx: DbOrTx, userId: string): Promise<StableIdentifier[]> {
  const rows = await tx
    .select({ provider: authIdentities.provider, subject: authIdentities.subject })
    .from(authIdentities)
    .where(eq(authIdentities.userId, userId));
  const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const out: StableIdentifier[] = rows.map((r) => ({
    kind: 'identity',
    provider: r.provider as IdentityProvider,
    subject: r.subject,
  }));
  if (user?.email) out.push({ kind: 'email', email: user.email });
  return out;
}

const activeAt = (now: Date) =>
  and(isNull(bans.revokedAt), or(isNull(bans.expiresAt), gt(bans.expiresAt, now)));

/**
 * Stores the account's active bans under its hashed identifiers. Run inside
 * the erasure transaction, before the user row (and its bans) cascade away.
 *
 * @param tx - The erasure transaction.
 * @param ctx - Shared services (secret, clock).
 * @param userId - The account being deleted.
 * @returns Number of bans retained.
 */
export async function retainBans(tx: DbOrTx, ctx: AppContext, userId: string): Promise<number> {
  const active = await tx
    .select({ id: bans.id, scope: bans.scope, reason: bans.reason, expiresAt: bans.expiresAt })
    .from(bans)
    .where(and(eq(bans.userId, userId), activeAt(ctx.now())));
  if (active.length === 0) return 0;
  const hashes = [
    ...new Set(
      (await accountIdentifiers(tx, userId)).map((id) => identifierHash(ctx.config.internalHmacSecret, id)),
    ),
  ];
  if (hashes.length === 0) return 0;
  await tx
    .insert(banEvasionMarks)
    .values(
      active.flatMap((b) =>
        hashes.map((identifierHash) => ({
          banId: b.id,
          identifierHash,
          scope: b.scope,
          reason: b.reason,
          expiresAt: b.expiresAt,
        })),
      ),
    )
    .onConflictDoNothing();
  return active.length;
}

/**
 * Re-applies retained bans whose identifiers the account now presents: its
 * linked identities and email, plus `extra` (e.g. a device secret offered at
 * sign-in that no identity holds yet). Each mark applies at most once per
 * account, even if that ban was later lifted.
 *
 * @param tx - Open transaction; the caller invalidates the ban cache after commit.
 * @param ctx - Shared services.
 * @param userId - The account signing in or just created.
 * @param extra - Identifiers presented but not (yet) linked.
 * @returns Number of bans newly applied.
 */
export async function reapplyRetainedBans(
  tx: DbOrTx,
  ctx: AppContext,
  userId: string,
  extra: readonly StableIdentifier[] = [],
): Promise<number> {
  const ids = [...(await accountIdentifiers(tx, userId)), ...extra];
  const hashes = [...new Set(ids.map((id) => identifierHash(ctx.config.internalHmacSecret, id)))];
  if (hashes.length === 0) return 0;
  const now = ctx.now();
  const marks = await tx
    .select({
      banId: banEvasionMarks.banId,
      scope: banEvasionMarks.scope,
      reason: banEvasionMarks.reason,
      expiresAt: banEvasionMarks.expiresAt,
    })
    .from(banEvasionMarks)
    .where(
      and(
        inArray(banEvasionMarks.identifierHash, hashes),
        isNull(banEvasionMarks.revokedAt),
        or(isNull(banEvasionMarks.expiresAt), gt(banEvasionMarks.expiresAt, now)),
      ),
    );
  const byBan = new Map(marks.map((m) => [m.banId, m]));
  if (byBan.size === 0) return 0;
  const inserted = await tx
    .insert(bans)
    .values(
      [...byBan.values()].map((m) => ({
        userId,
        scope: m.scope,
        reason: m.reason,
        expiresAt: m.expiresAt,
        evasionOf: m.banId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: bans.id });
  return inserted.length;
}

/**
 * Revokes the marks a lifted ban was re-applied from (an admin pardon covers
 * every later account too).
 *
 * @param db - Database or transaction.
 * @param evasionOf - The lifted ban's `evasion_of`.
 * @param now - Revocation time.
 */
export async function revokeMarks(db: DbOrTx, evasionOf: string, now: Date): Promise<void> {
  await db
    .update(banEvasionMarks)
    .set({ revokedAt: now })
    .where(and(eq(banEvasionMarks.banId, evasionOf), isNull(banEvasionMarks.revokedAt)));
}
