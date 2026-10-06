/**
 * Operations surface of the API.
 *
 * Responsibilities:
 * - Request correlation ids (`x-request-id`) for Fastify's logger.
 * - `GET /ready`: database and KV reachable and not shutting down, for load
 *   balancers and orchestrators. `GET /health` stays a cheap liveness check
 *   so a database outage never gets healthy API processes restarted.
 * - Prometheus `/metrics`.
 * - The data-retention timer.
 */
import { REQUEST_ID_HEADER, requestIdFor } from '@tumble/shared/request-id';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { AppContext } from '../context.ts';
import type { Database } from '../db/client.ts';
import type { Gateway } from '../realtime/gateway.ts';
import { createApiMetrics, registerMetrics, type ApiMetrics } from './metrics.ts';
import { RETENTION_KINDS, runRetention } from './retention.ts';

/** Fastify options that make `req.id` the correlation id. */
export const requestIdOptions = {
  // Fastify would trust the header verbatim; genReqId validates it first.
  requestIdHeader: false,
  genReqId: (req) => requestIdFor(req.headers[REQUEST_ID_HEADER]),
} satisfies Pick<FastifyServerOptions, 'requestIdHeader' | 'genReqId'>;

/** Handle returned by {@link registerOps}. */
export interface Ops {
  metrics: ApiMetrics;
  /** Makes `/ready` answer 503 (shutdown started). */
  setDraining(): void;
  /** Runs one retention pass now (tests, admin). */
  runRetention(): ReturnType<typeof runRetention>;
  close(): void;
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref(),
    ),
  ]);

/**
 * Registers the operations routes and starts the retention timer.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 * @param deps - Database and gateway handles.
 */
export function registerOps(
  app: FastifyInstance,
  ctx: AppContext,
  deps: { database: Database; gateway: Gateway },
): Ops {
  let draining = false;
  const metrics = createApiMetrics({ wsConnections: () => deps.gateway.connections() });

  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  app.get('/ready', { config: { rateLimit: false }, logLevel: 'warn' }, async (req, reply) => {
    if (draining) return reply.code(503).send({ ok: false, reason: 'shutting_down' });
    const checks: Record<string, string> = {};
    const probe = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await timeout(fn(), 2000);
        checks[name] = 'ok';
      } catch (err) {
        checks[name] = err instanceof Error ? err.message.slice(0, 200) : 'failed';
      }
    };
    await Promise.all([probe('db', () => ctx.db.execute(sql`select 1`)), probe('kv', () => ctx.kv.ping())]);
    const ok = Object.values(checks).every((v) => v === 'ok');
    if (!ok) req.log.warn({ checks }, 'not ready');
    return reply.code(ok ? 200 : 503).send({
      ok,
      db: deps.database.driver,
      dbOk: checks.db === 'ok',
      kv: ctx.config.redisUrl ? 'redis' : 'memory',
      kvOk: checks.kv === 'ok',
      checks,
    });
  });

  registerMetrics(app, ctx.config, metrics);

  const policy = ctx.config.ops.retention;
  const pass = async () => {
    try {
      const r = await runRetention(ctx, policy);
      metrics.retentionRuns.inc({ outcome: r.ran ? 'ok' : 'skipped' });
      if (!r.ran) return r;
      for (const kind of RETENTION_KINDS) metrics.retentionDeleted.inc({ kind }, r[kind]);
      if (RETENTION_KINDS.some((kind) => r[kind] > 0))
        app.log.info({ retention: r }, 'retention pass deleted rows or settled gifts');
      return r;
    } catch (err) {
      metrics.retentionRuns.inc({ outcome: 'error' });
      app.log.error({ err }, 'retention pass failed');
      throw err;
    }
  };
  const timers: NodeJS.Timeout[] = [];
  if (policy.intervalMs > 0) {
    // First pass shortly after boot (not during it), then on the interval; jitter spreads replicas.
    const first = setTimeout(() => void pass().catch(() => undefined), 60_000 + Math.random() * 60_000);
    const every = setInterval(() => void pass().catch(() => undefined), policy.intervalMs);
    first.unref();
    every.unref();
    timers.push(first, every);
  }

  return {
    metrics,
    setDraining: () => void (draining = true),
    runRetention: pass,
    close: () => {
      for (const t of timers) clearTimeout(t);
      metrics.close();
    },
  };
}
