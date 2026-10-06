/**
 * Wish lists: adding, the cap, removing and reordering, privacy toward
 * friends, strangers and blocks, the once-a-day store alert and its switch,
 * and entries leaving the list once the item is bought.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STORE_SETS } from '@tumble/content/cosmetics';
import { wishlistItems } from '../src/db/schema.ts';
import { rotationForDay } from '../src/economy/store.ts';
import { grantCosmetic } from '../src/economy/wallet.ts';
import { WISHLIST_LIMIT } from '../src/economy/wishlist.ts';
import type { RealtimeEvent } from '../src/realtime/notifier.ts';
import { dayKey } from '../src/util/time.ts';
import { createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const T0 = new Date('2026-10-02T12:00:00.000Z');

describe.each(BACKENDS)('wish lists ($name)', (backend) => {
  let api: TestApi;
  const events: { userId: string; event: RealtimeEvent }[] = [];
  beforeAll(async () => {
    api = await createTestApi(T0.toISOString(), backend.env);
    const real = api.ctx.notifier.notifyUser.bind(api.ctx.notifier);
    vi.spyOn(api.ctx.notifier, 'notifyUser').mockImplementation(async (userId, event) => {
      events.push({ userId, event });
      await real(userId, event);
    });
  });
  afterAll(async () => {
    await api.close();
  });

  const storeIds = () =>
    api.ctx.catalog.cosmetics.filter((c) => c.source === 'store' && c.price !== null).map((c) => c.id);
  const add = (u: TestUser, itemId: string) =>
    api.req('POST', '/wishlist', { token: u.accessToken, body: { itemId } });
  const list = async (u: TestUser) => (await api.req('GET', '/wishlist', { token: u.accessToken })).json();
  const alertsFor = (u: TestUser) =>
    events.filter((e) => e.userId === u.id && e.event.type === 'wishlist_in_store').map((e) => e.event);

  async function befriend(a: TestUser, b: TestUser): Promise<void> {
    await api.req('POST', '/friends/request', { token: a.accessToken, body: { userId: b.id } });
    await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
  }

  it('adds store items and bundles in order, once each, with today’s prices', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const [first, second] = storeIds();
    const bundle = `bundle:${STORE_SETS[0]!.id}`;
    for (const id of [first!, bundle, second!, first!]) expect((await add(u, id)).statusCode).toBe(200);
    const view = await list(u);
    expect(view).toMatchObject({ visibility: 'friends', alerts: true, limit: WISHLIST_LIMIT });
    expect(view.entries.map((e: { itemId: string }) => e.itemId)).toEqual([first, bundle, second]);
    expect(view.entries[1]).toMatchObject({ kind: 'bundle', owned: false, price: expect.any(Object) });
    expect(view.entries[0].price).toMatchObject({ amount: expect.any(Number) });
  });

  it('only takes things the store sells, and nothing already owned', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const pass = api.ctx.catalog.cosmetics.find((c) => c.source === 'pass')!;
    expect((await add(u, pass.id)).json().error).toBe('offer_not_available');
    expect((await add(u, 'bundle:nope')).json().error).toBe('offer_not_available');
    const id = storeIds()[3]!;
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, u.id, id, 'event'));
    const owned = await add(u, id);
    expect([owned.statusCode, owned.json().error]).toEqual([409, 'already_owned']);
  });

  it(`holds at most ${WISHLIST_LIMIT} entries`, async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const ids = storeIds();
    expect(ids.length).toBeGreaterThan(WISHLIST_LIMIT);
    await api.ctx.db
      .insert(wishlistItems)
      .values(ids.slice(0, WISHLIST_LIMIT).map((itemId, position) => ({ userId: u.id, itemId, position })));
    const full = await add(u, ids[WISHLIST_LIMIT]!);
    expect([full.statusCode, full.json().error]).toEqual([409, 'wishlist_full']);
    expect((await add(u, ids[0]!)).statusCode).toBe(200);
  });

  it('removes and reorders, refusing an order that does not match the list', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const [a, b, c] = storeIds();
    for (const id of [a!, b!, c!]) await add(u, id);
    const reordered = await api.req('PUT', '/wishlist/order', {
      token: u.accessToken,
      body: { itemIds: [c, a, b] },
    });
    expect(reordered.json().entries.map((e: { itemId: string }) => e.itemId)).toEqual([c, a, b]);
    const stale = await api.req('PUT', '/wishlist/order', {
      token: u.accessToken,
      body: { itemIds: [a, b] },
    });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'wishlist_changed']);
    const dupes = await api.req('PUT', '/wishlist/order', {
      token: u.accessToken,
      body: { itemIds: [a, a, b] },
    });
    expect(dupes.statusCode).toBe(409);
    const removed = await api.req('DELETE', `/wishlist/${a}`, { token: u.accessToken });
    expect(removed.json().entries.map((e: { itemId: string }) => e.itemId)).toEqual([c, b]);
    const bundle = `bundle:${STORE_SETS[0]!.id}`;
    await add(u, bundle);
    const gone = await api.req('DELETE', `/wishlist/${encodeURIComponent(bundle)}`, { token: u.accessToken });
    expect(gone.json().entries).toHaveLength(2);
  });

  it('shows the list to friends only, and answers strangers, blocks and hidden lists alike', async () => {
    api.clock.set(T0.toISOString());
    const owner = await api.guest();
    const friend = await api.guest();
    const stranger = await api.guest();
    const blocker = await api.guest();
    await befriend(owner, friend);
    await befriend(owner, blocker);
    const id = storeIds()[5]!;
    await add(owner, id);
    const peek = (u: TestUser) => api.req('GET', `/players/${owner.id}/wishlist`, { token: u.accessToken });
    const seen = await peek(friend);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().entries.map((e: { itemId: string }) => e.itemId)).toEqual([id]);
    const strange = await peek(stranger);
    expect([strange.statusCode, strange.json().error]).toEqual([403, 'wishlist_hidden']);
    await api.req('POST', '/friends/block', { token: owner.accessToken, body: { userId: blocker.id } });
    expect((await peek(blocker)).json()).toEqual(strange.json());
    const ghost = await api.req('GET', `/players/${randomUUID()}/wishlist`, { token: friend.accessToken });
    expect(ghost.json()).toEqual(strange.json());
    const hide = await api.req('PATCH', '/wishlist/settings', {
      token: owner.accessToken,
      body: { visibility: 'nobody' },
    });
    expect(hide.json().visibility).toBe('nobody');
    expect((await peek(friend)).json()).toEqual(strange.json());
    expect(
      (await api.req('GET', `/players/${owner.id}/wishlist`, { token: owner.accessToken })).statusCode,
    ).toBe(200);
    expect(
      (await api.req('PATCH', '/wishlist/settings', { token: owner.accessToken, body: {} })).statusCode,
    ).toBe(400);
  });

  it('hides items the owner already has from friends', async () => {
    api.clock.set(T0.toISOString());
    const owner = await api.guest();
    const friend = await api.guest();
    await befriend(owner, friend);
    const [keep, got] = storeIds().slice(10, 12);
    await add(owner, keep!);
    await add(owner, got!);
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, owner.id, got!, 'event'));
    const seen = await api.req('GET', `/players/${owner.id}/wishlist`, { token: friend.accessToken });
    expect(seen.json().entries.map((e: { itemId: string }) => e.itemId)).toEqual([keep]);
    expect((await list(owner)).entries.find((e: { itemId: string }) => e.itemId === got).owned).toBe(true);
  });

  it('alerts once per rotation when a wished item is on today’s shelves, and never with alerts off', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const today = rotationForDay(api.ctx.catalog, dayKey(api.clock.now()));
    const onShelf = today.daily[0]!.offerId;
    await add(u, onShelf);
    await api.req('GET', '/store', { token: u.accessToken });
    await api.req('GET', '/store', { token: u.accessToken });
    await api.req('GET', '/wishlist', { token: u.accessToken });
    expect(alertsFor(u)).toEqual([
      { type: 'wishlist_in_store', day: dayKey(T0), items: [{ itemId: onShelf, title: expect.any(String) }] },
    ]);

    const quiet = await api.guest();
    await add(quiet, onShelf);
    await api.req('PATCH', '/wishlist/settings', { token: quiet.accessToken, body: { alerts: false } });
    await api.req('GET', '/store', { token: quiet.accessToken });
    expect(alertsFor(quiet)).toEqual([]);

    const later = new Date(T0.getTime() + 86_400_000);
    const tomorrow = rotationForDay(api.ctx.catalog, dayKey(later));
    const nobody = await api.guest();
    const offShelf = storeIds().find(
      (id) =>
        ![...today.featured, ...today.daily, ...today.weekly].some((o) => o.offerId === id) &&
        ![...tomorrow.featured, ...tomorrow.daily, ...tomorrow.weekly].some((o) => o.offerId === id),
    )!;
    await add(nobody, offShelf);
    await api.req('GET', '/store', { token: nobody.accessToken });
    expect(alertsFor(nobody)).toEqual([]);
  });

  it('alerts again on the next rotation', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const d1 = rotationForDay(api.ctx.catalog, dayKey(T0));
    const d2 = rotationForDay(api.ctx.catalog, dayKey(new Date(T0.getTime() + 86_400_000)));
    await add(u, d1.daily[0]!.offerId);
    await add(u, d2.daily[0]!.offerId);
    await api.req('GET', '/wishlist', { token: u.accessToken });
    api.clock.set('2026-10-03T00:00:05.000Z');
    const relog = await api.req('POST', '/auth/guest', {
      body: { deviceToken: u.deviceToken },
      ip: '10.79.0.1',
    });
    u.accessToken = relog.json().accessToken;
    await api.req('GET', '/wishlist', { token: u.accessToken });
    expect(alertsFor(u).map((e) => (e as { day: string }).day)).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('drops an entry once the player buys it', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    const item = api.ctx.catalog.cosmetics.find(
      (c) => c.source === 'store' && c.price?.currency === 'gumballs',
    )!;
    await api.grant(u.id, 'gumballs', 100_000);
    await add(u, item.id);
    const buy = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers: { 'idempotency-key': `buy-${randomUUID()}` },
      body: { offerId: item.id },
    });
    expect(buy.statusCode, buy.body).toBe(200);
    expect((await list(u)).entries).toHaveLength(0);
    expect(await api.ctx.db.select().from(wishlistItems).where(eq(wishlistItems.userId, u.id))).toHaveLength(
      0,
    );
  });

  it('goes away with the account', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await add(u, storeIds()[7]!);
    await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect(await api.ctx.db.select().from(wishlistItems).where(eq(wishlistItems.userId, u.id))).toHaveLength(
      0,
    );
  });
});
