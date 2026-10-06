/**
 * Composes the game server: HTTP endpoints, the WebSocket transport and the
 * room manager. `main.ts` calls {@link startGameServer} with real or dev deps;
 * tests call it with fakes on an ephemeral port.
 *
 * Public port:
 * - `GET /health` — liveness + Rapier version (CORS for allowed origins: the client probes it)
 * - `GET /ready` — 503 while draining for shutdown
 * - `GET /debug/determinism?steps=N` — physics determinism probe; development only, N ≤ 1200
 * - `GET /metrics`, `GET /rooms` — only with `Authorization: Bearer <METRICS_TOKEN>`, or
 *   openly when neither a token nor an internal port is configured outside production
 * - `POST /internal/kick` — signed matchmaker call removing a kicked private show member
 * - `GET /ws` (upgrade) — game WebSocket (`/gs/ws` also accepted for the proxy path)
 *
 * Internal port (`INTERNAL_PORT`, optional): `/health`, `/metrics`, `/rooms`
 * without a token, for scrapers on a private network.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metricsAccess } from '@tumble/shared/metrics';
import type { TrustFn } from '@tumble/shared/proxy';
import { runDeterminismScenario } from '@tumble/sim';
import { handleControl, NonceCache, type ControlOptions } from './control.ts';
import { ServerMetrics } from './metrics.ts';
import { RoomManager, type RoomManagerOptions } from './room/RoomManager.ts';
import type { RoomDeps } from './room/types.ts';
import { WsTransport } from './transport/ws.ts';

/** Largest determinism probe served: it runs Rapier on the room event loop. */
export const MAX_DETERMINISM_STEPS = 1200;

/** HTTP exposure policy. */
export interface HttpPolicy {
  /** Serve `/debug/*` (never in production: it blocks every room's tick while it runs). */
  debug: boolean;
  /** Browser origins allowed CORS on `/health` and WebSocket upgrades; `true` reflects any. */
  allowedOrigins: readonly string[] | true;
  /** Bearer for `/metrics` and `/rooms` on the public port. */
  metricsToken?: string;
  /** Serve `/metrics` and `/rooms` openly on the public port (development without a token or internal port). */
  openMetrics: boolean;
  /** Port of the internal listener; absent → none. */
  internalPort?: number;
  /** Interface the internal listener binds (default: all). */
  internalHost?: string;
  /** Which proxies may set X-Forwarded-For (`TRUST_PROXY`). */
  trust: TrustFn | false;
  /** Unhandshaken WebSockets allowed per client address. */
  maxPendingPerIp: number;
}

/** Development defaults: everything open, no proxy trusted. */
export const DEV_HTTP_POLICY: HttpPolicy = {
  debug: true,
  allowedOrigins: true,
  openMetrics: true,
  trust: false,
  maxPendingPerIp: 8,
};

/** Options for {@link startGameServer}. */
export interface GameServerOptions extends RoomManagerOptions {
  /** TCP port; 0 picks a free one. */
  port: number;
  host?: string;
  deps: RoomDeps;
  /** Enables the signed matchmaker control endpoint (`POST /internal/kick`). */
  control?: ControlOptions;
  /** Readiness for `/ready`; false while draining (default: always ready). */
  ready?: () => boolean;
  /** Exposure policy; {@link DEV_HTTP_POLICY} when absent. */
  http?: HttpPolicy;
}

/** A running server. */
export interface GameServer {
  readonly http: Server;
  readonly rooms: RoomManager;
  readonly metrics: ServerMetrics;
  readonly transport: WsTransport;
  /** Actual bound port. */
  readonly port: number;
  /** Bound internal port, when one was configured. */
  readonly internalPort: number | null;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

function listen(server: Server, port: number, host: string | undefined): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    const done = () => resolve((server.address() as AddressInfo).port);
    // No host → dual-stack '::', so "localhost" works whether it resolves to ::1 or 127.0.0.1.
    if (host) server.listen(port, host, done);
    else server.listen(port, done);
  });
}

/**
 * Starts listening and ticking.
 *
 * @example
 * const server = await startGameServer({ port: 7350, deps: createDevRoomDeps(R) });
 */
export async function startGameServer(opts: GameServerOptions): Promise<GameServer> {
  const { deps } = opts;
  const policy = opts.http ?? DEV_HTTP_POLICY;
  const metrics = new ServerMetrics();
  const http = createServer();
  const originAllowed = (origin: string): boolean =>
    policy.allowedOrigins === true || policy.allowedOrigins.includes(origin.replace(/\/$/, ''));
  const transport: WsTransport = new WsTransport(http, {
    paths: ['/ws', '/gs/ws'],
    trust: policy.trust,
    // SECURITY: browsers send Origin on WebSocket handshakes and CORS does not apply to them;
    // a page on another site must not open game sockets with the visitor's network position.
    // Non-browser clients (bots, load tests) send no Origin and are judged by their ticket.
    admitOrigin: (origin) => origin === undefined || originAllowed(origin),
    admitAddress: (ip): boolean => rooms.pendingFrom(ip) < policy.maxPendingPerIp,
  });
  const rooms: RoomManager = new RoomManager(deps, metrics, transport, {
    maxPendingPerIp: policy.maxPendingPerIp,
    ...opts,
  });
  const control: ControlOptions | null = opts.control ? { nonces: new NonceCache(), ...opts.control } : null;

  const health = () => ({
    ok: true,
    rapier: deps.R.version(),
    rooms: rooms.list().length,
    anomalies: metrics.anomalies,
    lagComp: { grabs: metrics.lagCompGrabs, tackles: metrics.lagCompTackles },
  });
  const serveMonitoring = (pathname: string, res: ServerResponse): boolean => {
    if (pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(metrics.prometheus());
      return true;
    }
    if (pathname === '/rooms') {
      json(res, 200, rooms.list());
      return true;
    }
    return false;
  };

  http.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    // Only allowed origins get CORS; the old `*` let any site read room lists and metrics.
    if (origin && originAllowed(origin)) {
      cors['access-control-allow-origin'] = origin;
      cors.vary = 'origin';
    }
    if (handleControl(req, res, url.pathname, rooms, control)) return;
    switch (url.pathname) {
      case '/health':
        json(res, 200, health(), cors);
        return;
      case '/ready': {
        const ok = opts.ready?.() ?? true;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok } : { ok, reason: 'draining' }));
        return;
      }
      case '/debug/determinism': {
        if (!policy.debug) break;
        const requested = Math.trunc(Number(url.searchParams.get('steps') ?? 600));
        const steps = Math.min(
          Math.max(Number.isFinite(requested) ? requested : 600, 1),
          MAX_DETERMINISM_STEPS,
        );
        json(res, 200, runDeterminismScenario(deps.R, steps), cors);
        return;
      }
      case '/metrics':
      case '/rooms': {
        // SECURITY: room lists and metrics reveal load and match ids; public only with the token.
        const access = metricsAccess(policy.metricsToken, req.headers.authorization, !policy.openMetrics);
        if (access === 'ok') {
          serveMonitoring(url.pathname, res);
          return;
        }
        if (access === 'unauthorized') {
          json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        break;
      }
    }
    res.writeHead(404).end();
  });

  const port = await listen(http, opts.port, opts.host);
  let internal: Server | null = null;
  let internalPort: number | null = null;
  if (policy.internalPort !== undefined) {
    internal = createServer((req, res) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname === '/health') return json(res, 200, health());
      if (!serveMonitoring(pathname, res)) res.writeHead(404).end();
    });
    try {
      internalPort = await listen(internal, policy.internalPort, policy.internalHost);
    } catch (err) {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      throw err;
    }
  }
  rooms.start();

  return {
    http,
    rooms,
    metrics,
    transport,
    port,
    internalPort,
    async close(): Promise<void> {
      await rooms.stop();
      await transport.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (internal) await new Promise<void>((resolve) => internal.close(() => resolve()));
    },
  };
}
