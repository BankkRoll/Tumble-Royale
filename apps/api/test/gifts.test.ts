/**
 * Gifting: the policy as a pure function (every rule and boundary), then the
 * real routes on every storage backend: sending, opening, declining,
 * cancelling, auto-accept, idempotency and races, kill switches, account
 * deletion on either side, the ledger invariants and the admin console.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STORE_SETS } from '@tumble/content/cosmetics';
import type { CatalogCosmetic } from '../src/catalog.ts';
import {
  adminAuditLog,
  currenciesLedger,
  friendships,
  gifts,
  inventoryItems,
  users,
  wishlistItems,
} from '../src/db/schema.ts';
import {
  GIFT_AUTO_ACCEPT_DAYS,
  GIFT_DAILY_LIMIT,
  GIFT_INBOX_LIMIT,
  GIFT_MIN_ACCOUNT_DAYS,
  GIFT_MIN_FRIEND_DAYS,
  giftEligibility,
  settleExpiredGifts,
  type GiftRecipientFacts,
  type GiftSenderFacts,
} from '../src/economy/gifts.ts';
import { revokeGems, verifyLedger } from '../src/economy/ledger.ts';
import { priceOffer, rotationForDay } from '../src/economy/store.ts';
import { grantCosmetic } from '../src/economy/wallet.ts';
import type { RealtimeEvent } from '../src/realtime/notifier.ts';
import { dayKey } from '../src/util/time.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-10-02T12:00:00.000Z');

describe('gift policy', () => {
  const now = new Date(T0.getTime() + 60 * DAY);
  const at = (ms: number) => new Date(now.getTime() + ms);
  const sender = (over: Partial<GiftSenderFacts> = {}): GiftSenderFacts => ({
    isGuest: false,
    createdAt: at(-30 * DAY),
    sentToday: 0,
    ...over,
  });
  const recipient = (over: Partial<GiftRecipientFacts> = {}): GiftRecipientFacts => ({
    friendsSince: at(-10 * DAY),
    blocked: false,
    suspended: false,
    pendingCount: 0,
    pendingItems: new Set(),
    owned: new Set(['hat.other']),
    ...over,
  });

  it('allows a gift between long-standing friends', () => {
    expect(giftEligibility(sender(), recipient(), ['hat.a'], now)).toEqual({ eligible: true });
  });

  it('never lets a guest send', () => {
    expect(giftEligibility(sender({ isGuest: true }), recipient(), ['hat.a'], now)).toMatchObject({
      eligible: false,
      reason: 'gift_account_required',
    });
  });

  it('waits until the account is seven days old (half-open), and says when', () => {
    expect(GIFT_MIN_ACCOUNT_DAYS).toBe(7);
    const young = giftEligibility(
      sender({ createdAt: at(-GIFT_MIN_ACCOUNT_DAYS * DAY + 1) }),
      recipient(),
      ['hat.a'],
      now,
    );
    expect(young).toEqual({
      eligible: false,
      reason: 'gift_account_too_new',
      message: expect.any(String),
      retryAt: at(1),
    });
    expect(
      giftEligibility(sender({ createdAt: at(-GIFT_MIN_ACCOUNT_DAYS * DAY) }), recipient(), ['hat.a'], now)
        .eligible,
    ).toBe(true);
  });

  it('caps gifts per UTC day and frees up at midnight', () => {
    const capped = giftEligibility(sender({ sentToday: GIFT_DAILY_LIMIT }), recipient(), ['hat.a'], now);
    expect(capped).toMatchObject({ reason: 'gift_daily_limit' });
    expect((capped as { retryAt: Date }).retryAt.toISOString()).toBe(
      new Date(`${dayKey(at(DAY))}T00:00:00.000Z`).toISOString(),
    );
    expect(
      giftEligibility(sender({ sentToday: GIFT_DAILY_LIMIT - 1 }), recipient(), ['hat.a'], now).eligible,
    ).toBe(true);
  });

  it('answers "not friends" alike for strangers and blocks', () => {
    const stranger = giftEligibility(sender(), recipient({ friendsSince: null }), ['hat.a'], now);
    const blocked = giftEligibility(sender(), recipient({ blocked: true }), ['hat.a'], now);
    expect(stranger).toMatchObject({ reason: 'gift_not_friends' });
    expect(blocked).toEqual(stranger);
  });

  it('refuses suspended recipients', () => {
    expect(giftEligibility(sender(), recipient({ suspended: true }), ['hat.a'], now)).toMatchObject({
      reason: 'gift_recipient_unavailable',
    });
  });

  it('needs three days of friendship (half-open)', () => {
    expect(GIFT_MIN_FRIEND_DAYS).toBe(3);
    const fresh = giftEligibility(
      sender(),
      recipient({ friendsSince: at(-GIFT_MIN_FRIEND_DAYS * DAY + 1) }),
      ['hat.a'],
      now,
    );
    expect(fresh).toMatchObject({ reason: 'gift_friendship_too_new', retryAt: at(1) });
    expect(
      giftEligibility(sender(), recipient({ friendsSince: at(-GIFT_MIN_FRIEND_DAYS * DAY) }), ['hat.a'], now)
        .eligible,
    ).toBe(true);
  });

  it('refuses what the recipient owns, even one item of a bundle, and empty gifts', () => {
    expect(giftEligibility(sender(), recipient(), ['hat.other'], now)).toMatchObject({
      reason: 'gift_already_owned',
    });
    expect(giftEligibility(sender(), recipient(), ['hat.a', 'hat.other'], now)).toMatchObject({
      reason: 'gift_already_owned',
    });
    expect(giftEligibility(sender(), recipient(), [], now)).toMatchObject({ reason: 'gift_already_owned' });
  });

  it('refuses an item already waiting in another unopened gift, and a full inbox', () => {
    expect(
      giftEligibility(sender(), recipient({ pendingItems: new Set(['hat.a']) }), ['hat.a'], now),
    ).toMatchObject({ reason: 'gift_already_pending' });
    expect(
      giftEligibility(sender(), recipient({ pendingCount: GIFT_INBOX_LIMIT }), ['hat.a'], now),
    ).toMatchObject({ reason: 'gift_inbox_full' });
    expect(
      giftEligibility(sender(), recipient({ pendingCount: GIFT_INBOX_LIMIT - 1 }), ['hat.a'], now).eligible,
    ).toBe(true);
  });
});

describe.each(BACKENDS)('gifting ($name)', (backend) => {
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

  const asToken =
    (token: string) => (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
      api.req(method, url, { token, ...(body !== undefined ? { body } : {}) });
  const admin = asToken(ADMIN_TOKEN);

  function storeItems(currency: 'gumballs' | 'gems'): CatalogCosmetic[] {
    return api.ctx.catalog.cosmetics.filter((c) => c.source === 'store' && c.price?.currency === currency);
  }
  let itemNo = 0;
  /** A different store item for every test, so nothing carries over. */
  const nextItem = (currency: 'gumballs' | 'gems' = 'gumballs') => {
    const list = storeItems(currency);
    return list[itemNo++ % list.length]!;
  };
  const priceToday = (offerId: string) =>
    priceOffer(
      api.ctx.catalog,
      rotationForDay(api.ctx.catalog, dayKey(api.clock.now())),
      offerId,
      () => false,
    )!.price;

  async function backdate(u: TestUser, days: number): Promise<void> {
    await api.ctx.db
      .update(users)
      .set({ createdAt: new Date(api.clock.now().getTime() - days * DAY) })
      .where(eq(users.id, u.id));
  }

  async function befriend(a: TestUser, b: TestUser, days = 10): Promise<void> {
    await api.req('POST', '/friends/request', { token: a.accessToken, body: { userId: b.id } });
    const res = await api.req('POST', '/friends/accept', { token: b.accessToken, body: { userId: a.id } });
    expect(res.statusCode, res.body).toBe(200);
    await api.ctx.db
      .update(friendships)
      .set({ updatedAt: new Date(api.clock.now().getTime() - days * DAY) })
      .where(
        or(
          and(eq(friendships.userId, a.id), eq(friendships.friendId, b.id)),
          and(eq(friendships.userId, b.id), eq(friendships.friendId, a.id)),
        ),
      );
  }

  /** Two accounts old enough to gift, friends for ten days, the sender holding currency. */
  async function pair(): Promise<{ a: TestUser; b: TestUser }> {
    const a = await api.account();
    const b = await api.account();
    await backdate(a, 30);
    await backdate(b, 30);
    await befriend(a, b);
    await api.grant(a.id, 'gumballs', 100_000);
    await api.grant(a.id, 'gems', 100_000);
    return { a, b };
  }

  let ipNo = 0;
  /** Signs in again on the device token after the clock jumped past the access token. */
  async function relog(u: TestUser): Promise<void> {
    const res = await api.req('POST', '/auth/guest', {
      body: { deviceToken: u.deviceToken },
      ip: `10.78.${Math.floor(++ipNo / 250)}.${ipNo % 250}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    u.accessToken = res.json().accessToken;
  }

  const send = (from: TestUser, body: Record<string, unknown>, key = `gift-${randomUUID()}`) =>
    api.req('POST', '/gifts', { token: from.accessToken, headers: { 'idempotency-key': key }, body });
  const act = (u: TestUser, giftId: string, action: 'open' | 'decline' | 'cancel') =>
    api.req('POST', `/gifts/${giftId}/${action}`, { token: u.accessToken });

  async function wallet(u: TestUser) {
    return (await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet as {
      gumballs: number;
      gems: number;
    };
  }
  async function owned(userId: string) {
    return api.ctx.db.select().from(inventoryItems).where(eq(inventoryItems.userId, userId));
  }
  const giftLedger = (giftId: string) =>
    api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(eq(currenciesLedger.ref, `gift:${giftId}`))
      .orderBy(currenciesLedger.id);
  async function ledgerOk(...us: TestUser[]): Promise<void> {
    for (const u of us) expect((await verifyLedger(api.ctx.db, u.id)).ok, u.id).toBe(true);
  }
  const eventsFor = (userId: string, type: RealtimeEvent['type']) =>
    events.filter((e) => e.userId === userId && e.event.type === type).map((e) => e.event);

  it('charges the sender once with ref gift:<id>, grants nothing yet, and tells the recipient', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    const before = await wallet(a);
    const res = await send(a, { recipientId: b.id, offerId: item.id, message: 'happy birthday!' });
    expect(res.statusCode, res.body).toBe(200);
    const { gift } = res.json();
    const price = priceToday(item.id);
    expect(gift).toMatchObject({
      offerId: item.id,
      status: 'pending',
      price,
      message: { text: 'happy birthday!' },
      from: { userId: a.id },
      to: { userId: b.id },
      refunded: false,
    });
    expect(Date.parse(gift.opensAutomaticallyAt) - T0.getTime()).toBe(GIFT_AUTO_ACCEPT_DAYS * DAY);
    expect((await wallet(a))[price.currency as 'gumballs']).toBe(
      before[price.currency as 'gumballs'] - price.amount,
    );
    expect(await giftLedger(gift.giftId)).toEqual([
      expect.objectContaining({
        userId: a.id,
        reason: 'gift',
        delta: -price.amount,
        currency: price.currency,
      }),
    ]);
    expect((await owned(b.id)).some((i) => i.cosmeticId === item.id)).toBe(false);
    expect(eventsFor(b.id, 'gift').at(-1)).toMatchObject({
      giftId: gift.giftId,
      status: 'received',
      role: 'recipient',
      other: { userId: a.id },
      title: item.name,
    });
    const inbox = (await api.req('GET', '/gifts', { token: b.accessToken })).json();
    expect(inbox.unopened).toBe(1);
    expect(inbox.received[0]).toMatchObject({ giftId: gift.giftId, status: 'pending' });
    const outbox = (await api.req('GET', '/gifts', { token: a.accessToken })).json();
    expect(outbox.sent[0]).toMatchObject({ giftId: gift.giftId });
    expect(outbox.limits).toMatchObject({ daily: GIFT_DAILY_LIMIT, sentToday: 1 });
    await ledgerOk(a, b);
  });

  it('opens into the locker with source gift, off the wish list, and tells the sender', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem('gems');
    expect(
      (await api.req('POST', '/wishlist', { token: b.accessToken, body: { itemId: item.id } })).statusCode,
    ).toBe(200);
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    const opened = await act(b, gift.giftId, 'open');
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({ granted: [item.id], replayed: false, gift: { status: 'opened' } });
    expect(await owned(b.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ cosmeticId: item.id, source: 'gift' })]),
    );
    expect(await api.ctx.db.select().from(wishlistItems).where(eq(wishlistItems.userId, b.id))).toHaveLength(
      0,
    );
    expect(eventsFor(a.id, 'gift').at(-1)).toMatchObject({
      giftId: gift.giftId,
      status: 'opened',
      role: 'sender',
    });
    const again = await act(b, gift.giftId, 'open');
    expect(again.json()).toMatchObject({ replayed: true, granted: [] });
    expect((await act(b, gift.giftId, 'decline')).statusCode).toBe(409);
    expect((await act(a, gift.giftId, 'cancel')).json().error).toBe('gift_not_pending');
    await ledgerOk(a, b);
  });

  it('refunds the sender in full when the recipient declines, exactly once', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    const before = await wallet(a);
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    const results = await Promise.all([act(b, gift.giftId, 'decline'), act(b, gift.giftId, 'decline')]);
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(results.filter((r) => r.json().replayed)).toHaveLength(1);
    expect(results[0]!.json().gift).toMatchObject({ status: 'declined', refunded: true });
    expect(await wallet(a)).toEqual(before);
    const rows = await giftLedger(gift.giftId);
    expect(rows.map((r) => [r.reason, r.delta])).toEqual([
      ['gift', -gift.price.amount],
      ['gift_refund', gift.price.amount],
    ]);
    expect((await act(b, gift.giftId, 'open')).statusCode).toBe(409);
    expect(eventsFor(a.id, 'gift').at(-1)).toMatchObject({ status: 'declined' });
    await ledgerOk(a, b);
  });

  it('lets only the sender cancel an unopened gift, refunding it, and only the recipient open or decline', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    const before = await wallet(a);
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    expect((await act(b, gift.giftId, 'cancel')).statusCode).toBe(404);
    expect((await act(a, gift.giftId, 'open')).statusCode).toBe(404);
    expect((await act(a, gift.giftId, 'decline')).statusCode).toBe(404);
    const stranger = await api.account();
    expect((await act(stranger, gift.giftId, 'open')).statusCode).toBe(404);
    const cancelled = await act(a, gift.giftId, 'cancel');
    expect(cancelled.json().gift).toMatchObject({ status: 'cancelled', refunded: true });
    expect(await wallet(a)).toEqual(before);
    expect((await act(b, gift.giftId, 'open')).json()).toMatchObject({
      error: 'gift_not_pending',
      details: { status: 'cancelled' },
    });
    expect(eventsFor(b.id, 'gift').at(-1)).toMatchObject({ status: 'cancelled', role: 'recipient' });
    await ledgerOk(a, b);
  });

  it('turns a double submit, even a concurrent one, into one gift and one charge', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    const key = `gift-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => send(a, { recipientId: b.id, offerId: item.id }, key)),
    );
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(new Set(results.map((r) => r.json().gift.giftId)).size).toBe(1);
    expect(results.filter((r) => !r.json().replayed)).toHaveLength(1);
    const rows = await api.ctx.db.select().from(gifts).where(eq(gifts.senderId, a.id));
    expect(rows).toHaveLength(1);
    expect(await giftLedger(rows[0]!.id)).toHaveLength(1);
    const reused = await send(a, { recipientId: b.id, offerId: nextItem().id }, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error).toBe('idempotency_key_reused');
    await ledgerOk(a, b);
  });

  it('lets only one of two friends racing to gift the same item through', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const c = await api.account();
    await backdate(c, 30);
    await befriend(c, b);
    await api.grant(c.id, 'gumballs', 100_000);
    const item = nextItem();
    const [one, two] = await Promise.all([
      send(a, { recipientId: b.id, offerId: item.id }),
      send(c, { recipientId: b.id, offerId: item.id }),
    ]);
    const codes = [one.statusCode, two.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = one.statusCode === 409 ? one : two;
    expect(loser.json().error).toBe('gift_already_pending');
    const pending = await api.ctx.db
      .select()
      .from(gifts)
      .where(and(eq(gifts.recipientId, b.id), eq(gifts.status, 'pending')));
    expect(pending).toHaveLength(1);
    const charges = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(inArray(currenciesLedger.userId, [a.id, c.id]), eq(currenciesLedger.reason, 'gift')));
    expect(charges).toHaveLength(1);
    await ledgerOk(a, b, c);
  });

  it('refuses strangers, blocks, new friendships and yourself, charging nothing', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const stranger = await api.account();
    const item = nextItem();
    const before = await wallet(a);
    const self = await send(a, { recipientId: a.id, offerId: item.id });
    expect([self.statusCode, self.json().error]).toEqual([400, 'gift_self']);
    const strange = await send(a, { recipientId: stranger.id, offerId: item.id });
    expect([strange.statusCode, strange.json().error]).toEqual([403, 'gift_not_friends']);
    const ghost = await send(a, { recipientId: randomUUID(), offerId: item.id });
    expect(ghost.json()).toMatchObject({ error: 'gift_not_friends', message: strange.json().message });

    const fresh = await api.account();
    await befriend(a, fresh, 2);
    const young = await send(a, { recipientId: fresh.id, offerId: item.id });
    expect([young.statusCode, young.json().error]).toEqual([403, 'gift_friendship_too_new']);
    expect(Date.parse(young.json().details.retryAt)).toBe(T0.getTime() + DAY);

    expect(
      (await api.req('POST', '/friends/block', { token: b.accessToken, body: { userId: a.id } })).statusCode,
    ).toBe(200);
    const blocked = await send(a, { recipientId: b.id, offerId: item.id });
    expect(blocked.json()).toEqual(strange.json());
    expect(await wallet(a)).toEqual(before);
    expect(await api.ctx.db.select().from(gifts).where(eq(gifts.senderId, a.id))).toHaveLength(0);
  });

  it('keeps guests and brand-new accounts from sending', async () => {
    api.clock.set(T0.toISOString());
    const { b } = await pair();
    const guest = await api.guest();
    await backdate(guest, 30);
    await befriend(guest, b);
    await api.grant(guest.id, 'gumballs', 10_000);
    const item = nextItem();
    const g = await send(guest, { recipientId: b.id, offerId: item.id });
    expect([g.statusCode, g.json().error]).toEqual([403, 'gift_account_required']);

    const rookie = await api.account();
    await befriend(rookie, b);
    await api.grant(rookie.id, 'gumballs', 10_000);
    const r = await send(rookie, { recipientId: b.id, offerId: item.id });
    expect([r.statusCode, r.json().error]).toEqual([403, 'gift_account_too_new']);
    const picker = (
      await api.req('GET', `/gifts/eligibility?offerId=${item.id}`, { token: rookie.accessToken })
    ).json();
    expect(picker.sender).toMatchObject({ reason: 'gift_account_too_new' });
    expect(picker.friends[0]).toMatchObject({
      userId: b.id,
      eligible: false,
      reason: 'gift_account_too_new',
    });
  });

  it('refuses suspended recipients and lets a guest receive', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const guest = await api.guest();
    await befriend(a, guest);
    const item = nextItem();
    expect((await send(a, { recipientId: guest.id, offerId: item.id })).statusCode).toBe(200);
    await api.ban(b.id, 'all');
    const res = await send(a, { recipientId: b.id, offerId: item.id });
    expect([res.statusCode, res.json().error]).toEqual([409, 'gift_recipient_unavailable']);
  });

  it('refuses an item the recipient owns at send, and returns the gift if they own it by opening', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, b.id, item.id, 'event'));
    const owns = await send(a, { recipientId: b.id, offerId: item.id });
    expect([owns.statusCode, owns.json().error]).toEqual([409, 'gift_already_owned']);

    const later = nextItem();
    const before = await wallet(a);
    const { gift } = (await send(a, { recipientId: b.id, offerId: later.id })).json();
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, b.id, later.id, 'challenge'));
    const opened = await act(b, gift.giftId, 'open');
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      granted: [],
      gift: { status: 'returned', note: 'recipient_owns', refunded: true },
    });
    expect(await wallet(a)).toEqual(before);
    expect((await owned(b.id)).find((i) => i.cosmeticId === later.id)?.source).toBe('challenge');
    expect(eventsFor(a.id, 'gift').at(-1)).toMatchObject({ status: 'returned' });
    await ledgerOk(a, b);
  });

  it('gifts a bundle priced on what the recipient lacks, granting only that', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const set = STORE_SETS[1]!;
    const [has, ...lacks] = set.itemIds;
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, b.id, has!, 'event'));
    const res = await send(a, { recipientId: b.id, offerId: `bundle:${set.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const { gift } = res.json();
    expect(gift.items.map((i: { id: string }) => i.id).sort()).toEqual([...lacks].sort());
    const opened = await act(b, gift.giftId, 'open');
    expect(opened.json().granted.sort()).toEqual([...lacks].sort());
    await ledgerOk(a, b);
  });

  it('caps gifts per UTC day, cancelled ones included, and resets at midnight', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    for (let i = 0; i < GIFT_DAILY_LIMIT; i++) {
      const r = await send(a, { recipientId: b.id, offerId: nextItem().id });
      expect(r.statusCode, r.body).toBe(200);
      if (i === 0) await act(a, r.json().gift.giftId, 'cancel');
    }
    const over = await send(a, { recipientId: b.id, offerId: nextItem().id });
    expect([over.statusCode, over.json().error]).toEqual([429, 'gift_daily_limit']);
    expect(over.json().details.retryAt).toBe('2026-10-03T00:00:00.000Z');
    api.clock.set('2026-10-03T00:00:01.000Z');
    await relog(a);
    expect((await send(a, { recipientId: b.id, offerId: nextItem().id })).statusCode).toBe(200);
  });

  it('caps the recipient inbox', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const now = api.clock.now();
    await api.ctx.db.insert(gifts).values(
      Array.from({ length: GIFT_INBOX_LIMIT }, (_, i) => ({
        senderId: null,
        recipientId: b.id,
        idempotencyKey: `seed-${i}`,
        offerId: 'seed',
        items: [`seed.${i}`],
        currency: 'gumballs',
        price: 1,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 365 * DAY),
      })),
    );
    const full = await send(a, { recipientId: b.id, offerId: nextItem().id });
    expect([full.statusCode, full.json().error]).toEqual([409, 'gift_inbox_full']);
  });

  it('refuses unaffordable, unsold and mispriced gifts without a trace', async () => {
    api.clock.set(T0.toISOString());
    const { b } = await pair();
    const poor = await api.account();
    await backdate(poor, 30);
    await befriend(poor, b);
    const broke = await send(poor, { recipientId: b.id, offerId: nextItem().id });
    expect([broke.statusCode, broke.json().error]).toEqual([402, 'insufficient_funds']);
    const { a } = await pair();
    await befriend(a, b);
    const pass = api.ctx.catalog.cosmetics.find((c) => c.source === 'pass')!;
    expect((await send(a, { recipientId: b.id, offerId: pass.id })).json().error).toBe('offer_not_available');
    const shard = api.ctx.catalog.cosmetics.find((c) => c.source === 'shards')!;
    expect((await send(a, { recipientId: b.id, offerId: shard.id })).json().error).toBe(
      'offer_not_available',
    );
    const gemItem = nextItem('gems');
    const wrong = await send(a, { recipientId: b.id, offerId: gemItem.id, currency: 'gumballs' });
    expect([wrong.statusCode, wrong.json().error]).toEqual([400, 'currency_mismatch']);
    const crowns = await send(a, { recipientId: b.id, offerId: gemItem.id, currency: 'crown_shards' });
    expect(crowns.statusCode).toBe(400);
    expect(
      await api.ctx.db
        .select()
        .from(gifts)
        .where(inArray(gifts.senderId, [poor.id, a.id])),
    ).toHaveLength(0);
    const keyless = await api.req('POST', '/gifts', {
      token: a.accessToken,
      body: { recipientId: b.id, offerId: gemItem.id },
    });
    expect(keyless.json().error).toBe('idempotency_key_required');
  });

  it('filters the message, limits its length and silences muted senders', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const res = await send(a, { recipientId: b.id, offerId: nextItem().id, message: 'gg you absolute shit' });
    expect(res.statusCode, res.body).toBe(200);
    const msg = res.json().gift.message;
    expect(msg.text).toContain('absolute');
    expect(msg.masked).toBeDefined();
    expect(msg.masked).not.toContain('shit');
    const long = await send(a, { recipientId: b.id, offerId: nextItem().id, message: 'x'.repeat(81) });
    expect(long.statusCode).toBe(400);
    const blank = await send(a, { recipientId: b.id, offerId: nextItem().id, message: '   ' });
    expect(blank.json().gift.message).toBeNull();
    await api.ban(a.id, 'chat');
    const muted = await send(a, { recipientId: b.id, offerId: nextItem().id, message: 'hi' });
    expect([muted.statusCode, muted.json().error]).toEqual([403, 'gift_message_muted']);
    expect((await send(a, { recipientId: b.id, offerId: nextItem().id })).statusCode).toBe(200);
  });

  it('closes sending, declining and cancelling with the store switch, and every action in maintenance', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const { gift } = (await send(a, { recipientId: b.id, offerId: nextItem().id })).json();
    expect((await admin('PUT', '/internal/flags/store.enabled', { enabled: false })).statusCode).toBe(200);
    try {
      for (const res of [
        await send(a, { recipientId: b.id, offerId: nextItem().id }),
        await act(b, gift.giftId, 'decline'),
        await act(a, gift.giftId, 'cancel'),
      ]) {
        expect([res.statusCode, res.json().error]).toEqual([503, 'feature_disabled']);
      }
    } finally {
      await admin('PUT', '/internal/flags/store.enabled', { enabled: true });
    }
    expect(
      (await admin('PUT', '/internal/maintenance', { enabled: true, message: 'Mopping' })).statusCode,
    ).toBe(200);
    try {
      for (const res of [
        await send(a, { recipientId: b.id, offerId: nextItem().id }),
        await act(b, gift.giftId, 'open'),
        await act(b, gift.giftId, 'decline'),
      ]) {
        expect([res.statusCode, res.json().error]).toEqual([503, 'maintenance']);
      }
    } finally {
      await admin('DELETE', '/internal/maintenance');
    }
    expect((await act(b, gift.giftId, 'open')).statusCode).toBe(200);
  });

  it('auto-accepts a gift left unopened for 30 days, and then refuses cancelling it', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    const second = (await send(a, { recipientId: b.id, offerId: nextItem().id })).json().gift;
    api.clock.advance(GIFT_AUTO_ACCEPT_DAYS * DAY - 1);
    expect(await settleExpiredGifts(api.ctx)).toBe(0);
    api.clock.advance(1);
    await relog(a);
    await relog(b);
    const cancel = await act(a, second.giftId, 'cancel');
    expect([cancel.statusCode, cancel.json().error]).toEqual([409, 'gift_not_pending']);
    const inbox = (await api.req('GET', '/gifts', { token: b.accessToken })).json();
    expect(inbox.unopened).toBe(0);
    expect(inbox.received.find((g: { giftId: string }) => g.giftId === gift.giftId)).toMatchObject({
      status: 'opened',
      autoAccepted: true,
    });
    expect((await owned(b.id)).find((i) => i.cosmeticId === item.id)?.source).toBe('gift');
    expect(eventsFor(a.id, 'gift').some((e) => e.type === 'gift' && e.autoAccepted)).toBe(true);
    await ledgerOk(a, b);
  });

  it('auto-accepts from the retention sweep too, returning what the recipient already owns', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem();
    const before = await wallet(a);
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, b.id, item.id, 'event'));
    api.clock.advance(GIFT_AUTO_ACCEPT_DAYS * DAY);
    const r = await api.ops.runRetention();
    expect(r.gifts).toBeGreaterThanOrEqual(1);
    const [row] = await api.ctx.db.select().from(gifts).where(eq(gifts.id, gift.giftId));
    expect(row).toMatchObject({ status: 'returned', refunded: true, note: 'recipient_owns' });
    await relog(a);
    expect(await wallet(a)).toEqual(before);
    await ledgerOk(a, b);
  });

  it('pays a Gem refund into Gem debt first', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = nextItem('gems');
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    const gems = (await wallet(a)).gems;
    await api.ctx.db.transaction((tx) => revokeGems(tx, a.id, gems + 10, `test:${randomUUID()}`));
    await act(b, gift.giftId, 'decline');
    const w = (await api.req('GET', '/wallet', { token: a.accessToken })).json();
    expect(w.gemDebt).toBe(0);
    expect(w.wallet.gems).toBe(gift.price.amount - 10);
    await ledgerOk(a, b);
  });

  it('returns unopened gifts to their senders when the recipient deletes their account', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const before = await wallet(a);
    const { gift } = (await send(a, { recipientId: b.id, offerId: nextItem().id, message: 'enjoy' })).json();
    const opened = (await send(a, { recipientId: b.id, offerId: nextItem().id })).json().gift;
    await act(b, opened.giftId, 'open');
    const del = await api.req('DELETE', '/me', { token: b.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const rows = await api.ctx.db
      .select()
      .from(gifts)
      .where(inArray(gifts.id, [gift.giftId, opened.giftId]));
    expect(rows.find((g) => g.id === gift.giftId)).toMatchObject({
      status: 'returned',
      note: 'recipient_deleted',
      refunded: true,
      recipientId: null,
    });
    expect(rows.find((g) => g.id === opened.giftId)).toMatchObject({ status: 'opened', recipientId: null });
    expect((await wallet(a)).gumballs).toBe(before.gumballs - opened.price.amount);
    const view = (await api.req('GET', '/gifts', { token: a.accessToken })).json();
    expect(view.sent.find((g: { giftId: string }) => g.giftId === gift.giftId)).toMatchObject({
      status: 'returned',
      to: null,
    });
    await ledgerOk(a);
  });

  it("keeps a deleted sender's unopened gift for the recipient, without the note or a refund", async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const keep = (await send(a, { recipientId: b.id, offerId: nextItem().id, message: 'from me' })).json()
      .gift;
    const toDecline = (await send(a, { recipientId: b.id, offerId: nextItem().id })).json().gift;
    const del = await api.req('DELETE', '/me', { token: a.accessToken, body: { confirm: 'DELETE' } });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const inbox = (await api.req('GET', '/gifts', { token: b.accessToken })).json();
    expect(inbox.received.find((g: { giftId: string }) => g.giftId === keep.giftId)).toMatchObject({
      status: 'pending',
      from: null,
      message: null,
    });
    expect((await act(b, keep.giftId, 'open')).json().gift.status).toBe('opened');
    expect((await act(b, toDecline.giftId, 'decline')).json().gift).toMatchObject({
      status: 'declined',
      refunded: false,
    });
    await ledgerOk(b);
  });

  it('lists every friend in the picker with a price or the reason they cannot get it', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const owner = await api.account();
    await befriend(a, owner);
    const fresh = await api.account();
    await befriend(a, fresh, 1);
    const item = nextItem();
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, owner.id, item.id, 'event'));
    const res = await api.req('GET', `/gifts/eligibility?offerId=${item.id}`, { token: a.accessToken });
    expect(res.statusCode, res.body).toBe(200);
    const picker = res.json();
    expect(picker).toMatchObject({
      offerId: item.id,
      title: item.name,
      sender: null,
      dailyLimit: GIFT_DAILY_LIMIT,
    });
    expect(picker.friends[0]).toMatchObject({ userId: b.id, eligible: true, price: priceToday(item.id) });
    const byId = new Map(picker.friends.map((f: { userId: string }) => [f.userId, f]));
    expect(byId.get(owner.id)).toMatchObject({ eligible: false, reason: 'gift_already_owned' });
    expect(byId.get(fresh.id)).toMatchObject({ eligible: false, reason: 'gift_friendship_too_new' });
    const unknown = await api.req('GET', '/gifts/eligibility?offerId=nope.nope', { token: a.accessToken });
    expect(unknown.statusCode).toBe(404);
  });

  it('shows gifts to moderators and lets only admins reverse them, audited and ledger-correct', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const item = [...storeItems('gems'), ...storeItems('gumballs')].find((c) => c.slot === 'headwear')!;
    const before = await wallet(a);
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    await act(b, gift.giftId, 'open');
    const slots = (await api.req('GET', '/loadouts', { token: b.accessToken })).json().slots;
    const put = await api.req('PUT', '/loadouts/0', {
      token: b.accessToken,
      body: { name: 'Gifted', items: { ...slots[0].items, headwear: item.id } },
    });
    expect(put.statusCode, put.body).toBe(200);

    const modUser = await api.account();
    expect((await admin('PUT', `/internal/staff/${modUser.id}`, { role: 'moderator' })).statusCode).toBe(200);
    const session = await api.req('POST', '/admin/session', { token: modUser.accessToken, ip: '10.250.1.1' });
    const mod = asToken(session.json().token as string);
    const lookup = await mod('GET', `/internal/users/${a.id}/gifts`);
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json().sent[0]).toMatchObject({
      giftId: gift.giftId,
      status: 'opened',
      ledger: [expect.objectContaining({ reason: 'gift', delta: -gift.price.amount })],
    });
    expect((await mod('GET', `/internal/users/${b.id}/gifts`)).json().received[0].giftId).toBe(gift.giftId);
    const denied = await mod('POST', `/internal/gifts/${gift.giftId}/reverse`, { reason: 'chargeback' });
    expect([denied.statusCode, denied.json().error]).toEqual([403, 'insufficient_role']);
    expect((await admin('POST', `/internal/gifts/${gift.giftId}/reverse`, {})).statusCode).toBe(400);

    const rev = await admin('POST', `/internal/gifts/${gift.giftId}/reverse`, { reason: 'stolen card' });
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json()).toMatchObject({
      previousStatus: 'opened',
      revoked: [item.id],
      loadoutsChanged: [0],
      refunded: true,
      gift: { status: 'reversed', note: 'staff' },
    });
    expect((await owned(b.id)).some((i) => i.cosmeticId === item.id)).toBe(false);
    expect(await wallet(a)).toEqual(before);
    const [audit] = await api.ctx.db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.action, 'gift.reverse'), eq(adminAuditLog.targetId, gift.giftId)));
    expect(audit).toMatchObject({ reason: 'stolen card', actorRole: 'admin', targetType: 'gift' });
    const twice = await admin('POST', `/internal/gifts/${gift.giftId}/reverse`, { reason: 'again' });
    expect([twice.statusCode, twice.json().error]).toEqual([409, 'gift_not_reversible']);
    expect(eventsFor(b.id, 'gift').at(-1)).toMatchObject({ status: 'reversed' });
    await ledgerOk(a, b);
  });

  it('reverses a pending gift, and keeps an item the recipient has since earned', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const pendingGift = (await send(a, { recipientId: b.id, offerId: nextItem().id })).json().gift;
    const rev = await admin('POST', `/internal/gifts/${pendingGift.giftId}/reverse`, { reason: 'abuse' });
    expect(rev.json()).toMatchObject({ previousStatus: 'pending', revoked: [], refunded: true });
    expect((await act(b, pendingGift.giftId, 'open')).statusCode).toBe(409);

    const item = nextItem();
    const { gift } = (await send(a, { recipientId: b.id, offerId: item.id })).json();
    await act(b, gift.giftId, 'open');
    await api.ctx.db.transaction((tx) => grantCosmetic(tx, b.id, item.id, 'achievement'));
    const kept = await admin('POST', `/internal/gifts/${gift.giftId}/reverse`, { reason: 'abuse' });
    expect(kept.json()).toMatchObject({ revoked: [], refunded: true });
    expect((await owned(b.id)).find((i) => i.cosmeticId === item.id)?.source).toBe('achievement');
    await ledgerOk(a, b);
  });

  it('keeps gifts out of purchase history, so neither side can self-refund one', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const { gift } = (await send(a, { recipientId: b.id, offerId: nextItem().id })).json();
    await act(b, gift.giftId, 'open');
    for (const u of [a, b]) {
      const h = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
      expect(h.purchases).toHaveLength(0);
    }
    const refund = await api.req('POST', `/purchases/${gift.giftId}/refund`, { token: b.accessToken });
    expect(refund.statusCode).toBe(404);
  });

  it('keeps every balance equal to its ledger across a mix of gifts', async () => {
    api.clock.set(T0.toISOString());
    const { a, b } = await pair();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        (await send(a, { recipientId: b.id, offerId: nextItem(i % 2 ? 'gems' : 'gumballs').id })).json().gift
          .giftId,
      );
    await act(b, ids[0]!, 'open');
    await act(b, ids[1]!, 'decline');
    await act(a, ids[2]!, 'cancel');
    await admin('POST', `/internal/gifts/${ids[3]}/reverse`, { reason: 'test' });
    const rows = await api.ctx.db
      .select({ reason: currenciesLedger.reason, n: sql<number>`count(*)::int` })
      .from(currenciesLedger)
      .where(
        and(eq(currenciesLedger.userId, a.id), inArray(currenciesLedger.reason, ['gift', 'gift_refund'])),
      )
      .groupBy(currenciesLedger.reason);
    expect(Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)]))).toEqual({ gift: 4, gift_refund: 3 });
    await ledgerOk(a, b);
  });
});
