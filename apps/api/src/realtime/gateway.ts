/**
 * Realtime WebSocket gateway at `/ws?token=<access JWT>`.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the access token
 * travels in the query string. Each connection subscribes to its user's KV
 * channel (see `Notifier`) and maintains presence.
 *
 * Client → server: `{type:'ping'}`, `{type:'presence', status, playlistId?,
 * lobbyCode?}`, `{type:'party_chat', text}`, `{type:'whisper', to, text}`,
 * `{type:'global_chat', text}`, `{type:'club_chat', text}` and
 * `{type:'party_lobby', …}` (relayed to fellow party members, see
 * `partyLobby.ts`). Server → client: `RealtimeEvent`s plus
 * `{type:'hello'}`, `{type:'pong'}`, `{type:'global_chat', ...line}` (every
 * connection), `{type:'global_chat_history', lines}` (once, after `hello`)
 * and `{type:'error', code, message}` for refused client messages.
 *
 * Presence:
 * - every tab reports its own status; friends see the most engaged one
 *   (`in_match` > `in_queue` > `in_menu` > `online`);
 * - a new connection gets a `presence_snapshot` of its friends;
 * - closing the last tab starts a grace period (`presenceGraceMs`) before the
 *   user is shown offline, so reloads and network blips don't flicker.
 *
 * NOTE: tab bookkeeping is per API instance. Behind several instances a user's
 * tabs may land on different ones; the presence key's TTL is the backstop.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { isErased } from '../accounts/tombstone.ts';
import { verifyAccessToken } from '../auth/tokens.ts';
import { sendClubChat } from '../clubs/chat.ts';
import type { AppContext } from '../context.ts';
import { activeBans } from '../http/auth.ts';
import { ApiError } from '../http/errors.ts';
import { broadcastPresence, friendIds } from '../social/friends.ts';
import { GlobalChatRoom, sendGlobalChat } from '../social/globalChat.ts';
import { sendPartyChat } from '../social/partyChat.ts';
import { sendWhisper } from '../social/whisper.ts';
import { PartyService } from '../social/party.ts';
import { PRESENCE_TTL_MS, presenceViews, setPresence } from '../social/presence.ts';
import { REPORTABLE_PRESENCE, userChannel, type PresenceStatus } from './notifier.ts';
import { PartyLobbyRelay } from './partyLobby.ts';

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('presence'),
    status: z.enum(REPORTABLE_PRESENCE),
    playlistId: z.string().min(1).max(64).optional(),
    lobbyCode: z
      .string()
      .regex(/^[A-Z0-9]{4,8}$/)
      .optional(),
  }),
  z.object({ type: z.literal('party_chat'), text: z.string().max(500) }),
  z.object({ type: z.literal('whisper'), to: z.string().uuid(), text: z.string().max(500) }),
  z.object({ type: z.literal('global_chat'), text: z.string().max(500) }),
  z.object({ type: z.literal('club_chat'), text: z.string().max(500) }),
]);

const HEARTBEAT_MS = 30_000;
const MAX_MESSAGE_BYTES = 4096;

const ENGAGEMENT: Record<Exclude<PresenceStatus, 'offline'>, number> = {
  online: 0,
  in_menu: 1,
  in_queue: 2,
  in_match: 3,
};

interface TabState {
  status: Exclude<PresenceStatus, 'offline'>;
  playlistId?: string | undefined;
  lobbyCode?: string | undefined;
}

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
  const byUser = new Map<string, Map<WebSocket, TabState>>();
  const offlineTimers = new Map<string, NodeJS.Timeout>();
  const parties = new PartyService(ctx);
  const lobby = new PartyLobbyRelay(ctx, parties);
  /** Last presence each user's friends were told about (skips duplicate broadcasts). */
  const lastBroadcast = new Map<string, string>();
  const globalChat = new GlobalChatRoom((line) => {
    const payload = JSON.stringify({ type: 'global_chat', ...line });
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
  const globalChatReady = globalChat.start(ctx.kv);

  /** Stores the most engaged tab's state; returns true when friends should hear about it. */
  const storePresence = async (userId: string): Promise<boolean> => {
    const tabs = byUser.get(userId);
    if (!tabs || tabs.size === 0) return false;
    let best: TabState | null = null;
    for (const t of tabs.values()) if (!best || ENGAGEMENT[t.status] > ENGAGEMENT[best.status]) best = t;
    const key = JSON.stringify(best);
    const changed = lastBroadcast.get(userId) !== key;
    lastBroadcast.set(userId, key);
    await setPresence(ctx.kv, userId, best!.status, ctx.now().getTime(), best!);
    return changed;
  };

  const goOffline = async (userId: string) => {
    offlineTimers.delete(userId);
    if (byUser.has(userId)) return;
    lastBroadcast.delete(userId);
    await setPresence(ctx.kv, userId, 'offline', ctx.now().getTime());
    await broadcastPresence(ctx, userId);
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return;
    // SECURITY: CORS does not apply to WebSocket handshakes; without this any
    // site could open the gateway with a token it obtained. Origin-less
    // clients (tools, tests) still need a valid token.
    const origin = req.headers.origin;
    const allowed = ctx.config.corsOrigins;
    const norm = (o: string): string => o.replace(/\/$/, '');
    if (origin && allowed !== true && !allowed.some((a) => norm(a) === norm(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    void (async () => {
      const token = url.searchParams.get('token') ?? '';
      const claims = await verifyAccessToken(
        ctx.config.jwtSecret,
        token,
        Math.floor(ctx.now().getTime() / 1000),
      );
      const banned = claims
        ? (await isErased(ctx.kv, claims.sub)) ||
          (await activeBans(ctx, claims.sub)).some((b) => b.scope === 'all')
        : false;
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

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const onConnection = async (ws: WebSocket, userId: string) => {
    alive.set(ws, true);
    await globalChatReady;
    const pendingOffline = offlineTimers.get(userId);
    if (pendingOffline) {
      clearTimeout(pendingOffline);
      offlineTimers.delete(userId);
    }
    let tabs = byUser.get(userId);
    if (!tabs) {
      tabs = new Map();
      byUser.set(userId, tabs);
    }
    tabs.set(ws, { status: 'online' });
    const unsubscribe = await ctx.kv.subscribe(userChannel(userId), (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
    if (await storePresence(userId)) await broadcastPresence(ctx, userId);
    send(ws, { type: 'hello', userId, presenceTtlMs: PRESENCE_TTL_MS });
    send(ws, { type: 'global_chat_history', lines: globalChat.history() });
    const ids = await friendIds(ctx.db, userId);
    const views = await presenceViews(ctx.kv, ids);
    send(ws, {
      type: 'presence_snapshot',
      friends: ids.map((id) => ({ userId: id, ...(views.get(id) ?? { status: 'offline' }) })),
    });

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data) => {
      const text = String(data);
      let parsed: z.infer<typeof ClientMessage>;
      try {
        const json: unknown = JSON.parse(text);
        if (PartyLobbyRelay.matches(json))
          return void lobby.handle(userId, json, text.length).catch(() => undefined);
        parsed = ClientMessage.parse(json);
      } catch {
        return;
      }
      void (async () => {
        if (parsed.type === 'ping') {
          // Refreshes the TTL with the tab's real status; a ping is not a status report.
          await storePresence(userId);
          send(ws, { type: 'pong', at: ctx.now().getTime() });
        } else if (parsed.type === 'presence') {
          tabs.set(ws, { status: parsed.status, playlistId: parsed.playlistId, lobbyCode: parsed.lobbyCode });
          if (await storePresence(userId)) await broadcastPresence(ctx, userId);
        } else {
          try {
            if (parsed.type === 'whisper') await sendWhisper(ctx, userId, parsed.to, parsed.text);
            else if (parsed.type === 'global_chat') await sendGlobalChat(ctx, userId, parsed.text);
            else if (parsed.type === 'club_chat') await sendClubChat(ctx, userId, parsed.text);
            else await sendPartyChat(ctx, parties, userId, parsed.text);
          } catch (err) {
            if (err instanceof ApiError) send(ws, { type: 'error', code: err.code, message: err.message });
            else throw err;
          }
        }
      })().catch(() => undefined);
    });
    ws.on('close', () => {
      void (async () => {
        await unsubscribe();
        tabs.delete(ws);
        if (tabs.size > 0) {
          if (await storePresence(userId)) await broadcastPresence(ctx, userId);
          return;
        }
        byUser.delete(userId);
        lobby.forget(userId);
        const grace = ctx.config.presenceGraceMs;
        if (grace <= 0) return void (await goOffline(userId));
        const t = setTimeout(() => void goOffline(userId).catch(() => undefined), grace);
        t.unref();
        offlineTimers.set(userId, t);
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
      await globalChat.stop().catch(() => undefined);
      for (const t of offlineTimers.values()) clearTimeout(t);
      offlineTimers.clear();
      app.server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
