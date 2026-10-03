import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BitWriter, PROTOCOL_VERSION, writeHello } from '@tumble/netcode';
import { trustFunction } from '@tumble/shared/proxy';
import { loadRapier } from '@tumble/sim';
import {
  DEV_HTTP_POLICY,
  MAX_DETERMINISM_STEPS,
  startGameServer,
  type GameServer,
  type HttpPolicy,
} from '../src/server.ts';
import { testDeps, type FakeMatchSim } from './helpers.ts';

const TOKEN = 'metrics-token-0123456789';
const PROD: HttpPolicy = {
  debug: false,
  allowedOrigins: ['https://play.example'],
  metricsToken: TOKEN,
  openMetrics: false,
  trust: false,
  maxPendingPerIp: 2,
};

let server: GameServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(
  http: HttpPolicy,
  extra: { helloTimeoutMs?: number; realRapier?: boolean } = {},
): Promise<GameServer> {
  const sims: FakeMatchSim[] = [];
  const { realRapier, ...rest } = extra;
  const deps = {
    ...testDeps({ now: 0 }, sims),
    now: () => performance.now(),
    ...(realRapier ? { R: await loadRapier() } : {}),
  };
  server = await startGameServer({ port: 0, host: '127.0.0.1', deps, profileLogMs: 0, http, ...rest });
  return server;
}

const url = (s: GameServer, path: string, port = s.port) => `http://127.0.0.1:${port}${path}`;

/** Opens a socket; resolves with 101 on open, else the refusal status. Keeps open sockets in `held`. */
function upgrade(
  s: GameServer,
  headers: Record<string, string> = {},
  held: WebSocket[] = [],
): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers });
    ws.on('open', () => {
      held.push(ws);
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

describe('production HTTP exposure', () => {
  it('serves no debug endpoint and never answers with a wildcard CORS header', async () => {
    const s = await start(PROD);
    const debug = await fetch(url(s, '/debug/determinism?steps=10000'));
    expect(debug.status).toBe(404);
    const evil = await fetch(url(s, '/health'), { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(200);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const good = await fetch(url(s, '/health'), { headers: { origin: 'https://play.example' } });
    expect(good.headers.get('access-control-allow-origin')).toBe('https://play.example');
    expect(good.headers.get('vary')).toBe('origin');
  });

  it('serves /metrics and /rooms only with the bearer token', async () => {
    const s = await start(PROD);
    for (const path of ['/metrics', '/rooms']) {
      expect((await fetch(url(s, path))).status).toBe(401);
      expect((await fetch(url(s, path), { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      const ok = await fetch(url(s, path), { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('hides monitoring entirely without a token, and serves it on the internal port', async () => {
    const s = await start({ ...PROD, metricsToken: undefined, internalPort: 0, internalHost: '127.0.0.1' });
    expect((await fetch(url(s, '/metrics'))).status).toBe(404);
    expect((await fetch(url(s, '/rooms'))).status).toBe(404);
    expect(s.internalPort).toBeGreaterThan(0);
    const internal = s.internalPort!;
    expect(await (await fetch(url(s, '/metrics', internal))).text()).toMatch(/tumble_/);
    expect(await (await fetch(url(s, '/rooms', internal))).json()).toEqual([]);
    expect((await fetch(url(s, '/health', internal))).status).toBe(200);
    // The internal listener is not a second public surface.
    expect((await fetch(url(s, '/ws', internal))).status).toBe(404);
    expect((await fetch(url(s, '/debug/determinism', internal))).status).toBe(404);
    expect((await fetch(url(s, '/internal/kick', internal), { method: 'POST' })).status).toBe(404);
  });

  it('refuses WebSocket upgrades from foreign origins but not from origin-less clients', async () => {
    const s = await start(PROD);
    const held: WebSocket[] = [];
    expect(await upgrade(s, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade(s, { origin: 'https://play.example' }, held)).toBe(101);
    expect(await upgrade(s, {}, held)).toBe(101);
    for (const ws of held) ws.close();
  });
});

describe('pre-hello limits', () => {
  it('caps unhandshaken sockets per address and frees the slot on Hello, close or timeout', async () => {
    const s = await start(PROD, { helloTimeoutMs: 300 });
    const held: WebSocket[] = [];
    expect(await upgrade(s, {}, held)).toBe(101);
    expect(await upgrade(s, {}, held)).toBe(101);
    expect(await upgrade(s, {}, held)).toBe(429);
    expect(s.rooms.pendingFrom('127.0.0.1')).toBe(2);

    // A Hello moves the socket out of the pending set.
    const w = new BitWriter();
    writeHello(w, { version: PROTOCOL_VERSION, name: 'x', resumeToken: '', loadout: '' });
    held[0]!.send(w.finish().slice());
    await new Promise((r) => setTimeout(r, 50));
    expect(s.rooms.pendingFrom('127.0.0.1')).toBe(1);

    // The idle one is dropped by the hello timeout.
    const closed = new Promise<number>((r) => held[1]!.on('close', (code) => r(code)));
    expect(await closed).toBe(4000);
    expect(s.rooms.pendingFrom('127.0.0.1')).toBe(0);
    expect(await upgrade(s, {}, held)).toBe(101);
    for (const ws of held) ws.close();
  });

  it('does not let a forged X-Forwarded-For dodge the cap', async () => {
    const s = await start(PROD);
    const held: WebSocket[] = [];
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push(await upgrade(s, { 'x-forwarded-for': `198.51.100.${i}` }, held));
    expect(codes).toEqual([101, 101, 429]);
    for (const ws of held) ws.close();
  });

  it('keys on the address a trusted proxy appended', async () => {
    const s = await start({ ...PROD, trust: trustFunction(['127.0.0.1', '::1', '::ffff:127.0.0.1']) });
    const held: WebSocket[] = [];
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push(await upgrade(s, { 'x-forwarded-for': `6.6.6.${i}, 198.51.100.7` }, held));
    expect(codes).toEqual([101, 101, 429]);
    expect(await upgrade(s, { 'x-forwarded-for': '2001:db8::5' }, held)).toBe(101);
    expect(s.rooms.pendingFrom('198.51.100.7')).toBe(2);
    expect(s.rooms.pendingFrom('2001:db8::5')).toBe(1);
    for (const ws of held) ws.close();
  });
});

describe('development HTTP exposure', () => {
  it('keeps debug and monitoring open but caps the determinism probe', async () => {
    const s = await start(DEV_HTTP_POLICY, { realRapier: true });
    const probe = (await (await fetch(url(s, '/debug/determinism?steps=100000'))).json()) as {
      steps: number;
    };
    expect(probe.steps).toBe(MAX_DETERMINISM_STEPS);
    const odd = (await (await fetch(url(s, '/debug/determinism?steps=abc'))).json()) as { steps: number };
    expect(odd.steps).toBe(600);
    expect((await fetch(url(s, '/metrics'))).status).toBe(200);
    const cors = await fetch(url(s, '/health'), { headers: { origin: 'http://localhost:5173' } });
    expect(cors.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
