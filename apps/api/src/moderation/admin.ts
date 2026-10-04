/**
 * Admin routes shared by the `pnpm admin` CLI and the admin console,
 * complementing `moderation/routes.ts`, `moderation/reports.ts`,
 * `moderation/players.ts` and `news/routes.ts`:
 *
 * - `GET /internal/bans` — list bans (one player, a scope, or the newest), with names.
 * - `PATCH /internal/reports/:id` — resolve, dismiss or reopen a report.
 * - `GET /internal/flags` — every feature flag with its raw settings.
 * - `PATCH /internal/news/:id` — hide or restore a stored or bundled post.
 * - `GET /internal/users/lookup?q=` — find accounts by id, `name#tag` (the
 *   code players share to add friends), email, exact name or name prefix.
 * - `POST /internal/users/:id/rename` — force a display name change.
 *
 * Moderation routes accept the `moderator` role; flags and news need `admin`.
 * Every mutation writes an `admin_audit_log` row.
 */
import { NEWS_POSTS } from '@tumble/content/news';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { changeDisplayName } from '../accounts/accounts.ts';
import type { AppContext } from '../context.ts';
import { authIdentities, bans, featureFlags, newsPosts, profiles, reports, users } from '../db/schema.ts';
import { notFound, parse } from '../http/errors.ts';
import { parseNameTag } from '../names/display-name.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { BAN_SCOPES } from './sanctions.ts';

const UUID = z.string().uuid();
const BanListQuery = z.object({
  userId: UUID.optional(),
  /** `1` active only, `0` everything, `expired` lapsed or lifted only. */
  active: z.enum(['0', '1', 'expired']).default('1'),
  scope: z.enum(BAN_SCOPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const ReportPatch = z.object({
  status: z.enum(['open', 'resolved', 'dismissed', 'actioned']),
  reason: z.string().trim().max(500).optional(),
});
const NewsPatch = z.object({ hidden: z.boolean() });
const LookupQuery = z.object({ q: z.string().trim().min(1).max(320) });
const RenameBody = z.object({
  displayName: z.string().max(32),
  reason: z.string().trim().max(500).optional(),
});

/** `%`, `_` and `\` match literally in a LIKE prefix. */
const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Registers the admin routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/bans', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(BanListQuery, req.query);
    const now = ctx.now();
    const live = and(isNull(bans.revokedAt), or(isNull(bans.expiresAt), gt(bans.expiresAt, now)));
    const conds = [
      q.userId ? eq(bans.userId, q.userId) : undefined,
      q.scope ? eq(bans.scope, q.scope) : undefined,
      q.active === '1'
        ? live
        : q.active === 'expired'
          ? or(isNotNull(bans.revokedAt), lte(bans.expiresAt, now))
          : undefined,
    ];
    const rows = await ctx.db
      .select({ ban: bans, displayName: profiles.displayName, tag: profiles.tag })
      .from(bans)
      .leftJoin(profiles, eq(profiles.userId, bans.userId))
      .where(and(...conds))
      .orderBy(desc(bans.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    return {
      bans: rows.map((r) => ({ ...r.ban, displayName: r.displayName, tag: r.tag })),
      offset: q.offset,
      limit: q.limit,
    };
  });

  app.patch('/internal/reports/:id', async (req) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { status, reason } = parse(ReportPatch, req.body);
    const row = await ctx.db.transaction(async (tx) => {
      const [updated] = await tx.update(reports).set({ status }).where(eq(reports.id, id)).returning();
      if (!updated) throw notFound('Report');
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: `report.${status === 'open' ? 'reopen' : status}`,
          targetType: 'report',
          targetId: id,
          reason: reason || null,
          details: { targetUserId: updated.targetUserId },
        },
        tx,
      );
      return updated;
    });
    return { report: row };
  });

  app.get('/internal/flags', async (req) => {
    await requireStaff(ctx, req);
    return { flags: await ctx.db.select().from(featureFlags).orderBy(featureFlags.key) };
  });

  app.patch('/internal/news/:id', async (req) => {
    const actor = await requireStaff(ctx, req);
    const { id } = parse(z.object({ id: z.string().min(1).max(128) }), req.params);
    const { hidden } = parse(NewsPatch, req.body);
    const now = ctx.now();
    const [updated] = await ctx.db
      .update(newsPosts)
      .set({ hidden, updatedAt: now })
      .where(eq(newsPosts.id, id))
      .returning({ id: newsPosts.id });
    if (!updated) {
      // A bundled post has no row yet; store a copy so the hidden flag has somewhere to live.
      const bundled = NEWS_POSTS.find((p) => p.id === id);
      if (!bundled) throw notFound('News post');
      await ctx.db
        .insert(newsPosts)
        .values({ id, data: bundled, hidden, publishedAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: newsPosts.id, set: { hidden, updatedAt: now } });
    }
    await recordAudit(ctx, req, actor, {
      action: hidden ? 'news.hide' : 'news.show',
      targetType: 'news',
      targetId: id,
    });
    return { id, hidden };
  });

  app.get('/internal/users/lookup', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const { q } = parse(LookupQuery, req.query);
    const nameTag = parseNameTag(q);
    const where = UUID.safeParse(q).success
      ? eq(users.id, q)
      : nameTag
        ? and(sql`lower(${profiles.displayName}) = lower(${nameTag.name})`, eq(profiles.tag, nameTag.tag))
        : q.includes('@')
          ? sql`lower(${users.email}) = lower(${q})`
          : q.length >= 3
            ? sql`lower(${profiles.displayName}) like lower(${likePrefix(q)})`
            : sql`lower(${profiles.displayName}) = lower(${q})`;
    const rows = await ctx.db
      .select({
        id: users.id,
        isGuest: users.isGuest,
        email: users.email,
        region: users.region,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        displayName: profiles.displayName,
        tag: profiles.tag,
        level: profiles.level,
        crowns: profiles.crowns,
        gems: profiles.gems,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(where)
      .orderBy(desc(users.lastSeenAt))
      .limit(25);
    const ids = rows.map((u) => u.id);
    const providers = ids.length
      ? await ctx.db
          .select({ userId: authIdentities.userId, provider: authIdentities.provider })
          .from(authIdentities)
          .where(inArray(authIdentities.userId, ids))
      : [];
    const userBans = ids.length
      ? await ctx.db.select().from(bans).where(inArray(bans.userId, ids)).orderBy(desc(bans.createdAt))
      : [];
    return {
      users: rows.map((u) => ({
        ...u,
        providers: providers.filter((p) => p.userId === u.id).map((p) => p.provider),
        bans: userBans.filter((b) => b.userId === u.id).slice(0, 20),
      })),
    };
  });

  app.post('/internal/users/:id/rename', async (req) => {
    const actor = await requireStaff(ctx, req, 'moderator');
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { displayName, reason } = parse(RenameBody, req.body);
    const result = await ctx.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ name: profiles.displayName, tag: profiles.tag })
        .from(profiles)
        .where(eq(profiles.userId, id));
      if (!before) throw notFound('User');
      // Cooldown 0: moderators override it. The new change time restarts the
      // player's own cooldown, so they cannot immediately rename back.
      const after = await changeDisplayName(tx, id, displayName, ctx.now(), 0, 'staff');
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'player.rename',
          targetType: 'user',
          targetId: id,
          reason: reason || null,
          details: { from: `${before.name}#${before.tag}`, to: `${after.displayName}#${after.tag}` },
        },
        tx,
      );
      return after;
    });
    return { userId: id, ...result };
  });
}
