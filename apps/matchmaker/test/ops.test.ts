import { SignJWT } from 'jose';
import { runWithRequestId } from '@tumble/shared/request-id';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { ApiBanLookup } from '../src/bans.ts';
import { loadConfig } from '../src/config.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const SERVER = { authorization: `Bearer ${TEST_SECRETS.GAME_SERVER_SECRET}` };
let clock = Date.parse('2026-10-02T12:00:00Z');
let mm: MatchmakerApp | undefined;

afterEach(async () => {
  await mm?.close();
  mm = undefined;
});

async function build(env: Record<string, string> = {}): Promise<MatchmakerApp> {
  clock = Date.parse('2026-10-02T12:00:00Z');
  mm = await buildMatchmaker(loadConfig(testEnv(env)), { now: () => clock, logger: false });
  return mm;
}

function sign(sub: string, claims: Record<string, unknown>, ttl: number): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(enc(TEST_SECRETS.JWT_SECRET));
}

const access = (u: string) =>
  sign(u, { sid: 's', name: `${u}#0001`, region: 'na', guest: true, typ: 'access' }, 900);
const queueTicket = (u: string) =>
  sign(
    u,
    {
      typ: 'queue',
      pid: `solo:${u}`,
      leaderId: u,
      playlistId: 'main-show',
      queue: 'casual',
      teamSize: 1,
      maxPlayers: 40,
      minPlayers: 2,
      botsAllowed: true,
      region: 'na',
      members: [{ userId: u, name: `${u}#0001`, mu: 25, sigma: 8.3, ordinal: 0 }],
    },
    120,
  );

describe('matchmaker ops endpoints', () => {
  it('separates liveness from readiness', async () => {
    const m = await build();
    expect((await m.app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await m.app.inject({ url: '/ready' })).statusCode).toBe(200);
    m.ops.setDraining();
    expect((await m.app.inject({ url: '/ready' })).statusCode).toBe(503);
    expect((await m.app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('reports a broken store as not ready', async () => {
    const m = await build();
    vi.spyOn(m.store, 'get').mockRejectedValue(new Error('redis down'));
    const res = await m.app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe('redis down');
  });

  it('echoes and mints request ids', async () => {
    const m = await build();
    const kept = await m.app.inject({ url: '/health', headers: { 'x-request-id': 'abc-1' } });
    expect(kept.headers['x-request-id']).toBe('abc-1');
    const minted = await m.app.inject({ url: '/health', headers: { 'x-request-id': '<script>' } });
    expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exports queue depth, placements, time-to-match, servers and outbox backlog', async () => {
    const m = await build();
    const reg = await m.app.inject({
      method: 'POST',
      url: '/servers/register',
      headers: SERVER,
      payload: { serverId: 'gs-1', url: 'wss://gs-1.test/ws', region: 'na', capacity: 400 },
    });
    expect(reg.statusCode).toBe(200);
    const hb = await m.app.inject({
      method: 'POST',
      url: '/servers/heartbeat',
      headers: SERVER,
      payload: { serverId: 'gs-1', load: 0, outbox: 3 },
    });
    expect(hb.statusCode).toBe(200);
    for (const u of ['alice', 'bob']) {
      const res = await m.app.inject({
        method: 'POST',
        url: '/queue',
        headers: { authorization: `Bearer ${await access(u)}` },
        payload: { ticket: await queueTicket(u) },
      });
      expect(res.statusCode).toBe(200);
    }
    let text = (await m.app.inject({ url: '/metrics' })).body;
    expect(text).toContain('tumble_mm_queue_players{playlist="main-show",queue="casual",region="na"} 2');
    expect(text).toContain('tumble_mm_game_servers{region="na"} 1');
    expect(text).toContain('tumble_mm_server_seats{kind="capacity",region="na"} 400');
    expect(text).toContain('tumble_gameserver_outbox_backlog{server="gs-1"} 3');

    clock += 25_000;
    await m.mm.heartbeat('gs-1', 0);
    expect(await m.mm.tick()).toHaveLength(1);
    text = (await m.app.inject({ url: '/metrics' })).body;
    expect(text).toContain('tumble_mm_placements_total{queue="casual",region="na"} 1');
    expect(text).toContain('tumble_mm_time_to_match_seconds_count{queue="casual"} 2');
    expect(text).toContain('tumble_mm_time_to_match_seconds_bucket{le="30",queue="casual"} 2');
    expect(text).toContain('tumble_mm_time_to_match_seconds_bucket{le="20",queue="casual"} 0');
    expect(text).toContain('route="/queue",status="200"');

    await m.app.inject({ method: 'DELETE', url: '/servers/gs-1', headers: SERVER });
    text = (await m.app.inject({ url: '/metrics' })).body;
    expect(text).not.toContain('tumble_gameserver_outbox_backlog{server="gs-1"}');
  });

  it('guards /metrics with the token, and hides it in production without one', async () => {
    const m = await build({ METRICS_TOKEN: 'scrape-0123456789ab' });
    expect((await m.app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect(
      (await m.app.inject({ url: '/metrics', headers: { authorization: 'Bearer scrape-0123456789ab' } }))
        .statusCode,
    ).toBe(200);
    await m.close();
    mm = await buildMatchmaker(
      loadConfig(
        testEnv({ NODE_ENV: 'production', ALLOW_MEMORY_STORE: '1', API_URL: '', ALLOW_STANDALONE: '1' }),
      ),
      { now: () => clock, logger: false },
    );
    expect((await mm.app.inject({ url: '/metrics' })).statusCode).toBe(404);
  });
});

describe('request id propagation', () => {
  it('forwards the current request id on ban lookups', async () => {
    const seen: (string | null)[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-request-id'));
      return Response.json({ bans: {} });
    }) as unknown as typeof fetch;
    const bans = new ApiBanLookup({ apiUrl: 'http://api.test', secret: 'x'.repeat(32), fetch: fetchFn });
    await runWithRequestId('req-42', () => bans.scopes(['u1']));
    await bans.scopes(['u2']);
    expect(seen).toEqual(['req-42', null]);
  });
});
