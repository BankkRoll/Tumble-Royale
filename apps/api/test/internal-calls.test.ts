/**
 * Service-to-service trust: signatures bound to method and path, the narrow
 * game-server key, results checked against the matchmaker's placement, the
 * KV lock primitives and the error shapes clients see.
 */
import { createHmac } from 'node:crypto';
import { signInternal, verifyInternal } from '@tumble/shared/liveops-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryKV, withLock, type KV } from '../src/kv/index.ts';
import { ApiError } from '../src/http/errors.ts';
import { runRetention } from '../src/ops/retention.ts';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';

const GAME_KEY = 'game-server-only-key-0123456789';
const MM_URL = 'http://mm.test';

let api: TestApi | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await api?.close();
  api = undefined;
});

/** Posts `body` to `url` signed with `secret` for `signedPath` (v2 unless `legacy`). */
function signedPost(
  app: TestApi,
  url: string,
  body: unknown,
  secret: string,
  signedPath = url,
  legacy = false,
) {
  const raw = JSON.stringify(body);
  const now = app.clock.now().getTime();
  let headers: Record<string, string> = signInternal(secret, raw, now, { method: 'POST', path: signedPath });
  if (legacy) {
    const ts = String(now);
    const nonce = 'legacy-nonce-0123456789';
    headers = {
      'x-tumble-timestamp': ts,
      'x-tumble-nonce': nonce,
      'x-tumble-signature': createHmac('sha256', secret).update(`${ts}.${nonce}.${raw}`).digest('hex'),
    };
  }
  return app.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: raw,
  });
}

describe('internal signatures', () => {
  it('bind the method and path: a signature for one endpoint is refused on another', async () => {
    api = await createTestApi();
    const secret = api.ctx.config.internalHmacSecret;
    expect((await signedPost(api, '/internal/liveops', {}, secret)).statusCode).toBe(200);
    const moved = await signedPost(
      api,
      '/internal/bans/lookup',
      { userIds: [] },
      secret,
      '/internal/liveops',
    );
    expect(moved.statusCode).toBe(401);
    expect(moved.json().error).toBe('bad_signature');
  });

  it('refuse the legacy scheme unless INTERNAL_HMAC_ALLOW_V1 is set', async () => {
    api = await createTestApi();
    const secret = api.ctx.config.internalHmacSecret;
    expect((await signedPost(api, '/internal/liveops', {}, secret, undefined, true)).statusCode).toBe(401);
    await api.close();
    api = await createTestApi(undefined, { INTERNAL_HMAC_ALLOW_V1: '1' });
    expect((await signedPost(api, '/internal/liveops', {}, secret, undefined, true)).statusCode).toBe(200);
  });

  it('accept the game-server key only on the routes game servers call', async () => {
    api = await createTestApi(undefined, { GAME_SERVER_HMAC_SECRET: GAME_KEY });
    expect((await signedPost(api, '/internal/liveops', {}, GAME_KEY)).statusCode).toBe(200);
    const u = await api.guest();
    const show = buildShow({ humans: [{ userId: u.id, placement: 1 }] });
    expect((await signedPost(api, '/internal/match-results', show, GAME_KEY)).statusCode).toBe(200);
    const bans = await signedPost(api, '/internal/bans/lookup', { userIds: [u.id] }, GAME_KEY);
    expect(bans.statusCode).toBe(401);
    expect(
      (await signedPost(api, '/internal/bans/lookup', { userIds: [u.id] }, api.ctx.config.internalHmacSecret))
        .statusCode,
    ).toBe(200);
  });
});

describe('match results checked against the matchmaker placement', () => {
  /** A matchmaker double that answers placement lookups (and checks they are signed). */
  function matchmaker(placements: Record<string, unknown>, secret: () => string) {
    const asked: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const m = /^\/internal\/matches\/([^/]+)\/placement$/.exec(url.pathname);
      if (url.origin !== MM_URL || !m) return new Response('{}', { status: 404 });
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      if (
        !verifyInternal(secret(), headers, '', Number(headers['x-tumble-timestamp'] ?? 0), {
          method: 'GET',
          path: url.pathname,
        })
      )
        return new Response('{}', { status: 401 });
      asked.push(m[1]!);
      const p = placements[m[1]!];
      return p ? Response.json(p) : new Response('{}', { status: 404 });
    };
    return { fetch: fetchFn, asked };
  }

  const placed = (matchId: string, players: string[], over: Record<string, unknown> = {}) => ({
    matchId,
    serverId: 'gs-1',
    queue: 'casual',
    playlistId: 'main-show',
    players,
    spectators: [],
    ...over,
  });

  it('refuses invented matches, another server, another queue and strangers, before granting anything', async () => {
    let placements: Record<string, unknown> = {};
    let secret = '';
    const mm = matchmaker(new Proxy({}, { get: (_t, k) => placements[String(k)] }), () => secret);
    api = await createTestApi(undefined, { MATCHMAKER_URL: MM_URL }, { fetch: mm.fetch });
    secret = api.ctx.config.internalHmacSecret;
    const a = await api.guest();
    const b = await api.guest();
    const show = (matchId: string, serverId?: string) => ({
      ...buildShow({
        matchId,
        humans: [
          { userId: a.id, placement: 1 },
          { userId: b.id, placement: 2 },
        ],
      }),
      ...(serverId ? { serverId } : {}),
    });
    placements = {
      m_wrong_server: placed('m_wrong_server', [a.id, b.id]),
      m_wrong_queue: placed('m_wrong_queue', [a.id, b.id], { queue: 'ranked' }),
      m_stranger: placed('m_stranger', [a.id]),
      m_good: placed('m_good', [a.id, b.id]),
    };
    const code = async (matchId: string, serverId?: string) => {
      const res = await api!.postMatch(show(matchId, serverId));
      return [res.statusCode, res.json().error ?? 'ok'];
    };
    expect(await code('m_invented', 'gs-1')).toEqual([422, 'unknown_match']);
    expect(await code('m_wrong_server', 'gs-2')).toEqual([422, 'wrong_server']);
    expect(await code('m_wrong_server')).toEqual([422, 'wrong_server']);
    expect(await code('m_wrong_queue', 'gs-1')).toEqual([422, 'wrong_queue']);
    expect(await code('m_stranger', 'gs-1')).toEqual([422, 'not_placed']);
    const me = (await api.req('GET', '/me', { token: a.accessToken })).json();
    expect(me.stats.showsPlayed).toBe(0);
    expect(await code('m_good', 'gs-1')).toEqual([200, 'ok']);
    // A replay of a stored show does not ask again (the placement may be long gone).
    const asked = mm.asked.length;
    placements = {};
    expect(await code('m_good', 'gs-1')).toEqual([200, 'ok']);
    expect(mm.asked.length).toBe(asked);
  });

  it('asks the game server to retry while the matchmaker cannot be reached', async () => {
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    api = await createTestApi(undefined, { MATCHMAKER_URL: MM_URL }, { fetch: down });
    const u = await api.guest();
    const res = await api.postMatch({
      ...buildShow({ matchId: 'm_mm_down', humans: [{ userId: u.id, placement: 1 }] }),
      serverId: 'gs-1',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('placement_unavailable');
  });
});

describe('withLock', () => {
  it('answers 503 busy when the lock stays taken', async () => {
    const kv = new MemoryKV();
    await kv.setNX('lock:party:p1', 'someone-else', 60_000);
    const err = await withLock(kv, 'party:p1', async () => 'never').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).code).toBe('busy');
  });

  it("keeps the lock while a slow critical section runs and never deletes a later holder's lock", async () => {
    let now = 1_000_000;
    const kv = new MemoryKV(() => now);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const run = withLock(kv, 'party:p2', () => slow);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      now += 1500;
      await vi.advanceTimersByTimeAsync(1700);
    }
    // 9 s in: the 5 s lock was renewed, so nobody else got in.
    expect(await kv.setNX('lock:party:p2', 'intruder', 5000)).toBe(false);
    // The holder loses the lock anyway (renewals stop reaching it); another instance takes it.
    await kv.set('lock:party:p2', 'next-holder', 5000);
    release();
    await run;
    expect(await kv.get('lock:party:p2')).toBe('next-holder');
  });

  it("releases atomically: compare-and-delete only removes the holder's own value", async () => {
    const kv = new MemoryKV();
    await kv.set('k', 'mine', 5000);
    expect(await kv.delIfEquals('k', 'theirs')).toBe(false);
    expect(await kv.expireIfEquals('k', 'theirs', 60_000)).toBe(false);
    expect(await kv.delIfEquals('k', 'mine')).toBe(true);
    expect(await kv.get('k')).toBeNull();
  });
});

describe('retention lock', () => {
  it('does not delete a lock another instance took while the run was finishing', async () => {
    api = await createTestApi(undefined, {}, { memoryKv: true });
    const kv = api.ctx.kv;
    // Between the owner's last check and its release, the lock changes hands
    // (it expired and another instance took it). A get-then-del release
    // would delete the newcomer's lock.
    const handover: KV = Object.create(kv) as KV;
    handover.get = async (key: string) => {
      const v = await kv.get(key);
      if (key === 'ops:retention:lock' && v !== null) await kv.set(key, 'other-instance', 60_000);
      return v;
    };
    handover.delIfEquals = async (key: string, value: string) => {
      if (key === 'ops:retention:lock') await kv.set(key, 'other-instance', 60_000);
      return kv.delIfEquals(key, value);
    };
    const r = await runRetention({ ...api.ctx, kv: handover }, api.ctx.config.ops.retention);
    expect(r.ran).toBe(true);
    expect(await kv.get('ops:retention:lock')).toBe('other-instance');
  });
});

describe('error shapes', () => {
  it("maps Fastify's own errors to stable codes instead of FST_* internals", async () => {
    api = await createTestApi();
    api.app.post(
      '/__probe/schema',
      { schema: { body: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } } },
      async () => ({ ok: true }),
    );
    api.app.get('/__probe/unavailable', async () => {
      throw Object.assign(new Error('pool exhausted: 10 of 10 connections busy'), { statusCode: 503 });
    });
    const invalid = await api.app.inject({ method: 'POST', url: '/__probe/schema', payload: { n: 'x' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: 'bad_request',
      details: [{ path: 'n', message: expect.any(String) }],
    });
    const unavailable = await api.app.inject({ method: 'GET', url: '/__probe/unavailable' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: 'unavailable',
      message: 'Temporarily unavailable; try again shortly',
    });
    const badJson = await api.app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error).not.toMatch(/^FST_/);
    const media = await api.app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: { 'content-type': 'application/x-tumble' },
      payload: 'x',
    });
    expect(media.statusCode).toBe(415);
    expect(media.json().error).toBe('unsupported_media_type');
  });
});
