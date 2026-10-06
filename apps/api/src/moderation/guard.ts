/**
 * Staff-on-staff limits for moderation actions.
 *
 * Responsibilities:
 * - {@link assertCanModerate}: a console actor may only act on accounts whose
 *   staff role is below its own (a moderator cannot ban, mute, warn or rename
 *   another moderator or an admin, nor sanction themselves);
 * - {@link assertCanLiftBan}: lifting a ban also needs the role that issued
 *   it, and nobody lifts a ban on their own account.
 *
 * The operator token (`ADMIN_TOKEN`) is the deployment's root credential and
 * is exempt, so a rogue console admin can still be stopped from the CLI.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { adminAuditLog, bans } from '../db/schema.ts';
import { forbidden } from '../http/errors.ts';
import { roleAtLeast, STAFF_ROLES, staffRoleOf, type StaffActor, type StaffRole } from '../staff/auth.ts';

/**
 * Refuses a moderation action on an account whose staff role is at least the
 * actor's (which includes the actor's own account).
 *
 * @param ctx - Shared services.
 * @param actor - From `requireStaff`.
 * @param targetUserId - Account being acted on.
 * @throws {ApiError} 403 `target_is_staff`.
 * @example
 * await assertCanModerate(ctx, actor, body.userId);
 */
export async function assertCanModerate(
  ctx: AppContext,
  actor: StaffActor,
  targetUserId: string,
): Promise<void> {
  if (actor.kind === 'token') return;
  if (actor.userId === targetUserId)
    throw forbidden('target_is_staff', 'Staff cannot take moderation actions on their own account');
  const target = await staffRoleOf(ctx, targetUserId);
  // SECURITY: without this a moderator could silence or rename the admins who
  // review them.
  if (target && roleAtLeast(target.role, actor.role))
    throw forbidden('target_is_staff', `Only a higher role can act on a ${target.role}`);
}

/**
 * The most senior role recorded as issuing a ban, following a ban re-applied
 * for evasion back to the audit entry of the ban it was copied from.
 *
 * @returns Null when no audit row names the ban (seeded or pre-audit rows).
 */
async function issuerRole(db: DbOrTx, banId: string, evasionOf: string | null): Promise<StaffRole | null> {
  const ids = evasionOf ? [banId, evasionOf] : [banId];
  const rows = await db
    .select({ role: adminAuditLog.actorRole })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.targetType, 'user'),
        inArray(sql<string>`${adminAuditLog.details}->>'banId'`, ids),
      ),
    );
  let best: StaffRole | null = null;
  for (const r of rows) {
    if (!(STAFF_ROLES as readonly string[]).includes(r.role)) continue;
    const role = r.role as StaffRole;
    if (!best || roleAtLeast(role, best)) best = role;
  }
  return best;
}

/**
 * Refuses to lift a ban the actor may not lift: one on their own account, one
 * issued by a higher role, or one on an account they may not moderate.
 *
 * Call it before opening the lift's transaction: it reads through `ctx.db`,
 * which would wait forever on a single-connection (PGlite) pool held by that
 * transaction.
 *
 * @param ctx - Shared services.
 * @param actor - From `requireStaff`.
 * @param banId - Ban to lift.
 * @returns False when the ban does not exist.
 * @throws {ApiError} 403 `target_is_staff` / `ban_issued_by_admin`.
 */
export async function assertCanLiftBan(ctx: AppContext, actor: StaffActor, banId: string): Promise<boolean> {
  const db = ctx.db;
  const [ban] = await db
    .select({ userId: bans.userId, evasionOf: bans.evasionOf })
    .from(bans)
    .where(eq(bans.id, banId));
  if (!ban) return false;
  if (actor.kind === 'token') return true;
  await assertCanModerate(ctx, actor, ban.userId);
  const issuer = await issuerRole(db, banId, ban.evasionOf);
  if (issuer && !roleAtLeast(actor.role, issuer))
    throw forbidden('ban_issued_by_admin', `Only an ${issuer} can lift this ban`);
  return true;
}
