import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MESH_IDS,
  ANIM_CLIP_IDS,
  COSMETICS,
  STORE_PRICE,
  STORE_SETS,
  getCosmetic,
  type CosmeticSlot,
} from '../src/cosmetics/index.ts';
import {
  BUNDLE_DISCOUNT,
  DAILY_DEAL_DISCOUNT,
  STORE_DAILY_COUNT,
  STORE_FEATURED_COUNT,
  STORE_WEEKLY_COUNT,
  WEEKLY_DISCOUNT,
  discountedPrice,
  quoteBundle,
  sellableItems,
  storePriceOnShelf,
  storeSetById,
  storeShelfAt,
  storeShelfForDay,
} from '../src/progression/index.ts';

const STORE = COSMETICS.filter((c) => c.source === 'store');

describe('item shop collection', () => {
  it('stocks a broad catalog in every slot', () => {
    expect(STORE.length).toBeGreaterThanOrEqual(150);
    const slots: CosmeticSlot[] = [
      'color',
      'pattern',
      'face',
      'upper',
      'lower',
      'headwear',
      'back',
      'emote',
      'celebration',
      'victory',
      'nameplate',
      'banner',
      'trail',
      'footsteps',
    ];
    for (const slot of slots) expect(STORE.filter((c) => c.slot === slot).length, slot).toBeGreaterThan(3);
  });

  it('prices every store item on the rarity curve', () => {
    for (const c of STORE) {
      expect(c.price, c.id).toEqual(STORE_PRICE[c.rarity]);
      expect(c.price!.amount).toBeGreaterThanOrEqual(400);
      expect(c.price!.amount).toBeLessThanOrEqual(3000);
      expect(c.price!.currency).toBe(c.rarity === 'legendary' || c.rarity === 'mythic' ? 'gems' : 'gumballs');
    }
  });

  it('only uses render parameters the Tumbler implements', () => {
    for (const c of COSMETICS) {
      if (c.slot === 'headwear' || c.slot === 'back' || c.slot === 'upper' || c.slot === 'lower') {
        expect((ACCESSORY_MESH_IDS[c.slot] as readonly string[]).includes(c.mesh), c.id).toBe(true);
        expect(c.tint.length, c.id).toBeGreaterThan(0);
      }
      if (c.slot === 'face' && c.face.accessory)
        expect((ACCESSORY_MESH_IDS.face as readonly string[]).includes(c.face.accessory), c.id).toBe(true);
      if ('clip' in c) expect((ANIM_CLIP_IDS as readonly string[]).includes(c.clip), c.id).toBe(true);
    }
  });
});

describe('store sets', () => {
  it('are valid single-currency bundles of store items', () => {
    const ids = new Set<string>();
    for (const set of STORE_SETS) {
      expect(set.id).toMatch(/^bundle\.[a-z0-9-]+$/);
      expect(ids.has(set.id)).toBe(false);
      ids.add(set.id);
      expect(set.itemIds.length).toBeGreaterThanOrEqual(3);
      expect(new Set(set.itemIds).size).toBe(set.itemIds.length);
      const items = set.itemIds.map((id) => getCosmetic(id));
      for (const [i, item] of items.entries()) {
        expect(item, set.itemIds[i]).toBeDefined();
        expect(item!.source).toBe('store');
      }
      expect(new Set(items.map((i) => i!.price!.currency)).size).toBe(1);
      expect(quoteBundle(set, COSMETICS, () => false)).not.toBeNull();
    }
  });

  it('quotes only the missing items, at the bundle discount', () => {
    const set = STORE_SETS[0]!;
    const full = quoteBundle(set, COSMETICS, () => false)!;
    const list = set.itemIds.reduce((n, id) => n + getCosmetic(id)!.price!.amount, 0);
    expect(full.offerId).toBe(`bundle:${set.id}`);
    expect(full.missing).toEqual([...set.itemIds]);
    expect(full.listPrice.amount).toBe(list);
    expect(full.price).toEqual(
      discountedPrice({ currency: full.price.currency, amount: list }, BUNDLE_DISCOUNT),
    );
    expect(full.price.amount).toBeLessThan(list);

    const owned = new Set([set.itemIds[0]!]);
    const partial = quoteBundle(set, COSMETICS, (id) => owned.has(id))!;
    expect(partial.missing).not.toContain(set.itemIds[0]);
    expect(partial.price.amount).toBeLessThan(full.price.amount);

    const done = quoteBundle(set, COSMETICS, () => true)!;
    expect(done.missing).toEqual([]);
    expect(done.price.amount).toBe(0);
    expect(storeSetById(full.offerId)).toBe(set);
  });
});

describe('store rotation', () => {
  it('is deterministic per UTC day and changes between days', () => {
    const a = storeShelfForDay('2026-10-02', COSMETICS);
    expect(storeShelfForDay('2026-10-02', COSMETICS)).toEqual(a);
    expect(storeShelfAt(new Date('2026-10-02T23:59:59Z'), COSMETICS)).toEqual(a);
    const later = ['2026-10-03', '2026-10-04', '2026-10-05'].map((d) => storeShelfForDay(d, COSMETICS));
    expect(later.some((d) => JSON.stringify(d.daily) !== JSON.stringify(a.daily))).toBe(true);
  });

  it('fills every shelf with distinct sellable items', () => {
    for (const day of ['2026-01-01', '2026-06-15', '2026-10-02', '2026-12-31']) {
      const s = storeShelfForDay(day, COSMETICS);
      expect(s.featured).toHaveLength(STORE_FEATURED_COUNT);
      expect(s.daily).toHaveLength(STORE_DAILY_COUNT);
      expect(s.weekly).toHaveLength(STORE_WEEKLY_COUNT);
      const all = [...s.featured, ...s.daily, ...s.weekly];
      expect(new Set(all.map((o) => o.offerId)).size).toBe(all.length);
      for (const o of all) {
        expect(o.item.source).toBe('store');
        expect(o.price.currency).toBe(o.listPrice.currency);
        expect(o.price.amount).toBeGreaterThan(0);
        expect(o.price.amount).toBeLessThanOrEqual(o.listPrice.amount);
      }
      for (const o of s.featured) expect(['epic', 'legendary', 'mythic']).toContain(o.item.rarity);
      expect(s.heroBundleId).not.toBeNull();
    }
  });

  it('keeps the weekly shelf for the whole ISO week and restocks on Monday', () => {
    const mon = storeShelfForDay('2026-09-28', COSMETICS);
    const sun = storeShelfForDay('2026-10-04', COSMETICS);
    const next = storeShelfForDay('2026-10-05', COSMETICS);
    expect(sun.weekly).toEqual(mon.weekly);
    expect(sun.heroBundleId).toBe(mon.heroBundleId);
    expect(mon.weeklyEndsAt).toBe('2026-10-05T00:00:00.000Z');
    expect(mon.dailyEndsAt).toBe('2026-09-29T00:00:00.000Z');
    expect(next.week).not.toBe(mon.week);
  });

  it('discounts the deal of the day and the weekly shelf', () => {
    const s = storeShelfForDay('2026-10-02', COSMETICS);
    const [deal, ...rest] = s.daily;
    expect(deal!.deal).toBe(true);
    expect(deal!.price).toEqual(discountedPrice(deal!.listPrice, DAILY_DEAL_DISCOUNT));
    for (const o of rest) expect(o.price).toEqual(o.listPrice);
    for (const o of s.featured) expect(o.deal).toBe(false);
    for (const o of s.weekly) expect(o.price).toEqual(discountedPrice(o.listPrice, WEEKLY_DISCOUNT));
  });

  it('prices items at their shelf price, else their list price', () => {
    const s = storeShelfForDay('2026-10-02', COSMETICS);
    const deal = s.daily[0]!;
    expect(storePriceOnShelf(s, deal.item)).toEqual(deal.price);
    const offShelf = sellableItems(COSMETICS).find(
      (c) => ![...s.featured, ...s.daily, ...s.weekly].some((o) => o.offerId === c.id),
    )!;
    expect(storePriceOnShelf(s, offShelf)).toEqual(offShelf.price);
    expect(
      storePriceOnShelf(
        s,
        COSMETICS.find((c) => c.source === 'pass')!,
      ),
    ).toBeNull();
  });

  it('rounds discounts to tidy amounts', () => {
    expect(discountedPrice({ currency: 'gumballs', amount: 1500 }, 0.3)).toEqual({
      currency: 'gumballs',
      amount: 1050,
    });
    expect(discountedPrice({ currency: 'gems', amount: 800 }, 0.15).amount % 10).toBe(0);
    expect(discountedPrice({ currency: 'gems', amount: 10 }, 0.9).amount).toBe(10);
  });
});
