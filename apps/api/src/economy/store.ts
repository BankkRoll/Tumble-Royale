/**
 * Daily store rotation.
 *
 * The rotation for a UTC day is a pure function of the catalog and the day
 * key, so every API instance agrees without coordination; it is also written
 * to `store_rotations` for support/audit. Only items with a direct price are
 * eligible (pass and challenge rewards are never sold).
 */
import { hashString, Rng } from '@tumble/shared';
import type { Catalog, CatalogCosmetic, Rarity } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { storeRotations } from '../db/schema.ts';
import { dayKey, nextUtcMidnight } from '../util/time.ts';

/** Number of featured offers per day. */
export const FEATURED_COUNT = 2;
/** Number of daily-pick offers per day. */
export const DAILY_COUNT = 6;

const FEATURED_RARITIES: readonly Rarity[] = ['epic', 'legendary', 'mythic'];

/** A purchasable store offer. `offerId` is the cosmetic id. */
export interface StoreOffer {
  offerId: string;
  section: 'featured' | 'daily';
  item: CatalogCosmetic;
  price: { currency: 'gumballs' | 'gems'; amount: number };
}

/** The store for one day. */
export interface StoreRotation {
  day: string;
  featured: StoreOffer[];
  daily: StoreOffer[];
  refreshesAt: string;
}

function offer(item: CatalogCosmetic, section: StoreOffer['section']): StoreOffer {
  // Callers only pass priced items.
  return { offerId: item.id, section, item, price: item.price! };
}

/**
 * Computes the rotation for a day.
 *
 * @param catalog - Content catalog.
 * @param day - `YYYY-MM-DD` (UTC).
 * @returns Featured and daily offers, plus when the rotation ends.
 */
export function rotationForDay(catalog: Catalog, day: string): StoreRotation {
  const sellable = catalog.cosmetics.filter((c) => c.source === 'store' && c.price);
  const rng = new Rng(hashString(`store:${day}`));
  const featuredPool = rng.shuffle(sellable.filter((c) => FEATURED_RARITIES.includes(c.rarity)));
  const featured = featuredPool.slice(0, FEATURED_COUNT);
  const taken = new Set(featured.map((f) => f.id));
  const daily = rng.shuffle(sellable.filter((c) => !taken.has(c.id))).slice(0, DAILY_COUNT);
  const next = nextUtcMidnight(new Date(`${day}T00:00:00.000Z`));
  return {
    day,
    featured: featured.map((c) => offer(c, 'featured')),
    daily: daily.map((c) => offer(c, 'daily')),
    refreshesAt: next.toISOString(),
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
