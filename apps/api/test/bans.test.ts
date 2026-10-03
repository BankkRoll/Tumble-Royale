import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('ban enforcement', () => {
  it('refuses refresh rotation and device sign-in while an all ban is active', async () => {
    const u = await api.guest();
    await api.ban(u.id);
    const refresh = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json()).toMatchObject({ error: 'banned', details: { reason: 'testing bans' } });
    const device = await api.req('POST', '/auth/guest', { body: { deviceToken: u.deviceToken } });
    expect(device.statusCode).toBe(403);

    // The session survives the ban, so the player can come back once it lapses.
    api.clock.advance(61 * 60_000);
    const later = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(later.statusCode).toBe(200);
  });

  it('still lets ranked- and chat-banned players refresh', async () => {
    const u = await api.guest();
    await api.ban(u.id, 'ranked');
    await api.ban(u.id, 'chat');
    const refresh = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(refresh.statusCode).toBe(200);
  });

  it('answers signed ban lookups from the matchmaker', async () => {
    const a = await api.guest();
    const b = await api.guest();
    await api.ban(a.id, 'chat');
    const res = await api.internal('/internal/bans/lookup', { userIds: [a.id, b.id, 'not-a-uuid'] });
    expect(res.statusCode).toBe(200);
    const bans = res.json().bans;
    expect(bans[a.id]).toEqual([expect.objectContaining({ scope: 'chat', reason: 'testing bans' })]);
    expect(bans[b.id]).toEqual([]);
    expect(bans['not-a-uuid']).toEqual([]);

    const unsigned = await api.req('POST', '/internal/bans/lookup', { body: { userIds: [a.id] } });
    expect(unsigned.statusCode).toBe(401);
    const forged = await api.internal(
      '/internal/bans/lookup',
      { userIds: [a.id] },
      { secret: 'x'.repeat(32) },
    );
    expect(forged.statusCode).toBe(401);
  });

  it('refuses a queue ticket when any party member is suspended', async () => {
    const leader = await api.guest();
    const member = await api.guest();
    const created = await api.req('POST', '/party', { token: leader.accessToken });
    const code = created.json().party.code as string;
    await api.req('POST', '/party/join', { token: member.accessToken, body: { code } });
    await api.req('POST', '/party/ready', { token: member.accessToken, body: { ready: true } });
    expect((await api.req('POST', '/party/queue-ticket', { token: leader.accessToken })).statusCode).toBe(
      200,
    );

    // Each queue uses up the members' ready; ready again so only the ban can refuse.
    await api.req('POST', '/party/ready', { token: member.accessToken, body: { ready: true } });
    await api.ban(member.id);
    const res = await api.req('POST', '/party/queue-ticket', { token: leader.accessToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('member_banned');
  });
});
