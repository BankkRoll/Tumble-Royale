/**
 * Live news: `GET /news` (public) and `POST /internal/news` (admin).
 *
 * The feed is the news bundled with `@tumble/content` overlaid with posts
 * stored in `news_posts`, so a post can be published, corrected or withdrawn
 * without shipping a client. Clients keep their own bundled copy as the
 * offline fallback and merge this feed over it.
 */
import { NEWS_POSTS, NewsPostSchema, type NewsPost } from '@tumble/content/news';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { newsPosts } from '../db/schema.ts';
import { parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';

/**
 * A post as published live. Hero images may also be absolute `https://` URLs
 * (bundled posts can only use the client's public dir, which needs a release).
 */
export const LiveNewsPostSchema = NewsPostSchema.extend({
  image: z
    .string()
    .refine((v) => v.startsWith('/') || v.startsWith('https://'), 'image must be a site path or https URL')
    .optional(),
  /** Withdraw the post (also hides a bundled post with the same id). */
  hidden: z.boolean().optional(),
});

/** Body of `POST /internal/news`. */
export type LiveNewsPostInput = z.input<typeof LiveNewsPostSchema>;

/** Most live posts served; withdrawals are always all listed. */
const FEED_LIMIT = 200;

/**
 * The merged feed, newest first: stored posts replace bundled posts with the
 * same id, hidden stored posts remove them (and are listed in `withdrawn`).
 * A post dated in the future is held back until its date, so news can be
 * scheduled.
 *
 * @param ctx - API context.
 */
export async function newsFeed(ctx: AppContext): Promise<{ posts: NewsPost[]; withdrawn: string[] }> {
  const [rows, hiddenRows] = await Promise.all([
    ctx.db
      .select()
      .from(newsPosts)
      .where(eq(newsPosts.hidden, false))
      .orderBy(desc(newsPosts.publishedAt))
      .limit(FEED_LIMIT),
    // Every withdrawal, however old: a client may still hold its bundled copy.
    ctx.db.select({ id: newsPosts.id }).from(newsPosts).where(eq(newsPosts.hidden, true)),
  ]);
  const byId = new Map<string, NewsPost>(NEWS_POSTS.map((p) => [p.id, p]));
  for (const r of rows) {
    const post = LiveNewsPostSchema.safeParse(r.data);
    if (post.success) {
      const { hidden: _hidden, ...rest } = post.data;
      byId.set(r.id, rest);
    }
  }
  const withdrawn = hiddenRows.map((r) => r.id);
  for (const id of withdrawn) byId.delete(id);
  const now = ctx.now().getTime();
  const posts = [...byId.values()].filter((p) => !(Date.parse(p.date) > now));
  return { posts: posts.sort((a, b) => b.date.localeCompare(a.date)), withdrawn };
}

/**
 * Registers the news routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerNewsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/news', async (_req, reply) => {
    // Short shared cache: news changes rarely and every menu open asks for it.
    reply.header('cache-control', 'public, max-age=60');
    // `withdrawn` lets clients drop their bundled copy of a post the server retracted.
    return newsFeed(ctx);
  });

  // SECURITY: publishing reaches every player's menu, so it is admin-only.
  app.post('/internal/news', async (req, reply) => {
    const actor = await requireStaff(ctx, req);
    const post = parse(LiveNewsPostSchema, req.body);
    const now = ctx.now();
    const [prev] = await ctx.db.select({ id: newsPosts.id }).from(newsPosts).where(eq(newsPosts.id, post.id));
    await ctx.db
      .insert(newsPosts)
      .values({ id: post.id, data: post, hidden: post.hidden ?? false, publishedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: newsPosts.id,
        set: { data: post, hidden: post.hidden ?? false, updatedAt: now },
      });
    await recordAudit(ctx, req, actor, { action: 'news.publish', targetType: 'news', targetId: post.id });
    // 201 only when this created the post; a correction or withdrawal is an update.
    return reply.code(prev ? 200 : 201).send({ post });
  });
}
