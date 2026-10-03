/**
 * Builds the Store tab's data (`StoreData` minus the shard shop and Gem
 * packs) from the shared content rotation (offline) or the API's `/store`
 * response (online), so both modes fill the same sections the same way:
 * daily featured + picks, weekly picks, bundles (hero flagged `featured`) and
 * the full catalog at today's price.
 */
import { COSMETICS, getCosmetic, STORE_SETS, type CosmeticItem } from '@tumble/content/cosmetics';
import {
  quoteBundle,
  storeShelfAt,
  type StoreRotationOffer,
  type StoreShelf,
} from '@tumble/content/progression';
import type { StoreData, StoreOffer } from '@tumble/ui';
import { uiItem } from './cosmetics.ts';

/** The rotating and browsable parts of `StoreData`. */
export type StoreShelves = Pick<
  StoreData,
  'featured' | 'daily' | 'weekly' | 'bundles' | 'catalog' | 'rotationEndsAt' | 'weeklyEndsAt'
>;

/** A priced item before it becomes a UI offer. */
interface PricedItem {
  id: string;
  price: { currency: 'gumballs' | 'gems'; amount: number };
  listPrice?: { currency: 'gumballs' | 'gems'; amount: number };
  owned: boolean;
}

function itemOffer(
  offerId: string,
  item: CosmeticItem,
  p: PricedItem,
  extra: Partial<StoreOffer> = {},
): StoreOffer {
  const deal = p.listPrice && p.listPrice.amount > p.price.amount;
  return {
    id: offerId,
    item: uiItem(item, p.owned),
    currency: p.price.currency,
    price: p.price.amount,
    ...(deal ? { originalPrice: p.listPrice!.amount } : {}),
    ...extra,
  };
}

/** A bundle as a UI offer: the hero as `item` (owned only when the whole set is). */
function bundleOffer(
  offerId: string,
  set: { name: string; description: string; itemIds: readonly string[] },
  price: { currency: 'gumballs' | 'gems'; amount: number },
  listPrice: number,
  owns: (id: string) => boolean,
  hero: boolean,
): StoreOffer | null {
  const items = set.itemIds.map((id) => getCosmetic(id));
  if (items.some((i) => !i)) return null;
  const all = items.every((i) => owns(i!.id));
  const [first, ...rest] = items as CosmeticItem[];
  return {
    id: offerId,
    item: uiItem(first!, all),
    bundle: rest.map((i) => uiItem(i, owns(i.id))),
    currency: price.currency,
    price: price.amount,
    ...(listPrice > price.amount ? { originalPrice: listPrice } : {}),
    title: set.name,
    blurb: set.description,
    ...(hero ? { featured: true } : {}),
  };
}

/**
 * Store shelves from the shared rotation, for offline play.
 *
 * @param at - Current time.
 * @param owns - Local ownership check.
 * @returns Offers with ids `offer:<item id>` and `bundle:<set id>`.
 */
export function offlineStoreShelves(at: Date, owns: (id: string) => boolean): StoreShelves {
  const shelf: StoreShelf<CosmeticItem> = storeShelfAt(at, COSMETICS);
  const rotating = (o: StoreRotationOffer<CosmeticItem>, featured = false): StoreOffer =>
    itemOffer(
      `offer:${o.offerId}`,
      o.item,
      { id: o.offerId, price: o.price, listPrice: o.listPrice, owned: owns(o.offerId) },
      {
        ...(featured ? { featured: true, tag: 'Featured' } : {}),
        ...(o.deal && o.section === 'daily' ? { tag: 'Deal of the day' } : {}),
      },
    );
  const shelfPrice = new Map(
    [...shelf.featured, ...shelf.daily, ...shelf.weekly].map((o) => [o.offerId, o] as const),
  );
  const catalog = COSMETICS.filter((c) => c.source === 'store' && c.price).map((c) => {
    const on = shelfPrice.get(c.id);
    return itemOffer(`offer:${c.id}`, c, {
      id: c.id,
      price: on?.price ?? c.price!,
      listPrice: c.price!,
      owned: owns(c.id),
    });
  });
  const bundles = STORE_SETS.flatMap((set) => {
    const q = quoteBundle(set, COSMETICS, owns);
    if (!q) return [];
    const full = quoteBundle(set, COSMETICS, () => false)!;
    const price = q.missing.length > 0 ? q.price : full.price;
    const list = q.missing.length > 0 ? q.listPrice.amount : full.listPrice.amount;
    const o = bundleOffer(q.offerId, set, price, list, owns, set.id === shelf.heroBundleId);
    return o ? [o] : [];
  });
  return {
    featured: shelf.featured.map((o) => rotating(o, true)),
    daily: shelf.daily.map((o) => rotating(o)),
    weekly: shelf.weekly.map((o) => rotating(o)),
    bundles,
    catalog,
    rotationEndsAt: Date.parse(shelf.dailyEndsAt),
    weeklyEndsAt: Date.parse(shelf.weeklyEndsAt),
  };
}

/** The `/store` response fields this module reads. */
export interface ApiStoreShelves {
  featured: (PricedOffer & { section: string })[];
  daily: (PricedOffer & { section: string })[];
  weekly?: (PricedOffer & { section: string })[];
  heroBundle?: string | null;
  bundles?: {
    offerId: string;
    name: string;
    description: string;
    itemIds: string[];
    missing: string[];
    price: { currency: 'gumballs' | 'gems'; amount: number };
    listPrice: { currency: 'gumballs' | 'gems'; amount: number };
    owned: boolean;
  }[];
  catalog?: { offerId: string; price: { currency: 'gumballs' | 'gems'; amount: number }; owned: boolean }[];
  refreshesAt: string;
  weeklyRefreshesAt?: string;
}

interface PricedOffer {
  offerId: string;
  price: { currency: 'gumballs' | 'gems'; amount: number };
  listPrice?: { currency: 'gumballs' | 'gems'; amount: number };
  owned: boolean;
}

/**
 * Store shelves from the API, trusting its prices and ownership.
 *
 * @param store - `/store` response.
 * @param owns - Local ownership check (covers grants the store call predates).
 * @returns Offers whose ids are what `/purchase` expects (item id or `bundle:<id>`).
 */
export function onlineStoreShelves(store: ApiStoreShelves, owns: (id: string) => boolean): StoreShelves {
  const offer = (o: PricedOffer & { section?: string }, featured = false): StoreOffer[] => {
    const item = getCosmetic(o.offerId);
    if (!item) return [];
    const deal = o.listPrice && o.listPrice.amount > o.price.amount;
    return [
      itemOffer(
        o.offerId,
        item,
        {
          id: o.offerId,
          price: o.price,
          ...(o.listPrice ? { listPrice: o.listPrice } : {}),
          owned: o.owned || owns(o.offerId),
        },
        {
          ...(featured ? { featured: true, tag: 'Featured' } : {}),
          ...(deal && o.section === 'daily' ? { tag: 'Deal of the day' } : {}),
        },
      ),
    ];
  };
  const shelf = [...store.featured, ...store.daily, ...(store.weekly ?? [])];
  const today = new Map(shelf.map((o) => [o.offerId, o] as const));
  const catalog = (store.catalog ?? []).flatMap((c) => {
    const on = today.get(c.offerId);
    return offer({ offerId: c.offerId, price: on?.price ?? c.price, listPrice: c.price, owned: c.owned });
  });
  const bundles = (store.bundles ?? []).flatMap((b) => {
    const o = bundleOffer(
      b.offerId,
      b,
      b.price,
      b.listPrice.amount,
      (id) => !b.missing.includes(id) || owns(id),
      b.offerId === store.heroBundle,
    );
    return o ? [o] : [];
  });
  return {
    featured: store.featured.flatMap((o) => offer(o, true)),
    daily: store.daily.flatMap((o) => offer(o)),
    weekly: (store.weekly ?? []).flatMap((o) => offer(o)),
    bundles,
    catalog,
    rotationEndsAt: Date.parse(store.refreshesAt),
    ...(store.weeklyRefreshesAt ? { weeklyEndsAt: Date.parse(store.weeklyRefreshesAt) } : {}),
  };
}
