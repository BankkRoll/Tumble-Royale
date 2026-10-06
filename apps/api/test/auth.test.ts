import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, TEST_BINDING, TEST_NONCE, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('guest auth', () => {
  it('creates a guest with tokens, starter items and a profile', async () => {
    const u = await api.guest('Wobbly_Tester');
    expect(u.displayName).toBe('Wobbly_Tester');
    expect(u.tag).toMatch(/^\d{4}$/);
    const me = await api.req('GET', '/me', { token: u.accessToken });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      userId: u.id,
      isGuest: true,
      level: 1,
      wallet: { gumballs: 0, gems: 0 },
    });
    const inv = await api.req('GET', '/inventory', { token: u.accessToken });
    expect(inv.json().items.length).toBeGreaterThan(5);
  });

  it('signs back into the same account with the device token', async () => {
    const u = await api.guest();
    const again = await api.req('POST', '/auth/guest', { body: { deviceToken: u.deviceToken } });
    expect(again.json()).toMatchObject({ created: false, user: { id: u.id } });
  });

  it('rejects requests without or with a bad token', async () => {
    expect((await api.req('GET', '/me')).statusCode).toBe(401);
    expect((await api.req('GET', '/me', { token: 'nope' })).statusCode).toBe(401);
  });

  it('expires access tokens after 15 minutes', async () => {
    const u = await api.guest();
    api.clock.advance(16 * 60_000);
    expect((await api.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(401);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const u = await api.guest();
    const r1 = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const t1 = r1.json();
    expect(t1.refreshToken).not.toBe(u.refreshToken);
    expect((await api.req('GET', '/me', { token: t1.accessToken })).statusCode).toBe(200);

    const r2 = await api.req('POST', '/auth/refresh', { body: { refreshToken: t1.refreshToken } });
    expect(r2.statusCode).toBe(200);
    const t2 = r2.json();

    // Replaying the first (already rotated) token after the grace window revokes the whole family.
    api.clock.advance(31_000);
    const reuse = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error).toBe('refresh_reused');
    const after = await api.req('POST', '/auth/refresh', { body: { refreshToken: t2.refreshToken } });
    expect(after.statusCode).toBe(401);
  });

  it('lets a racing tab refresh with the token another tab just rotated', async () => {
    const u = await api.guest();
    const first = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    api.clock.advance(5_000);
    const racing = await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(racing.statusCode).toBe(200);
    // Both tabs' new tokens keep working: the family was not revoked.
    for (const t of [first.json().refreshToken, racing.json().refreshToken]) {
      expect((await api.req('POST', '/auth/refresh', { body: { refreshToken: t } })).statusCode).toBe(200);
    }
  });

  it('gives no grace to a just-rotated token whose family was logged out', async () => {
    const u = await api.guest();
    const next = (await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).json();
    await api.req('POST', '/auth/logout', { body: { refreshToken: next.refreshToken } });
    expect(
      (await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).statusCode,
    ).toBe(401);
  });

  it('logout revokes the refresh family', async () => {
    const u = await api.guest();
    expect(
      (await api.req('POST', '/auth/logout', { body: { refreshToken: u.refreshToken } })).statusCode,
    ).toBe(204);
    expect(
      (await api.req('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).statusCode,
    ).toBe(401);
  });

  it('reports OAuth providers as disabled without credentials', async () => {
    const res = await api.req('GET', `/auth/discord/start?binding=${'a'.repeat(64)}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('provider_disabled');
    expect((await api.req('GET', '/auth/providers')).json()).toMatchObject({
      discord: false,
      google: false,
      email: true,
    });
  });

  it('upgrades a guest through an email magic link', async () => {
    const u = await api.guest();
    const start = await api.req('POST', '/auth/email/start', {
      token: u.accessToken,
      body: { email: 'Player@Example.com', binding: TEST_BINDING },
    });
    expect(start.statusCode).toBe(202);
    const mail = api.mailer.sent.at(-1)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const body = { token, nonce: TEST_NONCE };
    const verify = await api.req('POST', '/auth/email/verify', { token: u.accessToken, body });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().user).toMatchObject({ id: u.id, isGuest: false });
    expect((await api.req('POST', '/auth/email/verify', { body })).statusCode).toBe(400);
  });

  it('enforces display name rules and cooldown', async () => {
    const u = await api.guest();
    const bad = await api.req('PATCH', '/me', { token: u.accessToken, body: { displayName: 'Sh1tLord' } });
    expect(bad.statusCode).toBe(400);
    const ok = await api.req('PATCH', '/me', { token: u.accessToken, body: { displayName: 'Bouncy Bob' } });
    expect(ok.statusCode).toBe(200);
    const again = await api.req('PATCH', '/me', {
      token: u.accessToken,
      body: { displayName: 'Bouncy Rob' },
    });
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe('name_cooldown');
  });

  it('blocks banned users', async () => {
    const u = await api.guest();
    const ban = await api.req('POST', '/internal/bans', {
      headers: { authorization: 'Bearer test-admin-token-0123456789' },
      body: { userId: u.id, reason: 'testing bans', durationHours: 1 },
    });
    expect(ban.statusCode).toBe(201);
    const me = await api.req('GET', '/me', { token: u.accessToken });
    expect(me.statusCode).toBe(403);
    expect(me.json().error).toBe('banned');
  });
});
