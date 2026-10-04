/**
 * Moderator sanctions shared by the ban routes, the report queue's bulk
 * actions and the player page: warnings, chat mutes, suspensions and lifting
 * them.
 *
 * Writes take a transaction so a sanction commits together with its report
 * updates and audit row; {@link announceSanction} / {@link announceLift} run
 * after the commit to drop every instance's ban cache (see
 * `invalidateBanCache`) and tell the player.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { bans, playerWarnings, reports, users } from '../db/schema.ts';
import { invalidateBanCache } from '../http/auth.ts';
import { notFound } from '../http/errors.ts';
import { revokeMarks } from './ban-evasion.ts';

/** Ban scopes: `all` suspends the account, `ranked` blocks ranked queues, `chat` mutes. */
export const BAN_SCOPES = ['all', 'ranked', 'chat'] as const;

/** A ban scope. */
export type BanScope = (typeof BAN_SCOPES)[number];

/** Longest timed sanction (ten years); anything longer is a permanent ban. */
export const MAX_SANCTION_HOURS = 24 * 365 * 10;

/** A sanction to apply. */
export interface SanctionInput {
  userId: string;
  /** `warn` records a strike only; `mute` is a `chat` ban; `ban` an `all` ban. */
  kind: 'warn' | 'mute' | 'ban' | 'ranked_ban';
  reason: string;
  /** Hours until it lapses; omitted means permanent (warnings never lapse). */
  durationHours?: number | undefined;
  /** Staff label recorded on warnings. */
  issuedBy: string;
  /** Report that prompted it, if any. */
  reportId?: string | null;
  /** Mark every open report against the player actioned (default: full bans only). */
  closeOpenReports?: boolean;
}

/** What {@link applySanction} wrote. */
export interface AppliedSanction {
  kind: SanctionInput['kind'];
  userId: string;
  /** Ban row id (mutes and bans). */
  banId?: string;
  /** Warning row id. */
  warningId?: string;
  expiresAt: Date | null;
}

const SCOPE: Record<Exclude<SanctionInput['kind'], 'warn'>, BanScope> = {
  mute: 'chat',
  ban: 'all',
  ranked_ban: 'ranked',
};

/**
 * Applies a sanction inside a transaction. A full ban also closes every open
 * report against the player unless {@link SanctionInput.closeOpenReports} says otherwise.
 *
 * @param tx - Open transaction.
 * @param now - Clock reading for the expiry.
 * @param input - The sanction.
 * @returns The rows written.
 * @throws {ApiError} 404 when the player does not exist.
 */
export async function applySanction(tx: DbOrTx, now: Date, input: SanctionInput): Promise<AppliedSanction> {
  const [target] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId));
  if (!target) throw notFound('Player');
  if (input.kind === 'warn') {
    const [w] = await tx
      .insert(playerWarnings)
      .values({
        userId: input.userId,
        reason: input.reason,
        reportId: input.reportId ?? null,
        issuedBy: input.issuedBy,
        createdAt: now,
      })
      .returning({ id: playerWarnings.id });
    return { kind: 'warn', userId: input.userId, warningId: w!.id, expiresAt: null };
  }
  const expiresAt = input.durationHours ? new Date(now.getTime() + input.durationHours * 3_600_000) : null;
  const [row] = await tx
    .insert(bans)
    .values({
      userId: input.userId,
      scope: SCOPE[input.kind],
      reason: input.reason,
      expiresAt,
      createdAt: now,
    })
    .returning({ id: bans.id });
  if (input.closeOpenReports ?? input.kind === 'ban') {
    await tx
      .update(reports)
      .set({ status: 'actioned' })
      .where(and(eq(reports.targetUserId, input.userId), eq(reports.status, 'open')));
  }
  return { kind: input.kind, userId: input.userId, banId: row!.id, expiresAt };
}

/**
 * Makes a committed sanction take effect everywhere and tells the player:
 * every API instance drops its cached ban state, and an online player gets a
 * notification (a suspended player's next request is refused anyway).
 *
 * @param ctx - Shared services.
 * @param s - What {@link applySanction} returned.
 * @param reason - Shown to the player.
 */
export async function announceSanction(ctx: AppContext, s: AppliedSanction, reason: string): Promise<void> {
  if (s.banId) await invalidateBanCache(ctx, s.userId);
  const until = s.expiresAt ? ` until ${s.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  const title =
    s.kind === 'warn'
      ? 'Warning from the moderators'
      : s.kind === 'mute'
        ? `Chat disabled${until}`
        : s.kind === 'ranked_ban'
          ? `Ranked disabled${until}`
          : `Account suspended${until}`;
  await ctx.notifier.notifyUser(s.userId, { type: 'notification', kind: 'warning', title, body: reason });
}

/**
 * Lifts a ban (or mute). Lifting a ban re-applied for ban evasion also
 * pardons the identifiers it came from.
 *
 * @param tx - Open transaction.
 * @param now - Revocation time.
 * @param banId - Ban to lift.
 * @returns The player and scope, or null when no such ban exists.
 */
export async function liftBan(
  tx: DbOrTx,
  now: Date,
  banId: string,
): Promise<{ userId: string; scope: string; alreadyLifted: boolean } | null> {
  const [before] = await tx.select({ revokedAt: bans.revokedAt }).from(bans).where(eq(bans.id, banId));
  if (!before) return null;
  const [row] = await tx
    .update(bans)
    .set({ revokedAt: before.revokedAt ?? now })
    .where(eq(bans.id, banId))
    .returning({ userId: bans.userId, scope: bans.scope, evasionOf: bans.evasionOf });
  if (row?.evasionOf) await revokeMarks(tx, row.evasionOf, now);
  return row ? { userId: row.userId, scope: row.scope, alreadyLifted: before.revokedAt !== null } : null;
}

/**
 * Marks reports with a final status.
 *
 * @param tx - Open transaction.
 * @param ids - Report ids.
 * @param status - New status.
 */
export async function setReportStatus(
  tx: DbOrTx,
  ids: readonly string[],
  status: 'open' | 'resolved' | 'dismissed' | 'actioned',
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(reports)
    .set({ status })
    .where(inArray(reports.id, [...ids]));
}
