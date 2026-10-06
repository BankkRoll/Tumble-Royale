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
 * `partyLobby.ts`) and `voice_join` / `voice_leave` / `voice_signal` (see
 * `voice/relay.ts`). Server → client: `RealtimeEvent`s plus
 * `{type:'hello'}`, `{type:'pong'}`, `{type:'global_chat', ...line}` (every
 * connection), `{type:'global_chat_history', lines}` (once, after `hello`)
 * and `{type:'error', code, message}` for refused client messages.
 *
 * Abuse limits:
 * - handshakes per client IP and per account per minute, counted in the
 *   shared KV so every instance enforces one budget;
 * - open sockets per account and per client IP on each instance;
 * - a token bucket per socket for every client frame;
 * - presence broadcasts debounced per user.
 *
 * Session lifetime: a socket closes when its access token expires (the client
 * reconnects with a fresh one), when the account is suspended (the ban cache
 * invalidation channel), deleted or signed out (`disconnect.ts`), on every
 * instance.
 *
 * Presence:
 * - every tab reports its own status; friends see the most engaged one
 *   (`in_match` > `in_queue` > `in_menu` > `online`);
 * - a new connection gets a `presence_snapshot` of its friends;
 * - closing the last tab starts a grace period (`presenceGraceMs`) before the
 *   user is shown offline, so reloads and network blips don't flicker;
 * - each instance holding tabs registers itself in `presence-tabs:<userId>`,
 *   so one instance's last tab closing does not report offline while another
 *   instance still holds a live tab.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { clientIp, trustFunction } from '@tumble/shared/proxy';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { isErased } from '../accounts/tombstone.ts';
import { verifyAccessToken } from '../auth/tokens.ts';
import { sendClubChat } from '../clubs/chat.ts';
import type { AppContext } from '../context.ts';
import { activeBans, BAN_INVALIDATION_CHANNEL } from '../http/auth.ts';
import { ApiError } from '../http/errors.ts';
import { hitWindow } from '../http/rate-limit.ts';
import { broadcastPresence, friendIds } from '../social/friends.ts';
import { GlobalChatRoom, sendGlobalChat } from '../social/globalChat.ts';
import { sendPartyChat } from '../social/partyChat.ts';
import { sendWhisper } from '../social/whisper.ts';
import { PartyService } from '../social/party.ts';
import { PRESENCE_TTL_MS, presenceViews, setPresence } from '../social/presence.ts';
import { VOICE_LIMITS } from '@tumble/shared';
import { VoiceRelay } from '../voice/relay.ts';
import { leaveVoice, voiceKeepAlive } from '../voice/service.ts';
import { DISCONNECT_CHANNEL, GATEWAY_CLOSE, parseDisconnectOrder } from './disconnect.ts';
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
// Voice offers and answers carry SDP, which outgrows the cap for everything
// else. Frames a little over the voice cap are dropped by the relay; only far
// larger ones close the socket.
const MAX_FRAME_BYTES = VOICE_LIMITS.maxMessageBytes + MAX_MESSAGE_BYTES;

/**
 * Per-socket frame budget. Sized above the busiest honest client: lobby poses
 * (15/s), voice signalling bursts (20/s, 60 burst) and chat together.
 */
export const GATEWAY_FRAME_LIMITS = {
  burst: 120,
  perSecond: 60,
  /** Frames dropped over budget before the socket is closed as a flood. */
  maxDropped: 600,
  /** Frames held while a fresh connection finishes its setup. */
  maxPending: 32,
} as const;

/** Least time between two presence broadcasts of one user (trailing edge kept). */
export const PRESENCE_DEBOUNCE_MS = 1000;
// A ping re-stores presence only this often; the KV entry lives PRESENCE_TTL_MS.
const PRESENCE_REFRESH_MS = PRESENCE_TTL_MS / 3;
// setTimeout's ceiling; longer delays fire at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

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

/** What the gateway knows about one open socket. */
interface Conn {
  userId: string;
  /** Session the handshake token was minted from (sign-out closes by session). */
  sessionId: string;
  ip: string;
  /** Access token expiry, epoch ms on the app clock. */
  expiresAt: number;
  tokens: number;
  refilledAt: number;
  dropped: number;
}

const noop = (): undefined => undefined;
const tabsKey = (userId: string) => `presence-tabs:${userId}`;

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
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const trust = trustFunction(ctx.config.trustProxy);
  const instanceId = randomUUID();
  const alive = new WeakMap<WebSocket, boolean>();
  const conns = new Map<WebSocket, Conn>();
  const byUser = new Map<string, Map<WebSocket, TabState>>();
  const ipSockets = new Map<string, number>();
  const offlineTimers = new Map<string, NodeJS.Timeout>();
  const presenceTimers = new Map<string, NodeJS.Timeout>();
  /** Real time (ms) of each user's last presence flush, for the debounce. */
  const presenceFlushedAt = new Map<string, number>();
  /** App-clock time of each user's last presence write, for ping refreshes. */
  const presenceStoredAt = new Map<string, number>();
  const parties = new PartyService(ctx);
  const lobby = new PartyLobbyRelay(ctx, parties);
  const voice = new VoiceRelay(ctx);
  /** The voice tab id each socket last joined with; closing the socket ends that session. */
  const voiceTabs = new WeakMap<WebSocket, string>();
  /** Last presence each user's friends were told about (skips duplicate broadcasts). */
  const lastBroadcast = new Map<string, string>();
  const globalChat = new GlobalChatRoom((line) => {
    const payload = JSON.stringify({ type: 'global_chat', ...line });
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });

  /** Closes a user's sockets here, optionally only those of some sessions. */
  const closeUser = (userId: string, code: number, reason: string, sessionIds?: readonly string[]) => {
    for (const ws of [...(byUser.get(userId)?.keys() ?? [])]) {
      const conn = conns.get(ws);
      if (!sessionIds || (conn && sessionIds.includes(conn.sessionId))) ws.close(code, reason);
    }
  };

  const onBanChange = async (userId: string) => {
    const bans = await activeBans(ctx, userId, true);
    if (bans.some((b) => b.scope === 'chat' || b.scope === 'all')) globalChat.forget(userId);
    if (bans.some((b) => b.scope === 'all')) closeUser(userId, GATEWAY_CLOSE.accessEnded, 'suspended');
  };

  const unsubscribers: Promise<() => Promise<void>>[] = [
    ctx.kv.subscribe(BAN_INVALIDATION_CHANNEL, (userId) => void onBanChange(userId).catch(noop)),
    ctx.kv.subscribe(DISCONNECT_CHANNEL, (raw) => {
      const order = parseDisconnectOrder(raw);
      if (!order) return;
      if (order.reason === 'erased') globalChat.forget(order.userId);
      closeUser(order.userId, GATEWAY_CLOSE.accessEnded, order.reason, order.sessionIds);
    }),
  ];
  const ready = Promise.all([globalChat.start(ctx.kv), ...unsubscribers]);

  /** Stores the most engaged tab's state; returns true when friends should hear about it. */
  const storePresence = async (userId: string): Promise<boolean> => {
    const tabs = byUser.get(userId);
    if (!tabs || tabs.size === 0) return false;
    let best: TabState | null = null;
    for (const t of tabs.values()) if (!best || ENGAGEMENT[t.status] > ENGAGEMENT[best.status]) best = t;
    const key = JSON.stringify(best);
    const changed = lastBroadcast.get(userId) !== key;
    lastBroadcast.set(userId, key);
    const now = ctx.now().getTime();
    presenceStoredAt.set(userId, now);
    await setPresence(ctx.kv, userId, best!.status, now, best!);
    await ctx.kv.zadd(tabsKey(userId), now + PRESENCE_TTL_MS, instanceId);
    return changed;
  };

  const flushPresence = async (userId: string) => {
    presenceFlushedAt.set(userId, Date.now());
    if (await storePresence(userId)) await broadcastPresence(ctx, userId);
  };

  /**
   * Stores and broadcasts presence at once when the user's last flush is
   * older than {@link PRESENCE_DEBOUNCE_MS}, else once that much time has
   * passed; changes in between fold into that one broadcast.
   */
  const schedulePresence = async (userId: string): Promise<void> => {
    if (presenceTimers.has(userId)) return;
    const wait = (presenceFlushedAt.get(userId) ?? -Infinity) + PRESENCE_DEBOUNCE_MS - Date.now();
    if (wait <= 0) return flushPresence(userId);
    const t = setTimeout(() => {
      presenceTimers.delete(userId);
      void flushPresence(userId).catch(noop);
    }, wait);
    t.unref();
    presenceTimers.set(userId, t);
  };

  const goOffline = async (userId: string) => {
    offlineTimers.delete(userId);
    if (byUser.has(userId)) return;
    lastBroadcast.delete(userId);
    presenceFlushedAt.delete(userId);
    presenceStoredAt.delete(userId);
    const key = tabsKey(userId);
    const now = ctx.now().getTime();
    await ctx.kv.zrem(key, instanceId);
    let elsewhere = false;
    for (const m of await ctx.kv.zrevrange(key, 0, -1)) {
      if (m.score > now) elsewhere = true;
      else await ctx.kv.zrem(key, m.member);
    }
    // Another instance still refreshes the shared entry; its own last close reports offline.
    if (elsewhere) return;
    await setPresence(ctx.kv, userId, 'offline', now);
    await broadcastPresence(ctx, userId);
  };

  const refuse = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
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
      refuse(socket, '403 Forbidden');
      return;
    }
    // SECURITY: the same TRUST_PROXY rules as Fastify's request.ip, so the
    // per-address limits cannot be dodged with a forged X-Forwarded-For.
    const ip = clientIp(req, trust);
    void (async () => {
      const { abuse } = ctx.config;
      const now = ctx.now().getTime();
      // SECURITY: every handshake costs token verification, a ban lookup and,
      // once open, a KV subscription and a presence fan-out, so they are
      // budgeted before any of that work.
      if (!(await hitWindow(ctx.kv, `ws:ip:${ip}`, abuse.wsIpUpgradesPerMinute, 60_000, now)))
        return refuse(socket, '429 Too Many Requests');
      const token = url.searchParams.get('token') ?? '';
      const claims = await verifyAccessToken(ctx.config.jwtSecret, token, Math.floor(now / 1000));
      if (!claims) return refuse(socket, '401 Unauthorized');
      if (!(await hitWindow(ctx.kv, `ws:user:${claims.sub}`, abuse.wsUserUpgradesPerMinute, 60_000, now)))
        return refuse(socket, '429 Too Many Requests');
      const banned =
        (await isErased(ctx.kv, claims.sub)) ||
        (await activeBans(ctx, claims.sub)).some((b) => b.scope === 'all');
      if (banned) return refuse(socket, '403 Forbidden');
      await ready;
      // No await from here to the upgrade callback, so the counts cannot race.
      if (
        (byUser.get(claims.sub)?.size ?? 0) >= abuse.wsMaxSocketsPerUser ||
        (ipSockets.get(ip) ?? 0) >= abuse.wsMaxSocketsPerIp
      )
        return refuse(socket, '429 Too Many Requests');
      const exp = decodeJwt(token).exp ?? 0;
      wss.handleUpgrade(req, socket, head, (ws) =>
        onConnection(ws, {
          userId: claims.sub,
          sessionId: claims.sid,
          ip,
          expiresAt: exp * 1000,
          tokens: GATEWAY_FRAME_LIMITS.burst,
          refilledAt: performance.now(),
          dropped: 0,
        }),
      );
    })().catch(() => socket.destroy());
  };

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const takeFrame = (conn: Conn): boolean => {
    const t = performance.now();
    const { burst, perSecond } = GATEWAY_FRAME_LIMITS;
    conn.tokens = Math.min(burst, conn.tokens + ((t - conn.refilledAt) / 1000) * perSecond);
    conn.refilledAt = t;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  };

  const onFrame = (ws: WebSocket, conn: Conn, tabs: Map<WebSocket, TabState>, text: string) => {
    const { userId } = conn;
    let parsed: z.infer<typeof ClientMessage>;
    try {
      const json: unknown = JSON.parse(text);
      if (VoiceRelay.matches(json))
        return void voice
          .handle(userId, json, text.length)
          .then((r) => {
            if (r.outcome === 'joined' && r.cid) voiceTabs.set(ws, r.cid);
            if (r.outcome === 'left' && voiceTabs.get(ws) === r.cid) voiceTabs.delete(ws);
            if (r.error) send(ws, { type: 'error', code: r.error.code, message: r.error.message });
          })
          .catch(noop);
      if (text.length > MAX_MESSAGE_BYTES) return;
      if (PartyLobbyRelay.matches(json)) return void lobby.handle(userId, json, text.length).catch(noop);
      parsed = ClientMessage.parse(json);
    } catch {
      return;
    }
    void (async () => {
      if (parsed.type === 'ping') {
        // Refreshes the TTL with the tab's real status; a ping is not a status report.
        if (ctx.now().getTime() - (presenceStoredAt.get(userId) ?? -Infinity) >= PRESENCE_REFRESH_MS)
          await storePresence(userId);
        if (voiceTabs.has(ws)) await voiceKeepAlive(ctx, userId);
        send(ws, { type: 'pong', at: ctx.now().getTime() });
      } else if (parsed.type === 'presence') {
        tabs.set(ws, { status: parsed.status, playlistId: parsed.playlistId, lobbyCode: parsed.lobbyCode });
        await schedulePresence(userId);
      } else {
        try {
          if (parsed.type === 'whisper') await sendWhisper(ctx, userId, parsed.to, parsed.text);
          else if (parsed.type === 'global_chat') await sendGlobalChat(ctx, userId, parsed.text, conn.ip);
          else if (parsed.type === 'club_chat') await sendClubChat(ctx, userId, parsed.text);
          else await sendPartyChat(ctx, parties, userId, parsed.text);
        } catch (err) {
          if (err instanceof ApiError) send(ws, { type: 'error', code: err.code, message: err.message });
          else throw err;
        }
      }
    })().catch(noop);
  };

  /**
   * Registers a socket. Every listener is attached before the first await, so
   * a socket that closes during setup still releases its tab, subscription
   * and presence; frames that arrive during setup wait in a short queue.
   */
  const onConnection = (ws: WebSocket, conn: Conn) => {
    const { userId } = conn;
    alive.set(ws, true);
    conns.set(ws, conn);
    ipSockets.set(conn.ip, (ipSockets.get(conn.ip) ?? 0) + 1);
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
    const myTabs = tabs;
    myTabs.set(ws, { status: 'online' });
    const expiry = setTimeout(
      () => ws.close(GATEWAY_CLOSE.tokenExpired, 'token expired'),
      Math.min(MAX_TIMER_MS, Math.max(0, conn.expiresAt - ctx.now().getTime())),
    );
    expiry.unref();

    let closed = false;
    let setUp = false;
    const pending: string[] = [];
    let unsubscribe: (() => Promise<void>) | null = null;

    ws.on('pong', () => alive.set(ws, true));
    // NOTE: an over-size frame or protocol violation surfaces here; `ws` closes
    // the socket itself, but an unhandled 'error' would crash the process.
    ws.on('error', () => ws.terminate());
    ws.on('message', (data) => {
      if (!takeFrame(conn)) {
        if (++conn.dropped > GATEWAY_FRAME_LIMITS.maxDropped)
          ws.close(GATEWAY_CLOSE.flooding, 'too many messages');
        return;
      }
      // The timer can lag behind a fake or skewed clock; the token's own expiry is authoritative.
      if (ctx.now().getTime() >= conn.expiresAt)
        return void ws.close(GATEWAY_CLOSE.tokenExpired, 'token expired');
      const text = String(data);
      if (!setUp) {
        if (pending.length < GATEWAY_FRAME_LIMITS.maxPending) pending.push(text);
        return;
      }
      onFrame(ws, conn, myTabs, text);
    });

    const setup = (async () => {
      await ready;
      const unsub = await ctx.kv.subscribe(userChannel(userId), (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      });
      if (closed) return void (await unsub());
      unsubscribe = unsub;
      await schedulePresence(userId);
      if (closed) return;
      send(ws, { type: 'hello', userId, presenceTtlMs: PRESENCE_TTL_MS });
      send(ws, { type: 'global_chat_history', lines: globalChat.history() });
      const ids = await friendIds(ctx.db, userId);
      const views = await presenceViews(ctx.kv, ids);
      send(ws, {
        type: 'presence_snapshot',
        friends: ids.map((id) => ({ userId: id, ...(views.get(id) ?? { status: 'offline' }) })),
      });
      setUp = true;
      for (const text of pending.splice(0)) onFrame(ws, conn, myTabs, text);
    })();
    setup.catch(() => ws.close(1011, 'setup failed'));

    ws.on('close', () => {
      closed = true;
      clearTimeout(expiry);
      conns.delete(ws);
      const left = (ipSockets.get(conn.ip) ?? 1) - 1;
      if (left > 0) ipSockets.set(conn.ip, left);
      else ipSockets.delete(conn.ip);
      myTabs.delete(ws);
      const last = myTabs.size === 0;
      if (last && byUser.get(userId) === myTabs) byUser.delete(userId);
      void (async () => {
        await setup.catch(noop);
        await unsubscribe?.();
        const voiceTab = voiceTabs.get(ws);
        if (voiceTab) await leaveVoice(ctx, userId, voiceTab);
        if (byUser.has(userId)) return void (await schedulePresence(userId));
        lobby.forget(userId);
        voice.forget(userId);
        const timer = presenceTimers.get(userId);
        if (timer) clearTimeout(timer);
        presenceTimers.delete(userId);
        const grace = ctx.config.presenceGraceMs;
        if (grace <= 0) return void (await goOffline(userId));
        const t = setTimeout(() => void goOffline(userId).catch(noop), grace);
        t.unref();
        offlineTimers.set(userId, t);
      })().catch(noop);
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
      await globalChat.stop().catch(noop);
      for (const u of unsubscribers) await (await u.catch(() => null))?.().catch(noop);
      for (const t of offlineTimers.values()) clearTimeout(t);
      offlineTimers.clear();
      for (const t of presenceTimers.values()) clearTimeout(t);
      presenceTimers.clear();
      app.server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
