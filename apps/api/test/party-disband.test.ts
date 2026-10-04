import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userChannel, type RealtimeEvent } from '../src/realtime/notifier.ts';
import { createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  // Asserts realtime events right after each call: in-process pub/sub delivers synchronously.
  api = await createTestApi(undefined, {}, { memoryKv: true });
});
afterAll(async () => {
  await api.close();
});

async function events(userId: string): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  await api.ctx.kv.subscribe(userChannel(userId), (m) => out.push(JSON.parse(m) as RealtimeEvent));
  return out;
}

describe('party_disbanded', () => {
  it('tells every member when the leader disbands', async () => {
    const leader = await api.guest();
    const member = await api.guest();
    const code = (await api.req('POST', '/party', { token: leader.accessToken })).json().party.code;
    const partyId = (
      await api.req('POST', '/party/join', { token: member.accessToken, body: { code } })
    ).json().party.id;
    const seen = await events(member.id);

    expect((await api.req('POST', '/party/disband', { token: member.accessToken })).statusCode).toBe(403);
    expect((await api.req('POST', '/party/disband', { token: leader.accessToken })).statusCode).toBe(204);
    expect(seen).toContainEqual({ type: 'party_disbanded', partyId });
    expect((await api.req('GET', '/party', { token: member.accessToken })).json().party).toBeNull();
    expect((await api.req('GET', '/party', { token: leader.accessToken })).json().party).toBeNull();
    expect((await api.req('GET', `/party/code/${code}`, { token: leader.accessToken })).statusCode).toBe(404);
  });

  it('is sent when the last member leaves', async () => {
    const solo = await api.guest();
    const partyId = (await api.req('POST', '/party', { token: solo.accessToken })).json().party.id;
    const seen = await events(solo.id);
    await api.req('POST', '/party/leave', { token: solo.accessToken });
    expect(seen).toContainEqual({ type: 'party_disbanded', partyId });
  });
});
