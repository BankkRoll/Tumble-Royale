/**
 * Admin routes used by the `pnpm admin` CLI (all behind `ADMIN_TOKEN`),
 * complementing the ones in `moderation/routes.ts` and `news/routes.ts`:
 *
 * - `GET /internal/bans` — list bans (one player, or the newest).
 * - `PATCH /internal/reports/:id` — resolve, dismiss or reopen a report.
 * - `GET /internal/flags` — every feature flag with its raw settings.
 * - `PATCH /internal/news/:id` — hide or restore a stored or bundled post.
 * - `GET /internal/users/lookup?q=` — find an account by id, `name#tag` or email.
 * - `POST /internal/users/:id/rename` — force a display name change.
 *
 * Every mutation writes an `audit.admin.*` event so moderator actions can be
 * reviewed later (the retention job keeps `audit.*` events).
 */
import { NEWS_POSTS } from '@tumble/content/news';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { changeDisplayName } from '../accounts/accounts.ts';
import type { AppContext } from '../context.ts';
import {
  authIdentities,
  bans,
  events,
  featureFlags,
  newsPosts,
  profiles,
  reports,
  users,
} from '../db/schema.ts';
import { requireAdmin } from '../http/auth.ts';
import { notFound, parse } from '../http/errors.ts';
import { parseNameTag } from '../names/display-name.ts';

const UUID = z.string().uuid();
const BanListQuery = z.object({
  userId: UUID.optional(),
  active: z.enum(['0', '1']).default('1'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const ReportPatch = z.object({ status: z.enum(['open', 'resolved', 'dismissed', 'actioned']) });
const NewsPatch = z.object({ hidden: z.boolean() });
const LookupQuery = z.object({ q: z.string().trim().min(1).max(320) });
const RenameBody = z.object({ displayName: z.string().max(32) });

async function audit(ctx: AppContext, req: FastifyRequest, name: string, props: Record<string, unknown>) {
  req.log.info({ audit: name, ...props }, 'admin action');
  await ctx.db
    .insert(events)
    .values({ userId: null, name: `audit.admin.${name}`, props: { ...props, ip: req.ip } });
}

/**
 * Registers the admin routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/internal/bans', async (req) => {
    requireAdmin(ctx, req);
    const q = parse(BanListQuery, req.query);
    const now = ctx.now();
    const conds = [
      q.userId ? eq(bans.userId, q.userId) : undefined,
      q.active === '1'
        ? and(isNull(bans.revokedAt), or(isNull(bans.expiresAt), gt(bans.expiresAt, now)))
        : undefined,
    ];
    const rows = await ctx.db
      .select()
      .from(bans)
      .where(and(...conds))
      .orderBy(desc(bans.createdAt))
      .limit(q.limit);
    return { bans: rows };
  });

  app.patch('/internal/reports/:id', async (req) => {
    requireAdmin(ctx, req);
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { status } = parse(ReportPatch, req.body);
    const [row] = await ctx.db.update(reports).set({ status }).where(eq(reports.id, id)).returning();
    if (!row) throw notFound('Report');
    await audit(ctx, req, 'report_status', { reportId: id, status });
    return { report: row };
  });

  app.get('/internal/flags', async (req) => {
    requireAdmin(ctx, req);
    return { flags: await ctx.db.select().from(featureFlags).orderBy(featureFlags.key) };
  });

  app.patch('/internal/news/:id', async (req) => {
    requireAdmin(ctx, req);
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
    await audit(ctx, req, hidden ? 'news_hide' : 'news_show', { postId: id });
    return { id, hidden };
  });

  app.get('/internal/users/lookup', async (req) => {
    requireAdmin(ctx, req);
    const { q } = parse(LookupQuery, req.query);
    const nameTag = parseNameTag(q);
    const where = UUID.safeParse(q).success
      ? eq(users.id, q)
      : nameTag
        ? and(sql`lower(${profiles.displayName}) = lower(${nameTag.name})`, eq(profiles.tag, nameTag.tag))
        : q.includes('@')
          ? sql`lower(${users.email}) = lower(${q})`
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
      .limit(25);
    const out = [];
    for (const u of rows) {
      const providers = await ctx.db
        .select({ provider: authIdentities.provider })
        .from(authIdentities)
        .where(eq(authIdentities.userId, u.id));
      const userBans = await ctx.db
        .select()
        .from(bans)
        .where(eq(bans.userId, u.id))
        .orderBy(desc(bans.createdAt))
        .limit(20);
      out.push({ ...u, providers: providers.map((p) => p.provider), bans: userBans });
    }
    return { users: out };
  });

  app.post('/internal/users/:id/rename', async (req) => {
    requireAdmin(ctx, req);
    const { id } = parse(z.object({ id: UUID }), req.params);
    const { displayName } = parse(RenameBody, req.body);
    const [before] = await ctx.db
      .select({ name: profiles.displayName, tag: profiles.tag })
      .from(profiles)
      .where(eq(profiles.userId, id));
    if (!before) throw notFound('User');
    // Cooldown 0: moderators override it. The new change time restarts the
    // player's own cooldown, so they cannot immediately rename back.
    const after = await ctx.db.transaction((tx) => changeDisplayName(tx, id, displayName, ctx.now(), 0));
    await audit(ctx, req, 'rename', {
      userId: id,
      from: `${before.name}#${before.tag}`,
      to: `${after.displayName}#${after.tag}`,
    });
    return { userId: id, ...after };
  });
}
