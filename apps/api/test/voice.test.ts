/**
 * Voice chat: TURN credentials, configuration, and the signalling relay —
 * rooms decided by the server, signals only between peers, blocks, kicks,
 * team squads, voice mutes across instances and voice reports.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { reports } from '../src/db/schema.ts';
import { createKV, type KV } from '../src/kv/index.ts';
import { RedisKV } from '../src/kv/redis.ts';
import { iceServersFor, roomTag, turnCredential, verifyTurnCredential } from '../src/voice/turn.ts';
import { relayVoiceSignal } from '../src/voice/service.ts';
import { createScratchDatabase } from './backing.ts';
import { ageAccount } from './clubHelpers.ts';
import { ADMIN_TOKEN, createTestApi, testEnv, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const START = '2026-10-02T12:00:00.000Z';
const SECRET = 'turn-secret-0123456789abcdef';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

type Msg = Record<string, unknown>;

interface Conn {
  ws: WebSocket;
  all: Msg[];
  /** Resolves with the next unseen message of `type` matching `pred`. */
  next(type: string, pred?: (m: Msg) => boolean): Promise<Msg>;
  /** Unseen messages of `type` so far. */
  pending(type: string): Msg[];
  send(m: unknown): void;
}

function connect(base: string, user: TestUser): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${user.accessToken}`);
    const queue: Msg[] = [];
    const all: Msg[] = [];
    const waiters: { type: string; pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      all.push(m);
      const i = waiters.findIndex((w) => w.type === m.type && w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
      else queue.push(m);
      if (m.type === 'hello') resolve(conn);
    });
    ws.on('error', reject);
    const conn: Conn = {
      ws,
      all,
      next: (type, pred = () => true) =>
        new Promise((res, rej) => {
          const i = queue.findIndex((m) => m.type === type && pred(m));
          if (i >= 0) return res(queue.splice(i, 1)[0]!);
          const w = { type, pred, resolve: res };
          waiters.push(w);
          setTimeout(() => {
            const at = waiters.indexOf(w);
            if (at >= 0) {
              waiters.splice(at, 1);
              rej(new Error(`timed out waiting for ${type}`));
            }
          }, 3000).unref();
        }),
      pending: (type) => queue.filter((m) => m.type === type),
      send: (m) => ws.send(JSON.stringify(m)),
    };
  });
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const peersOf = (m: Msg) => (m.peers as { userId: string }[]).map((p) => p.userId).sort();
const cid = () => `tab_${randomBytes(6).toString('hex')}`;

async function enableVoice(api: TestApi): Promise<void> {
  const res = await api.req('PUT', '/internal/flags/voice.enabled', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: { enabled: true },
  });
  expect(res.statusCode).toBe(200);
}

async function party(api: TestApi, leader: TestUser, ...members: TestUser[]): Promise<string> {
  const created = await api.req('POST', '/party', { token: leader.accessToken });
  const { id, code } = created.json().party as { id: string; code: string };
  for (const m of members)
    expect((await api.req('POST', '/party/join', { token: m.accessToken, body: { code } })).statusCode).toBe(
      200,
    );
  return id;
}

describe('TURN credentials', () => {
  it('follow the TURN REST scheme: expiry:user.room, base64 HMAC-SHA1', () => {
    const now = Date.parse(START);
    const c = turnCredential(SECRET, 'u1', 'party:abc', now, 600);
    const expiry = Math.floor(now / 1000) + 600;
    expect(c.username).toBe(`${expiry}:u1.${roomTag('party:abc')}`);
    expect(c.expiresAt).toBe(expiry * 1000);
    expect(c.credential).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(verifyTurnCredential(SECRET, c.username, c.credential, now)).toBe(true);
  });

  it('expire, and do not verify under another secret or a changed username', () => {
    const now = Date.parse(START);
    const c = turnCredential(SECRET, 'u1', 'party:abc', now, 600);
    expect(verifyTurnCredential(SECRET, c.username, c.credential, now + 600_000)).toBe(false);
    expect(verifyTurnCredential('another-secret-0123456789', c.username, c.credential, now)).toBe(false);
    expect(verifyTurnCredential(SECRET, c.username.replace('u1', 'u2'), c.credential, now)).toBe(false);
  });

  it('differ per user and per room', () => {
    const now = Date.parse(START);
    const a = turnCredential(SECRET, 'u1', 'party:a', now);
    expect(turnCredential(SECRET, 'u2', 'party:a', now).credential).not.toBe(a.credential);
    expect(turnCredential(SECRET, 'u1', 'party:b', now).credential).not.toBe(a.credential);
  });

  it('are only minted for a room, and STUN passes through untouched', () => {
    const voice = {
      stunUrls: ['stun:stun.example.com:3478'],
      turnUrls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'],
      turnSecret: SECRET,
      available: true,
    };
    const alone = iceServersFor(voice, 'u1', null, 0);
    expect(alone).toEqual({ servers: [{ urls: ['stun:stun.example.com:3478'] }], expiresAt: 0 });
    const inRoom = iceServersFor(voice, 'u1', 'party:x', 0);
    expect(inRoom.servers[1]).toMatchObject({
      urls: voice.turnUrls,
      username: expect.stringContaining(':u1.'),
    });
    expect(inRoom.expiresAt).toBeGreaterThan(0);
  });
});

describe('voice configuration', () => {
  it('reads VOICE_ICE_SERVERS and demands a secret for TURN', () => {
    const ok = loadConfig(
      testEnv({
        VOICE_ICE_SERVERS: 'stun:s.example.com:3478, turn:t.example.com:3478',
        VOICE_TURN_SECRET: SECRET,
      }),
    ).voice;
    expect(ok).toMatchObject({
      stunUrls: ['stun:s.example.com:3478'],
      turnUrls: ['turn:t.example.com:3478'],
      available: true,
    });
    expect(() => loadConfig(testEnv({ VOICE_ICE_SERVERS: 'turn:t.example.com' }))).toThrow(
      /VOICE_TURN_SECRET/,
    );
    expect(() => loadConfig(testEnv({ VOICE_ICE_SERVERS: 'http://nope' }))).toThrow(/VOICE_ICE_SERVERS/);
    expect(() =>
      loadConfig(testEnv({ VOICE_ICE_SERVERS: 'turn:t.example.com', VOICE_TURN_SECRET: 'short' })),
    ).toThrow(/at least 16/);
  });

  it('is unavailable without TURN when TURN is required (the production default)', () => {
    expect(loadConfig(testEnv({ VOICE_REQUIRE_TURN: '1' })).voice.available).toBe(false);
    expect(loadConfig(testEnv()).voice.available).toBe(true);
  });
});

describe('GET /voice/config', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(START, {}, { memoryKv: true });
  });
  afterAll(() => api.close());

  it('is off until the operator switches voice.enabled on, and off for a voice-muted player', async () => {
    const u = await api.guest();
    const get = async () => (await api.req('GET', '/voice/config', { token: u.accessToken })).json();
    expect(await get()).toMatchObject({ available: false, reason: 'flag_off', teamVoice: false });
    await enableVoice(api);
    expect(await get()).toMatchObject({ available: true, reason: null, relay: false });
    await api.ban(u.id, 'voice');
    expect(await get()).toMatchObject({ available: false, reason: 'muted' });
  });

  it('says not_configured when TURN is required but missing', async () => {
    const strict = await createTestApi(START, { VOICE_REQUIRE_TURN: '1' }, { memoryKv: true });
    try {
      await enableVoice(strict);
      const u = await strict.guest();
      expect((await strict.req('GET', '/voice/config', { token: u.accessToken })).json()).toMatchObject({
        available: false,
        reason: 'not_configured',
      });
    } finally {
      await strict.close();
    }
  });

  it('allows team voice only for linked accounts at least three days old', async () => {
    const fresh = await api.account();
    const get = async (t: string) => (await api.req('GET', '/voice/config', { token: t })).json();
    expect((await get(fresh.accessToken)).teamVoice).toBe(false);
    await ageAccount(api, fresh.id, 3);
    expect((await get(fresh.accessToken)).teamVoice).toBe(true);
  });
});

describe('voice signalling', () => {
  let api: TestApi;
  let base: string;
  beforeAll(async () => {
    api = await createTestApi(
      START,
      {
        VOICE_ICE_SERVERS: 'stun:stun.example.com:3478,turn:turn.example.com:3478',
        VOICE_TURN_SECRET: SECRET,
      },
      { memoryKv: true },
    );
    await enableVoice(api);
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    base = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => api.close());

  async function inVoice(user: TestUser, team = false) {
    const c = await connect(base, user);
    const tab = cid();
    c.send({ type: 'voice_join', cid: tab, team });
    const room = await c.next('voice_room', (m) => m.cid === tab);
    return { c, tab, room };
  }

  it('refuses to join while the flag is off', async () => {
    const off = await createTestApi(START, {}, { memoryKv: true });
    try {
      await off.app.listen({ host: '127.0.0.1', port: 0 });
      const u = await off.guest();
      const c = await connect(`ws://127.0.0.1:${(off.app.server.address() as AddressInfo).port}`, u);
      c.send({ type: 'voice_join', cid: cid(), team: false });
      expect(await c.next('error')).toMatchObject({ code: 'voice_disabled' });
      c.ws.close();
    } finally {
      await off.close();
    }
  });

  it('puts party members in one room with per-user TURN credentials, and relays only between them', async () => {
    const a = await api.guest();
    const b = await api.guest();
    const stranger = await api.guest();
    const partyId = await party(api, a, b);
    const A = await inVoice(a);
    expect(A.room).toMatchObject({ room: { id: `party:${partyId}`, kind: 'party' }, peers: [] });
    const B = await inVoice(b);
    expect(peersOf(B.room)).toEqual([a.id]);
    expect(peersOf(await A.c.next('voice_room'))).toEqual([b.id]);
    const ice = (B.room.ice as { servers: { username?: string }[]; relay: boolean }).servers;
    expect(ice[1]!.username).toContain(`:${b.id}.`);
    expect((B.room.ice as { relay: boolean }).relay).toBe(true);

    A.c.send({ type: 'voice_signal', cid: A.tab, to: b.id, kind: 'offer', sdp: SDP });
    expect(await B.c.next('voice_signal')).toMatchObject({ from: a.id, kind: 'offer', sdp: SDP });
    B.c.send({
      type: 'voice_signal',
      cid: B.tab,
      to: a.id,
      kind: 'ice',
      candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(await A.c.next('voice_signal')).toMatchObject({ from: b.id, kind: 'ice' });

    // A stranger in voice cannot reach a party member, even naming them directly.
    const S = await inVoice(stranger);
    S.c.send({ type: 'voice_signal', cid: S.tab, to: a.id, kind: 'offer', sdp: SDP });
    // Video offers, wrong tabs and oversized frames are dropped too.
    B.c.send({
      type: 'voice_signal',
      cid: B.tab,
      to: a.id,
      kind: 'offer',
      sdp: `${SDP}m=video 9 RTP 96\r\n`,
    });
    B.c.send({ type: 'voice_signal', cid: 'tab_notmine00', to: a.id, kind: 'offer', sdp: SDP });
    B.c.send({
      type: 'voice_signal',
      cid: B.tab,
      to: a.id,
      kind: 'offer',
      sdp: `${SDP}${'a=x\r\n'.repeat(2500)}`,
    });
    await settle(150);
    expect(A.c.pending('voice_signal')).toEqual([]);
    expect(
      await relayVoiceSignal(api.ctx, stranger.id, {
        type: 'voice_signal',
        cid: S.tab,
        to: a.id,
        kind: 'restart',
      }),
    ).toBe('not_peer');
    for (const x of [A, B, S]) x.c.ws.close();
    await settle();
  });

  it('removes a kicked member at once on both sides', async () => {
    const lead = await api.guest();
    const m1 = await api.guest();
    const m2 = await api.guest();
    await party(api, lead, m1, m2);
    const L = await inVoice(lead);
    const M1 = await inVoice(m1);
    const M2 = await inVoice(m2);
    expect(peersOf(M2.room)).toEqual([lead.id, m1.id].sort());
    await settle();
    expect(
      (await api.req('POST', '/party/kick', { token: lead.accessToken, body: { userId: m2.id } })).statusCode,
    ).toBe(200);
    expect(await M2.c.next('voice_room', (m) => m.room === null)).toMatchObject({ peers: [] });
    await L.c.next('voice_room', (m) => !peersOf(m).includes(m2.id));
    await M1.c.next('voice_room', (m) => !peersOf(m).includes(m2.id));
    expect(
      await relayVoiceSignal(api.ctx, m2.id, {
        type: 'voice_signal',
        cid: M2.tab,
        to: lead.id,
        kind: 'restart',
      }),
    ).toBe('not_peer');
    for (const x of [L, M1, M2]) x.c.ws.close();
    await settle();
  });

  it('never connects a blocked pair, in either direction, while the rest of the room stays', async () => {
    const a = await api.guest();
    const b = await api.guest();
    const c = await api.guest();
    await party(api, a, b, c);
    const A = await inVoice(a);
    const B = await inVoice(b);
    const C = await inVoice(c);
    await settle();
    expect(
      (await api.req('POST', '/friends/block', { token: b.accessToken, body: { userId: a.id } })).statusCode,
    ).toBe(200);
    expect(peersOf(await A.c.next('voice_room', (m) => !peersOf(m).includes(b.id)))).toEqual([c.id]);
    expect(peersOf(await B.c.next('voice_room', (m) => !peersOf(m).includes(a.id)))).toEqual([c.id]);
    // The blocker cannot signal the blocked player, nor the other way round.
    for (const [from, tab, to] of [
      [a, A.tab, b],
      [b, B.tab, a],
    ] as const)
      expect(
        await relayVoiceSignal(api.ctx, from.id, {
          type: 'voice_signal',
          cid: tab,
          to: to.id,
          kind: 'restart',
        }),
      ).toBe('not_peer');
    expect(
      await relayVoiceSignal(api.ctx, a.id, { type: 'voice_signal', cid: A.tab, to: c.id, kind: 'restart' }),
    ).toBe('relayed');
    // A newcomer to the room still sees the blocked pair apart.
    C.c.ws.close();
    await settle();
    const C2 = await inVoice(c);
    expect(peersOf(C2.room)).toEqual([a.id, b.id].sort());
    for (const x of [A, B, C2]) x.c.ws.close();
    await settle();
  });

  it('ends the session when the tab closes, and a second tab replaces the first', async () => {
    const a = await api.guest();
    const b = await api.guest();
    await party(api, a, b);
    const A = await inVoice(a);
    const B = await inVoice(b);
    await A.c.next('voice_room', (m) => peersOf(m).includes(b.id));
    const B2 = await inVoice(b);
    expect(await B.c.next('voice_off')).toMatchObject({ cid: B.tab, reason: 'replaced' });
    expect(peersOf(B2.room)).toEqual([a.id]);
    // Closing the replaced tab must not end the new tab's session.
    B.c.ws.close();
    await settle();
    expect(
      await relayVoiceSignal(api.ctx, a.id, { type: 'voice_signal', cid: A.tab, to: b.id, kind: 'restart' }),
    ).toBe('relayed');
    B2.c.ws.close();
    await A.c.next('voice_room', (m) => peersOf(m).length === 0);
    A.c.ws.close();
    await settle();
  });

  it('moves opted-in teammates into a team squad for a team round, then back to the party', async () => {
    const [a, b, c] = [await api.account(), await api.account(), await api.account()];
    for (const u of [a, b, c]) await ageAccount(api, u.id, 10);
    const guest = await api.guest();
    await party(api, a, guest);
    const A = await inVoice(a, true);
    const B = await inVoice(b, true);
    const C = await inVoice(c, false);
    const G = await inVoice(guest, true);
    await settle();
    const matchId = `m_${randomBytes(4).toString('hex')}`;
    const players = [a, b, c, guest].map((u) => ({ userId: u.id, team: 0 }));
    expect((await api.internal('/internal/voice/teams', { matchId, round: 2, players })).statusCode).toBe(
      204,
    );
    const teamRoom = await A.c.next(
      'voice_room',
      (m) => (m.room as { kind?: string } | null)?.kind === 'team',
    );
    // The guest and the player who kept team voice off stay out of the squad.
    expect(peersOf(teamRoom)).toEqual([b.id]);
    expect((await B.c.next('voice_room', (m) => peersOf(m).includes(a.id))).room).toMatchObject({
      kind: 'team',
    });
    expect(C.c.pending('voice_room').every((m) => m.room === null)).toBe(true);
    expect(await G.c.next('voice_room', (m) => m.room === null || peersOf(m).length === 0)).toBeTruthy();
    // A forged report without the HMAC is refused.
    const forged = await api.req('POST', '/internal/voice/teams', {
      body: { matchId, round: 3, players: [] },
    });
    expect(forged.statusCode).toBe(401);
    expect((await api.internal('/internal/voice/teams', { matchId, round: 2, players: [] })).statusCode).toBe(
      204,
    );
    expect(
      (await A.c.next('voice_room', (m) => (m.room as { kind?: string } | null)?.kind === 'party')).peers,
    ).toEqual([expect.objectContaining({ userId: guest.id })]);
    for (const x of [A, B, C, G]) x.c.ws.close();
    await settle();
  });

  it('files voice reports with room and time metadata, never audio', async () => {
    const a = await api.guest();
    const b = await api.guest();
    await party(api, a, b);
    const A = await inVoice(a);
    const B = await inVoice(b);
    await A.c.next('voice_room', (m) => peersOf(m).includes(b.id));
    const res = await api.req('POST', '/report', {
      token: a.accessToken,
      body: { targetUserId: b.id, reason: 'voice', details: 'shouting slurs' },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await api.ctx.db.select().from(reports).where(eq(reports.id, res.json().id));
    expect(row!.reason).toBe('voice');
    expect(row!.evidence).toEqual([
      expect.objectContaining({
        channel: 'voice',
        room: expect.stringMatching(/^party:/),
        text: expect.stringContaining('no audio'),
      }),
    ]);
    for (const x of [A, B]) x.c.ws.close();
    await settle();
  });
});

/** Two API instances over one database and one KV, as two processes behind a load balancer. */
async function twoInstances(backend: (typeof BACKENDS)[number]) {
  const redis = backend.env.REDIS_URL;
  const pg = backend.env.DATABASE_URL;
  const scratch = pg ? await createScratchDatabase(pg) : null;
  const database: Database = await openDatabase({ databaseUrl: scratch?.url, pgliteDir: 'memory://' });
  const db = { ...database, close: async () => undefined };
  const prefix = `tumble-test:${randomBytes(6).toString('hex')}:`;
  const kvs: KV[] = redis
    ? [new RedisKV(redis, prefix), new RedisKV(redis, prefix)]
    : [createKV(undefined, () => Date.parse(START))];
  const env = { DATABASE_URL: '', REDIS_URL: '' };
  const a = await createTestApi(START, env, { kv: kvs[0]!, database: db });
  const b = await createTestApi(START, env, { kv: kvs[1] ?? kvs[0]!, database: db });
  return {
    a,
    b,
    close: async () => {
      await a.close();
      await b.close().catch(() => undefined);
      await database.close();
      await scratch?.drop();
    },
  };
}

describe.each(BACKENDS)('voice sanctions across instances ($name)', (backend) => {
  it('a voice mute on one instance ends the session on the other and drops the player from their peers', async () => {
    const pair = await twoInstances(backend);
    const { a: apiA, b: apiB } = pair;
    const conns: Conn[] = [];
    try {
      await enableVoice(apiA);
      await apiA.app.listen({ host: '127.0.0.1', port: 0 });
      await apiB.app.listen({ host: '127.0.0.1', port: 0 });
      const baseA = `ws://127.0.0.1:${(apiA.app.server.address() as AddressInfo).port}`;
      const baseB = `ws://127.0.0.1:${(apiB.app.server.address() as AddressInfo).port}`;
      const x = await apiA.guest();
      const y = await apiA.guest();
      await party(apiA, x, y);
      const X = await connect(baseA, x);
      const Y = await connect(baseB, y);
      conns.push(X, Y);
      const tx = cid();
      const ty = cid();
      X.send({ type: 'voice_join', cid: tx, team: false });
      await X.next('voice_room');
      Y.send({ type: 'voice_join', cid: ty, team: false });
      expect(peersOf(await Y.next('voice_room'))).toEqual([x.id]);
      // Warms instance B's ban cache with "not muted".
      expect(
        await relayVoiceSignal(apiB.ctx, y.id, { type: 'voice_signal', cid: ty, to: x.id, kind: 'restart' }),
      ).toBe('relayed');

      const mute = await apiA.req('POST', '/internal/bans', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { userId: y.id, scope: 'voice', reason: 'abuse in voice', durationHours: 2 },
      });
      expect(mute.statusCode).toBe(201);
      await backend.settle();
      expect(await Y.next('voice_off')).toMatchObject({ reason: 'muted' });
      await X.next('voice_room', (m) => peersOf(m).length === 0);
      expect(
        await relayVoiceSignal(apiB.ctx, y.id, { type: 'voice_signal', cid: ty, to: x.id, kind: 'restart' }),
      ).toBe('not_in_voice');
      Y.send({ type: 'voice_join', cid: ty, team: false });
      expect(await Y.next('error')).toMatchObject({ code: 'voice_muted' });
    } finally {
      for (const c of conns) c.ws.close();
      await settle();
      await pair.close();
    }
  });
});
