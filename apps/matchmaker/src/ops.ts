/**
 * Operations surface of the matchmaker.
 *
 * Responsibilities:
 * - Request correlation ids (`x-request-id`), forwarded on calls to the API.
 * - `GET /ready`: store reachable and not shutting down (`/health` stays the
 *   liveness probe).
 * - Prometheus `/metrics`: request latency, queue depth, placements,
 *   time-to-match, registered game servers and their seats, the results
 *   outbox backlog each game server reports, open WebSockets.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  metricsAccess,
  METRICS_CONTENT_TYPE,
  Registry,
  registerProcessMetrics,
  type Labels,
} from '@tumble/shared/metrics';
import { REQUEST_ID_HEADER, requestIdFor, runWithRequestId } from '@tumble/shared/request-id';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { MatchmakerConfig } from './config.ts';
import type { Matchmaker, MatchRecord } from './matchmaker.ts';
import type { MMStore } from './store.ts';

/** Fastify options that make `req.id` the correlation id. */
export const requestIdOptions = {
  // Fastify would trust the header verbatim; genReqId validates it first.
  requestIdHeader: false,
  genReqId: (req) => requestIdFor(req.headers[REQUEST_ID_HEADER]),
} satisfies Pick<FastifyServerOptions, 'requestIdHeader' | 'genReqId'>;

/** Seconds; matchmaking waits run from instant to several minutes. */
const WAIT_BUCKETS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300];
/** Outbox reports older than this belong to a server that went away. */
const OUTBOX_STALE_MS = 60_000;

/** Handle returned by {@link registerOps}. */
export interface MatchmakerOps {
  registry: Registry;
  /** Makes `/ready` answer 503 (shutdown started). */
  setDraining(): void;
  /** Records a game server's results-outbox backlog from its heartbeat. */
  outboxReported(serverId: string, backlog: number): void;
  /** Forgets a server that deregistered. */
  serverRemoved(serverId: string): void;
  close(): void;
}

/**
 * Registers request ids, `/ready` and `/metrics`, and observes placements.
 *
 * @param app - Fastify instance.
 * @param deps - Matchmaker, store, config, live WebSocket count and clock.
 */
export function registerOps(
  app: FastifyInstance,
  deps: {
    cfg: MatchmakerConfig;
    mm: Matchmaker;
    store: MMStore;
    wsConnections: () => number;
    now: () => number;
  },
): MatchmakerOps {
  const { cfg, mm, store, now } = deps;
  let draining = false;
  const outbox = new Map<string, { backlog: number; at: number }>();

  const registry = new Registry();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  registerProcessMetrics(registry, loop);
  const httpDuration = registry.histogram(
    'tumble_http_request_duration_seconds',
    'HTTP request latency by route template, method and status.',
  );
  const placements = registry.counter('tumble_mm_placements_total', 'Matches placed on a game server.');
  const timeToMatch = registry.histogram(
    'tumble_mm_time_to_match_seconds',
    'Queue time of each human placed from the queue.',
    WAIT_BUCKETS,
  );
  registry.gauge('tumble_mm_queue_players', 'Players searching, by playlist, queue and region.', async () => {
    const counts = new Map<string, { labels: Labels; n: number }>();
    for (const e of await mm.entries()) {
      const labels = { playlist: e.playlistId, queue: e.queue, region: e.region };
      const k = JSON.stringify(labels);
      const c = counts.get(k) ?? { labels, n: 0 };
      c.n += e.members.length;
      counts.set(k, c);
    }
    return [...counts.values()].map((c) => [c.labels, c.n] as const);
  });
  registry.gauge('tumble_mm_game_servers', 'Live registered game servers by region.', async () => {
    const byRegion = new Map<string, number>();
    for (const s of await mm.servers()) byRegion.set(s.region, (byRegion.get(s.region) ?? 0) + 1);
    return [...byRegion].map(([region, n]) => [{ region }, n] as const);
  });
  registry.gauge(
    'tumble_mm_server_seats',
    'Game server seats by region (used includes reservations).',
    async () => {
      const seats = new Map<string, { used: number; capacity: number }>();
      for (const s of await mm.effectiveServers()) {
        const r = seats.get(s.region) ?? { used: 0, capacity: 0 };
        r.used += s.load;
        r.capacity += s.capacity;
        seats.set(s.region, r);
      }
      return [...seats].flatMap(([region, r]) => [
        [{ region, kind: 'used' }, r.used] as const,
        [{ region, kind: 'capacity' }, r.capacity] as const,
      ]);
    },
  );
  registry.gauge('tumble_gameserver_outbox_backlog', 'Undelivered show results per game server.', () => {
    const t = now();
    const out: (readonly [Labels, number])[] = [];
    for (const [server, o] of outbox) {
      if (t - o.at > OUTBOX_STALE_MS) outbox.delete(server);
      else out.push([{ server }, o.backlog]);
    }
    return out;
  });
  registry.gauge('tumble_ws_connections', 'Open player status WebSockets.', deps.wsConnections);

  mm.observer = {
    placed(record: MatchRecord, waitedMs: readonly number[]) {
      placements.inc({ queue: record.queue, region: record.region });
      for (const ms of waitedMs) timeToMatch.observe({ queue: record.queue }, Math.max(0, ms) / 1000);
    },
  };

  // run() around done() puts the rest of the request in the context, so ban lookups forward the id.
  app.addHook('onRequest', (req, _reply, done) => runWithRequestId(req.id, done));
  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe(
      { route: req.routeOptions.url ?? 'unmatched', method: req.method, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/ready', { logLevel: 'warn' }, async (req, reply) => {
    if (draining) return reply.code(503).send({ ok: false, reason: 'shutting_down' });
    try {
      await Promise.race([
        store.get('ops:ready-probe'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('store timed out')), 2000).unref()),
      ]);
      return { ok: true, store: cfg.redisUrl ? 'redis' : 'memory' };
    } catch (err) {
      req.log.warn({ err }, 'not ready');
      return reply.code(503).send({ ok: false, reason: err instanceof Error ? err.message : 'store failed' });
    }
  });

  app.get('/metrics', { logLevel: 'warn' }, async (req, reply) => {
    const access = metricsAccess(cfg.metricsToken, req.headers.authorization, cfg.env === 'production');
    if (access === 'disabled') return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    if (access === 'unauthorized')
      return reply.code(401).send({ error: 'unauthorized', message: 'Metrics token required' });
    return reply.type(METRICS_CONTENT_TYPE).send(await registry.render());
  });

  return {
    registry,
    setDraining: () => void (draining = true),
    outboxReported: (serverId, backlog) => void outbox.set(serverId, { backlog, at: now() }),
    serverRemoved: (serverId) => void outbox.delete(serverId),
    close: () => {
      loop.disable();
      mm.observer = undefined;
    },
  };
}
