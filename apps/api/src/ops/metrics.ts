/**
 * Prometheus metrics for the API, served at `GET /metrics`.
 *
 * Access follows `publicMetricsAccess`: `METRICS_TOKEN` as a bearer when set,
 * otherwise open in development and disabled (404) in production.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  METRICS_CONTENT_TYPE,
  publicMetricsAccess,
  Registry,
  registerProcessMetrics,
  type Counter,
  type Histogram,
} from '@tumble/shared/metrics';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.ts';

/** Path of the game server results ingest route, counted separately. */
const INGEST_ROUTE = '/internal/match-results';

/** The API's metrics. */
export interface ApiMetrics {
  registry: Registry;
  httpDuration: Histogram;
  /** Results ingests by outcome (`ok`, `rejected`, `error`). */
  ingest: Counter;
  /** Rows removed by the retention job, by kind. */
  retentionDeleted: Counter;
  /** Retention runs by outcome. */
  retentionRuns: Counter;
  /** Stops the event-loop sampler. */
  close(): void;
}

/**
 * Creates the registry.
 *
 * @param sources - Live values read at scrape time.
 */
export function createApiMetrics(sources: { wsConnections: () => number }): ApiMetrics {
  const registry = new Registry();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  registerProcessMetrics(registry, loop);
  registry.gauge('tumble_ws_connections', 'Open realtime gateway WebSockets.', sources.wsConnections);
  return {
    registry,
    httpDuration: registry.histogram(
      'tumble_http_request_duration_seconds',
      'HTTP request latency by route template, method and status.',
    ),
    ingest: registry.counter('tumble_results_ingest_total', 'Game server result ingests by outcome.'),
    retentionDeleted: registry.counter(
      'tumble_retention_deleted_total',
      'Rows deleted by the retention job.',
    ),
    retentionRuns: registry.counter('tumble_retention_runs_total', 'Retention job runs by outcome.'),
    close: () => loop.disable(),
  };
}

/**
 * Records every response and serves `/metrics`.
 *
 * @param app - Fastify instance.
 * @param config - For the access rule.
 * @param metrics - From {@link createApiMetrics}.
 */
export function registerMetrics(app: FastifyInstance, config: ApiConfig, metrics: ApiMetrics): void {
  app.addHook('onResponse', async (req, reply) => {
    // Route templates (`/matches/:id`), never raw URLs: ids would explode the series count.
    const route = req.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    metrics.httpDuration.observe(
      { route, method: req.method, status: String(status) },
      reply.elapsedTime / 1000,
    );
    if (route === INGEST_ROUTE) {
      metrics.ingest.inc({ outcome: status < 400 ? 'ok' : status < 500 ? 'rejected' : 'error' });
    }
  });

  app.get('/metrics', { config: { rateLimit: false }, logLevel: 'warn' }, async (req, reply) => {
    const access = publicMetricsAccess(
      config.ops.metrics,
      req.headers.authorization,
      config.env === 'production',
    );
    if (access === 'disabled')
      return reply.code(404).send({ error: 'not_found', message: 'No route GET /metrics' });
    if (access === 'unauthorized')
      return reply.code(401).send({ error: 'unauthorized', message: 'Metrics token required' });
    return reply.type(METRICS_CONTENT_TYPE).send(await metrics.registry.render());
  });
}
