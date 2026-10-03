/**
 * The item shop: daily and weekly rotations, deals and bundle pricing.
 *
 * Responsibilities:
 * - Pick the daily shelf (featured + daily picks, one of them a deal) and the
 *   weekly shelf as pure functions of the UTC day / ISO week, so the API and
 *   the offline client always show, and charge, exactly the same thing.
 * - Price an item on a given day (its deal price when it is on a discounted
 *   shelf, else its list price) and quote bundles for what a player still
 *   needs.
 *
 * Every `store` item is always buyable at its list price from the full
 * catalog; the rotations are merchandising plus discounts. Functions take any
 * item shape with the store-relevant fields, so the API can pass its own
 * catalog view.
 */
import { Rng, hashString } from '@tumble/shared';
import {
  STORE_SETS,
  type CosmeticSlot,
  type Currency,
  type Rarity,
  type StoreSet,
} from '../cosmetics/index.ts';
import { DAY_MS, nextUtcWeekStart, utcWeekKey } from './calendar.ts';

/** The fields of a cosmetic the store reads. */
export interface StoreItemLike {
  id: string;
  slot: CosmeticSlot;
  rarity: Rarity;
  source: string;
  price: { currency: Currency; amount: number } | null;
}

/** A price in one currency. */
export interface StorePrice {
  currency: Currency;
  amount: number;
}

/** Featured offers per day (Epic and up). */
export const STORE_FEATURED_COUNT = 2;
/** Daily picks per day. */
export const STORE_DAILY_COUNT = 6;
/** Weekly picks per ISO week. */
export const STORE_WEEKLY_COUNT = 4;
/** Discount on the one "deal of the day" among the daily picks. */
export const DAILY_DEAL_DISCOUNT = 0.3;
/** Discount on every weekly pick. */
export const WEEKLY_DISCOUNT = 0.15;
/** Discount on a bundle against the list prices of the items still needed. */
export const BUNDLE_DISCOUNT = 0.25;
/** Offer id prefix for bundles (`bundle:<set id>`); item offers use the cosmetic id. */
export const BUNDLE_OFFER_PREFIX = 'bundle:';

const FEATURED_RARITIES: readonly Rarity[] = ['epic', 'legendary', 'mythic'];

/** Shelf an offer sits on. */
export type StoreSection = 'featured' | 'daily' | 'weekly';

/** One item on a rotating shelf. */
export interface StoreRotationOffer<T extends StoreItemLike = StoreItemLike> {
  /** The cosmetic id. */
  offerId: string;
  section: StoreSection;
  item: T;
  /** What it costs on this shelf. */
  price: StorePrice;
  /** Catalog price; higher than `price` on deals. */
  listPrice: StorePrice;
  /** True when `price` is below `listPrice`. */
  deal: boolean;
}

/** The rotating shelves live on one UTC day. */
export interface StoreShelf<T extends StoreItemLike = StoreItemLike> {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  /** ISO week key of `day`. */
  week: string;
  featured: StoreRotationOffer<T>[];
  daily: StoreRotationOffer<T>[];
  weekly: StoreRotationOffer<T>[];
  /** This week's hero bundle (`STORE_SETS` id), or null when none is sellable. */
  heroBundleId: string | null;
  /** When the daily shelves restock (next 00:00 UTC), ISO-8601. */
  dailyEndsAt: string;
  /** When the weekly shelf restocks (next Monday 00:00 UTC), ISO-8601. */
  weeklyEndsAt: string;
}

/**
 * A discounted price, rounded to a tidy multiple of 10 and never below 10.
 *
 * @param price - List price.
 * @param discount - Fraction off, 0–1.
 * @example
 * discountedPrice({ currency: 'gumballs', amount: 1500 }, 0.3); // 1050
 */
export function discountedPrice(price: StorePrice, discount: number): StorePrice {
  const amount = Math.max(10, Math.round((price.amount * (1 - discount)) / 10) * 10);
  return { currency: price.currency, amount: Math.min(amount, price.amount) };
}

/**
 * Items the store can sell: `store` source with a list price.
 *
 * @param items - Catalog to filter.
 */
export function sellableItems<T extends StoreItemLike>(items: readonly T[]): T[] {
  return items.filter((c) => c.source === 'store' && c.price !== null);
}

function offer<T extends StoreItemLike>(
  item: T,
  section: StoreSection,
  discount: number,
): StoreRotationOffer<T> {
  const listPrice = item.price as StorePrice;
  const price = discount > 0 ? discountedPrice(listPrice, discount) : { ...listPrice };
  return {
    offerId: item.id,
    section,
    item,
    price,
    listPrice: { ...listPrice },
    deal: price.amount < listPrice.amount,
  };
}

/** Sets whose items are all sellable in `items` and share one currency. */
function sellableSets(items: readonly StoreItemLike[], sets: readonly StoreSet[]): StoreSet[] {
  const byId = new Map(sellableItems(items).map((c) => [c.id, c]));
  return sets.filter((s) => {
    const members = s.itemIds.map((id) => byId.get(id));
    if (members.some((m) => !m)) return false;
    return new Set(members.map((m) => m!.price!.currency)).size === 1;
  });
}

/**
 * The shelves for a UTC day.
 *
 * The weekly shelf is seeded by the ISO week and the daily shelves by the day;
 * daily picks never repeat a weekly pick, and nothing appears twice.
 *
 * @param day - `YYYY-MM-DD` (UTC).
 * @param items - Catalog to draw from (defaults to the content catalog).
 * @param sets - Bundles to choose the hero from.
 * @returns Featured, daily and weekly offers plus restock times.
 */
export function storeShelfForDay<T extends StoreItemLike>(
  day: string,
  items: readonly T[],
  sets: readonly StoreSet[] = STORE_SETS,
): StoreShelf<T> {
  const start = new Date(`${day}T00:00:00.000Z`);
  const week = utcWeekKey(start);
  const sellable = sellableItems(items);

  const weeklyRng = new Rng(hashString(`store-week:${week}`));
  const weekly = weeklyRng.shuffle([...sellable]).slice(0, STORE_WEEKLY_COUNT);
  const taken = new Set(weekly.map((c) => c.id));

  const rng = new Rng(hashString(`store:${day}`));
  const featured = rng
    .shuffle(sellable.filter((c) => FEATURED_RARITIES.includes(c.rarity) && !taken.has(c.id)))
    .slice(0, STORE_FEATURED_COUNT);
  for (const c of featured) taken.add(c.id);
  const daily = rng.shuffle(sellable.filter((c) => !taken.has(c.id))).slice(0, STORE_DAILY_COUNT);

  const hero = sellableSets(items, sets);
  const heroBundleId = hero.length > 0 ? hero[hashString(`store-bundle:${week}`) % hero.length]!.id : null;

  return {
    day,
    week,
    featured: featured.map((c) => offer(c, 'featured', 0)),
    // The first daily pick is the deal of the day.
    daily: daily.map((c, i) => offer(c, 'daily', i === 0 ? DAILY_DEAL_DISCOUNT : 0)),
    weekly: weekly.map((c) => offer(c, 'weekly', WEEKLY_DISCOUNT)),
    heroBundleId,
    dailyEndsAt: new Date(start.getTime() + DAY_MS).toISOString(),
    weeklyEndsAt: nextUtcWeekStart(start).toISOString(),
  };
}

/**
 * The shelves live at an instant.
 *
 * @param at - Instant.
 * @param items - Catalog to draw from.
 * @example
 * storeShelfAt(new Date(), COSMETICS).daily.map((o) => o.offerId);
 */
export function storeShelfAt<T extends StoreItemLike>(at: Date, items: readonly T[]): StoreShelf<T> {
  return storeShelfForDay(at.toISOString().slice(0, 10), items);
}

/**
 * What an item costs on a shelf: its shelf price when it is on one, else its
 * list price; null when the store never sells it.
 *
 * @param shelf - The day's shelves.
 * @param item - Item to price.
 */
export function storePriceOnShelf(shelf: StoreShelf, item: StoreItemLike): StorePrice | null {
  if (item.source !== 'store' || !item.price) return null;
  const hit = [...shelf.featured, ...shelf.daily, ...shelf.weekly].find((o) => o.offerId === item.id);
  return hit ? { ...hit.price } : { ...item.price };
}

/** A bundle priced for one player. */
export interface BundleQuote {
  /** `bundle:<set id>`. */
  offerId: string;
  set: StoreSet;
  /** Items the player does not own yet (what buying grants). */
  missing: string[];
  /** Discounted price of `missing`; amount 0 when nothing is missing. */
  price: StorePrice;
  /** Sum of the list prices of `missing`. */
  listPrice: StorePrice;
}

/**
 * Looks up a bundle by offer id (`bundle:<id>`) or set id.
 *
 * @param id - Offer or set id.
 * @param sets - Bundles to search.
 */
export function storeSetById(id: string, sets: readonly StoreSet[] = STORE_SETS): StoreSet | undefined {
  const key = id.startsWith(BUNDLE_OFFER_PREFIX) ? id.slice(BUNDLE_OFFER_PREFIX.length) : id;
  return sets.find((s) => s.id === key);
}

/**
 * Prices a bundle for a player: only the items they still need, at
 * {@link BUNDLE_DISCOUNT} off.
 *
 * @param set - The bundle.
 * @param items - Catalog the bundle's items come from.
 * @param owns - Ownership check.
 * @returns The quote, or null when the set is not sellable from `items`.
 */
export function quoteBundle(
  set: StoreSet,
  items: readonly StoreItemLike[],
  owns: (id: string) => boolean,
): BundleQuote | null {
  if (sellableSets(items, [set]).length === 0) return null;
  const byId = new Map(items.map((c) => [c.id, c]));
  const members = set.itemIds.map((id) => byId.get(id)!);
  const currency = members[0]!.price!.currency;
  const missing = members.filter((m) => !owns(m.id));
  const list = missing.reduce((n, m) => n + m.price!.amount, 0);
  return {
    offerId: `${BUNDLE_OFFER_PREFIX}${set.id}`,
    set,
    missing: missing.map((m) => m.id),
    price: list > 0 ? discountedPrice({ currency, amount: list }, BUNDLE_DISCOUNT) : { currency, amount: 0 },
    listPrice: { currency, amount: list },
  };
}
