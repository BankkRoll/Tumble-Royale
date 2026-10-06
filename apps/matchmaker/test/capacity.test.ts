/**
 * `GET /internal/capacity`: per-region game-server capacity for the API's
 * public status page, signed with `INTERNAL_HMAC_SECRET`, counts only.
 */
import { signInternal, STATIC_LIVEOPS } from '@tumble/shared/liveops-client';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_BANS } from '../src/bans.ts';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { capacityByRegion, type GameServer } from '../src/servers.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

const NOW = Date.parse('2026-10-02T12:00:00Z');

let mm: MatchmakerApp | undefined;
afterEach(async () => {
  await mm?.close();
  mm = undefined;
});

async function build(env: Record<string, string> = { API_URL: 'http://api.test' }) {
  mm = await buildMatchmaker(loadConfig(testEnv(env)), {
    now: () => NOW,
    logger: false,
    liveOps: STATIC_LIVEOPS,
    bans: NO_BANS,
  });
  return mm;
}

async function register(app: MatchmakerApp, id: string, region: string, capacity: number) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/servers/register',
    headers: {
      authorization: `Bearer ${TEST_SECRETS.GAME_SERVER_SECRET}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ serverId: id, url: `wss://${id}.internal.test`, region, capacity, load: 10 }),
  });
  expect(res.statusCode).toBe(200);
}

const signed = (secret: string = TEST_SECRETS.INTERNAL_HMAC_SECRET, at = NOW) => signInternal(secret, '', at);

describe('capacityByRegion', () => {
  it('sums live servers per region and caps load at capacity', () => {
    const s = (id: string, region: string, capacity: number, load: number): GameServer => ({
      id,
      url: `wss://${id}`,
      region,
      capacity,
      load,
      lastSeen: 0,
    });
    expect(capacityByRegion([s('a', 'eu', 100, 20), s('b', 'na', 50, 80), s('c', 'eu', 100, 30)])).toEqual([
      { region: 'eu', servers: 2, capacity: 200, load: 50 },
      { region: 'na', servers: 1, capacity: 50, load: 50 },
    ]);
  });
});

describe('GET /internal/capacity', () => {
  it('answers a signed request with counts per region and nothing about individual servers', async () => {
    const app = await build();
    await register(app, 'gs-eu-1', 'eu', 100);
    await register(app, 'gs-na-1', 'na', 60);
    const res = await app.app.inject({ method: 'GET', url: '/internal/capacity', headers: signed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      regions: [
        { region: 'eu', servers: 1, capacity: 100, load: 10 },
        { region: 'na', servers: 1, capacity: 60, load: 10 },
      ],
    });
    expect(res.body).not.toContain('internal.test');
    expect(res.body).not.toContain('gs-eu-1');
  });

  it('refuses unsigned, wrongly signed and stale requests', async () => {
    const app = await build();
    const get = (headers: Record<string, string>) =>
      app.app.inject({ method: 'GET', url: '/internal/capacity', headers });
    expect((await get({})).statusCode).toBe(401);
    expect((await get(signed('another-secret-0123456789'))).statusCode).toBe(401);
    expect((await get(signed(undefined, NOW - 10 * 60_000))).statusCode).toBe(401);
  });

  it('does not exist when the matchmaker has no internal secret', async () => {
    const app = await build({});
    const res = await app.app.inject({ method: 'GET', url: '/internal/capacity', headers: signed() });
    expect(res.statusCode).toBe(404);
  });
});
