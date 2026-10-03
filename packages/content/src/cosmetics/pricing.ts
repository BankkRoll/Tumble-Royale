/**
 * Store pricing for cosmetics.
 *
 * Prices follow one curve per rarity so the store stays coherent; premium
 * (Gems) pricing is reserved for Legendary/Mythic store items. Only `store`
 * items carry a price — pass, challenge, event, shard and default items are
 * never sold directly.
 */
import type { CosmeticSource, Currency, Rarity } from './schema.ts';

/** A direct store price, or null when the item is not sold. */
export type ItemPrice = { currency: Currency; amount: number } | null;

/** List price per rarity for `store` items. */
export const STORE_PRICE: Readonly<Record<Rarity, NonNullable<ItemPrice>>> = {
  common: { currency: 'gumballs', amount: 400 },
  uncommon: { currency: 'gumballs', amount: 800 },
  rare: { currency: 'gumballs', amount: 1500 },
  epic: { currency: 'gumballs', amount: 3000 },
  legendary: { currency: 'gems', amount: 800 },
  mythic: { currency: 'gems', amount: 1600 },
};

/**
 * Rarity, source and price for a catalog entry.
 *
 * @param rarity - Item rarity.
 * @param source - How the item is unlocked.
 * @returns The fields to spread into a catalog item.
 * @example
 * { id: 'headwear.halo', ...itemMeta('legendary', 'store') }
 */
export function itemMeta(
  rarity: Rarity,
  source: CosmeticSource,
): { rarity: Rarity; source: CosmeticSource; price: ItemPrice } {
  return { rarity, source, price: source === 'store' ? STORE_PRICE[rarity] : null };
}
