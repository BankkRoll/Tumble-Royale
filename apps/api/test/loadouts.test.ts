import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_CATALOG } from '../src/catalog.ts';
import { createTestApi, type TestApi } from './helpers.ts';

const unownedHat = CONTENT_CATALOG.cosmetics.find((c) => c.slot === 'headwear' && c.source === 'store')!.id;

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

describe('loadouts', () => {
  it('starts with a valid default loadout in slot 0 of 6', async () => {
    const u = await api.guest();
    const res = (await api.req('GET', '/loadouts', { token: u.accessToken })).json();
    expect(res.slots).toHaveLength(6);
    expect(res.activeIndex).toBe(0);
    expect(res.slots[0].items).toEqual(CONTENT_CATALOG.defaultLoadout());
    expect(res.slots[1]).toBeNull();
  });

  it('saves a loadout made of owned items and activates it', async () => {
    const u = await api.guest();
    const items = (await api.req('GET', '/loadouts', { token: u.accessToken })).json().slots[0].items;
    const put = await api.req('PUT', '/loadouts/2', {
      token: u.accessToken,
      body: {
        name: 'Minty',
        items: { ...items, colors: ['#5ce1e6', '#ffffff', '#123456'], pattern: 'pattern.stripes' },
      },
    });
    expect(put.statusCode).toBe(200);
    const act = await api.req('POST', '/loadouts/2/activate', { token: u.accessToken });
    expect(act.json()).toMatchObject({
      activeIndex: 2,
      items: { colors: ['#5ce1e6', '#ffffff', '#123456'], pattern: 'pattern.stripes' },
    });
    expect((await api.req('DELETE', '/loadouts/2', { token: u.accessToken })).statusCode).toBe(409);
  });

  it('rejects unowned items with 403 not_owned', async () => {
    const u = await api.guest();
    const items = (await api.req('GET', '/loadouts', { token: u.accessToken })).json().slots[0].items;
    const res = await api.req('PUT', '/loadouts/1', {
      token: u.accessToken,
      body: { items: { ...items, headwear: unownedHat } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'not_owned', details: { items: [unownedHat] } });
  });

  it('rejects items in the wrong slot and unknown ids', async () => {
    const u = await api.guest();
    const items = (await api.req('GET', '/loadouts', { token: u.accessToken })).json().slots[0].items;
    const wrong = await api.req('PUT', '/loadouts/1', {
      token: u.accessToken,
      body: { items: { ...items, face: 'pattern.stripes' } },
    });
    expect(wrong.json().error).toBe('invalid_loadout');
    const unknown = await api.req('PUT', '/loadouts/1', {
      token: u.accessToken,
      body: { items: { ...items, back: 'back.nonexistent' } },
    });
    expect(unknown.json().error).toBe('invalid_loadout');
    const badIndex = await api.req('PUT', '/loadouts/6', { token: u.accessToken, body: { items } });
    expect(badIndex.statusCode).toBe(400);
  });
});
