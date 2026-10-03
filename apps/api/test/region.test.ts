import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('account region', () => {
  it('lets a new guest pick a region, case-insensitively', async () => {
    const res = await api.req('POST', '/auth/guest', { body: { region: 'OCE' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.region).toBe('oce');
    const me = await api.req('GET', '/me', { token: res.json().accessToken });
    expect(me.json().region).toBe('oce');
  });

  it('rejects unknown regions on guest sign-in and PATCH /me', async () => {
    expect((await api.req('POST', '/auth/guest', { body: { region: 'mars' } })).statusCode).toBe(400);
    const u = await api.guest();
    const bad = await api.req('PATCH', '/me', { token: u.accessToken, body: { region: 'moon' } });
    expect(bad.statusCode).toBe(400);
  });

  it('keeps an existing guest region when signing back in', async () => {
    const created = (await api.req('POST', '/auth/guest', { body: { region: 'eu' } })).json();
    const again = await api.req('POST', '/auth/guest', {
      body: { deviceToken: created.deviceToken, region: 'asia' },
    });
    expect(again.json().user.region).toBe('eu');
  });

  it('moves regional leaderboards with the account, even before the token refreshes', async () => {
    const u = await api.guest();
    await api.postMatch(buildShow({ humans: [{ userId: u.id, placement: 1 }] }));
    const naBoard = (
      await api.req('GET', '/leaderboards/crowns?scope=regional', { token: u.accessToken })
    ).json();
    expect(naBoard).toMatchObject({ region: 'na', me: { userId: u.id, score: 1 } });

    const patched = await api.req('PATCH', '/me', { token: u.accessToken, body: { region: 'EU' } });
    expect(patched.json()).toMatchObject({ region: 'eu' });

    // The access token still says `na`; the board follows the stored region.
    const euBoard = (
      await api.req('GET', '/leaderboards/crowns?scope=regional', { token: u.accessToken })
    ).json();
    expect(euBoard).toMatchObject({ region: 'eu', me: { userId: u.id, score: 1 } });
    const oldBoard = (
      await api.req('GET', '/leaderboards/crowns?scope=regional&region=na', { token: u.accessToken })
    ).json();
    expect(oldBoard.me).toBeNull();
    expect(
      (await api.req('GET', '/leaderboards/crowns?scope=regional&region=xx', { token: u.accessToken }))
        .statusCode,
    ).toBe(400);
  });

  it('queues in the stored region by default', async () => {
    const u = await api.guest();
    await api.req('PATCH', '/me', { token: u.accessToken, body: { region: 'asia' } });
    const t = await api.req('POST', '/party/queue-ticket', { token: u.accessToken });
    expect(t.json().claims.region).toBe('asia');
  });
});
