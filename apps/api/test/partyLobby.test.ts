/**
 * Party lobby relay: members' main-menu Tumbler frames reach the other
 * members only, through the realtime gateway, validated and rate limited.
 */
import type { AddressInfo } from 'node:net';
import { encodeLobbyFrame, PARTY_LOBBY_LIMITS, type LobbyPose } from '@tumble/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PartyLobbyRelay } from '../src/realtime/partyLobby.ts';
import { userChannel } from '../src/realtime/notifier.ts';
import { PartyService } from '../src/social/party.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
let base: string;
beforeAll(async () => {
  // Rate buckets refill on the fake clock, which only the in-process KV follows.
  api = await createTestApi(undefined, {}, { memoryKv: true });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await api.close();
});
// Every test starts with full rate buckets.
beforeEach(() => api.clock.advance(10_000));

type Msg = Record<string, unknown>;

interface Conn {
  ws: WebSocket;
  frames: Msg[];
  /** Resolves once a `party_lobby` frame from `userId` with `seq` arrives. */
  waitFor(userId: string, seq: number): Promise<Msg>;
}

function connect(user: TestUser): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${user.accessToken}`);
    const frames: Msg[] = [];
    const waiters: { userId: string; seq: number; resolve: (m: Msg) => void }[] = [];
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      if (m.type === 'hello') resolve(conn);
      if (m.type !== 'party_lobby') return;
      frames.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.userId === m.userId && w.seq === m.seq) waiters.splice(i, 1)[0]!.resolve(m);
      }
    });
    ws.on('error', reject);
    const conn: Conn = {
      ws,
      frames,
      waitFor: (userId, seq) =>
        new Promise((res) => {
          const seen = frames.find((f) => f.userId === userId && f.seq === seq);
          if (seen) res(seen);
          else waiters.push({ userId, seq, resolve: res });
        }),
    };
  });
}

const pose = (x = 1, z = -0.5): LobbyPose => ({
  x,
  y: 0,
  z,
  yaw: 0.5,
  state: 1,
  speed: 4,
  vy: 0,
  grounded: true,
  emote: null,
});

const send = (c: Conn, msg: unknown) => c.ws.send(JSON.stringify(msg));
const settle = () => new Promise((r) => setTimeout(r, 80));

async function party(n: number): Promise<TestUser[]> {
  const leader = await api.guest();
  const code = (await api.req('POST', '/party', { token: leader.accessToken })).json().party.code as string;
  const out = [leader];
  for (let i = 1; i < n; i++) {
    const m = await api.guest();
    await api.req('POST', '/party/join', { token: m.accessToken, body: { code } });
    out.push(m);
  }
  return out;
}

describe('party lobby gateway', () => {
  it("relays A's frames to B and C only, never back to A or to strangers", async () => {
    const [a, b, c] = (await party(3)) as [TestUser, TestUser, TestUser];
    const d = await api.guest();
    const [ca, cb, cc, cd] = await Promise.all([connect(a), connect(b), connect(c), connect(d)]);

    send(ca, encodeLobbyFrame({ ...pose(), emote: 'emote.wave', state: 13 }, 1));
    const atB = await cb.waitFor(a.id, 1);
    const atC = await cc.waitFor(a.id, 1);
    expect(atB).toMatchObject({
      type: 'party_lobby',
      userId: a.id,
      x: 1,
      z: -0.5,
      state: 13,
      emote: 'emote.wave',
    });
    expect(atC.partyId).toBe(atB.partyId);

    send(cb, encodeLobbyFrame(pose(-2, -1), 1));
    await ca.waitFor(b.id, 1);
    await cc.waitFor(b.id, 1);
    await settle();
    expect(ca.frames.some((f) => f.userId === a.id)).toBe(false);
    expect(cb.frames.some((f) => f.userId === b.id)).toBe(false);
    expect(cd.frames).toHaveLength(0);

    for (const x of [ca, cb, cc, cd]) x.ws.close();
  });

  it('ignores frames from users outside the party', async () => {
    const [a, b] = (await party(2)) as [TestUser, TestUser];
    const outsider = await api.guest();
    const [ca, cb, co] = await Promise.all([connect(a), connect(b), connect(outsider)]);

    send(co, encodeLobbyFrame(pose(), 1));
    await settle();
    send(ca, encodeLobbyFrame(pose(), 9));
    await cb.waitFor(a.id, 9);
    expect(cb.frames.some((f) => f.userId === outsider.id)).toBe(false);
    expect(ca.frames).toHaveLength(0);
    for (const x of [ca, cb, co]) x.ws.close();
  });

  it('stops relaying to a kicked member at once', async () => {
    const [a, b, c] = (await party(3)) as [TestUser, TestUser, TestUser];
    const [ca, cb, cc] = await Promise.all([connect(a), connect(b), connect(c)]);
    send(ca, encodeLobbyFrame(pose(), 1));
    await cc.waitFor(a.id, 1);

    const res = await api.req('POST', '/party/kick', { token: a.accessToken, body: { userId: c.id } });
    expect(res.statusCode).toBe(200);
    send(ca, encodeLobbyFrame(pose(2, 2), 2));
    send(cc, encodeLobbyFrame(pose(3, 0), 1));
    await cb.waitFor(a.id, 2);
    await settle();
    expect(cc.frames.filter((f) => f.seq === 2)).toHaveLength(0);
    expect(cb.frames.some((f) => f.userId === c.id)).toBe(false);
    for (const x of [ca, cb, cc]) x.ws.close();
  });

  it('clamps out-of-range values and drops malformed or oversized frames', async () => {
    const [a, b] = (await party(2)) as [TestUser, TestUser];
    const [ca, cb] = await Promise.all([connect(a), connect(b)]);

    send(ca, { ...encodeLobbyFrame(pose(), 1), x: 'left' });
    send(ca, { ...encodeLobbyFrame(pose(), 2), pad: 'x'.repeat(PARTY_LOBBY_LIMITS.maxBytes) });
    send(ca, { ...encodeLobbyFrame(pose(), 3), x: 400, z: 300, y: -50, state: 77, emote: 'emote.not-real' });
    const clamped = await cb.waitFor(a.id, 3);
    expect(Math.hypot(clamped.x as number, clamped.z as number)).toBeLessThanOrEqual(
      PARTY_LOBBY_LIMITS.radius + 0.01,
    );
    expect(clamped).toMatchObject({
      y: PARTY_LOBBY_LIMITS.minY,
      state: PARTY_LOBBY_LIMITS.maxState,
      emote: null,
    });
    expect(clamped.pad).toBeUndefined();
    expect(cb.frames.map((f) => f.seq)).toEqual([3]);
    for (const x of [ca, cb]) x.ws.close();
  });
});

describe('party lobby relay', () => {
  const relay = () => new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));

  async function inbox(userId: string): Promise<Msg[]> {
    const out: Msg[] = [];
    await api.ctx.kv.subscribe(userChannel(userId), (m) => {
      const e = JSON.parse(m) as Msg;
      if (e.type === 'party_lobby') out.push(e);
    });
    return out;
  }

  it('rate limits per user and refills over time', async () => {
    const [a, b] = (await party(2)) as [TestUser, TestUser];
    const r = relay();
    const got = await inbox(b.id);
    const outcomes = [];
    for (let i = 0; i < PARTY_LOBBY_LIMITS.rateBurst + 10; i++)
      outcomes.push(await r.handle(a.id, encodeLobbyFrame(pose(), i), 100));
    expect(outcomes.filter((o) => o === 'relayed')).toHaveLength(PARTY_LOBBY_LIMITS.rateBurst);
    expect(outcomes.at(-1)).toBe('rate_limited');
    await vi.waitFor(() => expect(got).toHaveLength(PARTY_LOBBY_LIMITS.rateBurst));

    api.clock.advance(1000);
    expect(await r.handle(a.id, encodeLobbyFrame(pose(), 99), 100)).toBe('relayed');
    // Another member has their own bucket.
    expect(await r.handle(b.id, encodeLobbyFrame(pose(), 1), 100)).toBe('relayed');
  });

  it('reports non-members and invalid frames', async () => {
    const [a] = (await party(2)) as [TestUser, TestUser];
    const loner = await api.guest();
    const r = relay();
    expect(await r.handle(loner.id, encodeLobbyFrame(pose(), 1), 100)).toBe('no_party');
    expect(await r.handle(a.id, { type: 'party_lobby', seq: 1, x: null }, 40)).toBe('invalid');
    expect(await r.handle(a.id, encodeLobbyFrame(pose(), 1), PARTY_LOBBY_LIMITS.maxBytes + 1)).toBe(
      'too_large',
    );
  });

  it('relays an owned look once per interval and strips unowned or unknown items', async () => {
    const [a, b] = (await party(2)) as [TestUser, TestUser];
    const r = relay();
    const got = await inbox(b.id);
    const lo = (await api.req('GET', '/loadouts', { token: a.accessToken })).json();
    const { banner: _b, footsteps: _f, ...look } = lo.slots[lo.activeIndex].items;

    await r.handle(a.id, encodeLobbyFrame(pose(), 1, look), 600);
    await r.handle(a.id, encodeLobbyFrame(pose(), 2, look), 600);
    api.clock.advance(PARTY_LOBBY_LIMITS.lookMinIntervalMs);
    await r.handle(a.id, encodeLobbyFrame(pose(), 3, { ...look, headwear: 'headwear.not-a-thing' }), 600);
    const pricey = api.ctx.catalog.cosmetics.find((c) => c.slot === 'headwear' && c.source === 'store');
    await r.handle(a.id, encodeLobbyFrame(pose(), 4, { ...look, headwear: pricey!.id }), 600);

    await vi.waitFor(() => expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4]));
    expect(got[0]!.look).toEqual(look);
    expect(got.slice(1).every((e) => e.look === undefined)).toBe(true);
  });
});
