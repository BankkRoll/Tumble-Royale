/**
 * Party leader tools: kicking members and handing leadership over, with the
 * realtime events every member relies on to update their party slots.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userChannel, type RealtimeEvent } from '../src/realtime/notifier.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

async function events(userId: string): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  await api.ctx.kv.subscribe(userChannel(userId), (m) => out.push(JSON.parse(m) as RealtimeEvent));
  return out;
}

async function party(n: number): Promise<{ leader: TestUser; members: TestUser[]; code: string }> {
  const leader = await api.guest();
  const code = (await api.req('POST', '/party', { token: leader.accessToken })).json().party.code as string;
  const members: TestUser[] = [];
  for (let i = 0; i < n; i++) {
    const m = await api.guest();
    await api.req('POST', '/party/join', { token: m.accessToken, body: { code } });
    members.push(m);
  }
  return { leader, members, code };
}

type PartyEvent = Extract<RealtimeEvent, { type: 'party_update' }>;
const lastParty = (evs: RealtimeEvent[]) =>
  (evs.filter((e): e is PartyEvent => e.type === 'party_update').at(-1)?.party ?? null) as {
    leaderId: string;
    members: { userId: string; ready: boolean }[];
  } | null;

describe('party leader tools', () => {
  it('kicks a member: they are told, the others see it, and the code no longer works for them', async () => {
    const { leader, members, code } = await party(2);
    const [ann, bob] = members as [TestUser, TestUser];
    const annEvents = await events(ann.id);
    const bobEvents = await events(bob.id);

    const denied = await api.req('POST', '/party/kick', { token: bob.accessToken, body: { userId: ann.id } });
    expect(denied.json().error).toBe('not_leader');

    const res = await api.req('POST', '/party/kick', { token: leader.accessToken, body: { userId: ann.id } });
    expect(res.statusCode).toBe(200);
    expect(annEvents.some((e) => e.type === 'party_kicked')).toBe(true);
    expect(lastParty(bobEvents)!.members.map((m) => m.userId)).toEqual([leader.id, bob.id]);
    expect((await api.req('GET', '/party', { token: ann.accessToken })).json().party).toBeNull();
    const rejoin = await api.req('POST', '/party/join', { token: ann.accessToken, body: { code } });
    expect(rejoin.json().error).toBe('kicked');
  });

  it('promotes a member to leader and moves every leader right with it', async () => {
    const { leader, members } = await party(2);
    const [ann, bob] = members as [TestUser, TestUser];
    const leaderEvents = await events(leader.id);
    const bobEvents = await events(bob.id);

    expect(
      (await api.req('POST', '/party/promote', { token: ann.accessToken, body: { userId: bob.id } })).json()
        .error,
    ).toBe('not_leader');
    expect(
      (
        await api.req('POST', '/party/promote', { token: leader.accessToken, body: { userId: leader.id } })
      ).json().error,
    ).toBe('already_leader');
    const outsider = await api.guest();
    expect(
      (await api.req('POST', '/party/promote', { token: leader.accessToken, body: { userId: outsider.id } }))
        .statusCode,
    ).toBe(404);

    const res = await api.req('POST', '/party/promote', {
      token: leader.accessToken,
      body: { userId: ann.id },
    });
    expect(res.json().party.leaderId).toBe(ann.id);
    expect(res.json().party.members.find((m: { userId: string }) => m.userId === ann.id).ready).toBe(true);
    expect(lastParty(leaderEvents)!.leaderId).toBe(ann.id);
    expect(lastParty(bobEvents)!.leaderId).toBe(ann.id);

    // The old leader is now a regular member.
    const oldKick = await api.req('POST', '/party/kick', {
      token: leader.accessToken,
      body: { userId: bob.id },
    });
    expect(oldKick.json().error).toBe('not_leader');
    const newKick = await api.req('POST', '/party/kick', {
      token: ann.accessToken,
      body: { userId: leader.id },
    });
    expect(newKick.json().party.members.map((m: { userId: string }) => m.userId)).toEqual([ann.id, bob.id]);
  });
});
