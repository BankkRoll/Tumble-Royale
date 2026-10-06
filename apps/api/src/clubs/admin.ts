/**
 * The admin console's Clubs view (moderator role and up):
 *
 * - `GET /internal/clubs` — clubs by name or tag, live, disbanded or all,
 *   with their open report counts; `?reported=1` lists reported clubs first.
 * - `GET /internal/clubs/:id` — one club: settings, roster, recent chat
 *   (evidence), reports and its audit trail.
 * - `POST /internal/clubs/:id/rename` `{ name, tag?, reason }`, `/reset-name`,
 *   `/clear-description`, `/reset-emblem`, `/disband` — each with a required
 *   reason.
 * - `GET /internal/club-reports`, `POST /internal/club-reports/action` — the
 *   club report queue (dismiss or resolve, in bulk).
 *
 * Every mutation writes its `admin_audit_log` row in the same transaction as
 * the change, then tells the club's members once it is committed.
 */
import { randomInt } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkClubName, checkClubTag, CLUB_TEXT_MESSAGES, DEFAULT_CLUB_EMBLEM } from '@tumble/shared';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { adminAuditLog, clubReports, clubs, profiles } from '../db/schema.ts';
import { badRequest, conflict, isUniqueViolation, notFound, parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { recentClubMessages } from './chat.ts';
import { clubCard, disbandClub, notifyClub, roster, type ClubRow } from './service.ts';

/** Club report statuses. */
export const CLUB_REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
/** Chat lines shown on a club's console page. */
export const ADMIN_CLUB_CHAT_LINES = 100;

const UUID = z.string().uuid();
const IdParams = z.object({ id: UUID });
const Reason = z.string().trim().min(3).max(500);
const ReasonBody = z.object({ reason: Reason }).strict();
const RenameBody = z
  .object({ name: z.string().max(64), tag: z.string().max(16).optional(), reason: Reason })
  .strict();
const ListQuery = z.object({
  q: z.string().trim().max(24).optional(),
  status: z.enum(['live', 'disbanded', 'all']).default('live'),
  reported: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const ReportQuery = z.object({
  status: z.enum([...CLUB_REPORT_STATUSES, 'all']).default('open'),
  clubId: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const ReportActionBody = z
  .object({
    reportIds: z.array(UUID).min(1).max(100),
    action: z.enum(['dismiss', 'resolve']),
    reason: Reason,
  })
  .strict();

const SAFE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

/** A neutral replacement identity: no vowels, so it can never spell a word. */
function safeIdentity(): { name: string; tag: string } {
  const pick = (n: number) =>
    Array.from({ length: n }, () => SAFE_ALPHABET[randomInt(SAFE_ALPHABET.length)]).join('');
  return { name: `Club ${pick(6)}`, tag: pick(4) };
}

/** Matches a club id exactly, or a name (anywhere) or tag (prefix). */
function searchWhere(q: string): SQL | undefined {
  if (UUID.safeParse(q).success) return eq(clubs.id, q);
  const term = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return or(ilike(clubs.name, `%${term}%`), ilike(clubs.tag, `${term}%`));
}

/** True when no other live club uses this name or tag (case-insensitive). */
async function identityFree(tx: DbOrTx, id: string, name: string, tag: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: clubs.id })
    .from(clubs)
    .where(
      and(
        isNull(clubs.disbandedAt),
        ne(clubs.id, id),
        or(sql`lower(${clubs.name}) = lower(${name})`, sql`lower(${clubs.tag}) = lower(${tag})`),
      ),
    )
    .limit(1);
  return !hit;
}

/** Loads a club (live or disbanded) for a console action, locked. */
async function lockAny(tx: DbOrTx, id: string): Promise<ClubRow> {
  const [c] = await tx.select().from(clubs).where(eq(clubs.id, id)).for('update');
  if (!c) throw notFound('Club');
  return c;
}

/**
 * Registers the club moderation routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerClubAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/clubs', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(ListQuery, req.query);
    const where = and(
      q.status === 'live'
        ? isNull(clubs.disbandedAt)
        : q.status === 'disbanded'
          ? isNotNull(clubs.disbandedAt)
          : undefined,
      q.q ? searchWhere(q.q) : undefined,
    );
    const open = ctx.db
      .select({ clubId: clubReports.clubId, n: count().as('n') })
      .from(clubReports)
      .where(eq(clubReports.status, 'open'))
      .groupBy(clubReports.clubId)
      .as('open_reports');
    const rows = await ctx.db
      .select({ club: clubs, openReports: open.n })
      .from(clubs)
      .leftJoin(open, eq(open.clubId, clubs.id))
      .where(where)
      .orderBy(...(q.reported === '1' ? [desc(open.n)] : []), desc(clubs.lastActivityAt))
      .limit(q.limit)
      .offset(q.offset);
    return {
      offset: q.offset,
      limit: q.limit,
      clubs: rows.map((r) => ({
        ...clubCard(r.club),
        disbandedAt: r.club.disbandedAt?.toISOString() ?? null,
        openReports: Number(r.openReports ?? 0),
      })),
    };
  });

  app.get('/internal/clubs/:id', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const { id } = parse(IdParams, req.params);
    const [club] = await ctx.db.select().from(clubs).where(eq(clubs.id, id));
    if (!club) throw notFound('Club');
    const [members, chat, reports, audit] = await Promise.all([
      club.disbandedAt ? Promise.resolve([]) : roster(ctx, id),
      recentClubMessages(ctx, id, ADMIN_CLUB_CHAT_LINES),
      ctx.db
        .select({
          id: clubReports.id,
          reason: clubReports.reason,
          details: clubReports.details,
          status: clubReports.status,
          snapshot: clubReports.snapshot,
          evidence: clubReports.evidence,
          createdAt: clubReports.createdAt,
          reporterId: clubReports.reporterId,
          reporterName: profiles.displayName,
          reporterTag: profiles.tag,
        })
        .from(clubReports)
        .leftJoin(profiles, eq(profiles.userId, clubReports.reporterId))
        .where(eq(clubReports.clubId, id))
        .orderBy(desc(clubReports.createdAt))
        .limit(50),
      ctx.db
        .select()
        .from(adminAuditLog)
        .where(and(eq(adminAuditLog.targetType, 'club'), eq(adminAuditLog.targetId, id)))
        .orderBy(desc(adminAuditLog.id))
        .limit(30),
    ]);
    return {
      club: {
        ...clubCard(club),
        disbandedAt: club.disbandedAt?.toISOString() ?? null,
        disbandReason: club.disbandReason,
      },
      members,
      chat,
      reports,
      audit,
    };
  });

  /**
   * One audited change to a club: runs `change` and the audit row in a
   * transaction, then tells the members to refresh.
   */
  const act = async (
    req: Parameters<typeof requireStaff>[1],
    action: string,
    change: (tx: DbOrTx, club: ClubRow) => Promise<Record<string, unknown>>,
  ) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(IdParams, req.params);
    const { reason } = parse(z.object({ reason: Reason }).passthrough(), req.body);
    const details = await ctx.db.transaction(async (tx) => {
      const club = await lockAny(tx, id);
      if (club.disbandedAt) throw conflict('club_disbanded', 'That club was already disbanded');
      const d = await change(tx, club);
      await recordAudit(
        ctx,
        req,
        actor,
        { action, targetType: 'club', targetId: id, reason, details: d },
        tx,
      );
      return d;
    });
    await notifyClub(ctx, id, { type: 'club_update', clubId: id });
    return details;
  };

  /** Applies a new name/tag, mapping a race on the unique index to a conflict. */
  const rename = async (tx: DbOrTx, club: ClubRow, name: string, tag: string) => {
    if (!(await identityFree(tx, club.id, name, tag)))
      throw conflict('name_taken', 'Another club already has that name or tag');
    try {
      await tx.update(clubs).set({ name, tag, updatedAt: ctx.now() }).where(eq(clubs.id, club.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('name_taken', 'Another club already has that name or tag');
      throw err;
    }
    return { from: { name: club.name, tag: club.tag }, to: { name, tag } };
  };

  app.post('/internal/clubs/:id/rename', async (req) => {
    const body = parse(RenameBody, req.body);
    const name = checkClubName(body.name);
    if (!name.ok) throw badRequest('invalid_club_name', CLUB_TEXT_MESSAGES.name[name.reason]);
    const tag = body.tag !== undefined ? checkClubTag(body.tag) : null;
    if (tag && !tag.ok) throw badRequest('invalid_club_tag', CLUB_TEXT_MESSAGES.tag[tag.reason]);
    return act(req, 'club.rename', (tx, club) =>
      rename(tx, club, name.value, tag?.ok ? tag.value : club.tag),
    );
  });

  app.post('/internal/clubs/:id/reset-name', async (req) => {
    parse(ReasonBody, req.body);
    return act(req, 'club.reset_name', async (tx, club) => {
      let next = safeIdentity();
      // A collision is checked before writing: a failed write would abort the transaction.
      for (let i = 0; i < 5 && !(await identityFree(tx, club.id, next.name, next.tag)); i++)
        next = safeIdentity();
      return rename(tx, club, next.name, next.tag);
    });
  });

  app.post('/internal/clubs/:id/clear-description', async (req) => {
    parse(ReasonBody, req.body);
    return act(req, 'club.clear_description', async (tx, club) => {
      await tx.update(clubs).set({ description: '', updatedAt: ctx.now() }).where(eq(clubs.id, club.id));
      return { from: club.description };
    });
  });

  app.post('/internal/clubs/:id/reset-emblem', async (req) => {
    parse(ReasonBody, req.body);
    return act(req, 'club.reset_emblem', async (tx, club) => {
      await tx
        .update(clubs)
        .set({ emblem: DEFAULT_CLUB_EMBLEM, updatedAt: ctx.now() })
        .where(eq(clubs.id, club.id));
      return { from: club.emblem };
    });
  });

  app.post('/internal/clubs/:id/disband', async (req) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(IdParams, req.params);
    const { reason } = parse(ReasonBody, req.body);
    const result = await ctx.db.transaction(async (tx) => {
      const club = await lockAny(tx, id);
      if (club.disbandedAt) throw conflict('club_disbanded', 'That club was already disbanded');
      const members = await disbandClub(tx, id, reason, ctx.now());
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'club.disband',
          targetType: 'club',
          targetId: id,
          reason,
          details: { name: club.name, tag: club.tag, members: members.length },
        },
        tx,
      );
      return { club, members };
    });
    await ctx.notifier.notifyMany(result.members, {
      type: 'club_removed',
      clubId: id,
      name: result.club.name,
      reason: 'disbanded',
    });
    return { disbanded: id, members: result.members.length };
  });

  app.get('/internal/club-reports', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(ReportQuery, req.query);
    const conds: (SQL | undefined)[] = [
      q.status === 'all' ? undefined : eq(clubReports.status, q.status),
      q.clubId ? eq(clubReports.clubId, q.clubId) : undefined,
    ];
    const rows = await ctx.db
      .select({
        report: clubReports,
        clubName: clubs.name,
        clubTag: clubs.tag,
        disbandedAt: clubs.disbandedAt,
        reporterName: profiles.displayName,
        reporterTag: profiles.tag,
      })
      .from(clubReports)
      .innerJoin(clubs, eq(clubs.id, clubReports.clubId))
      .leftJoin(profiles, eq(profiles.userId, clubReports.reporterId))
      .where(and(...conds))
      .orderBy(asc(clubReports.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    return {
      offset: q.offset,
      limit: q.limit,
      reports: rows.map((r) => ({
        ...r.report,
        club: { id: r.report.clubId, name: r.clubName, tag: r.clubTag, disbanded: r.disbandedAt !== null },
        reporter: { id: r.report.reporterId, displayName: r.reporterName, tag: r.reporterTag },
      })),
    };
  });

  app.post(
    '/internal/club-reports/action',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const actor = await requireStaff(ctx, req, 'moderator');
      const body = parse(ReportActionBody, req.body);
      const status = body.action === 'dismiss' ? 'dismissed' : 'resolved';
      const updated = await ctx.db.transaction(async (tx) => {
        const rows = await tx
          .update(clubReports)
          .set({ status })
          .where(inArray(clubReports.id, body.reportIds))
          .returning({ id: clubReports.id, clubId: clubReports.clubId });
        for (const r of rows)
          await recordAudit(
            ctx,
            req,
            actor,
            {
              action: `club_report.${body.action}`,
              targetType: 'club',
              targetId: r.clubId,
              reason: body.reason,
              details: { reportId: r.id },
            },
            tx,
          );
        return rows;
      });
      if (updated.length === 0) throw notFound('Club report');
      const found = new Set(updated.map((r) => r.id));
      return { updated: [...found], missing: body.reportIds.filter((id) => !found.has(id)) };
    },
  );
}
