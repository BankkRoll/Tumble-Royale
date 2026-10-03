import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { MMEvent } from '../src/matchmaker.ts';
import { userChannel } from '../src/matchmaker.ts';
import { verifyJoinTicket } from '../src/tickets.ts';

const JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijkl';
const TICKET_SECRET = 'test-ticket-secret-0123456789';
const SERVER_SECRET = 'test-server-secret-0123456789';
const enc = (s: string) => new TextEncoder().encode(s);

let clock = Date.parse('2026-10-02T12:00:00Z');
let mmApp: MatchmakerApp;

beforeEach(async () => {
  clock = Date.parse('2026-10-02T12:00:00Z');
  const cfg = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET,
    GAME_TICKET_SECRET: TICKET_SECRET,
    GAME_SERVER_SECRET: SERVER_SECRET,
    LOG_LEVEL: 'silent',
  });
  mmApp = await buildMatchmaker(cfg, { now: () => clock, logger: false });
});
afterEach(async () => {
  await mmApp.close();
});

/** Mints an API-style access token. */
function access(userId: string, region = 'na'): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({ sid: 's', name: `${userId}#0001`, region, guest: true, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(enc(JWT_SECRET));
}

/** Mints an API-style party queue ticket. */
function queueTicket(
  leader: string,
  members: string[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({
    typ: 'queue',
    pid: members.length > 1 ? `party-${leader}` : `solo:${leader}`,
    leaderId: leader,
    playlistId: 'main-show',
    queue: 'casual',
    teamSize: 1,
    maxPlayers: 40,
    minPlayers: 2,
    botsAllowed: true,
    region: 'na',
    members: members.map((u) => ({ userId: u, name: `${u}#0001`, mu: 25, sigma: 8.3, ordinal: 0 })),
    ...extra,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(leader)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 120)
    .sign(enc(JWT_SECRET));
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  body?: unknown,
) {
  return mmApp.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

async function collect(userId: string): Promise<MMEvent[]> {
  const events: MMEvent[] = [];
  await mmApp.store.subscribe(userChannel(userId), (m) => events.push(JSON.parse(m) as MMEvent));
  return events;
}

/** Advances the clock; registered servers keep heartbeating meanwhile, as real ones do. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  for (const raw of Object.values(await mmApp.store.hgetall('servers'))) {
    const srv = JSON.parse(raw) as { id: string; load: number };
    await mmApp.mm.heartbeat(srv.id, srv.load);
  }
}

async function registerServer(id = 'gs-1', capacity = 400) {
  const res = await call('POST', '/servers/register', SERVER_SECRET, {
    serverId: id,
    url: `wss://${id}.test`,
    region: 'na',
    capacity,
  });
  expect(res.statusCode).toBe(200);
}

describe('queue over HTTP', () => {
  it('queues a party, releases it with bots after the wait and issues verifiable join tickets', async () => {
    await registerServer();
    const events = await collect('bob');
    const leaderToken = await access('alice');
    const res = await call('POST', '/queue', leaderToken, {
      ticket: await queueTicket('alice', ['alice', 'bob']),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ searching: 2, etaSec: 25 });

    expect(await mmApp.mm.tick()).toHaveLength(0);
    await advance(25_000);
    const [match] = await mmApp.mm.tick();
    expect(match).toMatchObject({ humans: 2, botFill: 38, serverId: 'gs-1', queue: 'casual' });
    expect(new Set(match!.roster.map((r) => r.partyId)).size).toBe(1);

    const found = events.find((e) => e.type === 'match_found');
    expect(found).toBeDefined();
    if (found?.type !== 'match_found') throw new Error('no match');
    expect(found.server.url).toBe('wss://gs-1.test');
    const claims = await verifyJoinTicket(TICKET_SECRET, found.ticket, new Date(clock));
    expect(claims).toMatchObject({ sub: 'bob', mid: match!.matchId, bots: 38, humans: 2, role: 'player' });
    expect(await verifyJoinTicket('wrong-secret-0123456789', found.ticket, new Date(clock))).toBeNull();

    const lookup = await call('GET', `/matches/${match!.matchId}`, SERVER_SECRET);
    expect(lookup.json().roster).toHaveLength(2);
    expect((await call('GET', '/queue/status', leaderToken)).json().status).toBeNull();
  });

  it('rejects non-leaders, bad tickets and missing auth', async () => {
    const ticket = await queueTicket('alice', ['alice', 'bob']);
    expect((await call('POST', '/queue', await access('bob'), { ticket })).json().error).toBe('not_leader');
    expect((await call('POST', '/queue', await access('alice'), { ticket: `${ticket}x` })).json().error).toBe(
      'invalid_ticket',
    );
    expect((await call('POST', '/queue', undefined, { ticket })).statusCode).toBe(401);
  });

  it('cancels the whole party', async () => {
    const events = await collect('bob');
    await call('POST', '/queue', await access('alice'), {
      ticket: await queueTicket('alice', ['alice', 'bob']),
    });
    expect((await call('DELETE', '/queue', await access('bob'))).statusCode).toBe(204);
    expect(await mmApp.mm.entries()).toHaveLength(0);
    expect(events.some((e) => e.type === 'queue_cancelled')).toBe(true);
  });

  it('holds lobbies until a game server is available', async () => {
    await call('POST', '/queue', await access('alice'), { ticket: await queueTicket('alice', ['alice']) });
    await advance(30_000);
    expect(await mmApp.mm.tick()).toHaveLength(0);
    expect(await mmApp.mm.entries()).toHaveLength(1);
    await registerServer();
    expect(await mmApp.mm.tick()).toHaveLength(1);
  });

  it('places lobbies on the least-loaded server in the region', async () => {
    await registerServer('busy', 200);
    await call('POST', '/servers/heartbeat', SERVER_SECRET, { serverId: 'busy', load: 150 });
    await registerServer('idle', 200);
    await call('POST', '/queue', await access('alice'), { ticket: await queueTicket('alice', ['alice']) });
    await advance(25_000);
    const [m] = await mmApp.mm.tick();
    expect(m!.serverId).toBe('idle');
  });

  it('streams status and match_found over the WebSocket', async () => {
    await registerServer();
    await mmApp.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (mmApp.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${await access('alice')}`);
    const messages: MMEvent[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as MMEvent));
    await new Promise((r) => ws.on('open', r));
    await call('POST', '/queue', await access('alice'), { ticket: await queueTicket('alice', ['alice']) });
    await mmApp.mm.broadcastStatus();
    await advance(25_000);
    await mmApp.mm.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.map((m) => m.type)).toEqual(expect.arrayContaining(['queued', 'status', 'match_found']));
    ws.close();
  });
});

describe('custom lobbies', () => {
  it('create → join by code → host settings → start', async () => {
    await registerServer();
    const host = await access('host');
    const created = await call('POST', '/lobbies', host, {
      settings: { maxPlayers: 12, bots: true, rounds: ['gumdrop-gauntlet', 'crown-climb'] },
    });
    expect(created.statusCode).toBe(200);
    const code = created.json().lobby.code as string;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const guestEvents = await collect('guest');
    const joined = await call('POST', `/lobbies/${code.toLowerCase()}/join`, await access('guest'), {});
    expect(joined.json().lobby.players).toHaveLength(2);
    const spec = await call('POST', `/lobbies/${code}/join`, await access('watcher'), { spectator: true });
    expect(spec.json().lobby.spectators).toHaveLength(1);

    expect(
      (await call('PATCH', `/lobbies/${code}`, await access('guest'), { bots: false })).json().error,
    ).toBe('not_host');
    const patched = await call('PATCH', `/lobbies/${code}`, host, { roundTimeScale: 1.5 });
    expect(patched.json().lobby.settings).toMatchObject({ roundTimeScale: 1.5, maxPlayers: 12 });
    expect(guestEvents.some((e) => e.type === 'lobby_update')).toBe(true);

    expect((await call('POST', `/lobbies/${code}/start`, await access('guest'))).statusCode).toBe(403);
    const started = await call('POST', `/lobbies/${code}/start`, host);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ players: 2, bots: 10 });

    const found = guestEvents.find((e) => e.type === 'match_found');
    if (found?.type !== 'match_found') throw new Error('no ticket');
    const claims = await verifyJoinTicket(TICKET_SECRET, found.ticket, new Date(clock));
    expect(claims).toMatchObject({
      queue: 'custom',
      custom: { maxPlayers: 12, roundTimeScale: 1.5, rounds: ['gumdrop-gauntlet', 'crown-climb'] },
    });
    const record = (await call('GET', `/matches/${started.json().matchId}`, SERVER_SECRET)).json();
    expect(record.roster.find((r: { userId: string }) => r.userId === 'watcher').role).toBe('spectator');

    expect((await call('POST', `/lobbies/${code}/join`, await access('late'), {})).json().error).toBe(
      'lobby_started',
    );
  });

  it('returns 404 for unknown codes and passes hosting on when the host leaves', async () => {
    expect((await call('GET', '/lobbies/ZZZZZZ', await access('x'))).statusCode).toBe(404);
    const code = (await call('POST', '/lobbies', await access('h1'), {})).json().lobby.code;
    await call('POST', `/lobbies/${code}/join`, await access('p2'), {});
    await call('POST', `/lobbies/${code}/leave`, await access('h1'));
    expect((await call('GET', `/lobbies/${code}`, await access('p2'))).json().lobby.hostId).toBe('p2');
  });
});
