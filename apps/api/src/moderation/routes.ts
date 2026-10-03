/**
 * Reports, feature flags, analytics events, leaderboards and admin tooling.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { bans, events, featureFlags, reports, users } from '../db/schema.ts';
import { verifyLedger } from '../economy/ledger.ts';
import { invalidateBanCache, optionalUser, requireAdmin, requireUser } from '../http/auth.ts';
import { badRequest, notFound, parse } from '../http/errors.ts';
import { BOARD_TYPES, readLeaderboard } from '../leaderboards/service.ts';
import { maskProfanity } from '../names/profanity.ts';
import { friendIds } from '../social/friends.ts';

const ReportBody = z.object({
  targetUserId: z.string().uuid(),
  matchId: z.string().max(64).optional(),
  reason: z.enum(['cheating', 'harassment', 'offensive_name', 'griefing', 'spam', 'other']),
  details: z.string().max(1000).optional(),
});
const EventsBody = z.object({
  events: z.array(z.object({ name: z.string().regex(/^[a-z0-9_.]{2,64}$/), props: z.record(z.string(), z.unknown()).optional() })).min(1).max(50),
});
const BoardParams = z.object({ type: z.enum(BOARD_TYPES) });
const BoardQuery = z.object({
  scope: z.enum(['global', 'regional', 'friends']).default('global'),
  region: z.string().min(2).max(8).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const BanBody = z.object({
  userId: z.string().uuid(),
  scope: z.enum(['all', 'ranked', 'chat']).default('all'),
  reason: z.string().min(3).max(500),
  durationHours: z.number().int().min(1).max(24 * 365 * 10).optional(),
});
const FlagBody = z.object({
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  payload: z.unknown().optional(),
});

/** Stable 0–99 bucket for a user and flag so rollouts are sticky. */
export function rolloutBucket(flagKey: string, userId: string): number {
  return createHash('sha256').update(`${flagKey}:${userId}`).digest().readUInt32BE(0) % 100;
}

/**
 * Registers moderation, flags, events, leaderboards and admin routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerModerationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/report', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const body = parse(ReportBody, req.body);
    if (body.targetUserId === auth.userId) throw badRequest('self_report', 'You cannot report yourself');
    const [target] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, body.targetUserId));
    if (!target) throw notFound('Player');
    const [row] = await ctx.db
      .insert(reports)
      .values({
        reporterId: auth.userId,
        targetUserId: body.targetUserId,
        matchId: body.matchId ?? null,
        reason: body.reason,
        details: body.details ? maskProfanity(body.details) : null,
      })
      .returning({ id: reports.id });
    return reply.code(201).send({ id: row?.id, status: 'open' });
  });

  app.get('/flags', async (req) => {
    const auth = await optionalUser(ctx, req);
    const rows = await ctx.db.select().from(featureFlags);
    const flags: Record<string, { enabled: boolean; payload: unknown }> = {};
    for (const f of rows) {
      const inRollout = f.rolloutPercent >= 100 || (auth ? rolloutBucket(f.key, auth.userId) < f.rolloutPercent : false);
      flags[f.key] = { enabled: f.enabled && inRollout, payload: f.enabled && inRollout ? (f.payload ?? null) : null };
    }
    return { flags };
  });

  app.post('/events', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await optionalUser(ctx, req);
    const body = parse(EventsBody, req.body);
    await ctx.db.insert(events).values(body.events.map((e) => ({ userId: auth?.userId ?? null, name: e.name, props: e.props ?? null })));
    return reply.code(202).send({ accepted: body.events.length });
  });

  app.get('/leaderboards/:type', async (req) => {
    const auth = await requireUser(ctx, req);
    const { type } = parse(BoardParams, req.params);
    const q = parse(BoardQuery, req.query);
    return readLeaderboard(ctx, {
      type,
      scope: q.scope,
      region: q.region ?? auth.region,
      userId: auth.userId,
      friendIds: q.scope === 'friends' ? await friendIds(ctx.db, auth.userId) : [],
      limit: q.limit,
      offset: q.offset,
    });
  });

  // --- Admin (ADMIN_TOKEN) -------------------------------------------------

  app.get('/internal/reports', async (req) => {
    requireAdmin(ctx, req);
    const rows = await ctx.db.select().from(reports).where(eq(reports.status, 'open')).orderBy(asc(reports.createdAt)).limit(200);
    return { reports: rows };
  });

  app.post('/internal/bans', async (req, reply) => {
    requireAdmin(ctx, req);
    const body = parse(BanBody, req.body);
    const now = ctx.now();
    const [row] = await ctx.db
      .insert(bans)
      .values({
        userId: body.userId,
        scope: body.scope,
        reason: body.reason,
        expiresAt: body.durationHours ? new Date(now.getTime() + body.durationHours * 3_600_000) : null,
      })
      .returning();
    await ctx.db
      .update(reports)
      .set({ status: 'actioned' })
      .where(and(eq(reports.targetUserId, body.userId), eq(reports.status, 'open')));
    invalidateBanCache(body.userId);
    return reply.code(201).send(row);
  });

  app.delete('/internal/bans/:id', async (req, reply) => {
    requireAdmin(ctx, req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await ctx.db.update(bans).set({ revokedAt: ctx.now() }).where(eq(bans.id, id)).returning({ userId: bans.userId });
    if (row) invalidateBanCache(row.userId);
    return reply.code(204).send();
  });

  app.put('/internal/flags/:key', async (req) => {
    requireAdmin(ctx, req);
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z0-9_.-]{2,64}$/) }), req.params);
    const body = parse(FlagBody, req.body);
    const values = { enabled: body.enabled, rolloutPercent: body.rolloutPercent, payload: body.payload ?? null, updatedAt: ctx.now() };
    await ctx.db.insert(featureFlags).values({ key, ...values }).onConflictDoUpdate({ target: featureFlags.key, set: values });
    return { key, ...values };
  });

  app.get('/internal/ledger/:userId', async (req) => {
    requireAdmin(ctx, req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    return verifyLedger(ctx.db, userId);
  });
}
