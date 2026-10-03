import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchmaker, type MatchmakerApp } from '../src/app.ts';
import { ApiBanLookup, type BanLookup } from '../src/bans.ts';
import { loadConfig } from '../src/config.ts';
import { userChannel, type MMEvent } from '../src/matchmaker.ts';
import { verifyJoinTicket } from '../src/tickets.ts';

const JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijkl';
const TICKET_SECRET = 'test-ticket-secret-0123456789';
const SERVER_SECRET = 'test-server-secret-0123456789';
const HMAC_SECRET = 'test-internal-hmac-secret-0123';
const enc = (s: string) => new TextEncoder().encode(s);

describe('ApiBanLookup', () => {
  it('signs lookups, caches answers briefly and fails open without caching', async () => {
    let clock = 0;
    let calls = 0;
    let down = false;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls++;
      if (down) throw new Error('connect ECONNREFUSED');
      const h = init.headers as Record<string, string>;
      const body = String(init.body);
      const expected = createHmac('sha256', HMAC_SECRET)
        .update(`${h['x-tumble-timestamp']}.${h['x-tumble-nonce']}.${body}`)
        .digest('hex');
      if (h['x-tumble-signature'] !== expected) return new Response('{}', { status: 401 });
      const { userIds } = JSON.parse(body) as { userIds: string[] };
      const bans = Object.fromEntries(
        userIds.map((id) => [id, id === 'bad' ? [{ scope: 'all', reason: 'x', expiresAt: null }] : []]),
      );
      return new Response(JSON.stringify({ bans }), { status: 200 });
    }) as typeof fetch;
    const logs: string[] = [];
    const lookup = new ApiBanLookup({
      apiUrl: 'http://api.test',
      secret: HMAC_SECRET,
      fetch: fakeFetch,
      now: () => clock,
      log: (m) => logs.push(m),
    });

    const first = await lookup.scopes(['bad', 'good']);
    expect([...first.get('bad')!]).toEqual(['all']);
    expect(first.get('good')!.size).toBe(0);
    await lookup.scopes(['bad', 'good']);
    expect(calls).toBe(1);

    clock += 16_000;
    down = true;
    const during = await lookup.scopes(['bad']);
    expect(during.get('bad')!.size).toBe(0);
    expect(logs.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
    down = false;
    expect([...(await lookup.scopes(['bad'])).get('bad')!]).toEqual(['all']);
    expect(calls).toBe(3);

    const wrongSecret = new ApiBanLookup({
      apiUrl: 'http://api.test',
      secret: 'nope-nope-nope-nope',
      fetch: fakeFetch,
    });
    expect((await wrongSecret.scopes(['bad'])).get('bad')!.size).toBe(0);
  });
});

describe('matchmaker ban enforcement', () => {
  const start = Date.parse('2026-10-02T12:00:00Z');
  let clock = start;
  const banned = new Map<string, string[]>();
  const bans: BanLookup = {
    scopes: async (ids) => new Map(ids.map((id) => [id, new Set(banned.get(id) ?? [])])),
  };
  let mm: MatchmakerApp;

  beforeEach(async () => {
    banned.clear();
    clock = start;
    mm = await buildMatchmaker(
      loadConfig({
        NODE_ENV: 'test',
        JWT_SECRET,
        GAME_TICKET_SECRET: TICKET_SECRET,
        GAME_SERVER_SECRET: SERVER_SECRET,
        LOG_LEVEL: 'silent',
      }),
      { now: () => clock, logger: false, bans },
    );
    await call('POST', '/servers/register', SERVER_SECRET, {
      serverId: 'gs-1',
      url: 'wss://gs-1.test',
      region: 'na',
      capacity: 400,
    });
  });
  afterEach(async () => {
    await mm.close();
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

  function queueTicket(leader: string, members: string[], queue: 'casual' | 'ranked' = 'casual') {
    const iat = Math.floor(clock / 1000);
    return new SignJWT({
      typ: 'queue',
      pid: `party-${leader}`,
      leaderId: leader,
      playlistId: queue === 'ranked' ? 'ranked' : 'main-show',
      queue,
      teamSize: 1,
      maxPlayers: 40,
      minPlayers: 1,
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

  function call(method: 'GET' | 'POST', url: string, token?: string, body?: unknown) {
    return mm.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }

  it('refuses to queue a party with a suspended member', async () => {
    banned.set('bob', ['all']);
    const res = await call('POST', '/queue', await access('alice'), {
      ticket: await queueTicket('alice', ['alice', 'bob']),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('banned');
    expect(await mm.mm.entries()).toHaveLength(0);
  });

  it('applies ranked bans to the ranked queue only', async () => {
    banned.set('alice', ['ranked']);
    const ranked = await call('POST', '/queue', await access('alice'), {
      ticket: await queueTicket('alice', ['alice'], 'ranked'),
    });
    expect(ranked.json().error).toBe('ranked_banned');
    const casual = await call('POST', '/queue', await access('alice'), {
      ticket: await queueTicket('alice', ['alice']),
    });
    expect(casual.statusCode).toBe(200);
  });

  it('marks chat-suspended players muted in their join ticket', async () => {
    banned.set('bob', ['chat']);
    const seen = new Map<string, MMEvent[]>();
    for (const u of ['alice', 'bob']) {
      const list: MMEvent[] = [];
      seen.set(u, list);
      await mm.store.subscribe(userChannel(u), (m) => list.push(JSON.parse(m) as MMEvent));
    }
    await call('POST', '/queue', await access('alice'), {
      ticket: await queueTicket('alice', ['alice', 'bob']),
    });
    const placed = await mm.mm.tick();
    expect(placed).toHaveLength(0);
    // Release with bots after the wait.
    clock += 30_000;
    await mm.mm.heartbeat('gs-1', 0);
    await mm.mm.tick();
    const ticketOf = async (u: string) => {
      const found = seen.get(u)!.find((e) => e.type === 'match_found');
      if (found?.type !== 'match_found') throw new Error(`no match for ${u}`);
      return verifyJoinTicket(TICKET_SECRET, found.ticket, new Date(clock));
    };
    expect(await ticketOf('bob')).toMatchObject({ mute: true });
    expect((await ticketOf('alice'))?.mute).toBeUndefined();
  });

  it('refuses suspended players in custom lobbies and drops them at start', async () => {
    banned.set('host', ['all']);
    expect((await call('POST', '/lobbies', await access('host'), {})).json().error).toBe('banned');
    banned.clear();
    const code = (await call('POST', '/lobbies', await access('host'), {})).json().lobby.code;
    banned.set('griefer', ['all']);
    expect((await call('POST', `/lobbies/${code}/join`, await access('griefer'), {})).statusCode).toBe(403);
    banned.clear();
    await call('POST', `/lobbies/${code}/join`, await access('later'), {});
    banned.set('later', ['all']);
    const started = await call('POST', `/lobbies/${code}/start`, await access('host'));
    expect(started.statusCode).toBe(200);
    expect(started.json().players).toBe(1);
  });
});
