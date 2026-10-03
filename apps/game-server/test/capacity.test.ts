import { describe, expect, it } from 'vitest';
import { startMatchmakerLink } from '../src/matchmakerLink.ts';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager, type TicketPolicy } from '../src/room/RoomManager.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, TEST_SECRETS, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
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

  it('reports ticketed joins on the heartbeat and carries them over a failed one', async () => {
    const heartbeats: Record<string, unknown>[] = [];
    let fail = false;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/servers/heartbeat')) {
        heartbeats.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (fail) return new Response('{}', { status: 503 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const queue: { matchId: string; userId: string }[][] = [
      [{ matchId: 'm_1', userId: 'u1' }],
      [{ matchId: 'm_1', userId: 'u2' }],
      [],
    ];
    const link = startMatchmakerLink({
      matchmakerUrl: 'http://mm.test',
      secret: 'secret',
      serverId: 'gs-a',
      publicUrl: 'ws://gs-a/ws',
      region: 'eu',
      capacity: 400,
      report: () => ({ load: 0, rooms: 0, matches: [] }),
      joined: () => queue.shift() ?? [],
      fetch: fakeFetch,
      intervalMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 0));
    fail = true;
    await link.beat();
    fail = false;
    // The refused heartbeat dropped the registration: this beat re-registers, the next carries both joins.
    await link.beat();
    await link.beat();
    await link.beat();
    await link.stop();
    expect(heartbeats[0]?.joined).toEqual([{ matchId: 'm_1', userId: 'u1' }]);
    expect(heartbeats[1]?.joined).toEqual([
      { matchId: 'm_1', userId: 'u1' },
      { matchId: 'm_1', userId: 'u2' },
    ]);
    expect(heartbeats[2]?.joined).toBeUndefined();
  });
});
