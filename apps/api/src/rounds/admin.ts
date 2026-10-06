/**
 * Moderation of shared custom rounds (admin console "Shared rounds"):
 *
 * - `GET /internal/custom-rounds`: rounds by status, reported first on
 *   request, with author and open report counts (moderator).
 * - `GET /internal/custom-rounds/:code`: one round with its JSON and reports (moderator).
 * - `POST /internal/custom-rounds/:code/takedown`: removes it everywhere and
 *   closes its open reports (moderator).
 * - `POST /internal/custom-rounds/:code/dismiss-reports`: closes open reports
 *   without action (moderator).
 * - `POST /internal/custom-rounds/:code/restore`: undoes a takedown (admin).
 *
 * Every mutation writes its `admin_audit_log` row in the same transaction.
 */
import { normalizeShareCode } from '@tumble/content/custom';
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { customRoundReports, customRounds, profiles } from '../db/schema.ts';
import { conflict, notFound, parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { CUSTOM_ROUND_STATUSES, roundSummary } from './customRounds.ts';

const ListQuery = z.object({
  status: z.enum([...CUSTOM_ROUND_STATUSES, 'all']).default('all'),
  reported: z.enum(['0', '1']).default('0'),
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const CodeParams = z.object({ code: z.string().min(1).max(32) });
const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

function code(params: unknown): string {
  const c = normalizeShareCode(parse(CodeParams, params).code);
  if (!c) throw notFound('Round');
  return c;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Registers the shared-round moderation routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerCustomRoundAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/custom-rounds', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(ListQuery, req.query);
    const openReports = ctx.db
      .select({ roundId: customRoundReports.roundId, n: count().as('n') })
      .from(customRoundReports)
      .where(eq(customRoundReports.status, 'open'))
      .groupBy(customRoundReports.roundId)
      .as('open_reports');
    const asCode = q.q ? normalizeShareCode(q.q) : null;
    const conds: (SQL | undefined)[] = [
      q.status === 'all' ? undefined : eq(customRounds.status, q.status),
      q.q
        ? or(
            ilike(customRounds.name, `%${escapeLike(q.q)}%`),
            asCode ? eq(customRounds.code, asCode) : undefined,
          )
        : undefined,
    ];
    const base = ctx.db
      .select({
        round: customRounds,
        reports: openReports.n,
        authorName: profiles.displayName,
        authorTag: profiles.tag,
      })
      .from(customRounds)
      .leftJoin(openReports, eq(openReports.roundId, customRounds.id))
      .leftJoin(profiles, eq(profiles.userId, customRounds.ownerId));
    const rows = await (
      q.reported === '1'
        ? base
            .where(and(...conds, isNotNull(openReports.roundId)))
            .orderBy(desc(openReports.n), asc(customRounds.createdAt))
        : base.where(and(...conds)).orderBy(desc(customRounds.createdAt))
    )
      .limit(q.limit)
      .offset(q.offset);
    return {
      offset: q.offset,
      limit: q.limit,
      rounds: rows.map((r) => ({
        ...roundSummary(r.round, true),
        ownerId: r.round.ownerId,
        author: r.authorName ? `${r.authorName}#${r.authorTag}` : null,
        openReports: Number(r.reports ?? 0),
        takenDownBy: r.round.takenDownBy,
        takenDownAt: r.round.takenDownAt?.toISOString() ?? null,
      })),
    };
  });

  app.get('/internal/custom-rounds/:code', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const c = code(req.params);
    const [row] = await ctx.db.select().from(customRounds).where(eq(customRounds.code, c));
    if (!row) throw notFound('Round');
    const [author] = await ctx.db
      .select({ displayName: profiles.displayName, tag: profiles.tag })
      .from(profiles)
      .where(eq(profiles.userId, row.ownerId));
    const reports = await ctx.db
      .select({
        id: customRoundReports.id,
        reason: customRoundReports.reason,
        details: customRoundReports.details,
        status: customRoundReports.status,
        createdAt: customRoundReports.createdAt,
        reporterId: customRoundReports.reporterId,
        reporterName: profiles.displayName,
        reporterTag: profiles.tag,
      })
      .from(customRoundReports)
      .leftJoin(profiles, eq(profiles.userId, customRoundReports.reporterId))
      .where(eq(customRoundReports.roundId, row.id))
      .orderBy(desc(customRoundReports.createdAt))
      .limit(200);
    return {
      round: {
        ...roundSummary(row, true),
        ownerId: row.ownerId,
        author: author ? `${author.displayName}#${author.tag}` : null,
        takenDownBy: row.takenDownBy,
        takenDownAt: row.takenDownAt?.toISOString() ?? null,
        definition: row.definition,
      },
      reports: reports.map((r) => ({
        id: r.id,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        reporter: { id: r.reporterId, name: r.reporterName ? `${r.reporterName}#${r.reporterTag}` : null },
      })),
    };
  });

  app.post(
    '/internal/custom-rounds/:code/takedown',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const actor = await requireStaff(ctx, req, 'moderator');
      const c = code(req.params);
      const { reason } = parse(ReasonBody, req.body);
      const now = ctx.now();
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(customRounds)
          .set({
            status: 'taken_down',
            takedownReason: reason,
            takenDownBy: actor.label,
            takenDownAt: now,
            updatedAt: now,
          })
          .where(and(eq(customRounds.code, c), inArray(customRounds.status, ['published', 'unpublished'])))
          .returning();
        if (!row) {
          const [exists] = await tx
            .select({ id: customRounds.id })
            .from(customRounds)
            .where(eq(customRounds.code, c));
          if (!exists) throw notFound('Round');
          throw conflict('already_taken_down', 'This round is already taken down');
        }
        const closed = await tx
          .update(customRoundReports)
          .set({ status: 'actioned' })
          .where(and(eq(customRoundReports.roundId, row.id), eq(customRoundReports.status, 'open')))
          .returning({ id: customRoundReports.id });
        await recordAudit(
          ctx,
          req,
          actor,
          {
            action: 'custom_round.takedown',
            targetType: 'custom_round',
            targetId: c,
            reason,
            details: { ownerId: row.ownerId, name: row.name, reportIds: closed.map((r) => r.id) },
          },
          tx,
        );
        return { round: roundSummary(row, true), reportsClosed: closed.length };
      });
    },
  );

  app.post(
    '/internal/custom-rounds/:code/dismiss-reports',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const actor = await requireStaff(ctx, req, 'moderator');
      const c = code(req.params);
      const { reason } = parse(ReasonBody, req.body);
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx.select().from(customRounds).where(eq(customRounds.code, c));
        if (!row) throw notFound('Round');
        const closed = await tx
          .update(customRoundReports)
          .set({ status: 'dismissed' })
          .where(and(eq(customRoundReports.roundId, row.id), eq(customRoundReports.status, 'open')))
          .returning({ id: customRoundReports.id });
        await recordAudit(
          ctx,
          req,
          actor,
          {
            action: 'custom_round.dismiss_reports',
            targetType: 'custom_round',
            targetId: c,
            reason,
            details: { reportIds: closed.map((r) => r.id) },
          },
          tx,
        );
        return { reportsClosed: closed.length };
      });
    },
  );

  app.post(
    '/internal/custom-rounds/:code/restore',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const actor = await requireStaff(ctx, req, 'admin');
      const c = code(req.params);
      const { reason } = parse(ReasonBody, req.body);
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(customRounds)
          .set({
            status: 'published',
            takedownReason: null,
            takenDownBy: null,
            takenDownAt: null,
            updatedAt: ctx.now(),
          })
          .where(and(eq(customRounds.code, c), eq(customRounds.status, 'taken_down')))
          .returning();
        if (!row) {
          const [exists] = await tx
            .select({ id: customRounds.id })
            .from(customRounds)
            .where(eq(customRounds.code, c));
          if (!exists) throw notFound('Round');
          throw conflict('not_taken_down', 'This round is not taken down');
        }
        await recordAudit(
          ctx,
          req,
          actor,
          {
            action: 'custom_round.restore',
            targetType: 'custom_round',
            targetId: c,
            reason,
            details: { ownerId: row.ownerId },
          },
          tx,
        );
        return { round: roundSummary(row, true) };
      });
    },
  );
}
