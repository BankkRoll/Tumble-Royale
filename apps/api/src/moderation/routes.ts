/**
 * Reports, feature flags, analytics events, leaderboards and admin tooling.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  ANALYTICS_EVENTS,
  ANALYTICS_LIMITS,
  CLIENT_ERROR_EVENT,
  validAnalyticsProps,
} from '@tumble/shared/liveops';
import { z } from 'zod';
import { accountRegion, RegionSchema } from '../accounts/accounts.ts';
import { isErased } from '../accounts/tombstone.ts';
import type { AppContext } from '../context.ts';
import { bans, events, featureFlags, reports, users } from '../db/schema.ts';
import { verifyLedger } from '../economy/ledger.ts';
import {
  activeBans,
  invalidateBanCache,
  optionalUser,
  requireAdmin,
  requireInternalSignature,
  requireUser,
  userIdFromToken,
} from '../http/auth.ts';
import { badRequest, notFound, parse } from '../http/errors.ts';
import { BOARD_TYPES, readLeaderboard } from '../leaderboards/service.ts';
import { maskProfanity } from '../names/profanity.ts';
import { invalidateLiveOps, MAINTENANCE_FLAG_KEY, serverFlag } from '../liveops/state.ts';
import { revokeMarks } from './ban-evasion.ts';
import { friendIds } from '../social/friends.ts';

const ReportBody = z.object({
  targetUserId: z.string().uuid(),
  matchId: z.string().max(64).optional(),
  reason: z.enum(['cheating', 'harassment', 'offensive_name', 'griefing', 'spam', 'other']),
  details: z.string().max(1000).optional(),
});
/** What the browser's crash reporter sends (`apps/client/src/crashReporter.ts`). */
const ClientErrorProps = z
  .object({
    kind: z.enum(['error', 'unhandledrejection']),
    type: z.string().max(100),
    message: z.string().max(500),
    stack: z.string().max(4000).optional(),
    source: z.string().max(300).optional(),
    line: z.number().int().min(0).optional(),
    col: z.number().int().min(0).optional(),
    path: z.string().max(200),
    count: z.number().int().min(1).max(1_000_000),
    ua: z.string().max(300).optional(),
    release: z.string().max(100).optional(),
  })
  .strict();
const AnalyticsEvent = z.union([
  z.object({ name: z.literal(CLIENT_ERROR_EVENT), props: ClientErrorProps }),
  z.object({
    name: z.enum(ANALYTICS_EVENTS),
    props: z
      .unknown()
      .optional()
      .transform((p, c) => {
        const ok = validAnalyticsProps(p);
        if (!ok) c.addIssue({ code: 'custom', message: 'props must be a small flat object' });
        return ok ?? {};
      }),
  }),
]);
// SECURITY: names are allow-listed so a client cannot write internal events (`audit.*`, grants).
const EventsBody = z.object({
  events: z.array(AnalyticsEvent).min(1).max(ANALYTICS_LIMITS.maxBatch),
  /** Access token of a `sendBeacon` batch, which cannot carry an Authorization header. */
  auth: z.string().max(4096).optional(),
});
const BoardParams = z.object({ type: z.enum(BOARD_TYPES) });
const BoardQuery = z.object({
  scope: z.enum(['global', 'regional', 'friends']).default('global'),
  region: RegionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const BanBody = z.object({
  userId: z.string().uuid(),
  scope: z.enum(['all', 'ranked', 'chat']).default('all'),
  reason: z.string().min(3).max(500),
  durationHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365 * 10)
    .optional(),
});
const BanLookupBody = z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(64) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FlagKeyParam = z.object({ key: z.string().regex(/^[A-Za-z0-9_.-]{2,64}$/) });
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
      if (f.key === MAINTENANCE_FLAG_KEY) continue;
      const inRollout =
        f.rolloutPercent >= 100 || (auth ? rolloutBucket(f.key, auth.userId) < f.rolloutPercent : false);
      flags[f.key] = {
        enabled: f.enabled && inRollout,
        payload: f.enabled && inRollout ? (f.payload ?? null) : null,
      };
    }
    return { flags };
  });

  app.post('/events', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    // `sendBeacon` from a closing page posts text/plain (no preflight) with the token in the body.
    let raw: unknown = req.body;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw badRequest('invalid_json', 'Body is not valid JSON');
      }
    }
    const body = parse(EventsBody, raw);
    const userId = (await optionalUser(ctx, req))?.userId ?? (await userIdFromToken(ctx, body.auth));
    // The sample flag is also the server-side kill switch: analytics are accepted and dropped, crash reports kept.
    const keep = (await serverFlag(ctx, 'analytics.sample'))
      ? body.events
      : body.events.filter((e) => e.name === CLIENT_ERROR_EVENT);
    if (keep.length > 0) {
      await ctx.db.insert(events).values(
        keep.map((e) => ({
          userId,
          name: e.name,
          props: e.props,
          createdAt: ctx.now(),
        })),
      );
    }
    return reply.code(202).send({ accepted: body.events.length });
  });

  app.get('/leaderboards/:type', async (req) => {
    const auth = await requireUser(ctx, req);
    const { type } = parse(BoardParams, req.params);
    const q = parse(BoardQuery, req.query);
    return readLeaderboard(ctx, {
      type,
      scope: q.scope,
      region: q.region ?? (q.scope === 'regional' ? await accountRegion(ctx.db, auth.userId) : auth.region),
      userId: auth.userId,
      friendIds: q.scope === 'friends' ? await friendIds(ctx.db, auth.userId) : [],
      limit: q.limit,
      offset: q.offset,
    });
  });

  // Matchmaker → API (HMAC): which of these players are suspended, and from what.
  app.post('/internal/bans/lookup', { config: { rateLimit: false } }, async (req) => {
    await requireInternalSignature(ctx, req);
    const { userIds } = parse(BanLookupBody, req.body);
    const out: Record<string, { scope: string; reason: string; expiresAt: string | null }[]> = {};
    for (const id of new Set(userIds)) {
      // Ids that are not account ids (bots, forged slots) cannot carry bans.
      const rows = UUID_RE.test(id) ? [...(await activeBans(ctx, id, true))] : [];
      // Tokens of a just-deleted account are still unexpired; treat it as suspended.
      if (await isErased(ctx.kv, id)) rows.push({ scope: 'all', reason: 'account deleted', expiresAt: null });
      out[id] = rows.map((b) => ({
        scope: b.scope,
        reason: b.reason,
        expiresAt: b.expiresAt?.toISOString() ?? null,
      }));
    }
    return { bans: out };
  });

  // --- Admin (ADMIN_TOKEN) -------------------------------------------------

  app.get('/internal/reports', async (req) => {
    requireAdmin(ctx, req);
    const rows = await ctx.db
      .select()
      .from(reports)
      .where(eq(reports.status, 'open'))
      .orderBy(asc(reports.createdAt))
      .limit(200);
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
    await invalidateBanCache(ctx, body.userId);
    return reply.code(201).send(row);
  });

  app.delete('/internal/bans/:id', async (req, reply) => {
    requireAdmin(ctx, req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await ctx.db
      .update(bans)
      .set({ revokedAt: ctx.now() })
      .where(eq(bans.id, id))
      .returning({ userId: bans.userId, evasionOf: bans.evasionOf });
    if (row?.evasionOf) await revokeMarks(ctx.db, row.evasionOf, ctx.now());
    if (row) await invalidateBanCache(ctx, row.userId);
    return reply.code(204).send();
  });

  app.put('/internal/flags/:key', async (req) => {
    requireAdmin(ctx, req);
    const { key } = parse(FlagKeyParam, req.params);
    if (key === MAINTENANCE_FLAG_KEY)
      throw badRequest(
        'reserved_flag',
        'Set maintenance with PUT /internal/maintenance (pnpm admin maintenance)',
      );
    const body = parse(FlagBody, req.body);
    const values = {
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      payload: body.payload ?? null,
      updatedAt: ctx.now(),
    };
    await ctx.db
      .insert(featureFlags)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: featureFlags.key, set: values });
    await invalidateLiveOps(ctx);
    return { key, ...values };
  });

  app.get('/internal/ledger/:userId', async (req) => {
    requireAdmin(ctx, req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    return verifyLedger(ctx.db, userId);
  });
}
