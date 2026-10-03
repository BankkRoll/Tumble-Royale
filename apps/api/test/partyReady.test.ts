/**
 * Party ready checks: members must ready up before every queue, and the
 * leader's ready is pressing Play.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('party ready checks', () => {
  it('blocks the queue until members ready up, then asks them again for the next show', async () => {
    const leader = await api.guest();
    const code = (await api.req('POST', '/party', { token: leader.accessToken })).json().party.code as string;
    const ann = await api.guest();
    const joined = await api.req('POST', '/party/join', { token: ann.accessToken, body: { code } });
    const member = (id: string, p: { members: { userId: string; ready: boolean }[] }) =>
      p.members.find((m) => m.userId === id)!;
    expect(member(ann.id, joined.json().party).ready).toBe(false);
    expect(member(leader.id, joined.json().party).ready).toBe(true);

    const early = await api.req('POST', '/party/queue-ticket', { token: leader.accessToken, body: {} });
    expect(early.json().error).toBe('not_ready');

    await api.req('POST', '/party/ready', { token: ann.accessToken, body: { ready: true } });
    const ticket = await api.req('POST', '/party/queue-ticket', { token: leader.accessToken, body: {} });
    expect(ticket.statusCode).toBe(200);

    const after = (await api.req('GET', '/party', { token: ann.accessToken })).json().party;
    expect(member(ann.id, after).ready).toBe(false);
    expect(member(leader.id, after).ready).toBe(true);
  });

  it('keeps the leader ready whatever they send', async () => {
    const leader = await api.guest();
    await api.req('POST', '/party', { token: leader.accessToken });
    const res = await api.req('POST', '/party/ready', { token: leader.accessToken, body: { ready: false } });
    expect(res.json().party.members[0].ready).toBe(true);
  });
});
