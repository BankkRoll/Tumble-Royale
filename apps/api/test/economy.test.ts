import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_CATALOG as CATALOG } from '../src/catalog.ts';
import { addPassXp } from '../src/progression/xp.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import { DisabledPaymentProvider } from '../src/economy/payments.ts';
import { purchases } from '../src/db/schema.ts';
import { DAILY_COUNT, FEATURED_COUNT, rotationForDay } from '../src/economy/store.ts';
import { createTestApi, type TestApi } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

async function todaysGumballOffer() {
  const store = (await api.req('GET', '/store')).json();
  const offer = [...store.featured, ...store.daily].find(
    (o: { price: { currency: string } }) => o.price.currency === 'gumballs',
  );
  if (!offer) throw new Error('no gumball offer today');
  return offer as { offerId: string; price: { currency: 'gumballs'; amount: number } };
}

describe('store rotation', () => {
  it('is deterministic per day and changes between days', () => {
    const a = rotationForDay(CATALOG, '2026-10-02');
    const b = rotationForDay(CATALOG, '2026-10-02');
    expect(a).toEqual(b);
    expect(a.featured).toHaveLength(FEATURED_COUNT);
    expect(a.daily).toHaveLength(DAILY_COUNT);
    const ids = [...a.featured, ...a.daily].map((o) => o.offerId);
    expect(new Set(ids).size).toBe(ids.length);
    const days = ['2026-10-03', '2026-10-04', '2026-10-05'].map((d) => rotationForDay(CATALOG, d));
    expect(days.some((d) => JSON.stringify(d.daily) !== JSON.stringify(a.daily))).toBe(true);
  });

  it('only sells priced store items', () => {
    const r = rotationForDay(CATALOG, '2026-12-25');
    for (const o of [...r.featured, ...r.daily]) {
      expect(o.item.source).toBe('store');
      expect(o.price.amount).toBeGreaterThan(0);
    }
  });

  it('serves today with a countdown to midnight UTC', async () => {
    const store = (await api.req('GET', '/store')).json();
    expect(store.day).toBe('2026-10-02');
    expect(store.refreshesAt).toBe('2026-10-03T00:00:00.000Z');
    expect(store.secondsRemaining).toBe(12 * 3600);
    expect(store.daily.map((o: { offerId: string }) => o.offerId)).toEqual(
      rotationForDay(CATALOG, '2026-10-02').daily.map((o) => o.offerId),
    );
  });
});

describe('purchases', () => {
  it('is idempotent: same key twice grants once and charges once', async () => {
    const u = await api.guest();
    const offer = await todaysGumballOffer();
    await api.grant(u.id, 'gumballs', offer.price.amount * 3);
    const headers = { 'idempotency-key': 'buy-once-123456' };
    const first = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers,
      body: { offerId: offer.offerId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      offerId: offer.offerId,
      replayed: false,
      wallet: { gumballs: offer.price.amount * 2 },
    });
    const second = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers,
      body: { offerId: offer.offerId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ purchaseId: first.json().purchaseId, replayed: true });

    const wallet = (await api.req('GET', '/wallet', { token: u.accessToken })).json();
    expect(wallet.wallet.gumballs).toBe(offer.price.amount * 2);
    expect(wallet.recent.filter((r: { reason: string }) => r.reason === 'purchase')).toHaveLength(1);
    const inv = (await api.req('GET', '/inventory', { token: u.accessToken })).json();
    expect(inv.items.filter((i: { id: string }) => i.id === offer.offerId)).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('handles concurrent duplicates with the same key', async () => {
    const u = await api.guest();
    const offer = await todaysGumballOffer();
    await api.grant(u.id, 'gumballs', offer.price.amount);
    const headers = { 'idempotency-key': 'concurrent-key-1' };
    const [a, b] = await Promise.all([
      api.req('POST', '/purchase', { token: u.accessToken, headers, body: { offerId: offer.offerId } }),
      api.req('POST', '/purchase', { token: u.accessToken, headers, body: { offerId: offer.offerId } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().purchaseId).toBe(b.json().purchaseId);
    expect((await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet.gumballs).toBe(0);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('rejects reusing a key for a different item', async () => {
    const u = await api.guest();
    const store = (await api.req('GET', '/store')).json();
    const offers = [...store.featured, ...store.daily];
    await api.grant(u.id, 'gumballs', 100_000);
    await api.grant(u.id, 'gems', 100_000);
    const headers = { 'idempotency-key': 'reuse-key-abc' };
    expect(
      (
        await api.req('POST', '/purchase', {
          token: u.accessToken,
          headers,
          body: { offerId: offers[0].offerId },
        })
      ).statusCode,
    ).toBe(200);
    const other = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers,
      body: { offerId: offers[1].offerId },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('idempotency_key_reused');
  });

  it('fails with insufficient funds and changes nothing', async () => {
    const u = await api.guest();
    const offer = await todaysGumballOffer();
    await api.grant(u.id, 'gumballs', offer.price.amount - 1);
    const res = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers: { 'idempotency-key': 'poor-player-1' },
      body: { offerId: offer.offerId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_funds', details: { missing: 1 } });
    expect((await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet.gumballs).toBe(
      offer.price.amount - 1,
    );
    const inv = (await api.req('GET', '/inventory', { token: u.accessToken })).json();
    expect(inv.items.some((i: { id: string }) => i.id === offer.offerId)).toBe(false);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('requires an Idempotency-Key and refuses items not on sale today', async () => {
    const u = await api.guest();
    const passItem = CATALOG.cosmetics.find((c) => c.source === 'pass')!.id;
    expect(
      (await api.req('POST', '/purchase', { token: u.accessToken, body: { offerId: passItem } })).statusCode,
    ).toBe(400);
    const notSold = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers: { 'idempotency-key': 'pass-item-key' },
      body: { offerId: passItem },
    });
    expect(notSold.statusCode).toBe(404);
  });

  it('keeps the ledger append-only', async () => {
    const u = await api.guest();
    await api.grant(u.id, 'gems', 10);
    await expect(api.ctx.db.execute(sql`update currencies_ledger set delta = 999999`)).rejects.toThrow();
    await expect(api.ctx.db.execute(sql`delete from currencies_ledger`)).rejects.toThrow();
  });
});

describe('gems & premium pass', () => {
  it('completes a fake checkout once per key', async () => {
    const u = await api.guest();
    const headers = { 'idempotency-key': 'gems-checkout-1' };
    const res = await api.req('POST', '/gems/checkout', {
      token: u.accessToken,
      headers,
      body: { packId: 'gems.1100' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'completed', provider: 'fake', gems: 1100 });
    const again = await api.req('POST', '/gems/checkout', {
      token: u.accessToken,
      headers,
      body: { packId: 'gems.1100' },
    });
    expect(again.json()).toMatchObject({ status: 'completed', replayed: true });
    expect((await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet.gems).toBe(1100);
  });

  it('refuses gem checkout without recording a purchase when payments are disabled', async () => {
    const u = await api.guest();
    const original = api.ctx.payments;
    api.ctx.payments = new DisabledPaymentProvider();
    try {
      const res = await api.req('POST', '/gems/checkout', {
        token: u.accessToken,
        headers: { 'idempotency-key': 'gems-disabled-1' },
        body: { packId: 'gems.1100' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'payments_unavailable' });
      const rows = await api.ctx.db.select().from(purchases).where(eq(purchases.userId, u.id));
      expect(rows).toHaveLength(0);
    } finally {
      api.ctx.payments = original;
    }
  });

  it('unlocks the premium pass with gems and claims tier rewards', async () => {
    const u = await api.guest();
    const noGems = await api.req('POST', '/pass/premium', {
      token: u.accessToken,
      headers: { 'idempotency-key': 'premium-poor' },
    });
    expect(noGems.statusCode).toBe(402);
    await api.grant(u.id, 'gems', 1000);
    const unlock = await api.req('POST', '/pass/premium', {
      token: u.accessToken,
      headers: { 'idempotency-key': 'premium-1' },
    });
    expect(unlock.statusCode).toBe(200);
    expect(unlock.json().wallet.gems).toBe(1000 - CATALOG.season.premiumPriceGems);

    expect(
      (
        await api.req('POST', '/pass/claim', { token: u.accessToken, body: { tier: 1, track: 'premium' } })
      ).json().error,
    ).toBe('tier_locked');
    const tier1 = CATALOG.season.tiers[0]!;
    await api.ctx.db.transaction((tx) => addPassXp(tx, CATALOG, u.id, tier1.xp));
    const pass = (await api.req('GET', '/pass', { token: u.accessToken })).json();
    expect(pass).toMatchObject({ tier: 1, premium: true });
    const premiumClaim = await api.req('POST', '/pass/claim', {
      token: u.accessToken,
      body: { tier: 1, track: 'premium' },
    });
    expect(premiumClaim.statusCode).toBe(200);
    expect(premiumClaim.json().rewards).toHaveLength(tier1.premium.length);
    expect(premiumClaim.json().rewards.every((r: { granted: boolean }) => r.granted)).toBe(true);
    expect(
      (
        await api.req('POST', '/pass/claim', { token: u.accessToken, body: { tier: 1, track: 'premium' } })
      ).json().error,
    ).toBe('already_claimed');
  });
});
