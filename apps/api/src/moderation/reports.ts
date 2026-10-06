/**
 * The report queue for moderators:
 *
 * - `GET /internal/reports` — reports filtered by status, reason, player or
 *   match, oldest first by default, with both players' names, the target's
 *   other open reports and active sanctions, and the captured chat evidence.
 * - `POST /internal/reports/action` — one decision for up to 100 reports:
 *   dismiss or resolve them, or warn, mute (chat or voice), suspend or permanently ban every
 *   player they target. A reason is required and lands in the audit log.
 *
 * Sanctions commit with their report updates and audit rows in one
 * transaction, then take effect on every API instance (`announceSanction`).
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { bans, profiles, reports } from '../db/schema.ts';
import { notFound, parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { assertCanModerate } from './guard.ts';
import {
  announceSanction,
  applySanction,
  MAX_SANCTION_HOURS,
  setReportStatus,
  type AppliedSanction,
} from './sanctions.ts';

/** Report reasons players can pick (`POST /report`). */
export const REPORT_REASONS = [
  'cheating',
  'harassment',
  'offensive_name',
  'griefing',
  'spam',
  /** Something said in voice chat; evidence is room and time metadata only (no recording exists). */
  'voice',
  'other',
] as const;
/** Report statuses. */
export const REPORT_STATUSES = ['open', 'resolved', 'dismissed', 'actioned'] as const;
/** Decisions `POST /internal/reports/action` takes. */
export const REPORT_ACTIONS = ['dismiss', 'resolve', 'warn', 'mute', 'voice_mute', 'ban'] as const;
/** Actions that take a duration (a ban without one is permanent). */
const TIMED = new Set<string>(['mute', 'voice_mute', 'ban']);

const UUID = z.string().uuid();
const ListQuery = z.object({
  status: z.enum([...REPORT_STATUSES, 'all']).default('open'),
  reason: z.enum(REPORT_REASONS).optional(),
  targetUserId: UUID.optional(),
  reporterId: UUID.optional(),
  matchId: z.string().min(1).max(64).optional(),
  order: z.enum(['oldest', 'newest']).default('oldest'),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const ActionBody = z
  .object({
    reportIds: z.array(UUID).min(1).max(100),
    action: z.enum(REPORT_ACTIONS),
    reason: z.string().trim().min(3).max(500),
    /** Mute length; ban length (omitted = permanent ban). */
    durationHours: z.number().int().min(1).max(MAX_SANCTION_HOURS).optional(),
  })
  .strict()
  .refine((b) => (b.action !== 'mute' && b.action !== 'voice_mute') || b.durationHours !== undefined, {
    message: 'a mute needs durationHours',
    path: ['durationHours'],
  })
  .refine((b) => b.durationHours === undefined || TIMED.has(b.action), {
    message: 'durationHours only applies to mutes and bans',
    path: ['durationHours'],
  });

/**
 * Registers the report queue routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/reports', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(ListQuery, req.query);
    const conds: (SQL | undefined)[] = [
      q.status === 'all' ? undefined : eq(reports.status, q.status),
      q.reason ? eq(reports.reason, q.reason) : undefined,
      q.targetUserId ? eq(reports.targetUserId, q.targetUserId) : undefined,
      q.reporterId ? eq(reports.reporterId, q.reporterId) : undefined,
      q.matchId ? eq(reports.matchId, q.matchId) : undefined,
    ];
    const where = and(...conds);
    const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(reports).where(where);
    const rows = await ctx.db
      .select()
      .from(reports)
      .where(where)
      .orderBy(q.order === 'oldest' ? asc(reports.createdAt) : desc(reports.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    const people = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetUserId]))];
    const targets = [...new Set(rows.map((r) => r.targetUserId))];
    const names = people.length
      ? await ctx.db
          .select({ userId: profiles.userId, displayName: profiles.displayName, tag: profiles.tag })
          .from(profiles)
          .where(inArray(profiles.userId, people))
      : [];
    const openAgainst = targets.length
      ? await ctx.db
          .select({ userId: reports.targetUserId, n: count() })
          .from(reports)
          .where(and(inArray(reports.targetUserId, targets), eq(reports.status, 'open')))
          .groupBy(reports.targetUserId)
      : [];
    const now = ctx.now();
    const sanctions = targets.length
      ? await ctx.db
          .select({ userId: bans.userId, id: bans.id, scope: bans.scope, expiresAt: bans.expiresAt })
          .from(bans)
          .where(
            and(
              inArray(bans.userId, targets),
              isNull(bans.revokedAt),
              or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
            ),
          )
      : [];
    const person = (id: string) => {
      const p = names.find((n) => n.userId === id);
      return { id, displayName: p?.displayName ?? null, tag: p?.tag ?? null };
    };
    return {
      total,
      offset: q.offset,
      limit: q.limit,
      reports: rows.map((r) => ({
        ...r,
        reporter: person(r.reporterId),
        target: {
          ...person(r.targetUserId),
          openReports: openAgainst.find((o) => o.userId === r.targetUserId)?.n ?? 0,
          activeSanctions: sanctions
            .filter((s) => s.userId === r.targetUserId)
            .map(({ id, scope, expiresAt }) => ({ id, scope, expiresAt })),
        },
      })),
    };
  });

  app.post(
    '/internal/reports/action',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const actor = await requireStaff(ctx, req, 'moderator');
      const body = parse(ActionBody, req.body);
      const now = ctx.now();
      const found = await ctx.db
        .select({ id: reports.id, targetUserId: reports.targetUserId })
        .from(reports)
        .where(inArray(reports.id, body.reportIds));
      if (found.length === 0) throw notFound('Report');
      if (body.action !== 'dismiss' && body.action !== 'resolve')
        for (const target of new Set(found.map((r) => r.targetUserId)))
          await assertCanModerate(ctx, actor, target);

      const applied = await ctx.db.transaction(async (tx) => {
        const out: AppliedSanction[] = [];
        const status =
          body.action === 'dismiss' ? 'dismissed' : body.action === 'resolve' ? 'resolved' : 'actioned';
        if (body.action !== 'dismiss' && body.action !== 'resolve') {
          const byTarget = new Map<string, string[]>();
          for (const r of found)
            byTarget.set(r.targetUserId, [...(byTarget.get(r.targetUserId) ?? []), r.id]);
          for (const [userId, reportIds] of byTarget) {
            const s = await applySanction(tx, now, {
              userId,
              kind: body.action,
              reason: body.reason,
              durationHours: body.durationHours,
              issuedBy: actor.label,
              reportId: reportIds[0] ?? null,
            });
            out.push(s);
            await recordAudit(
              ctx,
              req,
              actor,
              {
                action: `player.${body.action}`,
                targetType: 'user',
                targetId: userId,
                reason: body.reason,
                details: {
                  reportIds,
                  banId: s.banId ?? null,
                  warningId: s.warningId ?? null,
                  durationHours: body.durationHours ?? null,
                },
              },
              tx,
            );
          }
        }
        await setReportStatus(
          tx,
          found.map((r) => r.id),
          status,
        );
        for (const r of found) {
          await recordAudit(
            ctx,
            req,
            actor,
            {
              action: `report.${body.action}`,
              targetType: 'report',
              targetId: r.id,
              reason: body.reason,
              details: { targetUserId: r.targetUserId },
            },
            tx,
          );
        }
        return out;
      });
      for (const s of applied) await announceSanction(ctx, s, body.reason);

      const foundIds = new Set(found.map((r) => r.id));
      return {
        updated: found.map((r) => r.id),
        missing: body.reportIds.filter((id) => !foundIds.has(id)),
        sanctions: applied.map((s) => ({
          userId: s.userId,
          kind: s.kind,
          banId: s.banId ?? null,
          warningId: s.warningId ?? null,
          expiresAt: s.expiresAt?.toISOString() ?? null,
        })),
      };
    },
  );
}
