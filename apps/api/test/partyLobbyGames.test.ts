/**
 * Party lobby mini-games through the relay: only the leader's game snapshot
 * reaches the party (and only naming current members), claims come from
 * members only, everything is clamped by the shared sanitiser and the
 * per-user rate limit still applies. Separate from the gateway suite so its
 * guest sign-ups stay under the auth rate limit.
 */
import { randomUUID } from 'node:crypto';
import {
  PARTY_LOBBY_LIMITS,
  encodeLobbyFrame,
  type LobbyGameClaim,
  type LobbyGameWire,
  type LobbyPose,
} from '@tumble/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userChannel } from '../src/realtime/notifier.ts';
import { PartyLobbyRelay } from '../src/realtime/partyLobby.ts';
import { PartyService } from '../src/social/party.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  // The inbox assertions expect pub/sub to deliver synchronously, as the in-process KV does.
  api = await createTestApi(undefined, {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

const pose = (): LobbyPose => ({
  x: 1,
  y: 0,
  z: 1,
  yaw: 0,
  state: 0,
  speed: 0,
  vy: 0,
  grounded: true,
  emote: null,
});

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

async function inbox(userId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  await api.ctx.kv.subscribe(userChannel(userId), (m) => {
    const e = JSON.parse(m) as Record<string, unknown>;
    if (e.type === 'party_lobby') out.push(e);
  });
  return out;
}

const game = (players: string[], over: Partial<LobbyGameWire> = {}): LobbyGameWire => ({
  op: 'start',
  id: 5,
  kind: 'potato',
  phase: 'intro',
  left: 3.5,
  players,
  teams: players.map(() => 0),
  score: players.map(() => 0),
  out: 0,
  it: 0,
  aux: 9,
  targets: [],
  win: 0,
  ...over,
});

const frame = (seq: number, extras: { game?: LobbyGameWire; claim?: LobbyGameClaim }) =>
  encodeLobbyFrame(pose(), seq, null, extras);

describe('party lobby games', () => {
  it('relays the leader game, clamped, and drops games from members or naming strangers', async () => {
    const [lead, b, c] = (await party(3)) as [TestUser, TestUser, TestUser];
    const r = new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));
    const atC = await inbox(c.id);
    const ids = [lead.id, b.id, c.id];

    expect(
      await r.handle(lead.id, frame(1, { game: game(ids, { score: [120, 0, 0], left: 3.54 }) }), 300),
    ).toBe('relayed');
    await r.handle(b.id, frame(1, { game: game(ids) }), 300);
    await r.handle(lead.id, frame(2, { game: game([lead.id, randomUUID()]) }), 300);

    const [fromLead, fromB, fromLead2] = atC;
    expect(fromLead).toMatchObject({
      userId: lead.id,
      game: { kind: 'potato', players: ids, score: [99, 0, 0] },
    });
    expect((fromLead!.game as LobbyGameWire).left).toBe(3.5);
    expect(fromB!.game).toBeUndefined();
    expect(fromLead2!.game).toBeUndefined();
    expect(fromLead2).toMatchObject({ userId: lead.id, x: 1 });
  });

  it('relays member claims to the party and strips bad ones', async () => {
    const [lead, b, c] = (await party(3)) as [TestUser, TestUser, TestUser];
    const r = new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));
    const atLead = await inbox(lead.id);
    const atB = await inbox(b.id);

    await r.handle(b.id, frame(1, { claim: { id: 5, k: 'tag', target: c.id } }), 200);
    await r.handle(b.id, frame(2, { claim: { id: 5, k: 'tag', target: randomUUID() } }), 200);
    await r.handle(b.id, frame(3, { claim: { id: 5, k: 'hit', t: 1, g: 4 } }), 200);
    await r.handle(lead.id, frame(1, { claim: { id: 5, k: 'tag', target: b.id } }), 200);

    expect(atLead[0]).toMatchObject({ userId: b.id, claim: { k: 'tag', target: c.id } });
    expect(atLead[1]!.claim).toBeUndefined();
    expect(atLead[2]).toMatchObject({ claim: { k: 'hit', t: 1, g: 4 } });
    expect(atB[0]!.userId).toBe(lead.id);
    expect(atB[0]!.claim).toBeUndefined();
  });

  it('keeps the per-user rate limit for game frames', async () => {
    const [lead, b] = (await party(2)) as [TestUser, TestUser];
    const r = new PartyLobbyRelay(api.ctx, new PartyService(api.ctx));
    const ids = [lead.id, b.id];
    const outcomes: string[] = [];
    for (let i = 0; i < PARTY_LOBBY_LIMITS.rateBurst + 3; i++)
      outcomes.push(await r.handle(lead.id, frame(i + 1, { game: game(ids, { op: 'state' }) }), 300));
    expect(outcomes.filter((o) => o === 'relayed')).toHaveLength(PARTY_LOBBY_LIMITS.rateBurst);
    expect(outcomes.at(-1)).toBe('rate_limited');
  });
});
