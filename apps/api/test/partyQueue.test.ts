/**
 * The party queue handshake: ready votes are spent only once the matchmaker
 * accepted the ticket (`/party/queued`), members still in a show block the
 * queue by name, and a member playing on their own tells the party.
 * Runs on memory storage and, in CI, on Redis + Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userChannel, type RealtimeEvent } from '../src/realtime/notifier.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

type Member = { userId: string; ready: boolean };

describe.each(BACKENDS)('party queue handshake ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(undefined, backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  async function party(n: number): Promise<{ leader: TestUser; members: TestUser[] }> {
    const leader = await api.guest();
    const code = (await api.req('POST', '/party', { token: leader.accessToken })).json().party.code as string;
    const members: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const m = await api.guest();
      await api.req('POST', '/party/join', { token: m.accessToken, body: { code } });
      await api.req('POST', '/party/ready', { token: m.accessToken, body: { ready: true } });
      members.push(m);
    }
    return { leader, members };
  }

  const readyOf = async (u: TestUser, id: string): Promise<boolean> => {
    const p = (await api.req('GET', '/party', { token: u.accessToken })).json().party as {
      members: Member[];
    };
    return p.members.find((m) => m.userId === id)!.ready;
  };

  const ticket = (u: TestUser) => api.req('POST', '/party/queue-ticket', { token: u.accessToken, body: {} });

  const presence = (u: TestUser, status: string) =>
    api.req('POST', '/presence', { token: u.accessToken, body: { status } });

  async function listen(userId: string): Promise<RealtimeEvent[]> {
    const out: RealtimeEvent[] = [];
    await api.ctx.kv.subscribe(userChannel(userId), (m) => out.push(JSON.parse(m) as RealtimeEvent));
    return out;
  }

  it('keeps ready votes when the ticket is issued but the enqueue never succeeds', async () => {
    const { leader, members } = await party(1);
    const ann = members[0]!;
    expect((await ticket(leader)).statusCode).toBe(200);
    // The matchmaker refused (e.g. in_lobby): the leader never confirms, so Ann is still ready.
    expect(await readyOf(ann, ann.id)).toBe(true);
    // A retry needs no fresh votes.
    expect((await ticket(leader)).statusCode).toBe(200);
  });

  it('spends the votes once the leader confirms the enqueue', async () => {
    const { leader, members } = await party(2);
    expect((await ticket(leader)).statusCode).toBe(200);
    const res = await api.req('POST', '/party/queued', { token: leader.accessToken });
    expect(res.statusCode).toBe(200);
    const after = res.json().party as { members: Member[] };
    for (const m of members) expect(after.members.find((x) => x.userId === m.id)!.ready).toBe(false);
    expect(after.members.find((x) => x.userId === leader.id)!.ready).toBe(true);
    expect((await ticket(leader)).json().error).toBe('not_ready');
  });

  it('only lets the leader confirm, and is a no-op for a solo player', async () => {
    const { members } = await party(1);
    const res = await api.req('POST', '/party/queued', { token: members[0]!.accessToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_leader');
    const solo = await api.guest();
    const s = await api.req('POST', '/party/queued', { token: solo.accessToken });
    expect(s.statusCode).toBe(200);
    expect(s.json().party).toBeNull();
  });

  it('refuses to queue while a member is still in a show, naming them', async () => {
    const { leader, members } = await party(2);
    const [ann, bob] = members as [TestUser, TestUser];
    await presence(ann, 'in_match');
    const one = await ticket(leader);
    expect(one.statusCode).toBe(409);
    expect(one.json().error).toBe('member_busy');
    expect(one.json().message).toBe(`${ann.displayName} is still in a show`);

    await presence(bob, 'in_queue');
    expect((await ticket(leader)).json().message).toBe(
      `${ann.displayName}, ${bob.displayName} are still in a show`,
    );

    await presence(ann, 'in_menu');
    await presence(bob, 'online');
    expect((await ticket(leader)).statusCode).toBe(200);
  });

  it("never blocks on the leader's own stale presence", async () => {
    const { leader } = await party(1);
    await presence(leader, 'in_queue');
    expect((await ticket(leader)).statusCode).toBe(200);
  });

  it('reports a busy member before an unready one', async () => {
    const { leader, members } = await party(1);
    const ann = members[0]!;
    await api.req('POST', '/party/ready', { token: ann.accessToken, body: { ready: false } });
    await presence(ann, 'in_match');
    expect((await ticket(leader)).json().error).toBe('member_busy');
  });

  it('tells the party when a member plays solo and withdraws their vote', async () => {
    const { leader, members } = await party(2);
    const [ann, bob] = members as [TestUser, TestUser];
    const seen = await listen(leader.id);
    const annSeen = await listen(ann.id);

    const res = await api.req('POST', '/party/solo', { token: ann.accessToken, body: { playing: true } });
    expect(res.statusCode).toBe(200);
    await backend.settle();
    expect(await readyOf(bob, ann.id)).toBe(false);
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'party_solo', userId: ann.id, leader: false, playing: true }),
    );
    // The player who went solo is not told about themselves.
    expect(annSeen.some((e) => e.type === 'party_solo')).toBe(false);

    await api.req('POST', '/party/solo', { token: ann.accessToken, body: { playing: false } });
    await backend.settle();
    expect(seen.filter((e) => e.type === 'party_solo').at(-1)).toMatchObject({ playing: false });
  });

  it("announces the leader's solo show without touching anyone's vote", async () => {
    const { leader, members } = await party(1);
    const ann = members[0]!;
    const seen = await listen(ann.id);
    await api.req('POST', '/party/solo', { token: leader.accessToken, body: { playing: true } });
    await backend.settle();
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'party_solo', userId: leader.id, leader: true, playing: true }),
    );
    expect(await readyOf(ann, ann.id)).toBe(true);
    expect(await readyOf(ann, leader.id)).toBe(true);
  });

  it('answers a solo player with no party', async () => {
    const solo = await api.guest();
    const res = await api.req('POST', '/party/solo', { token: solo.accessToken, body: { playing: true } });
    expect(res.json()).toEqual({ party: null });
  });
});
