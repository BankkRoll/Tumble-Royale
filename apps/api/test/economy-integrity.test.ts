/**
 * Money integrity under concurrency and edge cases: double charges with
 * different idempotency keys, lock ordering between refunds, purchases,
 * gifts, loadouts and Stripe webhooks, price drift at a rotation boundary,
 * stuck Gem checkouts, chargebacks against refund requests, and checks of a
 * Stripe completion against the stored purchase.
 *
 * Every suite runs on each storage backend. The race tests only bite on real
 * Postgres (PGlite runs one transaction at a time): there they hold a lock on
 * a connection of their own (`pglocks.ts`), wait until Postgres reports the
 * request blocked on it, check which locks the request holds meanwhile, and
 * release. On PGlite the same requests run one after another and must still
 * give the same final answer.
 */
import { randomUUID } from 'node:crypto';
import { STORE_SETS } from '@tumble/content/cosmetics';
import { shardShopAt } from '@tumble/content/progression';
import { and, eq, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogCosmetic } from '../src/catalog.ts';
import {
  currenciesLedger,
  events,
  friendships,
  gifts,
  purchases,
  refunds,
  storeRotations,
  users,
} from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import type { PaymentProvider } from '../src/economy/payments.ts';
import { priceOffer, rotationForDay } from '../src/economy/store.ts';
import { dayKey } from '../src/util/time.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';
import {
  holdLocks,
  isLockFree,
  PROFILE_LOCK,
  PROFILE_NOWAIT,
  postgresUrl,
  waitForLockWaiters,
} from './pglocks.ts';
import {
  completedSession,
  fakeStripe,
  PACK,
  paidPack,
  type PaidPack,
  refundedCharge,
  startCheckout,
  webhook,
} from './stripeFake.ts';

const DAY = 86_400_000;
const T0 = '2026-10-02T12:00:00.000Z';

describe.each(BACKENDS)('economy integrity ($name)', (backend) => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi(T0, backend.env, fakeStripe());
  });
  afterAll(async () => {
    await api.close();
  });
  /** The race tests need a second connection, which only Postgres offers. */
  const pgOnly = () => postgresUrl(api);

  const storeItems = (currency: 'gumballs' | 'gems'): CatalogCosmetic[] =>
    api.ctx.catalog.cosmetics.filter((c) => c.source === 'store' && c.price?.currency === currency);
  let itemNo = 0;
  const nextItem = () => {
    const list = storeItems('gumballs');
    return list[itemNo++ % list.length]!;
  };
  const priceToday = (offerId: string) =>
    priceOffer(
      api.ctx.catalog,
      rotationForDay(api.ctx.catalog, dayKey(api.clock.now())),
      offerId,
      () => false,
    )!.price;
  const buy = (u: TestUser, body: Record<string, unknown>, key = `buy-${randomUUID()}`) =>
    api.req('POST', '/purchase', { token: u.accessToken, headers: { 'idempotency-key': key }, body });
  const ledgerOk = async (...us: TestUser[]) => {
    for (const u of us) expect((await verifyLedger(api.ctx.db, u.id)).ok, u.id).toBe(true);
  };
  const charges = async (u: TestUser, reason: string) =>
    (
      await api.ctx.db
        .select()
        .from(currenciesLedger)
        .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, reason)))
    ).length;

  async function rich(): Promise<TestUser> {
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 1_000_000);
    await api.grant(u.id, 'gems', 1_000_000);
    await api.grant(u.id, 'crown_shards', 1_000_000);
    return u;
  }

  async function backdate(u: TestUser, days: number): Promise<void> {
    await api.ctx.db
      .update(users)
      .set({ createdAt: new Date(api.clock.now().getTime() - days * DAY) })
      .where(eq(users.id, u.id));
  }

  /** Two accounts old enough to gift, friends for ten days, the sender holding currency. */
  async function pair(): Promise<{ a: TestUser; b: TestUser }> {
    const a = await api.account();
    const b = await api.account();
    await backdate(a, 30);
    await backdate(b, 30);
    await api.req('POST', '/friends/request', { token: a.accessToken, body: { userId: b.id } });
    const res = await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
    expect(res.statusCode, res.body).toBe(200);
    await api.ctx.db
      .update(friendships)
      .set({ updatedAt: new Date(api.clock.now().getTime() - 10 * DAY) })
      .where(
        or(
          and(eq(friendships.userId, a.id), eq(friendships.friendId, b.id)),
          and(eq(friendships.userId, b.id), eq(friendships.friendId, a.id)),
        ),
      );
    await api.grant(a.id, 'gumballs', 100_000);
    await api.grant(a.id, 'gems', 100_000);
    return { a, b };
  }
  const send = (from: TestUser, body: Record<string, unknown>, key = `gift-${randomUUID()}`) =>
    api.req('POST', '/gifts', { token: from.accessToken, headers: { 'idempotency-key': key }, body });

  // ---------------------------------------------------------------------------
  // Double charges (E1, E2)
  // ---------------------------------------------------------------------------

  it('charges once when two purchases of one item race with different keys', async () => {
    const u = await rich();
    const item = nextItem();
    const url = pgOnly();
    const held = url ? await holdLocks(url, [[PROFILE_LOCK, [u.id]]]) : null;
    const racing = [buy(u, { offerId: item.id }), buy(u, { offerId: item.id })];
    if (url && held) {
      await waitForLockWaiters(url, 2);
      await held.release();
    }
    const results = await Promise.all(racing);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('already_owned');
    expect(await charges(u, 'purchase')).toBe(1);
    await ledgerOk(u);
  });

  it('charges once when two Crown Shard purchases race with different keys', async () => {
    const u = await rich();
    const offer = shardShopAt(api.clock.now()).offers[0]!;
    const shard = (key: string) =>
      api.req('POST', '/shop/shards/buy', {
        token: u.accessToken,
        headers: { 'idempotency-key': key },
        body: { offerId: offer.itemId },
      });
    const url = pgOnly();
    const held = url ? await holdLocks(url, [[PROFILE_LOCK, [u.id]]]) : null;
    const racing = [shard(`s-${randomUUID()}`), shard(`s-${randomUUID()}`)];
    if (url && held) {
      await waitForLockWaiters(url, 2);
      await held.release();
    }
    const results = await Promise.all(racing);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await charges(u, 'shard_shop')).toBe(1);
    await ledgerOk(u);
  });

  // ---------------------------------------------------------------------------
  // Lock order: refunds and webhooks (E3, E4)
  // ---------------------------------------------------------------------------

  it('takes the purchase row before the wallet when requesting a Gem pack refund', async () => {
    const u = await api.account();
    const p = await paidPack(api, u);
    const url = pgOnly();
    const held = url
      ? await holdLocks(url, [['select 1 from purchases where id = $1 for update', [p.purchaseId]]])
      : null;
    const request = api.req('POST', `/purchases/${p.purchaseId}/refund`, {
      token: u.accessToken,
      body: { reason: 'Bought the wrong pack' },
    });
    if (url && held) {
      await waitForLockWaiters(url, 1);
      // The webhook path holds the purchase and then wants the wallet; the
      // request must not hold the wallet while it waits for the purchase.
      expect(await isLockFree(url, PROFILE_NOWAIT, [u.id])).toBe(true);
      await held.release();
    }
    const res = await request;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'real_money', status: 'pending' });
  });

  it('serialises every event of one PaymentIntent, even before the checkout completes', async () => {
    const u = await api.account();
    const p = await startCheckout(api, u);
    const url = pgOnly();
    const held = url
      ? await holdLocks(url, [['select pg_advisory_xact_lock(hashtext($1))', [`pi:${p.pi}`]]])
      : null;
    // A full refund delivered before the completion: no purchase row names the
    // PaymentIntent yet, so only the PaymentIntent lock can order the two.
    const refund = webhook(api, 'charge.refunded', refundedCharge(p, PACK.priceCents));
    const completion = webhook(api, 'checkout.session.completed', completedSession(p));
    if (url && held) {
      await waitForLockWaiters(url, 2);
      await held.release();
    }
    for (const res of await Promise.all([refund, completion])) expect(res.statusCode, res.body).toBe(200);
    const wallet = (await api.req('GET', '/wallet', { token: u.accessToken })).json();
    expect(wallet.wallet.gems).toBe(0);
    const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, p.purchaseId));
    expect(row!.status).toBe('refunded');
    await ledgerOk(u);
  });

  // ---------------------------------------------------------------------------
  // Refund requests vs chargebacks (E5)
  // ---------------------------------------------------------------------------

  it('closes an open refund request when the payment is disputed, and refuses to approve it', async () => {
    const u = await api.account();
    const p = await paidPack(api, u);
    const req = await api.req('POST', `/purchases/${p.purchaseId}/refund`, {
      token: u.accessToken,
      body: { reason: 'Bought the wrong pack' },
    });
    const refundId = req.json().refundId as string;
    const res = await webhook(api, 'charge.dispute.created', {
      id: `dp_${p.charge}`,
      object: 'dispute',
      charge: p.charge,
      payment_intent: p.pi,
      status: 'needs_response',
    });
    expect(res.statusCode).toBe(200);
    const [row] = await api.ctx.db.select().from(refunds).where(eq(refunds.id, refundId));
    expect(row).toMatchObject({ status: 'denied', decidedBy: 'system' });

    // A request reopened by hand (or one Stripe failed) still cannot pay twice.
    await api.ctx.db.update(refunds).set({ status: 'failed' }).where(eq(refunds.id, refundId));
    const approve = await api.req('POST', `/internal/refunds/${refundId}/approve`, {
      token: ADMIN_TOKEN,
      body: {},
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe('refund_payment_reversed');
  });

  // ---------------------------------------------------------------------------
  // Stripe completion vs the stored purchase (E17)
  // ---------------------------------------------------------------------------

  it('credits nothing when the completed session does not match the purchase', async () => {
    const u = await api.account();
    const other = await api.account();
    const cases: [string, (p: PaidPack) => Record<string, unknown>][] = [
      ['amount', () => ({ amount_total: 1, currency: 'usd' })],
      ['currency', () => ({ amount_total: PACK.priceCents, currency: 'eur' })],
      ['buyer', (p) => ({ metadata: { purchaseId: p.purchaseId, userId: other.id } })],
      ['session', () => ({ id: 'cs_someone_else' })],
    ];
    for (const [label, over] of cases) {
      const p = await startCheckout(api, u);
      const res = await webhook(api, 'checkout.session.completed', completedSession(p, over(p)));
      expect(res.statusCode, label).toBe(200);
      const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, p.purchaseId));
      expect(row!.completedAt, label).toBeNull();
    }
    expect((await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet.gems).toBe(0);
    const flagged = await api.ctx.db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.name, 'payments.checkout_mismatch')));
    expect(flagged).toHaveLength(4);
  });

  it('credits the Gems a pack held at checkout, whatever the catalog says later', async () => {
    const u = await api.account();
    const p = await startCheckout(api, u);
    const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, p.purchaseId));
    expect(row!.gems).toBe(PACK.gems);
    await api.ctx.db.update(purchases).set({ gems: 777 }).where(eq(purchases.id, p.purchaseId));
    const ok = await webhook(
      api,
      'checkout.session.completed',
      completedSession(p, {
        amount_total: PACK.priceCents,
        currency: 'usd',
        metadata: { purchaseId: p.purchaseId, userId: u.id },
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect((await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet.gems).toBe(777);
    await ledgerOk(u);
  });

  // ---------------------------------------------------------------------------
  // Price drift (E6)
  // ---------------------------------------------------------------------------

  it('refuses a purchase at a price other than the one the player confirmed', async () => {
    const u = await rich();
    const item = nextItem();
    const price = priceToday(item.id);
    const stale = await buy(u, {
      offerId: item.id,
      expectedPrice: { currency: price.currency, amount: price.amount + 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'price_changed', details: { price } });
    expect(await charges(u, 'purchase')).toBe(0);
    const ok = await buy(u, { offerId: item.id, expectedPrice: price });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().price).toEqual(price);
  });

  it('refuses a gift at a price other than the one the picker showed', async () => {
    const { a, b } = await pair();
    const item = nextItem();
    const price = priceToday(item.id);
    const stale = await send(a, {
      recipientId: b.id,
      offerId: item.id,
      expectedPrice: { currency: price.currency, amount: price.amount - 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'price_changed', details: { price } });
    const ok = await send(a, { recipientId: b.id, offerId: item.id, expectedPrice: price });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Gem checkout retries (E7)
  // ---------------------------------------------------------------------------

  it('creates the checkout again when the first attempt failed at the provider', async () => {
    let fail = true;
    const created: string[] = [];
    const flaky: PaymentProvider = {
      id: 'stripe',
      async createCheckout(req) {
        created.push(req.purchaseId);
        if (fail) throw new Error('provider unreachable');
        return {
          url: `https://pay.test/${req.purchaseId}`,
          providerRef: `cs_${req.purchaseId}`,
          completed: false,
        };
      },
      refund: () => Promise.reject(new Error('unused')),
      parseWebhook: () => ({ type: 'ignored', eventId: null }),
    };
    const local = await createTestApi(T0, backend.env, { payments: flaky });
    try {
      const u = await local.account();
      const key = `chk-${randomUUID()}`;
      const checkout = () =>
        local.req('POST', '/gems/checkout', {
          token: u.accessToken,
          headers: { 'idempotency-key': key },
          body: { packId: PACK.id },
        });
      expect((await checkout()).statusCode).toBe(500);
      fail = false;
      const retry = await checkout();
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({
        status: 'pending',
        checkoutUrl: expect.stringContaining('pay.test'),
      });
      // Same purchase both times, so the provider's idempotency key matches too.
      expect(new Set(created).size).toBe(1);
      expect(retry.json().purchaseId).toBe(created[0]);
      const replay = await checkout();
      expect(replay.json()).toMatchObject({ replayed: true, checkoutUrl: retry.json().checkoutUrl });
      expect(created).toHaveLength(2);
    } finally {
      await local.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Rotation insert outside the wallet locks (E8)
  // ---------------------------------------------------------------------------

  it('does not hold wallet locks while a new day’s rotation row is being written', async () => {
    const url = pgOnly();
    if (!url) return;
    const { a, b } = await pair();
    const day = dayKey(api.clock.now());
    await api.ctx.db.delete(storeRotations).where(eq(storeRotations.day, day));
    const held = await holdLocks(url, [
      [`insert into store_rotations (day, featured, daily) values ($1, '[]', '[]')`, [day]],
    ]);
    const gift = send(a, { recipientId: b.id, offerId: nextItem().id });
    await waitForLockWaiters(url, 1);
    expect(await isLockFree(url, PROFILE_NOWAIT, [a.id])).toBe(true);
    expect(await isLockFree(url, PROFILE_NOWAIT, [b.id])).toBe(true);
    await held.release();
    expect((await gift).statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Loadouts vs revokes (E9)
  // ---------------------------------------------------------------------------

  it('saves a loadout under the wallet lock every revoke takes', async () => {
    const u = await rich();
    const item = api.ctx.catalog.cosmetics.find(
      (c) => c.source === 'store' && c.price && ['pattern', 'headwear', 'face'].includes(c.slot),
    )!;
    expect((await buy(u, { offerId: item.id })).statusCode).toBe(200);
    const items = (await api.req('GET', '/loadouts', { token: u.accessToken })).json().slots[0].items;
    const url = pgOnly();
    const held = url ? await holdLocks(url, [[PROFILE_LOCK, [u.id]]]) : null;
    const save = api.req('PUT', '/loadouts/1', {
      token: u.accessToken,
      body: { items: { ...items, [item.slot]: item.id } },
    });
    if (url && held) {
      await waitForLockWaiters(url, 1);
      await held.release();
    }
    expect((await save).statusCode).toBe(200);

    // The admin revoke takes the same lock, so it waits for a save in progress.
    const held2 = url ? await holdLocks(url, [[PROFILE_LOCK, [u.id]]]) : null;
    const revoke = api.req('DELETE', `/internal/users/${u.id}/inventory/${item.id}`, {
      token: ADMIN_TOKEN,
      body: { reason: 'testing the lock' },
    });
    if (url && held2) {
      await waitForLockWaiters(url, 1);
      await held2.release();
    }
    expect((await revoke).statusCode).toBe(200);
    const after = (await api.req('GET', '/loadouts', { token: u.accessToken })).json().slots[1].items;
    expect(after[item.slot]).not.toBe(item.id);
  });

  // ---------------------------------------------------------------------------
  // Gift replays (E10)
  // ---------------------------------------------------------------------------

  it('replays a gift only for the identical request, even after a chat mute', async () => {
    const { a, b } = await pair();
    const item = nextItem();
    const key = `gift-${randomUUID()}`;
    const body = { recipientId: b.id, offerId: item.id, message: 'Enjoy!' };
    expect((await send(a, body, key)).statusCode).toBe(200);
    const otherNote = await send(a, { ...body, message: 'Something else' }, key);
    expect(otherNote.json().error).toBe('idempotency_key_reused');
    const otherCurrency = await send(a, { ...body, currency: 'gems' }, key);
    expect(otherCurrency.json().error).toBe('idempotency_key_reused');
    await api.ban(a.id, 'chat');
    const retry = await send(a, body, key);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().replayed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Erasure and gifts (E11, E12)
  // ---------------------------------------------------------------------------

  it('erases an account while a new sender’s gift lands, without deadlocking', async () => {
    const url = pgOnly();
    if (!url) return;
    // u must sort after both senders, so erasure locks a sender before u.
    let u: TestUser;
    let s1: TestUser;
    let s2: TestUser;
    for (;;) {
      const p1 = await pair();
      const p2 = await pair();
      await api.req('POST', '/friends/request', { token: p2.a.accessToken, body: { userId: p1.b.id } });
      await api.req('POST', '/friends/accept', { token: p1.b.accessToken, body: { userId: p2.a.id } });
      await api.ctx.db
        .update(friendships)
        .set({ updatedAt: new Date(api.clock.now().getTime() - 10 * DAY) })
        .where(
          or(
            and(eq(friendships.userId, p2.a.id), eq(friendships.friendId, p1.b.id)),
            and(eq(friendships.userId, p1.b.id), eq(friendships.friendId, p2.a.id)),
          ),
        );
      [u, s1, s2] = [p1.b, p1.a, p2.a];
      if (s1.id < u.id && s2.id < u.id) break;
    }
    expect((await send(s1, { recipientId: u.id, offerId: nextItem().id })).statusCode).toBe(200);
    const stall = await holdLocks(url, [[PROFILE_LOCK, [s1.id]]]);
    const erase = api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    await waitForLockWaiters(url, 1);
    // A gift from a sender erasure has not seen commits while it is stalled...
    expect((await send(s2, { recipientId: u.id, offerId: nextItem().id })).statusCode).toBe(200);
    // ...and that sender starts another one, holding its own wallet and wanting u's.
    const inflight = await holdLocks(url, [[PROFILE_LOCK, [s2.id]]]);
    const wantsU = inflight.query(PROFILE_LOCK, [u.id]);
    await stall.release();
    await wantsU.catch(() => undefined);
    await inflight.release();
    const res = await erase;
    expect(res.statusCode, res.body).toBe(204);
    const returned = await api.ctx.db
      .select()
      .from(gifts)
      .where(or(eq(gifts.senderId, s1.id), eq(gifts.senderId, s2.id)));
    expect(returned.map((g) => [g.status, g.refunded])).toEqual([
      ['returned', true],
      ['returned', true],
    ]);
    await ledgerOk(s1, s2);
  });

  it('opens a gift whose sender is deleted while the open waits for the sender’s lock', async () => {
    const url = pgOnly();
    if (!url) return;
    const { a, b } = await pair();
    const sent = await send(a, { recipientId: b.id, offerId: nextItem().id });
    const giftId = sent.json().gift.giftId as string;
    const erase = await holdLocks(url, [
      [`select set_config('tumble.erase_user', $1, true)`, [a.id]],
      ['delete from users where id = $1', [a.id]],
    ]);
    const open = api.req('POST', `/gifts/${giftId}/open`, { token: b.accessToken });
    await waitForLockWaiters(url, 1);
    await erase.commit();
    const res = await open;
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().gift).toMatchObject({ status: 'opened', from: null });
  });

  // ---------------------------------------------------------------------------
  // Maintenance (E13)
  // ---------------------------------------------------------------------------

  it('closes every spend route during maintenance', async () => {
    const u = await rich();
    const set = await api.req('PUT', '/internal/maintenance', {
      token: ADMIN_TOKEN,
      body: { enabled: true, message: 'Back soon' },
    });
    expect(set.statusCode, set.body).toBe(200);
    try {
      const headers = { 'idempotency-key': `m-${randomUUID()}` };
      for (const [url, body] of [
        ['/purchase', { offerId: nextItem().id }],
        ['/gems/checkout', { packId: PACK.id }],
        ['/shop/shards/buy', { offerId: shardShopAt(api.clock.now()).offers[0]!.itemId }],
      ] as const) {
        const res = await api.req('POST', url, { token: u.accessToken, headers, body });
        expect(res.statusCode, url).toBe(503);
        expect(res.json().error, url).toBe('maintenance');
      }
    } finally {
      await api.req('DELETE', '/internal/maintenance', { token: ADMIN_TOKEN });
    }
  });

  // ---------------------------------------------------------------------------
  // Wish lists (E14)
  // ---------------------------------------------------------------------------

  it('drops a wished-for bundle once its last item arrives on its own', async () => {
    const u = await rich();
    const set = STORE_SETS.find((s) =>
      s.itemIds.every(
        (id) => api.ctx.cosmetics.get(id)?.price && api.ctx.cosmetics.get(id)?.source === 'store',
      ),
    )!;
    const bundleId = `bundle:${set.id}`;
    expect(
      (await api.req('POST', '/wishlist', { token: u.accessToken, body: { itemId: bundleId } })).statusCode,
    ).toBe(200);
    for (const id of set.itemIds) expect((await buy(u, { offerId: id })).statusCode, id).toBe(200);
    const list = (await api.req('GET', '/wishlist', { token: u.accessToken })).json();
    expect(list.entries.map((e: { itemId: string }) => e.itemId)).not.toContain(bundleId);
  });

  // ---------------------------------------------------------------------------
  // Pagination (E15)
  // ---------------------------------------------------------------------------

  /** Follows `nextCursor` until the end; every row exactly once, newest first. */
  async function pageAll<T>(
    first: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
  ): Promise<T[][]> {
    const pages: T[][] = [];
    let cursor: string | null = null;
    do {
      const page = await first(cursor);
      pages.push(page.items);
      cursor = page.next;
    } while (cursor && pages.length < 50);
    return pages;
  }

  it('pages through purchases, wallet history and gifts without gaps or repeats', async () => {
    const { a, b } = await pair();
    const bought: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await buy(a, { offerId: nextItem().id });
      expect(res.statusCode, res.body).toBe(200);
      bought.unshift(res.json().purchaseId);
      api.clock.advance(1000);
    }
    const purchasePages = await pageAll(async (cursor) => {
      const j = (
        await api.req('GET', `/purchases?limit=2${cursor ? `&before=${cursor}` : ''}`, {
          token: a.accessToken,
        })
      ).json();
      return { items: j.purchases.map((p: { purchaseId: string }) => p.purchaseId), next: j.nextCursor };
    });
    expect(purchasePages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(purchasePages.flat()).toEqual(bought);

    const ledgerPages = await pageAll<number>(async (cursor) => {
      const j = (
        await api.req('GET', `/wallet?limit=3${cursor ? `&before=${cursor}` : ''}`, { token: a.accessToken })
      ).json();
      return { items: j.recent.map((r: { id: number }) => r.id), next: j.nextCursor };
    });
    const ids = ledgerPages.flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    expect(ids.length).toBe(
      (await api.ctx.db.select().from(currenciesLedger).where(eq(currenciesLedger.userId, a.id))).length,
    );

    const sent: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await send(a, { recipientId: b.id, offerId: nextItem().id });
      sent.unshift(res.json().gift.giftId);
      api.clock.advance(1000);
    }
    const inbox = (await api.req('GET', '/gifts', { token: a.accessToken })).json();
    expect(inbox.nextCursor).toEqual({ received: null, sent: null });
    const giftPages = await pageAll(async (cursor) => {
      if (!cursor) {
        const first = await api.ctx.db.select().from(gifts).where(eq(gifts.id, sent[0]!));
        return {
          items: [sent[0]!],
          next: Buffer.from(`${first[0]!.createdAt.getTime()}:${sent[0]}`).toString('base64url'),
        };
      }
      const j = (
        await api.req('GET', `/gifts/history?direction=sent&limit=1&before=${cursor}`, {
          token: a.accessToken,
        })
      ).json();
      return { items: j.gifts.map((g: { giftId: string }) => g.giftId), next: j.nextCursor };
    });
    expect(giftPages.flat()).toEqual(sent);
    const bad = await api.req('GET', '/purchases?before=not-a-cursor', { token: a.accessToken });
    expect(bad.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Gem gifts while a refund is open (design note)
  // ---------------------------------------------------------------------------

  it('pauses Gem gifts while a real-money refund request is open', async () => {
    const { a, b } = await pair();
    const p = await paidPack(api, a);
    expect(
      (
        await api.req('POST', `/purchases/${p.purchaseId}/refund`, {
          token: a.accessToken,
          body: { reason: 'Bought the wrong pack' },
        })
      ).statusCode,
    ).toBe(200);
    const gemItem = storeItems('gems')[0]!;
    const refused = await send(a, { recipientId: b.id, offerId: gemItem.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('gift_refund_pending');
    expect((await send(a, { recipientId: b.id, offerId: nextItem().id })).statusCode).toBe(200);
    const sent = await api.ctx.db.select().from(gifts).where(eq(gifts.senderId, a.id));
    expect(sent.map((g) => g.currency)).toEqual(['gumballs']);
  });
});
