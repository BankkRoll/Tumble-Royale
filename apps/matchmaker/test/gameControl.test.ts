import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { controlBase, httpGameControl, type MatchTarget } from '../src/gameControl.ts';
import type { GameServer } from '../src/servers.ts';

const server = (controlUrl?: string): GameServer => ({
  id: 'gs-1',
  url: 'wss://ignored.example/ws',
  region: 'na',
  capacity: 400,
  load: 0,
  lastSeen: 0,
  ...(controlUrl ? { controlUrl } : {}),
});

const target = (serverUrl: string, controlUrl?: string): MatchTarget => ({
  matchId: 'm_1',
  serverUrl,
  server: controlUrl === undefined ? null : server(controlUrl),
});

describe('controlBase', () => {
  it.each([
    ['wss://gs.example/ws', 'https://gs.example'],
    ['wss://gs.example/ws/', 'https://gs.example'],
    ['ws://gs.test:7350/ws', 'http://gs.test:7350'],
    ['ws://localhost:7350', 'http://localhost:7350'],
    ['ws://localhost:7350/', 'http://localhost:7350'],
    // Behind a path-routing proxy the prefix must survive, or the kick hits the static host.
    ['wss://play.example/gs/ws', 'https://play.example/gs'],
    ['wss://play.example/gs/ws/', 'https://play.example/gs'],
    ['wss://play.example/eu/gs-2/ws', 'https://play.example/eu/gs-2'],
    ['wss://play.example/gs/ws?region=eu#x', 'https://play.example/gs'],
    // Only a trailing /ws segment is a socket path.
    ['wss://play.example/news', 'https://play.example/news'],
    ['wss://play.example/ws/gs', 'https://play.example/ws/gs'],
  ])('derives %s → %s', (url, base) => {
    expect(controlBase(target(url))).toBe(base);
  });

  it.each([
    ['https://gs-1.internal:7350', 'https://gs-1.internal:7350'],
    ['https://gs-1.internal:7350/', 'https://gs-1.internal:7350'],
    ['http://10.0.0.5:7351/control/', 'http://10.0.0.5:7351/control'],
    // An explicit CONTROL_URL is taken as is: no /ws stripping.
    ['https://ops.example/ws', 'https://ops.example/ws'],
  ])('prefers the registered CONTROL_URL %s', (controlUrl, base) => {
    expect(controlBase(target('wss://play.example/gs/ws', controlUrl))).toBe(base);
  });

  it('rejects unusable URLs', () => {
    expect(controlBase(target('not a url'))).toBeNull();
    expect(controlBase(target('ftp://gs.example/ws'))).toBeNull();
    expect(controlBase(target('wss://gs.example/ws', 'ftp://ops.example'))).toBeNull();
  });
});

describe('httpGameControl', () => {
  it('signs timestamp, a fresh nonce and the body, and posts to the prefixed path', async () => {
    const secret = 'test-game-server-secret-0123456789';
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const control = httpGameControl(secret, () => 1_000, fetchFn);
    expect(await control.kick(target('wss://play.example/gs/ws'), 'u1')).toBe(true);
    expect(await control.kick(target('wss://play.example/gs/ws'), 'u1')).toBe(true);

    expect(calls[0]!.url).toBe('https://play.example/gs/internal/kick');
    const h = calls[0]!.headers;
    expect(h['x-tumble-ts']).toBe('1000');
    expect(h['x-tumble-nonce']).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const want = createHmac('sha256', secret)
      .update(`1000.${h['x-tumble-nonce']}.${calls[0]!.body}`)
      .digest('hex');
    expect(h['x-tumble-sig']).toBe(want);
    // Identical kicks in the same millisecond still differ, so neither looks like a replay.
    expect(calls[1]!.headers['x-tumble-nonce']).not.toBe(h['x-tumble-nonce']);
  });

  it('reports failure on errors and unusable targets', async () => {
    const down = httpGameControl('s'.repeat(32), Date.now, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    expect(await down.kick(target('wss://gs.example/ws'), 'u1')).toBe(false);
    expect(await down.kick(target('nope'), 'u1')).toBe(false);
  });
});
