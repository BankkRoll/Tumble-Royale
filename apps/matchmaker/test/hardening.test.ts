import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMatchmaker, MAX_SOCKETS_PER_USER, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SharedRateLimiter } from '../src/rateLimit.ts';
import { MemoryStore } from '../src/store.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

const JWT_SECRET = TEST_SECRETS.JWT_SECRET;
const SERVER_SECRET = TEST_SECRETS.GAME_SERVER_SECRET;
const clock = Date.parse('2026-10-02T12:00:00Z');
let mm: MatchmakerApp | undefined;

afterEach(async () => {
  await mm?.close();
  mm = undefined;
});

async function build(env: Record<string, string> = {}): Promise<MatchmakerApp> {
  mm = await buildMatchmaker(loadConfig(testEnv(env)), { now: () => clock, logger: false });
  return mm;
}

function access(userId: string): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({ sid: 's', name: `${userId}#0001`, region: 'na', guest: true, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe('CORS', () => {
  it('only answers configured origins', async () => {
    const app = (await build({ ALLOWED_ORIGINS: 'https://play.example.com, https://beta.example.com/' })).app;
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/queue',
      headers: { origin: 'https://beta.example.com' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://beta.example.com');

    const evilPreflight = await app.inject({
      method: 'OPTIONS',
      url: '/queue',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evilPreflight.statusCode).toBe(403);
    const evilGet = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evilGet.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('limits requests per IP', async () => {
    const app = (await build({ RATE_LIMIT_MAX: '3' })).app;
    const token = await access('alice');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (
          await app.inject({
            method: 'GET',
            url: '/queue/status',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // Game servers are authenticated by secret and not throttled per IP.
    const hb = await app.inject({
      method: 'POST',
      url: '/servers/register',
      headers: { authorization: `Bearer ${SERVER_SECRET}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ serverId: 'gs', url: 'wss://gs.test', region: 'na', capacity: 40 }),
    });
    expect(hb.statusCode).toBe(200);
  });

  it('limits queue and lobby mutations per player', async () => {
    const app = (await build({ USER_RATE_LIMIT_MAX: '2' })).app;
    const post = async (user: string, ip: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/lobbies',
          remoteAddress: ip,
          headers: { authorization: `Bearer ${await access(user)}`, 'content-type': 'application/json' },
          payload: '{}',
        })
      ).statusCode;
    expect([await post('alice', '10.0.0.1'), await post('alice', '10.0.0.2')]).toEqual([200, 200]);
    // A new address does not reset the player's budget.
    expect(await post('alice', '10.0.0.3')).toBe(429);
    expect(await post('bob', '10.0.0.3')).toBe(200);
  });
});

describe('client address and shared limits', () => {
  const hit = (app: MatchmakerApp['app'], remoteAddress: string, xff?: string) =>
    app
      .inject({
        method: 'GET',
        url: '/stats',
        remoteAddress,
        ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
      })
      .then((r) => r.statusCode);

  it('ignores X-Forwarded-For by default, so a forged header cannot reset the limit', async () => {
    const app = (await build({ RATE_LIMIT_MAX: '2' })).app;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await hit(app, '203.0.113.5', `198.51.100.${i}`));
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it('with TRUST_PROXY hops, keys on the address the trusted proxy appended', async () => {
    const app = (await build({ RATE_LIMIT_MAX: '2', TRUST_PROXY: '1' })).app;
    // The client forges different left-most entries; the load balancer appends the real one.
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push(await hit(app, '10.0.0.2', `6.6.6.${i}, 198.51.100.7`));
    expect(codes).toEqual([200, 200, 429]);
    // Another real client behind the same proxy has its own budget, IPv6 included.
    expect(await hit(app, '10.0.0.2', '2001:db8::1')).toBe(200);
  });

  it('with a CIDR list, believes only chained proxies inside it', async () => {
    const app = (await build({ RATE_LIMIT_MAX: '1', TRUST_PROXY: '10.0.0.0/8,fd00::/8' })).app;
    expect(await hit(app, 'fd00::9', '198.51.100.7, 10.1.1.1')).toBe(200);
    expect(await hit(app, '10.0.0.2', '6.6.6.6, 198.51.100.7, 10.1.1.1')).toBe(429);
    // Straight from the internet: the header is not believed.
    expect(await hit(app, '198.51.100.8', '10.9.9.9')).toBe(200);
    expect(await hit(app, '198.51.100.8', '10.9.9.10')).toBe(429);
  });

  it('refuses TRUST_PROXY=true at boot', () => {
    expect(() => loadConfig(testEnv({ TRUST_PROXY: 'true' }))).toThrow(/TRUST_PROXY/);
  });

  it('shares one window across instances on the same store', async () => {
    const store = new MemoryStore(() => clock);
    const cfg = loadConfig(testEnv({ RATE_LIMIT_MAX: '3' }));
    const a = await buildMatchmaker(cfg, { now: () => clock, logger: false, store });
    const b = await buildMatchmaker(cfg, { now: () => clock, logger: false, store });
    try {
      const codes = [];
      for (const app of [a, b, a, b]) codes.push(await hit(app.app, '203.0.113.5'));
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await a.app.close();
      await b.close();
    }
  });

  it('rejects WebSocket upgrades over the limit even with forged forwarding headers', async () => {
    const built = await build({ RATE_LIMIT_MAX: '2' });
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (built.app.server.address() as AddressInfo).port;
    const token = await access('alice');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        await new Promise<number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
            headers: { 'x-forwarded-for': `198.51.100.${i}` },
          });
          ws.on('open', () => {
            ws.close();
            resolve(101);
          });
          ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
          ws.on('error', () => undefined);
        }),
      );
    }
    expect(statuses).toEqual([101, 101, 429]);
  });

  it('caps open status sockets per account and frees a slot when one closes', async () => {
    const built = await build({ RATE_LIMIT_MAX: '1000' });
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (built.app.server.address() as AddressInfo).port;
    const open = (token: string) =>
      new Promise<{ status: number; ws: WebSocket }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
        ws.on('open', () => resolve({ status: 101, ws }));
        ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, ws }));
        ws.on('error', () => undefined);
      });
    const alice = await access('alice');
    const held = [];
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) held.push(await open(alice));
    expect(held.map((h) => h.status)).toEqual(held.map(() => 101));
    expect((await open(alice)).status).toBe(429);
    expect((await open(await access('bob'))).status).toBe(101);
    const first = held[0]!.ws;
    await new Promise((r) => {
      first.once('close', r);
      first.close();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await open(alice)).status).toBe(101);
  });
});

describe('shared limiter', () => {
  it('stops consulting the store once the local window is full, and fails open to it', async () => {
    let t = 0;
    const store = new MemoryStore(() => t);
    let calls = 0;
    const counting = Object.assign(Object.create(store) as MemoryStore, {
      hitWindow: (k: string, w: number) => {
        calls++;
        return store.hitWindow(k, w);
      },
    });
    const limiter = new SharedRateLimiter(counting, 'rl:t', 2, 1000, () => t);
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await limiter.hit('k')).allowed);
    expect(results).toEqual([true, true, false, false, false]);
    expect(calls).toBe(2);
    t = 1000;
    expect((await limiter.hit('k')).allowed).toBe(true);

    const errors: unknown[] = [];
    const broken = Object.assign(Object.create(store) as MemoryStore, {
      hitWindow: () => Promise.reject(new Error('redis down')),
    });
    const fallback = new SharedRateLimiter(
      broken,
      'rl:t',
      1,
      1000,
      () => t,
      (e) => errors.push(e),
    );
    expect((await fallback.hit('x')).allowed).toBe(true);
    expect((await fallback.hit('x')).allowed).toBe(false);
    expect(errors).toHaveLength(1);
  });
});
