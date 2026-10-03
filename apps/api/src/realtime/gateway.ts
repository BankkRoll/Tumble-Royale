/**
 * Realtime WebSocket gateway at `/ws?token=<access JWT>`.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the access token
 * travels in the query string. Each connection subscribes to its user's KV
 * channel (see `Notifier`) and maintains presence. Client → server messages:
 * `{type:'ping'}` and `{type:'presence', status}`; server → client messages are
 * `RealtimeEvent`s plus `{type:'hello'}` and `{type:'pong'}`.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { verifyAccessToken } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import { activeBans } from '../http/auth.ts';
import { friendIds } from '../social/friends.ts';
import { PRESENCE_TTL_MS, setPresence } from '../social/presence.ts';
import { userChannel, type PresenceStatus } from './notifier.ts';

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('presence'), status: z.enum(['online', 'in_menu', 'in_queue', 'in_match']) }),
]);

const HEARTBEAT_MS = 30_000;
const MAX_MESSAGE_BYTES = 4096;

/** Handle for shutting the gateway down. */
export interface Gateway {
  /** Live connection count (all users). */
  connections(): number;
  close(): Promise<void>;
}

/**
 * Attaches the gateway to Fastify's HTTP server.
 *
 * @param app - Fastify instance (its `server` receives the upgrade).
 * @param ctx - Shared services.
 */
export function attachGateway(app: FastifyInstance, ctx: AppContext): Gateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();
  const byUser = new Map<string, Set<WebSocket>>();

  const broadcastPresence = async (userId: string, status: PresenceStatus) => {
    await ctx.notifier.notifyMany(await friendIds(ctx.db, userId), { type: 'presence', userId, status });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return;
    void (async () => {
      const token = url.searchParams.get('token') ?? '';
      const claims = await verifyAccessToken(
        ctx.config.jwtSecret,
        token,
        Math.floor(ctx.now().getTime() / 1000),
      );
      const banned = claims ? (await activeBans(ctx, claims.sub)).some((b) => b.scope === 'all') : false;
      if (!claims || banned) {
        socket.write(
          `HTTP/1.1 ${banned ? '403 Forbidden' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, claims.sub));
    })().catch(() => socket.destroy());
  };

  const onConnection = async (ws: WebSocket, userId: string) => {
    alive.set(ws, true);
    let set = byUser.get(userId);
    const firstConnection = !set;
    if (!set) {
      set = new Set();
      byUser.set(userId, set);
    }
    set.add(ws);
    const unsubscribe = await ctx.kv.subscribe(userChannel(userId), (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
    await setPresence(ctx.kv, userId, 'online', ctx.now().getTime());
    if (firstConnection) await broadcastPresence(userId, 'online');
    ws.send(JSON.stringify({ type: 'hello', userId, presenceTtlMs: PRESENCE_TTL_MS }));

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data) => {
      let parsed: z.infer<typeof ClientMessage>;
      try {
        parsed = ClientMessage.parse(JSON.parse(String(data)));
      } catch {
        return;
      }
      void (async () => {
        if (parsed.type === 'ping') {
          await setPresence(ctx.kv, userId, 'online', ctx.now().getTime());
          ws.send(JSON.stringify({ type: 'pong', at: ctx.now().getTime() }));
        } else {
          await setPresence(ctx.kv, userId, parsed.status, ctx.now().getTime());
          await broadcastPresence(userId, parsed.status);
        }
      })().catch(() => undefined);
    });
    ws.on('close', () => {
      void (async () => {
        await unsubscribe();
        set.delete(ws);
        if (set.size === 0) {
          byUser.delete(userId);
          await setPresence(ctx.kv, userId, 'offline', ctx.now().getTime());
          await broadcastPresence(userId, 'offline');
        }
      })().catch(() => undefined);
    });
  };

  app.server.on('upgrade', onUpgrade);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    connections: () => wss.clients.size,
    close: async () => {
      clearInterval(heartbeat);
      app.server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
