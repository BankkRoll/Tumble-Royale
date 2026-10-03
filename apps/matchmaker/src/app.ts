/**
 * Matchmaker HTTP + WebSocket surface.
 *
 * Responsibilities:
 * - Player routes (Bearer API access token): queue, cancel, status, custom lobbies.
 * - Game-server routes (Bearer `GAME_SERVER_SECRET`): register, heartbeat, match lookup.
 * - `/ws?token=` stream relaying the player's queue/lobby events.
 * - The release tick and the 1 Hz status broadcast.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { MatchmakerConfig } from './config.ts';
import { DEFAULT_CUSTOM, Matchmaker, MMError, userChannel } from './matchmaker.ts';
import { createStore, type MMStore } from './store.ts';
import { verifyAccess, verifyQueueTicket, type Player } from './tickets.ts';

/** Overrides for tests. */
export interface MatchmakerAppOptions {
  store?: MMStore;
  now?: () => number;
  logger?: boolean;
}

/** A built matchmaker. */
export interface MatchmakerApp {
  app: FastifyInstance;
  mm: Matchmaker;
  store: MMStore;
  close(): Promise<void>;
}

const QueueBody = z.object({ ticket: z.string().min(20).max(8192) });
const RegisterBody = z.object({
  serverId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  url: z.string().url(),
  region: z.string().min(2).max(8),
  capacity: z.number().int().min(1).max(100_000),
  load: z.number().int().min(0).default(0),
  humans: z.number().int().min(0).optional(),
});
const HeartbeatBody = z.object({
  serverId: z.string().min(1).max(64),
  load: z.number().int().min(0),
  /** Humans connected to the server's rooms (older servers omit it). */
  humans: z.number().int().min(0).optional(),
});
const SettingsSchema = z
  .object({
    playlistId: z.string().min(1).max(64),
    rounds: z.array(z.string().min(1).max(64)).max(10),
    maxPlayers: z.number().int().min(2).max(60),
    bots: z.boolean(),
    roundTimeScale: z.number().min(0.5).max(2),
    lobbyCountdownSec: z.number().int().min(0).max(120),
    spectatorSlots: z.number().int().min(0).max(10),
  })
  .partial();
const CreateLobbyBody = z.object({
  settings: SettingsSchema.default({}),
  region: z.string().min(2).max(8).optional(),
});
const CodeParam = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{6}$/),
});
const JoinLobbyBody = z.object({ spectator: z.boolean().default(false) }).default({ spectator: false });
const KickBody = z.object({ userId: z.string().min(1).max(64) });

function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new MMError(
      400,
      'invalid_request',
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

const bearer = (req: FastifyRequest): string | null => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/**
 * Builds the matchmaker.
 *
 * @param cfg - Configuration.
 * @param opts - Test overrides.
 */
export async function buildMatchmaker(
  cfg: MatchmakerConfig,
  opts: MatchmakerAppOptions = {},
): Promise<MatchmakerApp> {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? createStore(cfg.redisUrl, now);
  const mm = new Matchmaker(cfg, store, now);
  const app = Fastify({ logger: opts.logger === false ? false : { level: cfg.logLevel }, trustProxy: true });

  // @fastify/cors is not a dependency here; the surface is small enough to answer preflights directly.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MMError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  const player = async (req: FastifyRequest): Promise<Player> => {
    const token = bearer(req);
    const p = token ? await verifyAccess(cfg.jwtSecret, token, new Date(now())) : null;
    if (!p) throw new MMError(401, 'unauthorized', 'Valid API access token required');
    return p;
  };
  const gameServer = (req: FastifyRequest): void => {
    const token = Buffer.from(bearer(req) ?? '');
    const secret = Buffer.from(cfg.gameServerSecret);
    if (token.length !== secret.length || !timingSafeEqual(token, secret))
      throw new MMError(401, 'unauthorized', 'Invalid game server secret');
  };

  app.get('/health', async () => ({
    ok: true,
    store: cfg.redisUrl ? 'redis' : 'memory',
    queued: (await mm.entries()).reduce((s, e) => s + e.members.length, 0),
    servers: (await mm.servers()).length,
  }));

  // Public and unauthenticated: the Play tab shows these counts before sign-in.
  app.get('/stats', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=5');
    return mm.stats();
  });

  // --- Queue -----------------------------------------------------------------
  app.post('/queue', async (req) => {
    const p = await player(req);
    const { ticket } = parse(QueueBody, req.body);
    const t = await verifyQueueTicket(cfg.jwtSecret, ticket, new Date(now()));
    if (!t)
      throw new MMError(
        401,
        'invalid_ticket',
        'Queue ticket invalid or expired; request a new one from the API',
      );
    const entry = await mm.enqueue(p, t);
    return { entryId: entry.id, status: await mm.status(p.userId) };
  });

  app.delete('/queue', async (req, reply: FastifyReply) => {
    const p = await player(req);
    await mm.cancel(p.userId);
    return reply.code(204).send();
  });

  app.get('/queue/status', async (req) => {
    const p = await player(req);
    return { status: await mm.status(p.userId) };
  });

  // --- Game servers ------------------------------------------------------------
  app.post('/servers/register', async (req) => {
    gameServer(req);
    const b = parse(RegisterBody, req.body);
    return mm.registerServer({
      id: b.serverId,
      url: b.url,
      region: b.region,
      capacity: b.capacity,
      load: b.load,
      ...(b.humans !== undefined ? { humans: b.humans } : {}),
    });
  });

  app.post('/servers/heartbeat', async (req) => {
    gameServer(req);
    const b = parse(HeartbeatBody, req.body);
    return mm.heartbeat(b.serverId, b.load, b.humans);
  });

  app.delete('/servers/:id', async (req, reply) => {
    gameServer(req);
    await mm.removeServer(parse(z.object({ id: z.string().min(1).max(64) }), req.params).id);
    return reply.code(204).send();
  });

  app.get('/matches/:id', async (req) => {
    gameServer(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const m = await mm.getMatch(id);
    if (!m) throw new MMError(404, 'not_found', 'Unknown match');
    return m;
  });

  // --- Custom lobbies -----------------------------------------------------------
  app.post('/lobbies', async (req) => {
    const p = await player(req);
    const b = parse(CreateLobbyBody, req.body ?? {});
    return { lobby: await mm.createLobby(p, b.settings, b.region) };
  });

  app.get('/lobbies/defaults', async () => DEFAULT_CUSTOM);

  app.get('/lobbies/:code', async (req) => {
    await player(req);
    return { lobby: await mm.getLobby(parse(CodeParam, req.params).code) };
  });

  app.post('/lobbies/:code/join', async (req) => {
    const p = await player(req);
    const { code } = parse(CodeParam, req.params);
    const { spectator } = parse(JoinLobbyBody, req.body ?? undefined);
    return { lobby: await mm.joinLobby(p, code, spectator) };
  });

  app.post('/lobbies/:code/leave', async (req, reply) => {
    const p = await player(req);
    parse(CodeParam, req.params);
    await mm.leaveLobby(p.userId);
    return reply.code(204).send();
  });

  app.patch('/lobbies/:code', async (req) => {
    const p = await player(req);
    const { code } = parse(CodeParam, req.params);
    return { lobby: await mm.updateLobby(p.userId, code, parse(SettingsSchema, req.body)) };
  });

  app.post('/lobbies/:code/kick', async (req) => {
    const p = await player(req);
    const { code } = parse(CodeParam, req.params);
    return { lobby: await mm.kickFromLobby(p.userId, code, parse(KickBody, req.body).userId) };
  });

  app.post('/lobbies/:code/start', async (req) => {
    const p = await player(req);
    const { code } = parse(CodeParam, req.params);
    const m = await mm.startLobby(p.userId, code);
    return {
      matchId: m.matchId,
      server: { id: m.serverId, url: m.serverUrl },
      players: m.humans,
      bots: m.botFill,
    };
  });

  // --- WebSocket status stream -------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return;
    void (async () => {
      const p = await verifyAccess(cfg.jwtSecret, url.searchParams.get('token') ?? '', new Date(now()));
      if (!p) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void (async () => {
          const unsubscribe = await store.subscribe(userChannel(p.userId), (msg) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(msg);
          });
          ws.on('close', () => void unsubscribe());
          ws.on('message', () => undefined);
          const status = await mm.status(p.userId);
          ws.send(JSON.stringify(status ? { type: 'status', ...status } : { type: 'idle' }));
        })().catch(() => ws.close());
      });
    })().catch(() => socket.destroy());
  };
  app.server.on('upgrade', onUpgrade);

  const timers: NodeJS.Timeout[] = [];
  if (cfg.tickMs > 0) {
    timers.push(
      setInterval(() => void mm.tick().catch((err) => app.log.error({ err }, 'tick failed')), cfg.tickMs),
    );
    timers.push(
      setInterval(
        () => void mm.broadcastStatus().catch((err) => app.log.error({ err }, 'status failed')),
        1000,
      ),
    );
  }

  return {
    app,
    mm,
    store,
    close: async () => {
      for (const t of timers) clearInterval(t);
      app.server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(1001, 'shutting down');
      await new Promise<void>((r) => wss.close(() => r()));
      await app.close();
      await store.close();
    },
  };
}
