import { shardShopAt, xpForLevel } from '@tumble/content/progression';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { challengeProgress, purchases } from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import { addXp } from '../src/progression/xp.ts';
import { buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
});

async function wallet(u: TestUser) {
  return (await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet as {
    gumballs: number;
    gems: number;
    crownShards: number;
  };
}

const buy = (u: TestUser, offerId: string, key: string) =>
  api.req('POST', '/shop/shards/buy', {
    token: u.accessToken,
    body: { offerId },
    headers: { 'idempotency-key': key },
  });

describe('Crown Shard shop', () => {
  it("lists this week's shelf with prices, balance and restock time", async () => {
    const u = await api.guest();
    const r = (await api.req('GET', '/shop/shards', { token: u.accessToken })).json();
    const shelf = shardShopAt(api.clock.now());
    expect(r.week).toBe('2026-W40');
    expect(r.refreshesAt).toBe('2026-10-05T00:00:00.000Z');
    expect(r.balance).toBe(0);
    expect(r.offers.map((o: { offerId: string }) => o.offerId)).toEqual(shelf.offers.map((o) => o.itemId));
    for (const o of r.offers) {
      expect(o.item.source).toBe('shards');
      expect(o.price.currency).toBe('crown_shards');
      expect(o.owned).toBe(false);
    }
    expect((await api.req('GET', '/shop/shards')).json().balance).toBeNull();
  });

  it('refuses without enough shards and changes nothing', async () => {
    const u = await api.guest();
    const offer = shardShopAt(api.clock.now()).offers[0]!;
    await api.grant(u.id, 'crown_shards', offer.price - 1);
    const res = await buy(u, offer.itemId, 'shard-poor-0001');
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('insufficient_funds');
    expect((await wallet(u)).crownShards).toBe(offer.price - 1);
  });

  it('buys once per key, writes a ledger spend and grants the item', async () => {
    const u = await api.guest();
    const [offer, other] = shardShopAt(api.clock.now()).offers;
    await api.grant(u.id, 'crown_shards', 59);
    const first = await buy(u, offer!.itemId, 'shard-buy-0001');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      offerId: offer!.itemId,
      price: { currency: 'crown_shards', amount: offer!.price },
      replayed: false,
    });
    expect(first.json().wallet.crownShards).toBe(59 - offer!.price);

    const again = await buy(u, offer!.itemId, 'shard-buy-0001');
    expect(again.json()).toMatchObject({ replayed: true, purchaseId: first.json().purchaseId });
    expect((await wallet(u)).crownShards).toBe(59 - offer!.price);

    expect((await buy(u, other!.itemId, 'shard-buy-0001')).json().error).toBe('idempotency_key_reused');
    expect((await buy(u, offer!.itemId, 'shard-buy-0002')).json().error).toBe('already_owned');

    const inv = (await api.req('GET', '/inventory', { token: u.accessToken })).json();
    expect(inv.items.some((i: { id: string }) => i.id === offer!.itemId)).toBe(true);
    const rows = await api.ctx.db.select().from(purchases).where(eq(purchases.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'shard_item', currency: 'crown_shards', status: 'completed' });
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('refuses items that are not on the shelf this week', async () => {
    const u = await api.guest();
    await api.grant(u.id, 'crown_shards', 59);
    const onShelf = new Set(shardShopAt(api.clock.now()).offers.map((o) => o.itemId));
    const offShelf = api.ctx.catalog.cosmetics.find((c) => c.source === 'shards' && !onShelf.has(c.id))!;
    expect((await buy(u, offShelf.id, 'shard-off-0001')).json().error).toBe('offer_not_available');
    expect((await buy(u, 'headwear.tiara', 'shard-off-0002')).json().error).toBe('offer_not_available');
  });
});

describe('free Gem earn paths', () => {
  it('pays the first Crown of each UTC day only once', async () => {
    const u = await api.guest();
    const crownGems = (r: { gems?: { lines: { label: string; amount: number }[] } }) =>
      (r.gems?.lines ?? [])
        .filter((l) => l.label === 'First Crown of the day')
        .reduce((s, l) => s + l.amount, 0);
    const win = async () =>
      (await api.postMatch(buildShow({ humans: [{ userId: u.id, placement: 1 }] }))).json().rewards[0];
    expect(crownGems(await win())).toBe(api.ctx.catalog.gemEarn.firstCrownOfDay);
    expect(crownGems(await win())).toBe(0);
    api.clock.advance(86_400_000);
    expect(crownGems(await win())).toBe(api.ctx.catalog.gemEarn.firstCrownOfDay);
    api.clock.set('2026-10-02T12:00:00.000Z');
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('pays Gems on level milestones', async () => {
    const u = await api.guest();
    const every = api.ctx.catalog.gemEarn.levelMilestoneEvery;
    const r = await api.ctx.db.transaction((tx) => addXp(tx, api.ctx.catalog, u.id, xpForLevel(every)));
    expect(r.levelAfter).toBe(every);
    expect(r.levelGems).toBe(api.ctx.catalog.gemEarn.levelMilestone);
    expect((await wallet(u)).gems).toBe(api.ctx.catalog.gemEarn.levelMilestone);
  });

  it('pays Gems for weekly challenges, not dailies', async () => {
    const u = await api.guest();
    const board = (await api.req('GET', '/challenges', { token: u.accessToken })).json();
    const weekly = board.weekly[0];
    const daily = board.daily[0];
    expect(weekly.reward.gems).toBe(api.ctx.catalog.gemEarn.weeklyChallenge);
    expect(daily.reward.gems).toBe(0);
    for (const c of [weekly, daily])
      await api.ctx.db
        .update(challengeProgress)
        .set({ progress: c.target, completedAt: api.clock.now() })
        .where(and(eq(challengeProgress.id, c.id), eq(challengeProgress.userId, u.id)));
    const w = (
      await api.req('POST', '/challenges/claim', { token: u.accessToken, body: { id: weekly.id } })
    ).json();
    expect(w.gems).toBe(api.ctx.catalog.gemEarn.weeklyChallenge);
    const d = (
      await api.req('POST', '/challenges/claim', { token: u.accessToken, body: { id: daily.id } })
    ).json();
    expect(d.gems).toBe(0);
    expect((await wallet(u)).gems).toBe(api.ctx.catalog.gemEarn.weeklyChallenge);
  });

  it('reports a test checkout for the dev fake provider', async () => {
    const r = (await api.req('GET', '/gems/packs')).json();
    expect(r).toMatchObject({ provider: 'fake', checkout: 'test' });
    expect(r.packs.length).toBeGreaterThan(0);
  });
});
