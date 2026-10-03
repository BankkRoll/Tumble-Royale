import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const SERVER_SECRET = 'test-server-secret-0123456789';
let mmApp: MatchmakerApp;

beforeEach(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijkl',
    GAME_TICKET_SECRET: 'test-ticket-secret-0123456789',
    GAME_SERVER_SECRET: SERVER_SECRET,
    LOG_LEVEL: 'silent',
  });
  mmApp = await buildMatchmaker(cfg, { logger: false });
});
afterEach(async () => {
  await mmApp.close();
});

describe('GET /ping', () => {
  it('answers without auth, uncached, listing regions with live servers', async () => {
    for (const [id, region] of [
      ['gs-eu', 'eu'],
      ['gs-na', 'na'],
      ['gs-na2', 'na'],
    ] as const) {
      const res = await mmApp.app.inject({
        method: 'POST',
        url: '/servers/register',
        headers: { authorization: `Bearer ${SERVER_SECRET}` },
        payload: { serverId: id, url: `wss://${id}.test`, region, capacity: 40 },
      });
      expect(res.statusCode).toBe(200);
    }
    const res = await mmApp.app.inject({ method: 'GET', url: '/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ ok: true, regions: ['eu', 'na'] });
  });
});
