/**
 * Limited-time event routes. Paths say `live-events` because `POST /events`
 * is the analytics ingest.
 *
 * Public:
 * - `GET /live-events` — every visible event (upcoming, live, recently ended) with
 *   its effective window, phase, featured playlists, challenges and points
 *   track, plus the kill-switch state and the server clock.
 *
 * Players (bearer token):
 * - `GET /live-events/progress` — the player's points, challenges and claimed
 *   tiers per visible event; first settles any ended event (unclaimed earned
 *   rewards are paid automatically) and lists what that paid.
 * - `POST /live-events/:id/claim` `{ tier }` — pay one reached tier.
 * - `POST /live-events/:id/challenges/claim` `{ challengeId }` — pay a completed
 *   challenge's points and XP.
 *
 * Admin (`ADMIN_TOKEN`, `pnpm admin events …`):
 * - `GET /internal/live-events`, `PUT|DELETE /internal/live-events/:id` — override or
 *   reset an event's window and switch it on or off. Every change is audited
 *   and invalidates the live-ops cache on every API instance.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogEvent } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import { eventOverrides } from '../db/schema.ts';
import { requireAdmin, requireUser } from '../http/auth.ts';
import { badRequest, notFound, parse } from '../http/errors.ts';
import { audit } from '../liveops/routes.ts';
import { invalidateLiveOps } from '../liveops/state.ts';
import {
  claimEventChallenge,
  claimEventTier,
  eventProgressView,
  settleEndedEvents,
  type EventSettlement,
} from './progress.ts';
import {
  claimableEvent,
  eventsEnabled,
  scheduledEvents,
  visibleEvents,
  type ScheduledEvent,
} from './state.ts';

/** Longest window an operator may set. */
export const MAX_OVERRIDE_DAYS = 90;

const Instant = z.iso.datetime({ offset: true });
const EventIdParam = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/) });
const TierBody = z.object({ tier: z.number().int().min(1).max(100) }).strict();
const ChallengeBody = z.object({ challengeId: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict();
const OverrideBody = z
  .object({
    startsAt: Instant.optional(),
    endsAt: Instant.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const NoQuery = z.object({}).strict();

const READ_RATE = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const CLAIM_RATE = { rateLimit: { max: 20, timeWindow: '1 minute' } };

function definition(def: CatalogEvent) {
  return {
    name: def.name,
    description: def.description,
    themeId: def.themeId,
    art: def.art,
    icon: def.icon,
    playlistIds: def.playlistIds,
    points: def.points,
    challenges: def.challenges,
    tiers: def.tiers,
  };
}

function publicView(e: ScheduledEvent) {
  return { id: e.id, startsAt: e.startsAt, endsAt: e.endsAt, phase: e.phase, ...definition(e.def) };
}

function settlementView(s: EventSettlement) {
  return {
    eventId: s.eventId,
    name: s.name,
    points: s.challenges.reduce((n, c) => n + c.points, 0),
    challenges: s.challenges.map((c) => c.challengeId),
    tiers: s.tiers.map((t) => t.tier),
    rewards: s.tiers.flatMap((t) => t.rewards),
  };
}

/**
 * Registers the event routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  // --- Public ------------------------------------------------------------------

  app.get('/live-events', async (req, reply) => {
    parse(NoQuery, req.query);
    reply.header('cache-control', 'public, max-age=30');
    return {
      enabled: await eventsEnabled(ctx),
      events: (await visibleEvents(ctx)).map(publicView),
      serverTime: ctx.now().getTime(),
    };
  });

  // --- Players -------------------------------------------------------------------

  app.get('/live-events/progress', { config: READ_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    parse(NoQuery, req.query);
    const enabled = await eventsEnabled(ctx);
    const all = await scheduledEvents(ctx);
    const visible = await visibleEvents(ctx);
    const result = await ctx.db.transaction(async (tx) => {
      const settled = enabled ? await settleEndedEvents(tx, ctx.catalog, all, auth.userId, ctx.now()) : [];
      return { settled, progress: await eventProgressView(tx, visible, auth.userId) };
    });
    if (result.settled.length) {
      for (const s of result.settled)
        await ctx.notifier.notifyUser(auth.userId, {
          type: 'notification',
          kind: 'reward',
          title: `${s.name} rewards added`,
          body: 'The event ended. Everything you earned but had not claimed is now yours.',
        });
    }
    return {
      enabled,
      progress: result.progress,
      settled: result.settled.map(settlementView),
      serverTime: ctx.now().getTime(),
    };
  });

  app.post('/live-events/:id/claim', { config: CLAIM_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { id } = parse(EventIdParam, req.params);
    const { tier } = parse(TierBody, req.body);
    const e = await claimableEvent(ctx, id);
    const result = await ctx.db.transaction(async (tx) => {
      const paid = await claimEventTier(tx, ctx.catalog, e, auth.userId, tier, ctx.now());
      const [progress] = await eventProgressView(tx, [e], auth.userId);
      return { ...paid, progress };
    });
    await ctx.notifier.notifyUser(auth.userId, { type: 'wallet', ...result.wallet });
    return result;
  });

  app.post('/live-events/:id/challenges/claim', { config: CLAIM_RATE }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { id } = parse(EventIdParam, req.params);
    const { challengeId } = parse(ChallengeBody, req.body);
    const e = await claimableEvent(ctx, id);
    return ctx.db.transaction(async (tx) => {
      const paid = await claimEventChallenge(tx, ctx.catalog, e, auth.userId, challengeId, ctx.now());
      const [progress] = await eventProgressView(tx, [e], auth.userId);
      return { ...paid, progress };
    });
  });

  // --- Admin -------------------------------------------------------------------------

  const adminView = (e: ScheduledEvent) => ({
    id: e.id,
    name: e.name,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    enabled: e.enabled,
    phase: e.phase,
    overridden: e.overridden,
    bundled: { startsAt: e.def.startsAt, endsAt: e.def.endsAt },
  });

  app.get('/internal/live-events', async (req) => {
    requireAdmin(ctx, req);
    return {
      enabled: await eventsEnabled(ctx),
      events: (await scheduledEvents(ctx)).map(adminView),
      serverTime: ctx.now().getTime(),
    };
  });

  app.put('/internal/live-events/:id', async (req) => {
    requireAdmin(ctx, req);
    const { id } = parse(EventIdParam, req.params);
    const patch = parse(OverrideBody, req.body ?? {});
    const current = (await scheduledEvents(ctx)).find((e) => e.id === id);
    if (!current) throw notFound('Event');
    if (patch.startsAt === undefined && patch.endsAt === undefined && patch.enabled === undefined)
      throw badRequest('empty_patch', 'Set startsAt, endsAt or enabled');
    const next = {
      startsAt: new Date(patch.startsAt ?? current.startsAt),
      endsAt: new Date(patch.endsAt ?? current.endsAt),
      enabled: patch.enabled ?? current.enabled,
    };
    if (next.endsAt.getTime() <= next.startsAt.getTime())
      throw badRequest('invalid_window', 'endsAt must be after startsAt');
    if (next.endsAt.getTime() - next.startsAt.getTime() > MAX_OVERRIDE_DAYS * 86_400_000)
      throw badRequest('invalid_window', `An event may run at most ${MAX_OVERRIDE_DAYS} days`);
    const values = { ...next, updatedAt: ctx.now() };
    await ctx.db
      .insert(eventOverrides)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: eventOverrides.id, set: values });
    await invalidateLiveOps(ctx);
    await audit(ctx, req, 'event_override', {
      eventId: id,
      startsAt: next.startsAt.toISOString(),
      endsAt: next.endsAt.toISOString(),
      enabled: next.enabled,
    });
    return { event: adminView((await scheduledEvents(ctx)).find((e) => e.id === id)!) };
  });

  app.delete('/internal/live-events/:id', async (req) => {
    requireAdmin(ctx, req);
    const { id } = parse(EventIdParam, req.params);
    if (!ctx.catalog.events.some((e) => e.id === id)) throw notFound('Event');
    await ctx.db.delete(eventOverrides).where(eq(eventOverrides.id, id));
    await invalidateLiveOps(ctx);
    await audit(ctx, req, 'event_reset', { eventId: id });
    return { event: adminView((await scheduledEvents(ctx)).find((e) => e.id === id)!) };
  });
}
