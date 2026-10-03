import { describe, expect, it } from 'vitest';
import { capacityConfig, linkConfig } from '../src/config.ts';
import { startMatchmakerLink } from '../src/matchmakerLink.ts';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager, type TicketPolicy } from '../src/room/RoomManager.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const SECRET = 'test-ticket-secret-0123456789';
const WALL = Date.parse('2026-10-02T12:00:00Z');

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_capacity_match',
    sid: 'gs-a',
    pid: `solo:${sub}`,
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'casual',
    region: 'na',
    size: 40,
    humans: 2,
    bots: 38,
    teamSize: 1,
    ...over,
  };
}

function setup(policy: Partial<TicketPolicy> = {}) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const manager = new RoomManager(testDeps(clock, sims), new ServerMetrics(), null, {
    config: { capacity: 40, fillWaitMs: 60_000, startAtHumans: 40, ticketedFillWaitMs: 60_000 },
    profileLogMs: 0,
    maxRooms: 3,
    tickets: { secret: SECRET, allowUnticketed: true, now: () => WALL, ...policy },
  });
  const connect = (ticket: string): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello('client', '', ticket);
    c.pump(clock.now);
    return c;
  };
  return { manager, connect };
}

describe('capacity config', () => {
  it('keeps the seat and room limits consistent by default', () => {
    expect(capacityConfig({})).toEqual({ roomCapacity: 40, maxRooms: 10, serverCapacity: 400 });
    expect(capacityConfig({ MAX_ROOMS: '4', ROOM_CAPACITY: '20' }).serverCapacity).toBe(80);
    expect(capacityConfig({ SERVER_CAPACITY: '120' }).serverCapacity).toBe(120);
  });

  it('only links to the matchmaker when both URL and secret are set', () => {
    expect(linkConfig({ MATCHMAKER_URL: 'http://mm' }, 7350)).toBeNull();
    expect(
      linkConfig({ MATCHMAKER_URL: 'http://mm', GAME_SERVER_SECRET: 's', SERVER_ID: 'gs-1' }, 7350),
    ).toMatchObject({ serverId: 'gs-1', publicUrl: 'ws://localhost:7350/ws', region: 'na' });
  });
});

describe('ticket server id', () => {
  it('refuses tickets for matches placed on another server', () => {
    const { connect } = setup({ serverId: 'gs-a' });
    expect(connect(signJoinTicket(SECRET, claims('u1', { sid: 'gs-b' }), WALL)).kicked).toBe(true);
    expect(connect(signJoinTicket(SECRET, claims('u2', { sid: 'default' }), WALL)).kicked).toBe(true);
    expect(connect(signJoinTicket(SECRET, claims('u3'), WALL)).welcome).not.toBeNull();
  });

  it('accepts the development default server id only when allowed', () => {
    const { connect } = setup({ serverId: 'gs-a', allowDefaultSid: true });
    expect(connect(signJoinTicket(SECRET, claims('u1', { sid: 'default' }), WALL)).welcome).not.toBeNull();
  });

  it('does not check the server id when not registered with a matchmaker', () => {
    const { connect } = setup();
    expect(connect(signJoinTicket(SECRET, claims('u1', { sid: 'anything' }), WALL)).welcome).not.toBeNull();
  });
});

describe('capacity report', () => {
  it('counts a matchmade room at its full planned size from the first ticket', () => {
    const { manager, connect } = setup();
    expect(manager.capacityReport()).toEqual({ load: 0, rooms: 0, matches: [] });
    connect(signJoinTicket(SECRET, claims('u1'), WALL));
    expect(manager.capacityReport()).toEqual({ load: 40, rooms: 1, matches: ['m_capacity_match'] });
    connect('');
    expect(manager.capacityReport()).toMatchObject({ load: 41, rooms: 2 });
    expect(manager.roomLimit).toBe(3);
  });
});

describe('matchmaker link', () => {
  it('registers seats and rooms, then heartbeats load, rooms and hosted matches', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const link = startMatchmakerLink({
      matchmakerUrl: 'http://mm.test/',
      secret: 'secret',
      serverId: 'gs-a',
      publicUrl: 'ws://gs-a/ws',
      region: 'eu',
      capacity: 400,
      maxRooms: 10,
      report: () => ({ load: 40, rooms: 1, matches: ['m_1'] }),
      fetch: fakeFetch,
      intervalMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 0));
    await link.beat();
    await link.stop();
    expect(calls[0]).toMatchObject({
      url: 'http://mm.test/servers/register',
      body: { serverId: 'gs-a', capacity: 400, maxRooms: 10, load: 40, rooms: 1, region: 'eu' },
    });
    expect(calls[1]).toMatchObject({
      url: 'http://mm.test/servers/heartbeat',
      body: { serverId: 'gs-a', load: 40, rooms: 1, matches: ['m_1'] },
    });
    expect(calls[2]?.url).toBe('http://mm.test/servers/gs-a');
  });
});
