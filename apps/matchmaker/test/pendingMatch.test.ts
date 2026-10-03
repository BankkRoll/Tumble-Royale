import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import type { BanLookup, BanScope } from '../src/bans.ts';
import { loadConfig } from '../src/config.ts';
import { userChannel, type MatchFoundEvent, type MMEvent } from '../src/matchmaker.ts';
import { JOIN_TICKET_TTL_SEC, verifyJoinTicket } from '../src/tickets.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

const JWT_SECRET = TEST_SECRETS.JWT_SECRET;
const TICKET_SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const SERVER_SECRET = TEST_SECRETS.GAME_SERVER_SECRET;
const enc = (s: string) => new TextEncoder().encode(s);

let clock = Date.parse('2026-10-02T12:00:00Z');
let mmApp: MatchmakerApp;
const banned = new Map<string, Set<BanScope>>();
const bans: BanLookup = {
  async scopes(userIds) {
    return new Map(userIds.filter((u) => banned.has(u)).map((u) => [u, banned.get(u)!]));
  },
};

beforeEach(async () => {
  clock = Date.parse('2026-10-02T12:00:00Z');
  banned.clear();
  mmApp = await buildMatchmaker(loadConfig(testEnv()), { now: () => clock, logger: false, bans });
});
afterEach(async () => {
  await mmApp.close();
});

function access(userId: string): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({ sid: 's', name: `${userId}#0001`, region: 'na', guest: true, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(enc(JWT_SECRET));
}

function queueTicket(leader: string, members: string[], maxPlayers = 2): Promise<string> {
  const iat = Math.floor(clock / 1000);
  return new SignJWT({
    typ: 'queue',
    pid: members.length > 1 ? `party-${leader}` : `solo:${leader}`,
    leaderId: leader,
    playlistId: 'main-show',
    queue: 'casual',
    teamSize: 1,
    maxPlayers,
    minPlayers: 2,
    botsAllowed: true,
    region: 'na',
    members: members.map((u) => ({ userId: u, name: `${u}#0001`, mu: 25, sigma: 8.3, ordinal: 0 })),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(leader)
    .setIssuer('tumble-api')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 120)
    .sign(enc(JWT_SECRET));
}

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, body?: unknown) {
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

async function registerServer(id = 'gs-1') {
  const res = await call('POST', '/servers/register', SERVER_SECRET, {
    serverId: id,
    url: `wss://${id}.test/ws`,
    region: 'na',
    capacity: 400,
  });
  expect(res.statusCode).toBe(200);
}

const heartbeat = (body: Record<string, unknown>) =>
  call('POST', '/servers/heartbeat', SERVER_SECRET, { serverId: 'gs-1', load: 0, ...body });

/** Queues alice and bob as solos and places them on gs-1, with nobody listening. */
async function placeMatch(): Promise<string> {
  await registerServer();
  await call('POST', '/queue', await access('alice'), { ticket: await queueTicket('alice', ['alice']) });
  await call('POST', '/queue', await access('bob'), { ticket: await queueTicket('bob', ['bob']) });
  const [match] = await mmApp.mm.tick();
  if (!match) throw new Error('no match placed');
  return match.matchId;
}

async function status(userId: string): Promise<{ status: unknown; match: MatchFoundEvent | null }> {
  return (await call('GET', '/queue/status', await access(userId))).json();
}

async function openStream(userId: string): Promise<{ ws: WebSocket; messages: MMEvent[] }> {
  if (!mmApp.app.server.listening) await mmApp.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (mmApp.app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${await access(userId)}`);
  const messages: MMEvent[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d)) as MMEvent));
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 50));
  return { ws, messages };
}

describe('pending match_found', () => {
  it('keeps a match placed while the player was offline and replays it on connect', async () => {
    const matchId = await placeMatch();
    clock += 30_000;
    const s = await status('alice');
    expect(s.status).toBeNull();
    expect(s.match).toMatchObject({ type: 'match_found', matchId, expiresIn: JOIN_TICKET_TTL_SEC - 30 });
    expect(await verifyJoinTicket(TICKET_SECRET, s.match!.ticket, new Date(clock))).toMatchObject({
      sub: 'alice',
      mid: matchId,
    });

    const { ws, messages } = await openStream('alice');
    expect(messages.filter((m) => m.type === 'match_found')).toEqual([
      expect.objectContaining({ matchId, expiresIn: JOIN_TICKET_TTL_SEC - 30 }),
    ]);
    ws.close();
  });

  it('forgets the match once the ticket expired', async () => {
    await placeMatch();
    clock += JOIN_TICKET_TTL_SEC * 1000;
    expect((await status('alice')).match).toBeNull();
    const { ws, messages } = await openStream('alice');
    expect(messages.some((m) => m.type === 'match_found')).toBe(false);
    ws.close();
  });

  it('stops replaying once the game server reports the player joined, and only for that match', async () => {
    const matchId = await placeMatch();
    expect((await heartbeat({ joined: [{ matchId: 'm_other', userId: 'alice' }] })).statusCode).toBe(200);
    expect((await status('alice')).match?.matchId).toBe(matchId);
    await heartbeat({ joined: [{ matchId, userId: 'alice' }] });
    expect((await status('alice')).match).toBeNull();
    expect((await status('bob')).match?.matchId).toBe(matchId);
  });

  it('clears on decline and when the player queues again', async () => {
    await placeMatch();
    expect((await call('DELETE', '/queue/match', await access('alice'))).statusCode).toBe(204);
    expect((await status('alice')).match).toBeNull();
    await call('POST', '/queue', await access('bob'), { ticket: await queueTicket('bob', ['bob'], 4) });
    expect((await status('bob')).match).toBeNull();
  });

  it('never stores a match for a player who cancelled before placement', async () => {
    await registerServer();
    await call('POST', '/queue', await access('alice'), { ticket: await queueTicket('alice', ['alice']) });
    await call('DELETE', '/queue', await access('alice'));
    await call('POST', '/queue', await access('bob'), { ticket: await queueTicket('bob', ['bob']) });
    expect(await mmApp.mm.tick()).toEqual([]);
    expect((await status('alice')).match).toBeNull();
  });

  it('sends a live match_found once to a connected player (no duplicate from the replay)', async () => {
    await registerServer();
    const { ws, messages } = await openStream('alice');
    await call('POST', '/queue', await access('alice'), { ticket: await queueTicket('alice', ['alice']) });
    await call('POST', '/queue', await access('bob'), { ticket: await queueTicket('bob', ['bob']) });
    await mmApp.mm.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.filter((m) => m.type === 'match_found')).toHaveLength(1);
    ws.close();
  });
});

describe('rejoin a running match', () => {
  it('re-issues a ticket marked as a rejoin while the server still hosts the match', async () => {
    const matchId = await placeMatch();
    await heartbeat({ matches: [matchId] });
    clock += 5 * 60_000;
    await heartbeat({ matches: [matchId] });
    const res = await call('POST', '/queue/rejoin', await access('alice'), { matchId });
    expect(res.statusCode).toBe(200);
    const claims = await verifyJoinTicket(TICKET_SECRET, res.json().match.ticket, new Date(clock));
    expect(claims).toMatchObject({ sub: 'alice', mid: matchId, sid: 'gs-1', rejoin: true });
  });

  it('refuses strangers, unknown matches, finished shows and restarted servers', async () => {
    const matchId = await placeMatch();
    await heartbeat({ matches: [matchId] });
    const rejoin = async (userId: string, id = matchId) =>
      (await call('POST', '/queue/rejoin', await access(userId), { matchId: id })).json().error as string;
    expect(await rejoin('mallory')).toBe('not_in_match');
    expect(await rejoin('alice', 'm_nope')).toBe('match_not_found');

    // The server keeps heartbeating but stopped reporting the match (show ended, or it restarted).
    clock += 20_000;
    await heartbeat({ matches: [] });
    expect(await rejoin('alice')).toBe('match_over');

    // The server is gone altogether.
    await heartbeat({ matches: [matchId] });
    expect((await call('POST', '/queue/rejoin', await access('alice'), { matchId })).statusCode).toBe(200);
    clock += 20_000;
    expect(await rejoin('alice')).toBe('match_over');
  });

  it('allows a rejoin before the first player reached the room (reservation still held)', async () => {
    const matchId = await placeMatch();
    const res = await call('POST', '/queue/rejoin', await access('bob'), { matchId });
    expect(res.statusCode).toBe(200);
  });

  it('refuses suspended players', async () => {
    const matchId = await placeMatch();
    await heartbeat({ matches: [matchId] });
    banned.set('alice', new Set(['all']));
    const res = await call('POST', '/queue/rejoin', await access('alice'), { matchId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('banned');
  });

  it('refuses a player the private show host removed', async () => {
    await registerServer();
    const host = await access('host');
    const code = (await call('POST', '/lobbies', host, { settings: { maxPlayers: 4 } })).json().lobby
      .code as string;
    await call('POST', `/lobbies/${code}/join`, await access('guest'), {});
    const started = await call('POST', `/lobbies/${code}/start`, host, { force: true });
    const matchId = started.json().matchId as string;
    await heartbeat({ matches: [matchId] });
    expect((await status('guest')).match?.matchId).toBe(matchId);
    await call('POST', `/lobbies/${code}/kick`, host, { userId: 'guest' });
    expect((await status('guest')).match).toBeNull();
    const res = await call('POST', '/queue/rejoin', await access('guest'), { matchId });
    expect(res.json().error).toBe('removed_by_host');
  });

  it('pushes nothing on the stream for a rejoin (only the caller gets the ticket)', async () => {
    const matchId = await placeMatch();
    const seen: MMEvent[] = [];
    await mmApp.store.subscribe(userChannel('alice'), (m) => seen.push(JSON.parse(m) as MMEvent));
    await call('POST', '/queue/rejoin', await access('alice'), { matchId });
    expect(seen).toEqual([]);
  });
});
