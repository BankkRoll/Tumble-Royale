/**
 * The Crown Shard shop: a weekly rotation of `shards`-source exclusives
 * priced in Crown Shards.
 *
 * Shards also combine into Crowns ({@link SHARDS_PER_CROWN}), so every
 * price sits below one Crown's worth: buying is a real choice between a
 * cosmetic now and a Crown sooner. The rotation is a pure function of the
 * ISO week, so the API and the offline client always show the same shelf.
 */
import { Rng, hashString } from '@tumble/shared';
import { COSMETICS, type CosmeticItem, type CosmeticSlot, type Rarity } from '../cosmetics/index.ts';
import { nextUtcWeekStart, utcWeekKey } from './calendar.ts';
import { SHARDS_PER_CROWN } from './rewards.ts';

/** Offers on the shelf each week. */
export const SHARD_SHOP_SLOTS = 4;

/** Most legendaries on one week's shelf, so the big-ticket items stay special. */
const MAX_LEGENDARY_PER_WEEK = 1;

/** Crown Shard price per rarity. Every price is below {@link SHARDS_PER_CROWN}. */
export const SHARD_PRICES: Readonly<Partial<Record<Rarity, number>>> = {
  common: 8,
  uncommon: 12,
  rare: 18,
  epic: 30,
  legendary: 48,
};

/** One shelf entry. */
export interface ShardOffer {
  /** Cosmetic id; also the offer id. */
  itemId: string;
  slot: CosmeticSlot;
  rarity: Rarity;
  /** Price in Crown Shards. */
  price: number;
}

/** One week's shelf. */
export interface ShardShopRotation {
  /** ISO week key, e.g. `2026-W40`. */
  week: string;
  offers: ShardOffer[];
  /** When the shelf restocks (Monday 00:00 UTC), ISO-8601. */
  refreshesAt: string;
}

/**
 * Items the shard shop can ever stock.
 *
 * @param cosmetics - Catalog to draw from.
 */
export function shardShopPool(cosmetics: readonly CosmeticItem[] = COSMETICS): CosmeticItem[] {
  return cosmetics.filter((c) => c.source === 'shards' && SHARD_PRICES[c.rarity] !== undefined);
}

/**
 * Shard price of an item, or null when the shard shop never sells it.
 *
 * @param item - Cosmetic.
 */
export function shardPrice(item: Pick<CosmeticItem, 'source' | 'rarity'>): number | null {
  if (item.source !== 'shards') return null;
  const p = SHARD_PRICES[item.rarity];
  return p !== undefined && p < SHARDS_PER_CROWN ? p : null;
}

/**
 * The shelf for an ISO week.
 *
 * @param week - ISO week key (`YYYY-Www`).
 * @param refreshesAt - When this shelf ends (ISO-8601).
 * @param cosmetics - Catalog to draw from.
 * @returns Up to {@link SHARD_SHOP_SLOTS} distinct offers, at most one legendary.
 */
export function shardShopForWeek(
  week: string,
  refreshesAt: string,
  cosmetics: readonly CosmeticItem[] = COSMETICS,
): ShardShopRotation {
  const rng = new Rng(hashString(`shards:${week}`));
  const picked: CosmeticItem[] = [];
  let legendaries = 0;
  for (const c of rng.shuffle(shardShopPool(cosmetics))) {
    if (picked.length >= SHARD_SHOP_SLOTS) break;
    if (c.rarity === 'legendary') {
      if (legendaries >= MAX_LEGENDARY_PER_WEEK) continue;
      legendaries++;
    }
    picked.push(c);
  }
  return {
    week,
    refreshesAt,
    offers: picked.map((c) => ({ itemId: c.id, slot: c.slot, rarity: c.rarity, price: shardPrice(c) ?? 0 })),
  };
}

/**
 * The shelf live at an instant.
 *
 * @param at - Instant.
 * @param cosmetics - Catalog to draw from.
 * @example
 * shardShopAt(new Date()).offers.map((o) => o.itemId);
 */
export function shardShopAt(at: Date, cosmetics: readonly CosmeticItem[] = COSMETICS): ShardShopRotation {
  return shardShopForWeek(utcWeekKey(at), nextUtcWeekStart(at).toISOString(), cosmetics);
}
