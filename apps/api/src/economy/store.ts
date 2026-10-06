/**
 * The item shop on the server.
 *
 * Responsibilities:
 * - Serve the day's shelves (featured, daily, weekly, hero bundle) from the
 *   shared content rotation (`@tumble/content/progression` `storeShelfForDay`),
 *   so the offline client and every API instance agree without coordination.
 * - Price purchases: an item costs its shelf price today (deal or weekly
 *   discount) or its list price from the full catalog; a bundle costs the
 *   discounted sum of the items the buyer still needs.
 * - Record each day's featured/daily ids in `store_rotations` for support/audit.
 *
 * Only `store` items with a list price are ever sold (pass, challenge, event
 * and shard items never are).
 */
import {
  STORE_DAILY_COUNT,
  STORE_FEATURED_COUNT,
  quoteBundle,
  sellableItems,
  storePriceOnShelf,
  storeSetById,
  storeShelfForDay,
  type BundleQuote,
  type StorePrice,
  type StoreSection,
} from '@tumble/content/progression';
import { STORE_SETS } from '@tumble/content/cosmetics';
import { z } from 'zod';
import { conflict } from '../http/errors.ts';
import type { Catalog, CatalogCosmetic } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { storeRotations } from '../db/schema.ts';
import { dayKey } from '../util/time.ts';

/** Number of featured offers per day. */
export const FEATURED_COUNT = STORE_FEATURED_COUNT;
/** Number of daily-pick offers per day. */
export const DAILY_COUNT = STORE_DAILY_COUNT;

/** A rotating-shelf offer. `offerId` is the cosmetic id. */
export interface StoreOffer {
  offerId: string;
  section: StoreSection;
  item: CatalogCosmetic;
  /** What it costs today. */
  price: StorePrice;
  /** Catalog price (higher than `price` on deals). */
  listPrice: StorePrice;
}

/** The shelves for one day. */
export interface StoreRotation {
  day: string;
  featured: StoreOffer[];
  daily: StoreOffer[];
  weekly: StoreOffer[];
  /** This week's hero bundle offer id (`bundle:<id>`), or null. */
  heroBundle: string | null;
  /** When the daily shelves restock (00:00 UTC). */
  refreshesAt: string;
  /** When the weekly shelf restocks (Monday 00:00 UTC). */
  weeklyRefreshesAt: string;
}

/**
 * Computes the shelves for a day.
 *
 * @param catalog - Content catalog.
 * @param day - `YYYY-MM-DD` (UTC).
 */
export function rotationForDay(catalog: Catalog, day: string): StoreRotation {
  const shelf = storeShelfForDay(day, catalog.cosmetics);
  const map = (o: (typeof shelf.featured)[number]): StoreOffer => ({
    offerId: o.offerId,
    section: o.section,
    item: o.item,
    price: o.price,
    listPrice: o.listPrice,
  });
  return {
    day,
    featured: shelf.featured.map(map),
    daily: shelf.daily.map(map),
    weekly: shelf.weekly.map(map),
    heroBundle: shelf.heroBundleId ? `bundle:${shelf.heroBundleId}` : null,
    refreshesAt: shelf.dailyEndsAt,
    weeklyRefreshesAt: shelf.weeklyEndsAt,
  };
}

/**
 * Today's rotation; persists it the first time it is computed.
 *
 * @param db - Database.
 * @param catalog - Content catalog.
 * @param now - Current time.
 */
export async function currentRotation(db: DbOrTx, catalog: Catalog, now: Date): Promise<StoreRotation> {
  const rotation = rotationForDay(catalog, dayKey(now));
  await db
    .insert(storeRotations)
    .values({
      day: rotation.day,
      featured: rotation.featured.map((o) => o.offerId),
      daily: rotation.daily.map((o) => o.offerId),
    })
    .onConflictDoNothing();
  return rotation;
}

/** Every item the store sells at list price, in catalog order. */
export function storeCatalog(catalog: Catalog): CatalogCosmetic[] {
  return sellableItems(catalog.cosmetics);
}

/**
 * Bundles priced for a player.
 *
 * @param catalog - Content catalog.
 * @param owns - Ownership check (anonymous viewers own nothing).
 */
export function bundleQuotes(catalog: Catalog, owns: (id: string) => boolean): BundleQuote[] {
  return STORE_SETS.flatMap((s) => {
    const q = quoteBundle(s, catalog.cosmetics, owns);
    return q ? [q] : [];
  });
}

/** The price the client showed the player; a purchase or gift at any other price is refused. */
export const ExpectedPrice = z.object({
  currency: z.enum(['gumballs', 'gems']),
  amount: z.number().int().min(0),
});

/**
 * Refuses a charge that differs from the price the player confirmed: the
 * shelves rotated since the store was opened, or a bundle got cheaper because
 * the buyer (or gift recipient) came to own part of it.
 *
 * @param expected - What the client showed, when it said.
 * @param actual - What the server would charge now.
 * @throws {ApiError} 409 `price_changed` with the new quote in `details.price`.
 */
export function assertExpectedPrice(
  expected: { currency: string; amount: number } | undefined,
  actual: { currency: string; amount: number },
): void {
  if (!expected) return;
  if (expected.currency === actual.currency && expected.amount === actual.amount) return;
  throw conflict('price_changed', 'The price changed since you opened the store', {
    price: { currency: actual.currency, amount: actual.amount },
  });
}

/** What a purchase would charge and grant. */
export type PricedOffer =
  | { kind: 'item'; item: CatalogCosmetic; price: StorePrice }
  | { kind: 'bundle'; quote: BundleQuote; price: StorePrice };

/**
 * Prices an offer id for a buyer today.
 *
 * @param catalog - Content catalog.
 * @param rotation - Today's shelves.
 * @param offerId - A cosmetic id or `bundle:<id>`.
 * @param owns - The buyer's ownership check.
 * @returns The priced offer, or null when nothing by that id is for sale.
 */
export function priceOffer(
  catalog: Catalog,
  rotation: StoreRotation,
  offerId: string,
  owns: (id: string) => boolean,
): PricedOffer | null {
  if (offerId.startsWith('bundle:')) {
    const set = storeSetById(offerId);
    const quote = set ? quoteBundle(set, catalog.cosmetics, owns) : null;
    return quote ? { kind: 'bundle', quote, price: quote.price } : null;
  }
  const item = catalog.cosmetics.find((c) => c.id === offerId);
  if (!item) return null;
  const price = storePriceOnShelf(rotation, item);
  return price ? { kind: 'item', item, price } : null;
}
