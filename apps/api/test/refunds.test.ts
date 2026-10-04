/**
 * Self-service store refunds: the policy as a pure function (every rule and
 * window boundary), then the real routes on every storage backend: refunding
 * items and bundles, equipped items, the yearly limit, double and concurrent
 * submits, kill switches, erased accounts and the purchase history.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_SETS } from '@tumble/content/cosmetics';
import type { CatalogCosmetic } from '../src/catalog.ts';
import { currenciesLedger, inventoryItems, loadouts, purchases, refunds } from '../src/db/schema.ts';
import { applyLedger, verifyLedger } from '../src/economy/ledger.ts';
import { grantCosmetic } from '../src/economy/wallet.ts';
import {
  REAL_MONEY_REFUND_WINDOW_DAYS,
  refundEligibility,
  SELF_REFUND_LIMIT,
  SELF_REFUND_LIMIT_WINDOW_DAYS,
  SELF_REFUND_WINDOW_DAYS,
  type RefundablePurchase,
  type RefundContext,
} from '../src/economy/refunds.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-10-02T12:00:00.000Z');

describe('refund policy', () => {
  const item = (over: Partial<RefundablePurchase> = {}): RefundablePurchase => ({
    kind: 'cosmetic',
    status: 'completed',
    at: T0,
    items: ['hat.a'],
    ...over,
  });
  const ctx = (over: Partial<RefundContext> = {}): RefundContext => ({
    existing: null,
    owned: new Set(['hat.a', 'hat.b']),
    recentSelfRefunds: [],
    now: new Date(T0.getTime() + DAY),
    ...over,
  });
  const at = (ms: number) => new Date(T0.getTime() + ms);

  it('allows a store purchase inside the window and reports when it closes', () => {
    expect(refundEligibility(item(), ctx())).toEqual({
      eligible: true,
      kind: 'self_service',
      until: at(SELF_REFUND_WINDOW_DAYS * DAY),
    });
  });

  it('closes the self-service window exactly at seven days (half-open)', () => {
    const last = refundEligibility(item(), ctx({ now: at(SELF_REFUND_WINDOW_DAYS * DAY - 1) }));
    expect(last.eligible).toBe(true);
    const closed = refundEligibility(item(), ctx({ now: at(SELF_REFUND_WINDOW_DAYS * DAY) }));
    expect(closed).toMatchObject({ eligible: false, reason: 'refund_window_expired' });
  });

  it('gives Gem packs the longer request window and makes them staff requests', () => {
    const pack = item({ kind: 'gem_pack', items: [] });
    expect(refundEligibility(pack, ctx({ now: at(REAL_MONEY_REFUND_WINDOW_DAYS * DAY - 1) }))).toMatchObject({
      eligible: true,
      kind: 'real_money',
    });
    expect(refundEligibility(pack, ctx({ now: at(REAL_MONEY_REFUND_WINDOW_DAYS * DAY) }))).toMatchObject({
      reason: 'refund_window_expired',
    });
  });

  it('never refunds the Season Pass or the Crown Shard shop', () => {
    expect(refundEligibility(item({ kind: 'pass_premium', items: [] }), ctx())).toMatchObject({
      reason: 'refund_not_refundable',
    });
    expect(refundEligibility(item({ kind: 'shard_item' }), ctx())).toMatchObject({
      reason: 'refund_not_refundable',
    });
    expect(refundEligibility(item({ kind: 'mystery' }), ctx())).toMatchObject({
      reason: 'refund_not_refundable',
    });
  });

  it('refuses purchases that never completed or were already refunded', () => {
    expect(refundEligibility(item({ status: 'pending' }), ctx())).toMatchObject({
      reason: 'refund_not_completed',
    });
    expect(refundEligibility(item({ status: 'refunded' }), ctx())).toMatchObject({
      reason: 'refund_already_refunded',
    });
    expect(
      refundEligibility(item(), ctx({ existing: { kind: 'self_service', status: 'completed' } })),
    ).toMatchObject({ reason: 'refund_already_refunded' });
  });

  it('refuses a second request and explains a denial', () => {
    const pack = item({ kind: 'gem_pack', items: [] });
    expect(
      refundEligibility(pack, ctx({ existing: { kind: 'real_money', status: 'pending' } })),
    ).toMatchObject({ reason: 'refund_already_requested' });
    expect(
      refundEligibility(pack, ctx({ existing: { kind: 'real_money', status: 'denied' } })),
    ).toMatchObject({
      reason: 'refund_already_requested',
      message: expect.stringContaining('declined'),
    });
    expect(
      refundEligibility(pack, ctx({ existing: { kind: 'real_money', status: 'refunded' } })),
    ).toMatchObject({ reason: 'refund_already_refunded' });
  });

  it('refuses a Gem pack whose payment was already reversed', () => {
    for (const status of ['partially_refunded', 'refunded', 'disputed', 'charged_back']) {
      expect(refundEligibility(item({ kind: 'gem_pack', items: [], status }), ctx())).toMatchObject({
        reason: 'refund_payment_reversed',
      });
    }
  });

  it('counts self refunds over a rolling year and says when one frees up', () => {
    const now = at(DAY);
    const recent = [at(-300 * DAY), at(-100 * DAY), at(-DAY)];
    const full = refundEligibility(item(), ctx({ now, recentSelfRefunds: recent }));
    expect(SELF_REFUND_LIMIT).toBe(3);
    expect(full).toMatchObject({
      reason: 'refund_limit_reached',
      retryAt: new Date(recent[0]!.getTime() + SELF_REFUND_LIMIT_WINDOW_DAYS * DAY),
    });
    // The oldest one ages out exactly a year later.
    const aged = [at(-SELF_REFUND_LIMIT_WINDOW_DAYS * DAY + DAY), ...recent.slice(1)];
    expect(refundEligibility(item(), ctx({ now, recentSelfRefunds: aged })).eligible).toBe(true);
    expect(refundEligibility(item(), ctx({ now, recentSelfRefunds: recent.slice(1) })).eligible).toBe(true);
  });

  it('refuses when anything the purchase granted has left the locker', () => {
    expect(refundEligibility(item({ items: ['hat.a', 'hat.gone'] }), ctx())).toMatchObject({
      reason: 'refund_item_missing',
    });
    expect(refundEligibility(item({ items: [] }), ctx())).toMatchObject({ reason: 'refund_item_missing' });
  });
});

describe.each(BACKENDS)('self-service refunds ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(T0.toISOString(), backend.env);
  });
  afterAll(async () => {
    await api.close();
  });

  const admin = (method: 'PUT' | 'DELETE', url: string, body?: unknown) =>
    api.req(method, url, { token: ADMIN_TOKEN, ...(body !== undefined ? { body } : {}) });

  /** Store items sold at list price, by currency and (optionally) slot. */
  function storeItems(currency: 'gumballs' | 'gems', slot?: string): CatalogCosmetic[] {
    return api.ctx.catalog.cosmetics.filter(
      (c) => c.source === 'store' && c.price?.currency === currency && (!slot || c.slot === slot),
    );
  }

  async function buy(u: TestUser, offerId: string) {
    const res = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers: { 'idempotency-key': `buy-${randomUUID()}` },
      body: { offerId },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { purchaseId: string; items: string[]; price: { currency: string; amount: number } };
  }

  const refund = (u: TestUser, purchaseId: string, body?: unknown) =>
    api.req('POST', `/purchases/${purchaseId}/refund`, {
      token: u.accessToken,
      ...(body !== undefined ? { body } : {}),
    });

  let ipNo = 0;
  /** Signs the guest in again on its device token after the clock jumped past its access token. */
  async function relog(u: TestUser): Promise<void> {
    const res = await api.req('POST', '/auth/guest', {
      body: { deviceToken: u.deviceToken },
      ip: `10.77.${Math.floor(++ipNo / 250)}.${ipNo % 250}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    u.accessToken = res.json().accessToken;
  }

  async function wallet(u: TestUser) {
    return (await api.req('GET', '/wallet', { token: u.accessToken })).json() as {
      wallet: { gumballs: number; gems: number };
      gemDebt: number;
    };
  }

  async function owned(u: TestUser): Promise<Set<string>> {
    const rows = await api.ctx.db
      .select({ id: inventoryItems.cosmeticId })
      .from(inventoryItems)
      .where(eq(inventoryItems.userId, u.id));
    return new Set(rows.map((r) => r.id));
  }

  it('refunds a Gumball purchase for a guest: item gone, Gumballs back, ledger ref refund:<id>', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const item = storeItems('gumballs')[0]!;
    const before = (await wallet(u)).wallet.gumballs;
    const p = await buy(u, item.id);
    api.clock.advance(2 * DAY);
    await relog(u);

    const res = await refund(u, p.purchaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      purchaseId: p.purchaseId,
      kind: 'self_service',
      status: 'completed',
      credit: p.price,
      items: [item.id],
      replayed: false,
    });
    expect((await wallet(u)).wallet.gumballs).toBe(before);
    expect((await owned(u)).has(item.id)).toBe(false);
    const rows = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'store_refund')));
    expect(rows).toEqual([
      expect.objectContaining({ ref: `refund:${p.purchaseId}`, delta: p.price.amount, currency: 'gumballs' }),
    ]);
    const [purchase] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, p.purchaseId));
    expect(purchase!.status).toBe('refunded');
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('answers a double submit with the first refund, credited once', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gems', 50_000);
    const p = await buy(u, storeItems('gems')[0]!.id);
    const first = await refund(u, p.purchaseId);
    const second = await refund(u, p.purchaseId);
    expect(first.json().replayed).toBe(false);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ refundId: first.json().refundId, replayed: true });
    expect((await wallet(u)).wallet.gems).toBe(50_000);
    expect(await api.ctx.db.select().from(refunds).where(eq(refunds.userId, u.id))).toHaveLength(1);
  });

  it('applies concurrent submits once', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const p = await buy(u, storeItems('gumballs')[1]!.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => refund(u, p.purchaseId)));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(results.filter((r) => !r.json().replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().refundId)).size).toBe(1);
    expect((await wallet(u)).wallet.gumballs).toBe(50_000);
    const credits = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'store_refund')));
    expect(credits).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('takes an equipped item out of every loadout that wears it', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    await api.grant(u.id, 'gems', 50_000);
    const hat = [...storeItems('gumballs', 'headwear'), ...storeItems('gems', 'headwear')][0]!;
    const p = await buy(u, hat.id);
    const slots = (await api.req('GET', '/loadouts', { token: u.accessToken })).json().slots;
    for (const index of [0, 3]) {
      const put = await api.req('PUT', `/loadouts/${index}`, {
        token: u.accessToken,
        body: { name: `Look ${index}`, items: { ...slots[0].items, headwear: hat.id } },
      });
      expect(put.statusCode, put.body).toBe(200);
    }
    const res = await refund(u, p.purchaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().loadoutsChanged).toEqual([0, 3]);
    const saved = await api.ctx.db.select().from(loadouts).where(eq(loadouts.userId, u.id));
    for (const l of saved) {
      expect((l.items as { headwear: string | null }).headwear).not.toBe(hat.id);
    }
    expect((saved.find((l) => l.slotIndex === 0)!.items as { headwear: string | null }).headwear).toBe(
      api.ctx.catalog.defaultLoadout().headwear,
    );
  });

  it('refunds a bundle whole: every granted item goes, the bundle price comes back', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 200_000);
    await api.grant(u.id, 'gems', 200_000);
    const set = STORE_SETS[0]!;
    const before = (await wallet(u)).wallet;
    const p = await buy(u, `bundle:${set.id}`);
    expect(p.items.length).toBeGreaterThan(1);
    const res = await refund(u, p.purchaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.sort()).toEqual([...p.items].sort());
    const inv = await owned(u);
    for (const id of p.items) expect(inv.has(id)).toBe(false);
    expect((await wallet(u)).wallet).toMatchObject(before);
  });

  it('keeps an item the player has since also earned, and still gives the price back', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 200_000);
    await api.grant(u.id, 'gems', 200_000);
    const set = STORE_SETS[0]!;
    const before = (await wallet(u)).wallet;
    const p = await buy(u, `bundle:${set.id}`);
    const [earned, ...bought] = p.items;
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, u.id, earned!, 'event'));
    const res = await refund(u, p.purchaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.sort()).toEqual([...bought].sort());
    const inv = await owned(u);
    expect(inv.has(earned!)).toBe(true);
    for (const id of bought) expect(inv.has(id)).toBe(false);
    expect((await wallet(u)).wallet).toMatchObject(before);
  });

  it('refuses a bundle once part of it was taken away by staff', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 200_000);
    await api.grant(u.id, 'gems', 200_000);
    const set = STORE_SETS[1] ?? STORE_SETS[0]!;
    const p = await buy(u, `bundle:${set.id}`);
    const revoked = await admin('DELETE', `/internal/users/${u.id}/inventory/${p.items[0]}`, {
      reason: 'support case',
    });
    expect(revoked.statusCode).toBe(200);
    const res = await refund(u, p.purchaseId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('refund_item_missing');
  });

  it('refunds an item that has since left the catalogue at the price paid', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 1_000);
    const purchaseId = randomUUID();
    await api.ctx.db.transaction(async (tx) => {
      await tx.insert(purchases).values({
        id: purchaseId,
        userId: u.id,
        idempotencyKey: `legacy-${purchaseId}`,
        kind: 'cosmetic',
        itemId: 'headwear.retired-test-hat',
        currency: 'gumballs',
        price: 400,
        status: 'completed',
        response: { items: ['headwear.retired-test-hat'] },
        completedAt: api.clock.now(),
      });
      await applyLedger(tx, {
        userId: u.id,
        currency: 'gumballs',
        delta: -400,
        reason: 'purchase',
        ref: purchaseId,
      });
      await tx
        .insert(inventoryItems)
        .values({ userId: u.id, cosmeticId: 'headwear.retired-test-hat', source: 'store' });
    });
    const history = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
    expect(history.purchases[0]).toMatchObject({
      purchaseId,
      title: 'headwear.retired-test-hat',
      eligibility: { eligible: true, kind: 'self_service' },
    });
    const res = await refund(u, purchaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect((await wallet(u)).wallet.gumballs).toBe(1_000);
    expect((await owned(u)).has('headwear.retired-test-hat')).toBe(false);
  });

  it('closes the window after seven days', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const p = await buy(u, storeItems('gumballs')[2]!.id);
    api.clock.advance(SELF_REFUND_WINDOW_DAYS * DAY);
    await relog(u);
    const res = await refund(u, p.purchaseId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'refund_window_expired',
      details: { reason: 'refund_window_expired' },
    });
  });

  it('stops at three self refunds a year and frees one a year after the first', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 500_000);
    await api.grant(u.id, 'gems', 500_000);
    const pool = [...storeItems('gumballs'), ...storeItems('gems')];
    for (let i = 0; i < SELF_REFUND_LIMIT; i++) {
      const p = await buy(u, pool[i]!.id);
      expect((await refund(u, p.purchaseId)).statusCode).toBe(200);
      api.clock.advance(DAY);
      await relog(u);
    }
    const fourth = await buy(u, pool[SELF_REFUND_LIMIT]!.id);
    const refused = await refund(u, fourth.purchaseId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'refund_limit_reached',
      details: { retryAt: new Date(T0.getTime() + SELF_REFUND_LIMIT_WINDOW_DAYS * DAY).toISOString() },
    });
    const history = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
    expect(history.selfRefunds).toMatchObject({ used: 3, limit: 3, windowDays: 365 });
    expect(history.selfRefunds.nextAvailableAt).toBe(refused.json().details.retryAt);

    api.clock.set(new Date(T0.getTime() + SELF_REFUND_LIMIT_WINDOW_DAYS * DAY).toISOString());
    await relog(u);
    const later = await buy(u, pool[SELF_REFUND_LIMIT + 1]!.id);
    expect((await refund(u, later.purchaseId)).statusCode).toBe(200);
  });

  it('keeps refunds to the buyer and to purchases that exist', async () => {
    api.clock.set(T0.toISOString());
    const owner = await api.guest();
    const other = await api.guest();
    await api.grant(owner.id, 'gumballs', 50_000);
    const p = await buy(owner, storeItems('gumballs')[3]!.id);
    expect((await refund(other, p.purchaseId)).statusCode).toBe(404);
    expect((await refund(owner, randomUUID())).statusCode).toBe(404);
    expect((await refund(owner, 'not-a-uuid')).statusCode).toBe(400);
    expect((await refund(owner, p.purchaseId, { reason: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await refund(owner, p.purchaseId, { extra: true })).statusCode).toBe(400);
    expect((await api.req('POST', `/purchases/${p.purchaseId}/refund`)).statusCode).toBe(401);
    expect((await api.req('GET', '/purchases')).statusCode).toBe(401);
  });

  it('refuses the Season Pass and Crown Shard purchases with a reason', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gems', 50_000);
    const pass = await api.req('POST', '/pass/premium', {
      token: u.accessToken,
      headers: { 'idempotency-key': `pass-${randomUUID()}` },
    });
    expect(pass.statusCode, pass.body).toBe(200);
    const res = await refund(u, pass.json().purchaseId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('refund_not_refundable');
    const history = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
    expect(history.purchases[0]).toMatchObject({
      kind: 'pass_premium',
      title: 'Season Pass premium',
      eligibility: { eligible: false, reason: 'refund_not_refundable' },
    });
  });

  it('closes refunds with the store switch and during maintenance', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const p = await buy(u, storeItems('gumballs')[4]!.id);
    expect((await admin('PUT', '/internal/flags/store.enabled', { enabled: false })).statusCode).toBe(200);
    try {
      const closed = await refund(u, p.purchaseId);
      expect(closed.statusCode).toBe(503);
      expect(closed.json().error).toBe('feature_disabled');
    } finally {
      await admin('PUT', '/internal/flags/store.enabled', { enabled: true });
    }
    expect(
      (await admin('PUT', '/internal/maintenance', { enabled: true, message: 'Mopping' })).statusCode,
    ).toBe(200);
    try {
      const busy = await refund(u, p.purchaseId);
      expect(busy.statusCode).toBe(503);
      expect(busy.json().error).toBe('maintenance');
    } finally {
      await admin('DELETE', '/internal/maintenance');
    }
    expect((await api.ctx.db.select().from(refunds).where(eq(refunds.userId, u.id))).length).toBe(0);
    expect((await refund(u, p.purchaseId)).statusCode).toBe(200);
  });

  it('refuses a deleted account and drops its refunds with it', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const p = await buy(u, storeItems('gumballs')[5]!.id);
    expect((await refund(u, p.purchaseId)).statusCode).toBe(200);
    const second = await buy(u, storeItems('gumballs')[6]!.id);
    const del = await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await refund(u, second.purchaseId)).statusCode).toBe(401);
    expect(await api.ctx.db.select().from(refunds).where(eq(refunds.userId, u.id))).toHaveLength(0);
  });

  it('pays Gems back into Gem debt first', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gems', 50_000);
    const p = await buy(u, storeItems('gems')[1]!.id);
    // Simulate a reversed Gem pack: everything left is taken and 100 more is owed.
    const { revokeGems } = await import('../src/economy/ledger.ts');
    const balance = (await wallet(u)).wallet.gems;
    await api.ctx.db.transaction((tx) => revokeGems(tx, u.id, balance + 100, `test-reversal:${u.id}`));
    expect(await wallet(u)).toMatchObject({ wallet: { gems: 0 }, gemDebt: 100 });
    const res = await refund(u, p.purchaseId);
    expect(res.statusCode, res.body).toBe(200);
    const after = await wallet(u);
    expect(after.gemDebt).toBe(Math.max(0, 100 - p.price.amount));
    expect(after.wallet.gems).toBe(Math.max(0, p.price.amount - 100));
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('lists purchases newest first with eligibility, refund state and the policy', async () => {
    api.clock.set(T0.toISOString());
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const a = await buy(u, storeItems('gumballs')[7]!.id);
    api.clock.advance(60_000);
    const b = await buy(u, storeItems('gumballs')[8]!.id);
    expect((await refund(u, a.purchaseId)).statusCode).toBe(200);
    const h = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
    expect(h.policy).toEqual({ selfServiceWindowDays: 7, realMoneyWindowDays: 14 });
    expect(h.purchases.map((x: { purchaseId: string }) => x.purchaseId)).toEqual([
      b.purchaseId,
      a.purchaseId,
    ]);
    expect(h.purchases[0]).toMatchObject({
      kind: 'cosmetic',
      items: [{ id: b.items[0], name: expect.any(String) }],
      price: b.price,
      refund: null,
      eligibility: { eligible: true, kind: 'self_service' },
    });
    expect(h.purchases[1]).toMatchObject({
      status: 'refunded',
      refund: { kind: 'self_service', status: 'completed' },
      eligibility: { eligible: false, reason: 'refund_already_refunded' },
    });
    expect(h.selfRefunds).toMatchObject({ used: 1, nextAvailableAt: null });
  });
});
