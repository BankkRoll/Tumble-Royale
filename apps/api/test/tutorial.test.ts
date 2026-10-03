/**
 * `POST /me/tutorial-complete`: the one-time Practice Island reward.
 */
import { TUTORIAL_REWARD } from '@tumble/content/progression';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../src/db/schema.ts';
import { TUTORIAL_GRANT_EVENT } from '../src/progression/tutorial.ts';
import { createTestApi, type TestApi } from './helpers.ts';

describe('POST /me/tutorial-complete', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  const owned = async (token: string): Promise<string[]> => {
    const res = await api.req('GET', '/inventory', { token });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string }[] }).items.map((i) => i.id);
  };

  it('needs a signed-in account', async () => {
    expect((await api.req('POST', '/me/tutorial-complete')).statusCode).toBe(401);
  });

  it('grants the XP and the nameplate once, with an audit row', async () => {
    const u = await api.guest();
    const before = (await api.req('GET', '/me', { token: u.accessToken })).json() as {
      xp: { total: number };
    };
    const first = await api.req('POST', '/me/tutorial-complete', { token: u.accessToken });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      granted: true,
      xp: TUTORIAL_REWARD.xp,
      unlock: TUTORIAL_REWARD.cosmeticId,
    });
    expect(first.json().totalXp).toBe(before.xp.total + TUTORIAL_REWARD.xp);
    expect(await owned(u.accessToken)).toContain(TUTORIAL_REWARD.cosmeticId);

    const again = await api.req('POST', '/me/tutorial-complete', { token: u.accessToken });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      granted: false,
      xp: 0,
      unlock: null,
      totalXp: first.json().totalXp,
    });

    const audit = await api.ctx.db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.name, TUTORIAL_GRANT_EVENT)));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.props).toMatchObject({ xp: TUTORIAL_REWARD.xp, cosmeticId: TUTORIAL_REWARD.cosmeticId });
  });

  it('grants exactly once under concurrent calls', async () => {
    const u = await api.guest();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api.req('POST', '/me/tutorial-complete', { token: u.accessToken })),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().granted === true)).toHaveLength(1);
  });

  it('cannot be pre-empted through the public analytics endpoint', async () => {
    const u = await api.guest();
    const forged = await api.req('POST', '/events', {
      token: u.accessToken,
      body: { events: [{ name: TUTORIAL_GRANT_EVENT }] },
    });
    expect(forged.statusCode).toBe(400);
    const res = await api.req('POST', '/me/tutorial-complete', { token: u.accessToken });
    expect(res.json().granted).toBe(true);
  });
});
