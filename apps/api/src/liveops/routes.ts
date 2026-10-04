/**
 * Live-ops routes: maintenance, scheduled playlists, the services' live-ops
 * snapshot and crash aggregation.
 *
 * Public:
 * - `GET /status` — the maintenance window and its phase, plus the server
 *   clock so clients can correct for skew.
 * - `GET /playlists` — every bundled playlist's effective schedule and phase.
 *
 * Game servers and the matchmaker (HMAC, `INTERNAL_HMAC_SECRET`):
 * - `POST /internal/liveops` — raw flags, maintenance and every playlist's
 *   effective schedule (so services need no copy of the content).
 * - `POST /internal/errors` — a crash report, stored as a `server.error` event.
 *
 * Admin (`ADMIN_TOKEN` or an admin console session):
 * - `GET /internal/playlists`, `PUT|DELETE /internal/playlists/:id`.
 * - `PUT|DELETE /internal/maintenance`.
 * - `GET /internal/errors/top` — client or server errors grouped by type and
 *   message over a recent window.
 *
 * Every admin mutation writes an `admin_audit_log` row and invalidates the
 * live-ops cache on every API instance.
 */
import { PLAYLISTS } from '@tumble/content/shows';
import { CLIENT_ERROR_EVENT, SERVER_ERROR_EVENT, type MaintenanceWindow } from '@tumble/shared/liveops';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { events, featureFlags, playlistOverrides } from '../db/schema.ts';
import { requireInternalSignature } from '../http/auth.ts';
import { badRequest, notFound, parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff, type StaffActor } from '../staff/auth.ts';
import {
  invalidateLiveOps,
  liveOpsSnapshot,
  MAINTENANCE_FLAG_KEY,
  maintenanceStatus,
  requireFlag,
  scheduledPlaylists,
} from './state.ts';

const Instant = z.iso.datetime({ offset: true });
const PlaylistPatch = z
  .object({
    startsAt: Instant.nullable().optional(),
    endsAt: Instant.nullable().optional(),
    featured: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
const MaintenanceBody = z
  .object({
    enabled: z.boolean(),
    message: z.string().trim().max(500).optional(),
    startsAt: Instant.nullable().optional(),
    endsAt: Instant.nullable().optional(),
  })
  .strict();
const ServerErrorBody = z
  .object({
    service: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    kind: z.string().max(40).default('error'),
    type: z.string().min(1).max(100),
    message: z.string().max(500),
    stack: z.string().max(4000).optional(),
    release: z.string().max(100).optional(),
  })
  .strict();
const ErrorsTopQuery = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(['client', 'server']).default('client'),
});

/** Routes that spend or refund currency or start a payment; `store.enabled` off closes them all. */
export const STORE_SPEND_ROUTES: ReadonlySet<string> = new Set([
  '/purchase',
  '/purchases/:purchaseId/refund',
  '/gems/checkout',
  '/shop/shards/buy',
  '/pass/premium',
]);

const at = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

function checkOrder(startsAt: string | null, endsAt: string | null): void {
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    throw badRequest('invalid_window', 'endsAt must be after startsAt');
}

/**
 * Stores a crash of this API process as a `server.error` event, the same
 * shape the other services post to `/internal/errors`. For the lifecycle's
 * `reporters`; never throws.
 *
 * @param ctx - Shared services.
 * @param err - The thrown value.
 * @param context - Lifecycle context (`kind`).
 */
export async function recordServerError(
  ctx: AppContext,
  err: unknown,
  context: Record<string, unknown>,
): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    await ctx.db.insert(events).values({
      userId: null,
      name: SERVER_ERROR_EVENT,
      createdAt: ctx.now(),
      props: {
        service: 'api',
        kind: typeof context.kind === 'string' ? context.kind.slice(0, 40) : 'error',
        type: (e.name || 'Error').slice(0, 100),
        message: e.message.slice(0, 500),
        ...(e.stack ? { stack: e.stack.slice(0, 4000) } : {}),
      },
    });
  } catch {
    // The database may be what broke; Sentry and the log still have it.
  }
}

/**
 * Registers the live-ops routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerLiveOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // One hook instead of a check in each purchase route, so a new spend route only needs adding here.
  // Payment webhooks are deliberately absent: money already taken must still be credited.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && STORE_SPEND_ROUTES.has(req.routeOptions.url ?? ''))
      await requireFlag(ctx, 'store.enabled', 'The store is closed for a moment. Try again soon!');
  });

  // --- Public ------------------------------------------------------------------

  // Polled by every menu; a short shared cache keeps a crowd of clients cheap.
  app.get('/status', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=10');
    return { maintenance: await maintenanceStatus(ctx), serverTime: ctx.now().getTime() };
  });

  app.get('/playlists', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    const playlists = (await scheduledPlaylists(ctx)).map((p) => ({
      id: p.id,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      featured: p.featured,
      phase: p.phase,
    }));
    return { playlists, serverTime: ctx.now().getTime() };
  });

  // --- Services (HMAC) -----------------------------------------------------------

  // Every matchmaker and game server polls this; HMAC proves who they are and they may share one NAT.
  app.post('/internal/liveops', { config: { rateLimit: false } }, async (req) => {
    await requireInternalSignature(ctx, req);
    const { flags, maintenance } = await liveOpsSnapshot(ctx);
    const playlists = (await scheduledPlaylists(ctx)).map(({ id, startsAt, endsAt, featured, hidden }) => ({
      id,
      startsAt,
      endsAt,
      featured,
      hidden,
    }));
    return { flags, maintenance, playlists, serverTime: ctx.now().getTime() };
  });

  app.post('/internal/errors', async (req, reply) => {
    await requireInternalSignature(ctx, req);
    const body = parse(ServerErrorBody, req.body);
    await ctx.db
      .insert(events)
      .values({ userId: null, name: SERVER_ERROR_EVENT, props: body, createdAt: ctx.now() });
    return reply.code(202).send({ accepted: 1 });
  });

  // --- Admin: playlists -------------------------------------------------------------

  app.get('/internal/playlists', async (req) => {
    await requireStaff(ctx, req);
    return { playlists: await scheduledPlaylists(ctx), serverTime: ctx.now().getTime() };
  });

  app.put('/internal/playlists/:id', async (req) => {
    const actor = await requireStaff(ctx, req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const patch = parse(PlaylistPatch, req.body ?? {});
    if (!PLAYLISTS.some((p) => p.id === id)) throw notFound('Playlist');
    const current = (await scheduledPlaylists(ctx)).find((p) => p.id === id)!;
    const next = {
      startsAt: patch.startsAt === undefined ? current.startsAt : patch.startsAt,
      endsAt: patch.endsAt === undefined ? current.endsAt : patch.endsAt,
      featured: patch.featured ?? current.featured,
      hidden: patch.hidden ?? current.hidden,
    };
    checkOrder(next.startsAt, next.endsAt);
    const values = {
      startsAt: at(next.startsAt),
      endsAt: at(next.endsAt),
      featured: next.featured,
      hidden: next.hidden,
      updatedAt: ctx.now(),
    };
    await ctx.db
      .insert(playlistOverrides)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: playlistOverrides.id, set: values });
    await invalidateLiveOps(ctx);
    await recordAudit(ctx, req, actor, {
      action: 'playlist.override',
      targetType: 'playlist',
      targetId: id,
      details: next,
    });
    return { playlist: (await scheduledPlaylists(ctx)).find((p) => p.id === id) };
  });

  app.delete('/internal/playlists/:id', async (req) => {
    const actor = await requireStaff(ctx, req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    if (!PLAYLISTS.some((p) => p.id === id)) throw notFound('Playlist');
    await ctx.db.delete(playlistOverrides).where(eq(playlistOverrides.id, id));
    await invalidateLiveOps(ctx);
    await recordAudit(ctx, req, actor, { action: 'playlist.reset', targetType: 'playlist', targetId: id });
    return { playlist: (await scheduledPlaylists(ctx)).find((p) => p.id === id) };
  });

  // --- Admin: maintenance -------------------------------------------------------------

  const writeMaintenance = async (req: FastifyRequest, actor: StaffActor, m: MaintenanceWindow) => {
    const values = {
      enabled: m.enabled,
      rolloutPercent: 100,
      payload: { message: m.message, startsAt: m.startsAt, endsAt: m.endsAt },
      updatedAt: ctx.now(),
    };
    await ctx.db
      .insert(featureFlags)
      .values({ key: MAINTENANCE_FLAG_KEY, ...values })
      .onConflictDoUpdate({ target: featureFlags.key, set: values });
    await invalidateLiveOps(ctx);
    await recordAudit(ctx, req, actor, {
      action: m.enabled ? 'maintenance.set' : 'maintenance.clear',
      targetType: 'maintenance',
      details: { ...m },
    });
    return { maintenance: await maintenanceStatus(ctx) };
  };

  app.put('/internal/maintenance', async (req) => {
    const actor = await requireStaff(ctx, req);
    const body = parse(MaintenanceBody, req.body);
    const current = await maintenanceStatus(ctx);
    const next: MaintenanceWindow = {
      enabled: body.enabled,
      message: body.message || current.message,
      startsAt: body.startsAt === undefined ? current.startsAt : body.startsAt,
      endsAt: body.endsAt === undefined ? current.endsAt : body.endsAt,
    };
    checkOrder(next.startsAt, next.endsAt);
    if (next.enabled && next.endsAt && Date.parse(next.endsAt) <= ctx.now().getTime())
      throw badRequest('invalid_window', 'endsAt is already in the past');
    return writeMaintenance(req, actor, next);
  });

  app.delete('/internal/maintenance', async (req) => {
    const actor = await requireStaff(ctx, req);
    const current = await maintenanceStatus(ctx);
    return writeMaintenance(req, actor, {
      enabled: false,
      message: current.message,
      startsAt: null,
      endsAt: null,
    });
  });

  // --- Admin: errors -------------------------------------------------------------------

  app.get('/internal/errors/top', async (req) => {
    await requireStaff(ctx, req);
    const q = parse(ErrorsTopQuery, req.query);
    const since = new Date(ctx.now().getTime() - q.hours * 3_600_000);
    const name = q.source === 'client' ? CLIENT_ERROR_EVENT : SERVER_ERROR_EVENT;
    // `count` is how often one client saw the error before its batch went out; old or odd rows count once.
    const occurrences = sql<number>`sum(case when ${events.props}->>'count' ~ '^[0-9]{1,6}$' then (${events.props}->>'count')::int else 1 end)`;
    const rows = await ctx.db
      .select({
        type: sql<string>`coalesce(${events.props}->>'type', 'Error')`,
        message: sql<string>`coalesce(${events.props}->>'message', '')`,
        occurrences: occurrences.mapWith(Number),
        reports: sql<number>`count(*)`.mapWith(Number),
        players: sql<number>`count(distinct ${events.userId})`.mapWith(Number),
        services: sql<string | null>`string_agg(distinct ${events.props}->>'service', ',')`,
        releases: sql<string | null>`string_agg(distinct ${events.props}->>'release', ',')`,
        firstSeen: sql<string>`min(${events.createdAt})`,
        lastSeen: sql<string>`max(${events.createdAt})`,
        sampleStack: sql<string | null>`max(${events.props}->>'stack')`,
        samplePath: sql<string | null>`max(${events.props}->>'path')`,
      })
      .from(events)
      .where(and(eq(events.name, name), gte(events.createdAt, since)))
      .groupBy(sql`1`, sql`2`)
      .orderBy(sql`3 desc`, sql`10 desc`)
      .limit(q.limit);
    const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
    return {
      source: q.source,
      since: since.toISOString(),
      errors: rows.map((r) => ({
        ...r,
        firstSeen: toIso(r.firstSeen),
        lastSeen: toIso(r.lastSeen),
        sampleStack: r.sampleStack?.slice(0, 1200) ?? null,
      })),
    };
  });
}
