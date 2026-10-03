/**
 * Composes the game server: HTTP endpoints, the WebSocket transport and the
 * room manager. `main.ts` calls {@link startGameServer} with real or dev deps;
 * tests call it with fakes on an ephemeral port.
 *
 * HTTP:
 * - `GET /health` — liveness + Rapier version
 * - `GET /debug/determinism?steps=N` — physics determinism probe (Phase 0)
 * - `GET /metrics` — Prometheus text
 * - `GET /rooms` — JSON room list
 * - `GET /ws` (upgrade) — game WebSocket (`/gs/ws` also accepted for the Vite proxy path)
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runDeterminismScenario } from '@tumble/sim';
import { ServerMetrics } from './metrics.ts';
import { RoomManager, type RoomManagerOptions } from './room/RoomManager.ts';
import type { RoomDeps } from './room/types.ts';
import { WsTransport } from './transport/ws.ts';

/** Options for {@link startGameServer}. */
export interface GameServerOptions extends RoomManagerOptions {
  /** TCP port; 0 picks a free one. */
  port: number;
  host?: string;
  deps: RoomDeps;
}

/** A running server. */
export interface GameServer {
  readonly http: Server;
  readonly rooms: RoomManager;
  readonly metrics: ServerMetrics;
  readonly transport: WsTransport;
  /** Actual bound port. */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Starts listening and ticking.
 *
 * @example
 * const server = await startGameServer({ port: 7350, deps: createDevRoomDeps(R) });
 */
export async function startGameServer(opts: GameServerOptions): Promise<GameServer> {
  const { deps } = opts;
  const metrics = new ServerMetrics();
  const http = createServer();
  const transport = new WsTransport(http, { paths: ['/ws', '/gs/ws'] });
  const rooms = new RoomManager(deps, metrics, transport, opts);

  http.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // NOTE: the client dev server runs on a different port, so debug endpoints need CORS.
    res.setHeader('Access-Control-Allow-Origin', '*');
    switch (url.pathname) {
      case '/health':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rapier: deps.R.version(), rooms: rooms.list().length }));
        return;
      case '/debug/determinism': {
        const steps = Math.min(Math.max(Number(url.searchParams.get('steps') ?? 600), 1), 10_000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(runDeterminismScenario(deps.R, steps)));
        return;
      }
      case '/metrics':
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(metrics.prometheus());
        return;
      case '/rooms':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rooms.list()));
        return;
      default:
        res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    // No host → dual-stack '::', so "localhost" works whether it resolves to ::1 or 127.0.0.1.
    if (opts.host) http.listen(opts.port, opts.host, () => resolve());
    else http.listen(opts.port, () => resolve());
  });
  rooms.start();
  const port = (http.address() as AddressInfo).port;

  return {
    http,
    rooms,
    metrics,
    transport,
    port,
    async close(): Promise<void> {
      rooms.stop();
      await transport.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
