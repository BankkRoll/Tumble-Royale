/**
 * Realtime gateway hardening: handshake budgets, socket caps, the per-socket
 * frame bucket, debounced presence, listeners registered before setup, and
 * sockets that end with the session (token expiry, ban, deletion, sign-out),
 * on one instance and across two sharing a KV.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDatabase } from '../src/db/client.ts';
import { createKV } from '../src/kv/index.ts';
import { PartyLobbyRelay } from '../src/realtime/partyLobby.ts';
import { GATEWAY_FRAME_LIMITS } from '../src/realtime/gateway.ts';
import { getPresence } from '../src/social/presence.ts';
import { PartyService } from '../src/social/party.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

type Msg = Record<string, unknown>;
const START = '2026-10-02T12:00:00.000Z';

const opened: TestApi[] = [];
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close();
});

async function serve(env: Record<string, string> = {}, extra: Parameters<typeof createTestApi>[2] = {}) {
  const api = await createTestApi(START, env, extra);
  opened.push(api);
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
  return { api, base };
}

interface Client {
  ws: WebSocket;
  got: Msg[];
  closed: Promise<number>;
  next(type: string, pred?: (m: Msg) => boolean): Promise<Msg>;
}

function connect(base: string, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${token}`);
    const got: Msg[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d)) as Msg));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    const next = (type: string, pred: (m: Msg) => boolean = () => true) =>
      new Promise<Msg>((res, rej) => {
        const started = Date.now();
        const check = () => {
          const i = got.findIndex((m) => m.type === type && pred(m));
          if (i >= 0) return res(got.splice(i, 1)[0]!);
          if (Date.now() - started > 4000) return rej(new Error(`timed out waiting for ${type}`));
          setTimeout(check, 10);
        };
        check();
      });
    ws.on('open', () => resolve({ ws, got, closed, next }));
    ws.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function befriend(api: TestApi, a: TestUser, b: TestUser) {
  await api.req('POST', '/friends/request', {
    token: a.accessToken,
    body: { nameTag: `${b.displayName}#${b.tag}` },
  });
  await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
}

describe('handshake budgets and socket caps', () => {
  it('refuses handshakes over the per-address budget', async () => {
    const { api, base } = await serve({ WS_IP_UPGRADES_PER_MINUTE: '3' });
    const users = await Promise.all([api.guest(), api.guest(), api.guest(), api.guest()]);
    for (const u of users.slice(0, 3)) (await connect(base, u.accessToken)).ws.close();
    await expect(connect(base, users[3]!.accessToken)).rejects.toThrow(/429/);
  });

  it('refuses handshakes over the per-account budget', async () => {
    const { api, base } = await serve({ WS_USER_UPGRADES_PER_MINUTE: '2' });
    const u = await api.guest();
    for (let i = 0; i < 2; i++) {
      const c = await connect(base, u.accessToken);
      c.ws.close();
      await c.closed;
    }
    await expect(connect(base, u.accessToken)).rejects.toThrow(/429/);
    const other = await api.guest();
    (await connect(base, other.accessToken)).ws.close();
  });

  it('caps open sockets per account and per address', async () => {
    const { api, base } = await serve({ WS_MAX_SOCKETS_PER_USER: '2', WS_MAX_SOCKETS_PER_IP: '3' });
    const [a, b] = await Promise.all([api.guest(), api.guest()]);
    const first = await connect(base, a.accessToken);
    await connect(base, a.accessToken);
    await expect(connect(base, a.accessToken)).rejects.toThrow(/429/);
    await connect(base, b.accessToken);
    await expect(connect(base, b.accessToken)).rejects.toThrow(/429/);
    first.ws.close();
    await first.closed;
    await connect(base, b.accessToken);
    expect(api.gateway.connections()).toBe(3);
  });
});

describe('frames', () => {
  it('drops frames over the per-socket budget and closes a sustained flood', async () => {
    const { api, base } = await serve();
    const c = await connect(base, (await api.guest()).accessToken);
    await c.next('hello');
    const sent = 300;
    for (let i = 0; i < sent; i++) c.ws.send('{"type":"ping"}');
    await sleep(500);
    const pongs = c.got.filter((m) => m.type === 'pong').length;
    expect(pongs).toBeGreaterThan(0);
    expect(pongs).toBeLessThan(sent);
    expect(pongs).toBeLessThanOrEqual(GATEWAY_FRAME_LIMITS.burst + 60);

    for (let i = 0; i < GATEWAY_FRAME_LIMITS.maxDropped + GATEWAY_FRAME_LIMITS.burst; i++) c.ws.send('{}');
    expect(await c.closed).toBe(4008);
  });

  it('folds a burst of presence reports into few broadcasts ending on the last status', async () => {
    const { api, base } = await serve();
    const [a, b] = await Promise.all([api.guest(), api.guest()]);
    await befriend(api, a, b);
    const watcher = await connect(base, b.accessToken);
    await watcher.next('hello');
    const talker = await connect(base, a.accessToken);
    await watcher.next('presence', (m) => m.userId === a.id);
    const statuses = ['in_menu', 'in_queue', 'in_menu', 'in_queue', 'in_match'];
    for (let i = 0; i < 20; i++)
      talker.ws.send(JSON.stringify({ type: 'presence', status: statuses[i % 5] }));
    await sleep(1600);
    const seen = watcher.got.filter((m) => m.type === 'presence' && m.userId === a.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(2);
    expect(seen.at(-1)).toMatchObject({ status: 'in_match' });
  });
});

describe('connection setup', () => {
  it('releases presence for a socket closed before its setup finished', async () => {
    const { api, base } = await serve();
    const u = await api.guest();
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${base}/ws?token=${u.accessToken}`);
      ws.on('open', () => ws.terminate());
      ws.on('close', () => resolve());
    });
    await sleep(600);
    expect((await getPresence(api.ctx.kv, u.id)).status).toBe('offline');
    expect(api.gateway.connections()).toBe(0);
  });
});

describe('sockets end with the session', () => {
  it('closes a socket once its access token expires', async () => {
    const { api, base } = await serve();
    const c = await connect(base, (await api.guest()).accessToken);
    await c.next('hello');
    api.clock.advance(16 * 60_000);
    c.ws.send('{"type":"ping"}');
    expect(await c.closed).toBe(4401);
  });

  it('closes a suspended account and scrubs its lines from the chat history', async () => {
    const { api, base } = await serve();
    const [bad, other] = await Promise.all([api.guest(), api.guest()]);
    const c = await connect(base, bad.accessToken);
    await c.next('hello');
    c.ws.send(JSON.stringify({ type: 'global_chat', text: 'spam spam spam' }));
    await c.next('global_chat');
    await api.ban(bad.id);
    expect(await c.closed).toBe(4403);
    const fresh = await connect(base, other.accessToken);
    const history = await fresh.next('global_chat_history');
    expect((history.lines as { from: { userId: string } }[]).some((l) => l.from.userId === bad.id)).toBe(
      false,
    );
  });

  it('closes the sockets of a deleted account', async () => {
    const { api, base } = await serve();
    const u = await api.guest();
    const c = await connect(base, u.accessToken);
    await c.next('hello');
    const del = await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode).toBeLessThan(300);
    expect(await c.closed).toBe(4403);
  });

  it('closes only the signed-out session', async () => {
    const { api, base } = await serve();
    const u = await api.guest();
    const second = await api.req('POST', '/auth/guest', {
      body: { deviceToken: u.deviceToken },
      ip: '10.9.9.9',
    });
    const other = await connect(base, second.json().accessToken as string);
    const c = await connect(base, u.accessToken);
    await c.next('hello');
    await other.next('hello');
    expect((await api.req('POST', '/auth/logout', { token: u.accessToken, body: {} })).statusCode).toBe(204);
    expect(await c.closed).toBe(4403);
    await sleep(100);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses party lobby frames from a suspended account', async () => {
    const { api } = await serve();
    const u = await api.guest();
    await api.ban(u.id);
    const relay = new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));
    expect(await relay.handle(u.id, { type: 'party_lobby', x: 0, z: 0, ry: 0 }, 40)).toBe('suspended');
  });
});

describe('two instances', () => {
  async function pair() {
    const database = await openDatabase({ databaseUrl: undefined, pgliteDir: 'memory://' });
    const db = { ...database, close: async () => undefined };
    const kv = createKV(undefined, () => Date.parse(START));
    const env = { DATABASE_URL: '', REDIS_URL: '' };
    const a = await serve(env, { kv, database: db });
    const b = await serve(env, { kv, database: db });
    return { a, b, close: () => database.close() };
  }

  it('closes the socket on the other instance when the account is banned', async () => {
    const { a, b, close } = await pair();
    try {
      const u = await a.api.guest();
      const c = await connect(b.base, u.accessToken);
      await c.next('hello');
      await a.api.ban(u.id);
      expect(await c.closed).toBe(4403);
    } finally {
      for (const x of opened.splice(0)) await x.close();
      await close();
    }
  });

  it('keeps a user online while another instance still holds a tab', async () => {
    const { a, b, close } = await pair();
    try {
      const u = await a.api.guest();
      const onA = await connect(a.base, u.accessToken);
      await onA.next('hello');
      const onB = await connect(b.base, u.accessToken);
      await onB.next('hello');
      onA.ws.close();
      await onA.closed;
      await sleep(600);
      expect((await getPresence(a.api.ctx.kv, u.id)).status).toBe('online');
      onB.ws.close();
      await onB.closed;
      await sleep(600);
      expect((await getPresence(a.api.ctx.kv, u.id)).status).toBe('offline');
    } finally {
      for (const x of opened.splice(0)) await x.close();
      await close();
    }
  });
});
