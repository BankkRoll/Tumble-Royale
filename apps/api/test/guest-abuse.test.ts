/**
 * Throwaway-account limits: new guests per address per hour, the account age
 * a guest needs before posting in global chat, and the global chat budget an
 * address shares across all of its accounts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sendGlobalChat } from '../src/social/globalChat.ts';
import { createTestApi, type TestApi } from './helpers.ts';

const opened: TestApi[] = [];
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close();
});
async function make(env: Record<string, string>) {
  // Account rows take created_at from the database's own clock, so the API clock starts at real time.
  const api = await createTestApi(new Date().toISOString(), env);
  opened.push(api);
  return api;
}

describe('guest sign-ups', () => {
  it('caps new guests per address per hour but lets returning guests in', async () => {
    const api = await make({ GUEST_SIGNUPS_PER_IP_HOUR: '2' });
    const ip = '10.77.0.1';
    const mint = () => api.req('POST', '/auth/guest', { body: {}, ip });
    const first = await mint();
    expect(first.statusCode).toBe(200);
    expect((await mint()).statusCode).toBe(200);
    const third = await mint();
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('guest_limit');
    const back = await api.req('POST', '/auth/guest', {
      body: { deviceToken: first.json().deviceToken },
      ip,
    });
    expect(back.statusCode).toBe(200);
    expect((await api.req('POST', '/auth/guest', { body: {}, ip: '10.77.0.2' })).statusCode).toBe(200);
    api.clock.advance(3_600_000);
    expect((await mint()).statusCode).toBe(200);
  });
});

describe('global chat', () => {
  it('makes a fresh guest wait before posting, but not a linked account', async () => {
    const api = await make({ GLOBAL_CHAT_MIN_ACCOUNT_AGE_MINUTES: '10' });
    const guest = await api.guest();
    await expect(sendGlobalChat(api.ctx, guest.id, 'hello')).rejects.toMatchObject({
      status: 403,
      code: 'chat_too_new',
    });
    const linked = await api.account();
    await expect(sendGlobalChat(api.ctx, linked.id, 'hello')).resolves.toBeTruthy();
    api.clock.advance(11 * 60_000);
    await expect(sendGlobalChat(api.ctx, guest.id, 'hello again')).resolves.toBeTruthy();
  });

  it('shares one budget across every account on an address', async () => {
    const api = await make({ GLOBAL_CHAT_IP_MAX: '3' });
    const users = await Promise.all([api.guest(), api.guest(), api.guest(), api.guest()]);
    const ip = '10.78.0.1';
    for (const u of users.slice(0, 3))
      await expect(sendGlobalChat(api.ctx, u.id, 'hi', ip)).resolves.toBeTruthy();
    await expect(sendGlobalChat(api.ctx, users[3]!.id, 'hi', ip)).rejects.toMatchObject({
      code: 'chat_rate',
    });
    await expect(sendGlobalChat(api.ctx, users[3]!.id, 'hi', '10.78.0.2')).resolves.toBeTruthy();
  });
});
