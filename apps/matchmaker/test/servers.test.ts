import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RESERVATION_TTL_MS, userChannel, type MMEvent } from '../src/matchmaker.ts';
import { candidateRegions, pickServer, type GameServer } from '../src/servers.ts';

const JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijkl';
const SERVER_SECRET = 'test-server-secret-0123456789';
const enc = (s: string) => new TextEncoder().encode(s);

describe('pickServer', () => {
  const srv = (id: string, region: string, over: Partial<GameServer> = {}): GameServer => ({
    id,
    url: `wss://${id}`,
    region,
    capacity: 100,
    load: 0,
    lastSeen: 0,
    ...over,
  });

  it('tries regions in order and skips full, room-capped and dead servers', () => {
    const servers = [
      srv('na-full', 'na', { load: 90 }),
      srv('na-rooms', 'na', { maxRooms: 2, rooms: 2 }),
      srv('na-dead', 'na', { lastSeen: -60_000 }),
      srv('eu-busy', 'eu', { load: 50 }),
      srv('eu-idle', 'eu', { load: 10 }),
    ];
    expect(pickServer(servers, 'na', 40, 0)).toBeNull();
    expect(pickServer(servers, ['na', 'eu'], 40, 0)?.id).toBe('eu-idle');
    // The home region wins whenever anything there fits.
    expect(pickServer(servers, ['na', 'eu'], 5, 0)?.id).toBe('na-full');
    expect(pickServer([srv('na-ok', 'na', { maxRooms: 2, rooms: 1 })], 'na', 40, 0)?.id).toBe('na-ok');
  });

  it('orders fallback regions nearest first, then anything else that is live', () => {
    expect(candidateRegions('na', false)).toEqual(['na']);
    expect(candidateRegions('oce', true).slice(0, 3)).toEqual(['oce', 'asia', 'na']);
    expect(candidateRegions('mars', true, ['eu', 'na'])).toEqual(['mars', 'eu', 'na']);
  });
});

describe('placement', () => {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  let mm: MatchmakerApp;
  const reports = new Map<string, { load: number; rooms?: number; matches?: string[] }>();

  beforeEach(async () => {
    clock = Date.parse('2026-10-02T12:00:00Z');
    reports.clear();
    mm = await buildMatchmaker(
      loadConfig({ NODE_ENV: 'test', JWT_SECRET, GAME_SERVER_SECRET: SERVER_SECRET, LOG_LEVEL: 'silent' }),
      { now: () => clock, logger: false },
    );
  });
  afterEach(async () => {
    await mm.close();
  });

  async function register(id: string, region: string, capacity: number, maxRooms?: number) {
    const res = await mm.app.inject({
      method: 'POST',
      url: '/servers/register',
      headers: { authorization: `Bearer ${SERVER_SECRET}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ serverId: id, url: `wss://${id}.test`, region, capacity, maxRooms }),
    });
    expect(res.statusCode).toBe(200);
    reports.set(id, { load: 0, rooms: 0, matches: [] });
  }

  /** Advances time while every server keeps heartbeating its current report. */
  async function advance(ms: number) {
    clock += ms;
    for (const [id, r] of reports) {
      const res = await mm.app.inject({
        method: 'POST',
        url: '/servers/heartbeat',
        headers: { authorization: `Bearer ${SERVER_SECRET}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ serverId: id, ...r }),
      });
      expect(res.statusCode).toBe(200);
    }
  }

  async function queue(userId: string, region = 'na') {
    const iat = Math.floor(clock / 1000);
    const token = await new SignJWT({ sid: 's', name: `${userId}#1`, region, guest: true, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('tumble-api')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(enc(JWT_SECRET));
    const ticket = await new SignJWT({
      typ: 'queue',
      pid: `solo:${userId}`,
      leaderId: userId,
      playlistId: 'main-show',
      queue: 'casual',
      teamSize: 1,
      maxPlayers: 40,
      minPlayers: 1,
      botsAllowed: true,
      region,
      members: [{ userId, name: `${userId}#1`, mu: 25, sigma: 8, ordinal: 0 }],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('tumble-api')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 120)
      .sign(enc(JWT_SECRET));
    const events: MMEvent[] = [];
    await mm.store.subscribe(userChannel(userId), (m) => events.push(JSON.parse(m) as MMEvent));
    const res = await mm.app.inject({
      method: 'POST',
      url: '/queue',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ ticket }),
    });
    expect(res.statusCode).toBe(200);
    return events;
  }

  it('keeps seats reserved across heartbeats until the server reports the match', async () => {
    await register('gs', 'na', 60);
    await queue('a');
    await advance(25_000);
    const [first] = await mm.mm.tick();
    expect(first?.serverId).toBe('gs');

    // The room does not exist yet, so the server still reports nothing; the reservation must hold.
    const waiting = await queue('b');
    await advance(25_000);
    expect(await mm.mm.tick()).toHaveLength(0);
    expect(waiting).toContainEqual({ type: 'waiting_for_server', region: 'na', otherRegions: false });

    // The room is up: its 40 seats are now in the reported load and the reservation is released.
    reports.set('gs', { load: 40, rooms: 1, matches: [first!.matchId] });
    await advance(1000);
    expect((await mm.mm.effectiveServers())[0]).toMatchObject({ load: 40, rooms: 1 });
    expect(await mm.mm.tick()).toHaveLength(0);

    // The show ends and the room closes.
    reports.set('gs', { load: 0, rooms: 0, matches: [] });
    await advance(1000);
    expect(await mm.mm.tick()).toHaveLength(1);
  });

  it('expires reservations whose players never reached the server', async () => {
    await register('gs', 'na', 60);
    await queue('a');
    await advance(25_000);
    expect(await mm.mm.tick()).toHaveLength(1);
    expect((await mm.mm.effectiveServers())[0]!.load).toBe(40);
    await advance(RESERVATION_TTL_MS + 1000);
    expect((await mm.mm.effectiveServers())[0]!.load).toBe(0);
  });

  it('respects the room cap a server reports', async () => {
    await register('gs', 'na', 400, 1);
    await queue('a');
    await queue('b', 'na');
    await advance(25_000);
    // Both entries form one lobby; a second lobby needs a second room.
    expect(await mm.mm.tick()).toHaveLength(1);
    await queue('c');
    await advance(25_000);
    expect(await mm.mm.tick()).toHaveLength(0);
  });

  it('falls back to the nearest region with room after REGION_FALLBACK_MS and says so', async () => {
    await register('eu-1', 'eu', 400);
    await register('asia-1', 'asia', 400);
    const events = await queue('a', 'na');
    await advance(25_000);
    expect(await mm.mm.tick()).toHaveLength(0);
    await advance(500);
    expect(await mm.mm.tick()).toHaveLength(0);
    expect(events.filter((e) => e.type === 'waiting_for_server')).toEqual([
      { type: 'waiting_for_server', region: 'na', otherRegions: false },
    ]);
    await advance(10_000);
    const [placed] = await mm.mm.tick();
    expect(placed?.serverId).toBe('eu-1');
    const found = events.find((e) => e.type === 'match_found');
    expect(found?.type === 'match_found' && found.server.region).toBe('eu');
  });

  it('tells players once when it starts looking in other regions', async () => {
    await register('eu-full', 'eu', 10);
    const events = await queue('a', 'na');
    await advance(25_000);
    await mm.mm.tick();
    await advance(10_000);
    await mm.mm.tick();
    await advance(1000);
    await mm.mm.tick();
    expect(events.filter((e) => e.type === 'waiting_for_server')).toEqual([
      { type: 'waiting_for_server', region: 'na', otherRegions: false },
      { type: 'waiting_for_server', region: 'na', otherRegions: true },
    ]);
  });
});
