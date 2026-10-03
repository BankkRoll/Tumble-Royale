/**
 * Live news: `GET /news` (public) and `POST /internal/news` (ADMIN_TOKEN).
 *
 * The feed is the news bundled with `@tumble/content` overlaid with posts
 * stored in `news_posts`, so a post can be published, corrected or withdrawn
 * without shipping a client. Clients keep their own bundled copy as the
 * offline fallback and merge this feed over it.
 */
import { NEWS_POSTS, NewsPostSchema, type NewsPost } from '@tumble/content/news';
import { desc, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { newsPosts } from '../db/schema.ts';
import { requireAdmin } from '../http/auth.ts';
import { parse } from '../http/errors.ts';

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

/**
 * The merged feed, newest first: stored posts replace bundled posts with the
 * same id, hidden stored posts remove them (and are listed in `withdrawn`).
 *
 * @param ctx - API context.
 */
export async function newsFeed(ctx: AppContext): Promise<{ posts: NewsPost[]; withdrawn: string[] }> {
  const rows = await ctx.db.select().from(newsPosts).orderBy(desc(newsPosts.publishedAt)).limit(200);
  const byId = new Map<string, NewsPost>(NEWS_POSTS.map((p) => [p.id, p]));
  const withdrawn: string[] = [];
  for (const r of rows) {
    if (r.hidden) {
      byId.delete(r.id);
      withdrawn.push(r.id);
      continue;
    }
    const post = LiveNewsPostSchema.safeParse(r.data);
    if (post.success) {
      const { hidden: _hidden, ...rest } = post.data;
      byId.set(r.id, rest);
    }
  }
  return { posts: [...byId.values()].sort((a, b) => b.date.localeCompare(a.date)), withdrawn };
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
    requireAdmin(ctx, req);
    const post = parse(LiveNewsPostSchema, req.body);
    const now = ctx.now();
    await ctx.db
      .insert(newsPosts)
      .values({ id: post.id, data: post, hidden: post.hidden ?? false, publishedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: newsPosts.id,
        set: { data: post, hidden: post.hidden ?? false, updatedAt: sql`now()` },
      });
    return reply.code(201).send({ post });
  });
}
