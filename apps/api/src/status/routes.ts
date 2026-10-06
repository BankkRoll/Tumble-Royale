/**
 * Public status page routes and incident administration.
 *
 * Public (no auth, rate limited per client, short shared caches):
 * - `GET /status/summary` — overall state, components, maintenance and open
 *   incidents.
 * - `GET /status/history` — 90 days of daily uptime per component and the
 *   incidents that started in that window.
 * - `GET /status/feed.json`, `GET /status/feed.atom` — incident feeds.
 *
 * Staff (`ADMIN_TOKEN` or a console session; moderators read, admins write):
 * - `GET /internal/status/incidents[?state=active|all][&limit=N]`
 * - `POST /internal/status/incidents` — open one with its first update.
 * - `POST /internal/status/incidents/:id/updates` — post an update.
 * - `POST /internal/status/incidents/:id/resolve` — resolve with a closing update.
 *
 * Every write commits with its `admin_audit_log` row and drops the cached
 * summary on every API instance.
 */
import {
  cleanPublicText,
  INCIDENT_IMPACTS,
  INCIDENT_LIMITS,
  INCIDENT_STATUSES,
  isComponentId,
  UPTIME_DAYS,
} from '@tumble/shared/status';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { parse } from '../http/errors.ts';
import { recordAudit } from '../staff/audit.ts';
import { requireStaff } from '../staff/auth.ts';
import { maintenanceStatus } from '../liveops/state.ts';
import { atomFeed, jsonFeed, maintenanceEntry } from './feeds.ts';
import { getIncident, listIncidents, openIncident, updateIncident } from './incidents.ts';
import type { StatusService } from './service.ts';

const publicText = (max: number, min = 1) =>
  z.string().transform(cleanPublicText).pipe(z.string().min(min).max(max));

const Components = z
  .array(z.string().refine(isComponentId, 'unknown component'))
  .max(INCIDENT_LIMITS.componentsMax)
  .transform((ids) => [...new Set(ids)]);

const OpenBody = z
  .object({
    title: publicText(INCIDENT_LIMITS.titleMax, 3),
    impact: z.enum(INCIDENT_IMPACTS),
    status: z.enum(INCIDENT_STATUSES).default('investigating'),
    components: Components.default([]),
    message: publicText(INCIDENT_LIMITS.messageMax),
  })
  .strict();

const UpdateBody = z
  .object({
    status: z.enum(INCIDENT_STATUSES),
    message: publicText(INCIDENT_LIMITS.messageMax),
    impact: z.enum(INCIDENT_IMPACTS).optional(),
    components: Components.optional(),
  })
  .strict();

const ResolveBody = z.object({ message: publicText(INCIDENT_LIMITS.messageMax).optional() }).strict();

const ListQuery = z.object({
  state: z.enum(['active', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const IdParams = z.object({ id: z.uuid() });

const DEFAULT_RESOLVED_MESSAGE = 'This incident has been resolved.';

/**
 * Registers the status routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 * @param status - The status service (summary cache, history).
 */
export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext, status: StatusService): void {
  // --- Public ---------------------------------------------------------------------

  // SECURITY: these answer anyone. They expose only component states, the
  // maintenance message and incident text staff wrote for the public: no
  // hostnames, addresses, server counts, error messages or player data.
  const limited = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const links = () => ({ page: `${ctx.config.publicWebUrl}/status`, api: ctx.config.publicApiUrl });
  const feedIncidents = () =>
    listIncidents(ctx.db, { since: new Date(ctx.now().getTime() - UPTIME_DAYS * 86_400_000), limit: 50 });
  const feedMaintenance = async () => maintenanceEntry(await maintenanceStatus(ctx), ctx.now().toISOString());

  app.get('/status/summary', limited(60), async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=15');
    return status.summary();
  });

  app.get('/status/history', limited(20), async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return status.history();
  });

  app.get('/status/feed.json', limited(20), async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    reply.type('application/feed+json; charset=utf-8');
    return JSON.stringify(jsonFeed(await feedIncidents(), links(), await feedMaintenance()));
  });

  app.get('/status/feed.atom', limited(20), async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    reply.type('application/atom+xml; charset=utf-8');
    return atomFeed(await feedIncidents(), links(), ctx.now().toISOString(), await feedMaintenance());
  });

  // --- Staff ----------------------------------------------------------------------

  app.get('/internal/status/incidents', async (req) => {
    await requireStaff(ctx, req, 'moderator');
    const q = parse(ListQuery, req.query);
    return { incidents: await listIncidents(ctx.db, { activeOnly: q.state === 'active', limit: q.limit }) };
  });

  app.post('/internal/status/incidents', async (req, reply) => {
    const actor = await requireStaff(ctx, req, 'admin');
    const body = parse(OpenBody, req.body);
    const id = await ctx.db.transaction(async (tx) => {
      const id = await openIncident(tx, body, ctx.now());
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'status.incident.open',
          targetType: 'incident',
          targetId: id,
          details: {
            title: body.title,
            impact: body.impact,
            status: body.status,
            components: body.components,
          },
        },
        tx,
      );
      return id;
    });
    await status.invalidate();
    return reply.code(201).send({ incident: await getIncident(ctx.db, id) });
  });

  app.post('/internal/status/incidents/:id/updates', async (req) => {
    const actor = await requireStaff(ctx, req, 'admin');
    const { id } = parse(IdParams, req.params);
    const body = parse(UpdateBody, req.body);
    await ctx.db.transaction(async (tx) => {
      const before = await updateIncident(tx, id, body, ctx.now());
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: body.status === 'resolved' ? 'status.incident.resolve' : 'status.incident.update',
          targetType: 'incident',
          targetId: id,
          details: {
            from: before.status,
            status: body.status,
            ...(body.impact ? { impact: body.impact } : {}),
            ...(body.components ? { components: body.components } : {}),
          },
        },
        tx,
      );
    });
    await status.invalidate();
    return { incident: await getIncident(ctx.db, id) };
  });

  app.post('/internal/status/incidents/:id/resolve', async (req) => {
    const actor = await requireStaff(ctx, req, 'admin');
    const { id } = parse(IdParams, req.params);
    const body = parse(ResolveBody, req.body ?? {});
    await ctx.db.transaction(async (tx) => {
      const before = await updateIncident(
        tx,
        id,
        { status: 'resolved', message: body.message ?? DEFAULT_RESOLVED_MESSAGE },
        ctx.now(),
      );
      await recordAudit(
        ctx,
        req,
        actor,
        {
          action: 'status.incident.resolve',
          targetType: 'incident',
          targetId: id,
          details: { from: before.status, status: 'resolved' },
        },
        tx,
      );
    });
    await status.invalidate();
    return { incident: await getIncident(ctx.db, id) };
  });
}
