/**
 * Store, as a dressing room: the 3D Tumbler stays on stage at the left while
 * the side column holds the shop, split into text-only sections:
 *
 * - Today: this week's hero bundle, the featured pair, the daily picks (one is
 *   the deal of the day) and every other bundle;
 * - This week: the discounted weekly picks;
 * - Catalog: every item for sale, with slot chips and rarity/price/name sort;
 * - Crown Shards: the weekly royal exclusives;
 * - Purchases (online accounts): purchase history with refunds
 *   (`PurchaseHistory.tsx`).
 *
 * Every card names its locker slot, shows owned / price / can't-afford state
 * and previews on the player's own Tumbler. Selecting an offer tries it on
 * live; the docked detail buys it (with confirmation) and then offers "Equip
 * now", and (online, Gumball and Gem offers) puts it on the wish list or
 * gifts it to a friend (`Gifting.tsx`). docs/design/SCREENS.md §5.2, docs/design/ECONOMY.md §4.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Coin, ItemCard, Price } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, formatRemaining, useNow } from '../../components/hooks.ts';
import { ItemPreview } from '../../components/ItemPreview.tsx';
import { uiEvents } from '../../store/events.ts';
import { featureOn } from '../../store/liveOps.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import {
  COSMETIC_SLOTS,
  RARITIES,
  SLOT_NAMES,
  type CosmeticItem,
  type CosmeticSlot,
  type Currency,
  type StoreData,
  type StoreOffer,
  type StoreSection,
} from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';
import { useAccountUI } from '../../store/account.ts';
import { DressingRoom, ItemDetail, isEquipped, useActiveLoadout } from './DressingRoom.tsx';
import { GiftButton, WishlistButton } from './Gifting.tsx';
import { PurchaseHistorySection } from './PurchaseHistory.tsx';

/** Anything on a shelf: a Gumball/Gem offer, a bundle or a Crown Shard offer. */
interface ShelfOffer {
  id: string;
  item: CosmeticItem;
  currency: Currency | 'crownShards';
  price: number;
  originalPrice?: number;
  bundle?: CosmeticItem[];
  tag?: string;
  /** Bundle name; items use `item.name`. */
  title?: string;
  blurb?: string;
}

type Wallet = Record<ShelfOffer['currency'], number>;

/**
 * A shelf's countdown; once it has run out the new shelves are on their way.
 *
 * @example
 * countdown('New picks in', 0, 1); // 'Restocking…'
 */
export function countdown(prefix: string, endsAt: number, now: number): string {
  return endsAt <= now ? 'Restocking…' : `${prefix} ${formatRemaining(endsAt - now)}`;
}

/** When the first of the shown shelves (daily, weekly, Crown Shard) rotates; Infinity without a store. */
export function storeExpiresAt(store: StoreData | null | undefined): number {
  return Math.min(
    store?.rotationEndsAt ?? Infinity,
    store?.weeklyEndsAt ?? Infinity,
    store?.shardShop?.rotationEndsAt ?? Infinity,
  );
}

/**
 * Whether the open Store should ask for new shelves: a shelf has rotated and
 * this rotation was not asked about yet (the answer moves the time forward).
 *
 * @param expiresAt - {@link storeExpiresAt}.
 * @param now - Epoch ms.
 * @param askedFor - The rotation time last asked about.
 */
export function shouldRefreshStore(expiresAt: number, now: number, askedFor: number | null): boolean {
  return Number.isFinite(expiresAt) && now >= expiresAt && askedFor !== expiresAt;
}

// The price each open confirmation showed: the store may refresh (and the
// shelves rotate) while the dialog is up, and the purchase must then be
// refused rather than charge something the player never saw.
const quotedPrices = new Map<string, { currency: Currency; amount: number }>();

/** Records the price a purchase confirmation for `offerId` shows. */
export function quotePurchase(offerId: string, price: { currency: Currency; amount: number }): void {
  quotedPrices.set(offerId, price);
}

/**
 * Turns a confirmed purchase dialog into the `purchase` intent, carrying the
 * price the dialog showed as `expectedPrice`.
 *
 * @returns Unsubscribe.
 */
export function bindPurchaseConfirm(): () => void {
  return uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (!dialogId.startsWith('purchase:')) return;
    const offerId = dialogId.slice('purchase:'.length);
    const expectedPrice = quotedPrices.get(offerId);
    quotedPrices.delete(offerId);
    if (buttonId !== 'confirm') return;
    uiEvents.emit('purchase', { offerId, ...(expectedPrice ? { expectedPrice } : {}) });
  });
}

const CURRENCY_NAMES: Readonly<Record<ShelfOffer['currency'], string>> = {
  gumballs: 'Gumballs',
  gems: 'Gems',
  crownShards: 'Crown Shards',
};

const SECTION_LABELS: Readonly<Record<StoreSection, string>> = {
  today: 'Today',
  week: 'This week',
  catalog: 'Catalog',
  shards: 'Crown Shards',
  purchases: 'Purchases',
};

type SortKey = 'rarity' | 'priceLow' | 'priceHigh' | 'name';
const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  rarity: 'Rarity',
  priceLow: 'Price: low to high',
  priceHigh: 'Price: high to low',
  name: 'Name',
};

function useWallet(): Wallet {
  const gumballs = useUI((s) => s.profile?.gumballs ?? 0);
  const gems = useUI((s) => s.profile?.gems ?? 0);
  const crownShards = useUI((s) => s.profile?.crownShards ?? 0);
  return { gumballs, gems, crownShards };
}

function toShelf(o: StoreOffer): ShelfOffer {
  return {
    id: o.id,
    item: o.item,
    currency: o.currency,
    price: o.price,
    ...(o.originalPrice !== undefined ? { originalPrice: o.originalPrice } : {}),
    ...(o.bundle ? { bundle: o.bundle } : {}),
    ...(o.tag ? { tag: o.tag } : {}),
    ...(o.title ? { title: o.title } : {}),
    ...(o.blurb ? { blurb: o.blurb } : {}),
  };
}

/** Whole-number percentage saved, or 0. */
function savings(o: ShelfOffer): number {
  return o.originalPrice && o.originalPrice > o.price ? Math.round((1 - o.price / o.originalPrice) * 100) : 0;
}

/** Why the selected offer can't be bought yet, and how to fix that. */
function shortfallNote(o: ShelfOffer, wallet: Wallet): string {
  const missing = formatNumber(o.price - wallet[o.currency]);
  switch (o.currency) {
    case 'gems':
      return `Need ${missing} more Gems — earn them from weekly challenges, your first Crown each day and the Season Pass`;
    case 'crownShards':
      return `Need ${missing} more Crown Shards — reach finals to earn them`;
    case 'gumballs':
      return `Need ${missing} more — earn Gumballs by playing`;
  }
}

/** Price, owned or can't-afford state for a card footer. */
function OfferPrice({ offer, wallet }: { offer: ShelfOffer; wallet: Wallet }): JSX.Element {
  if (offer.item.owned) return <span className="tr-chip tr-chip--mint">Owned</span>;
  const short = wallet[offer.currency] < offer.price;
  return (
    <span className={`tr-offer-price${short ? ' is-short' : ''}`} data-afford={short ? 'short' : 'ok'}>
      <Price
        currency={offer.currency}
        amount={offer.price}
        {...(offer.originalPrice !== undefined && offer.originalPrice > offer.price
          ? { original: offer.originalPrice }
          : {})}
      />
    </span>
  );
}

function FeaturedCard({
  offer,
  wallet,
  selected,
  onSelect,
}: {
  offer: ShelfOffer;
  wallet: Wallet;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const item = offer.item;
  const save = savings(offer);
  return (
    <button
      type="button"
      className={`tr-featured-card tr-item--${item.rarity}${selected ? ' is-selected' : ''}`}
      style={{ ['--art-a' as string]: item.art[0], ['--art-b' as string]: item.art[1] }}
      data-nav=""
      onClick={onSelect}
      aria-label={`${item.name}, ${rarityLabels[item.rarity]}, ${SLOT_NAMES[item.slot]}${item.owned ? ', owned' : ''}`}
    >
      <span className="tr-featured-art">
        <ItemPreview item={item} className="tr-item-icon" />
      </span>
      <span className="tr-col" style={{ gap: '0.15em', minWidth: 0, alignItems: 'flex-start' }}>
        {(offer.tag || save > 0) && (
          <span className="tr-featured-tag">
            {save > 0 ? `${offer.tag ?? 'Deal'} · ${save}% off` : offer.tag}
          </span>
        )}
        <b className="tr-clamp-2" style={{ maxWidth: '100%', lineHeight: 1.1 }}>
          {item.name}
        </b>
        <span className={`tr-rarity-band tr-rarity-band--${item.rarity}`}>
          {SLOT_NAMES[item.slot]} · {rarityLabels[item.rarity]}
        </span>
        <OfferPrice offer={offer} wallet={wallet} />
      </span>
    </button>
  );
}

/** A bundle: hero item large, the rest as small previews, savings and price. */
function BundleCard({
  offer,
  wallet,
  hero,
  selected,
  onSelect,
}: {
  offer: ShelfOffer;
  wallet: Wallet;
  hero?: boolean;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const items = [offer.item, ...(offer.bundle ?? [])];
  const save = savings(offer);
  return (
    <button
      type="button"
      className={`tr-bundle${hero ? ' is-hero' : ''} tr-item--${offer.item.rarity}${selected ? ' is-selected' : ''}`}
      data-nav=""
      data-testid={hero ? 'store-hero-bundle' : 'store-bundle'}
      onClick={onSelect}
      aria-label={`${offer.title ?? offer.item.name} bundle, ${items.length} items${offer.item.owned ? ', owned' : ''}`}
    >
      <span className="tr-bundle-hero">
        <ItemPreview item={offer.item} className="tr-item-icon" />
      </span>
      <span className="tr-col tr-grow" style={{ gap: '0.25em', minWidth: 0, alignItems: 'flex-start' }}>
        <span className="tr-row" style={{ gap: '0.35em', flexWrap: 'wrap' }}>
          <span className="tr-featured-tag">{hero ? 'Bundle of the week' : 'Bundle'}</span>
          {save > 0 && !offer.item.owned && <span className="tr-chip tr-chip--mint">Save {save}%</span>}
        </span>
        <b className="tr-title tr-h3 tr-ellipsis" style={{ maxWidth: '100%' }}>
          {offer.title ?? offer.item.name}
        </b>
        {hero && offer.blurb && <span className="tr-small tr-muted tr-clamp-2">{offer.blurb}</span>}
        <span className="tr-bundle-items">
          {items.map((it) => (
            <span
              key={it.id}
              className={`tr-bundle-item tr-item--${it.rarity}${it.owned ? ' is-owned' : ''}`}
              title={`${it.name} (${SLOT_NAMES[it.slot]})`}
            >
              <ItemPreview item={it} flat />
            </span>
          ))}
        </span>
        <span className="tr-small tr-muted">
          {items.length} items · {[...new Set(items.map((i) => SLOT_NAMES[i.slot]))].slice(0, 4).join(', ')}
        </span>
        <OfferPrice offer={offer} wallet={wallet} />
      </span>
    </button>
  );
}

function OfferGrid({
  offers,
  wallet,
  selectedId,
  onSelect,
  testId,
}: {
  offers: ShelfOffer[];
  wallet: Wallet;
  selectedId: string | null;
  onSelect: (o: ShelfOffer) => void;
  testId?: string;
}): JSX.Element {
  const loadout = useActiveLoadout();
  return (
    <div className="tr-item-grid" data-testid={testId}>
      {offers.map((o, i) => (
        <ItemCard
          key={o.id}
          item={o.item}
          selected={o.id === selectedId}
          equipped={isEquipped(loadout, o.item)}
          delay={Math.min(i * 25, 300)}
          onClick={() => onSelect(o)}
          footer={
            <>
              {savings(o) > 0 && !o.item.owned && <span className="tr-deal-tag">{savings(o)}% off</span>}
              <OfferPrice offer={o} wallet={wallet} />
            </>
          }
        />
      ))}
    </div>
  );
}

/** Browsable catalog: slot chips, rarity filter and sort. */
function CatalogSection({
  offers,
  wallet,
  selectedId,
  onSelect,
}: {
  offers: ShelfOffer[];
  wallet: Wallet;
  selectedId: string | null;
  onSelect: (o: ShelfOffer) => void;
}): JSX.Element {
  const [slot, setSlot] = useState<CosmeticSlot | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('rarity');
  const slots = COSMETIC_SLOTS.filter((s) => offers.some((o) => o.item.slot === s));
  const shown = useMemo(() => {
    const list = offers.filter((o) => slot === 'all' || o.item.slot === slot);
    const rank = (o: ShelfOffer): number => RARITIES.indexOf(o.item.rarity);
    // Gems are worth far more than Gumballs, so price sorts keep each currency together.
    const cost = (o: ShelfOffer): number => (o.currency === 'gems' ? 1e6 : 0) + o.price;
    const by: Record<SortKey, (a: ShelfOffer, b: ShelfOffer) => number> = {
      rarity: (a, b) => rank(a) - rank(b) || a.item.name.localeCompare(b.item.name),
      priceLow: (a, b) => cost(a) - cost(b) || a.item.name.localeCompare(b.item.name),
      priceHigh: (a, b) => cost(b) - cost(a) || a.item.name.localeCompare(b.item.name),
      name: (a, b) => a.item.name.localeCompare(b.item.name),
    };
    return [...list].sort(by[sort]);
  }, [offers, slot, sort]);
  const ownedCount = shown.filter((o) => o.item.owned).length;
  return (
    <section className="tr-col tr-store-section" aria-label="Catalog" data-testid="store-catalog">
      <div className="tr-slot-chips tr-scroll-x" role="group" aria-label="Filter by slot">
        {(['all', ...slots] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={s === slot}
            className={`tr-slot-chip${s === slot ? ' is-active' : ''}`}
            data-nav=""
            onClick={() => {
              playCue('ui.tab');
              setSlot(s);
            }}
          >
            {s === 'all' ? 'All' : SLOT_NAMES[s]}
          </button>
        ))}
      </div>
      <div className="tr-row tr-wrap" style={{ gap: '0.5em' }}>
        <label className="tr-row tr-small" style={{ gap: '0.4em' }}>
          Sort
          <select
            className="tr-input tr-store-sort"
            value={sort}
            data-nav=""
            aria-label="Sort the catalog"
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <span className="tr-small tr-muted">
          {shown.length} items · {ownedCount} owned
        </span>
      </div>
      <OfferGrid offers={shown} wallet={wallet} selectedId={selectedId} onSelect={onSelect} />
    </section>
  );
}

/**
 * Store tab, or a closed sign while an operator has the store switched off
 * (`store.enabled`); the API refuses purchases meanwhile anyway.
 */
export function StoreTab(): JSX.Element {
  const open = useUI((s) => featureOn(s.liveOps.flags, 'store.enabled'));
  if (!open) {
    return (
      <section className="tr-panel tr-col tr-interactive" data-testid="store-closed" style={{ gap: '0.4em' }}>
        <div className="tr-title tr-h3">The store is closed for a moment</div>
        <p className="tr-small tr-muted">Your items and currency are safe. Check back soon!</p>
      </section>
    );
  }
  return <StoreShelves />;
}

function StoreShelves(): JSX.Element {
  const store = useUI((s) => s.store);
  const deepSection = useUI((s) => s.storeSection);
  const loadout = useActiveLoadout();
  const wallet = useWallet();
  const online = useAccountUI((a) => a.session === 'online');
  const [section, setSection] = useState<StoreSection>(() => deepSection ?? 'today');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    if (!deepSection) return;
    setSection(deepSection);
    ui.setState({ storeSection: null });
  }, [deepSection]);

  const shards: ShelfOffer[] = (store?.shardShop?.offers ?? []).map((o) => ({
    id: o.id,
    item: o.item,
    currency: 'crownShards',
    price: o.price,
  }));
  const featured = (store?.featured ?? []).map(toShelf);
  const daily = (store?.daily ?? []).map(toShelf);
  const weekly = (store?.weekly ?? []).map(toShelf);
  const bundles = (store?.bundles ?? []).map(toShelf);
  const catalog = (store?.catalog ?? []).map(toShelf);
  const heroBundle = bundles.find((b) => (store?.bundles ?? []).find((o) => o.id === b.id)?.featured);
  const otherBundles = bundles.filter((b) => b !== heroBundle);
  const offers = [...bundles, ...featured, ...daily, ...weekly, ...shards, ...catalog];
  const selected = offers.find((o) => o.id === selectedId) ?? null;
  const sections: StoreSection[] = [
    'today',
    ...(weekly.length > 0 ? (['week'] as const) : []),
    ...(catalog.length > 0 ? (['catalog'] as const) : []),
    ...(shards.length > 0 ? (['shards'] as const) : []),
    ...(online ? (['purchases'] as const) : []),
  ];
  const active = sections.includes(section) ? section : 'today';

  const expiresAt = storeExpiresAt(store);
  const askedFor = useRef<number | null>(null);
  useEffect(() => {
    if (shouldRefreshStore(expiresAt, now, askedFor.current)) {
      askedFor.current = expiresAt;
      uiEvents.emit('storeExpired');
    }
  }, [now, expiresAt]);

  useEffect(() => bindPurchaseConfirm(), []);

  const select = (o: ShelfOffer): void => {
    playCue('ui.click');
    setSelectedId(o.id);
    if (o.bundle && o.bundle.length > 0) {
      uiEvents.emit('tryOnBundle', {
        items: [o.item, ...o.bundle].map((b) => ({ slot: b.slot, itemId: b.id })),
      });
    } else uiEvents.emit('tryOn', { slot: o.item.slot, itemId: o.item.id });
  };
  const reset = (): void => {
    setSelectedId(null);
    uiEvents.emit('tryOnBundle', { items: [] });
  };
  const buy = (o: ShelfOffer): void => {
    const what = o.bundle
      ? `the ${o.title ?? o.item.name} bundle`
      : `${o.item.name} (${SLOT_NAMES[o.item.slot]})`;
    if (o.currency !== 'crownShards') quotePurchase(o.id, { currency: o.currency, amount: o.price });
    ui.getState().showDialog({
      id: `purchase:${o.id}`,
      kind: 'purchase',
      title: 'Treat yourself?',
      body:
        `Spend ${formatNumber(o.price)} ${CURRENCY_NAMES[o.currency]} on ${what}?` +
        (o.currency === 'crownShards' ? ' Spent shards no longer count toward your next Crown.' : ''),
      icon: o.item.icon,
    });
  };

  const shardShop = store?.shardShop;
  const tryingOn =
    selected && !isEquipped(loadout, selected.item) ? (selected.title ?? selected.item.name) : null;
  const short = selected ? wallet[selected.currency] < selected.price : false;
  return (
    <DressingRoom className="tr-store" tryingOn={tryingOn} onReset={reset}>
      {!store ? (
        <div className="tr-panel tr-empty">
          <span className="tr-gumball-spinner" />
          <p>Stocking the shelves…</p>
        </div>
      ) : (
        <>
          <div className="tr-panel tr-store-shelf">
            <div className="tr-panel-head">
              <div className="tr-store-tabs tr-scroll-x" role="tablist" aria-label="Store sections">
                {sections.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={s === active}
                    className={`tr-slot-chip${s === active ? ' is-active' : ''}`}
                    data-nav=""
                    data-section={s}
                    onClick={() => {
                      playCue('ui.tab');
                      setSection(s);
                    }}
                  >
                    {SECTION_LABELS[s]}
                  </button>
                ))}
              </div>
              <span className="tr-grow" />
              <Button size="sm" variant="premium" onClick={() => ui.getState().setCurrencyPanel('gems')}>
                <Coin currency="gems" /> Gems
              </Button>
            </div>
            <div className="tr-store-body tr-scroll">
              {active === 'today' && (
                <section className="tr-col tr-store-section" aria-label="Today" data-testid="store-today">
                  {heroBundle && (
                    <BundleCard
                      offer={heroBundle}
                      wallet={wallet}
                      hero
                      selected={heroBundle.id === selectedId}
                      onSelect={() => select(heroBundle)}
                    />
                  )}
                  <div className="tr-panel-head">
                    <h2 className="tr-title tr-h3 tr-grow">Featured</h2>
                    <span className="tr-chip tr-chip--lemon">
                      {countdown('New picks in', store.rotationEndsAt, now)}
                    </span>
                  </div>
                  <div className="tr-featured-row">
                    {featured.map((o) => (
                      <FeaturedCard
                        key={o.id}
                        offer={o}
                        wallet={wallet}
                        selected={o.id === selectedId}
                        onSelect={() => select(o)}
                      />
                    ))}
                  </div>
                  <h2 className="tr-title tr-h3">Daily picks</h2>
                  <OfferGrid
                    offers={daily}
                    wallet={wallet}
                    selectedId={selectedId}
                    onSelect={select}
                    testId="store-daily"
                  />
                  {otherBundles.length > 0 && (
                    <>
                      <h2 className="tr-title tr-h3">Bundles</h2>
                      <div className="tr-bundle-list">
                        {otherBundles.map((b) => (
                          <BundleCard
                            key={b.id}
                            offer={b}
                            wallet={wallet}
                            selected={b.id === selectedId}
                            onSelect={() => select(b)}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}
              {active === 'week' && (
                <section
                  className="tr-col tr-store-section"
                  aria-label="This week"
                  data-testid="store-weekly"
                >
                  <div className="tr-panel-head">
                    <h2 className="tr-title tr-h3 tr-grow">This week</h2>
                    {store.weeklyEndsAt !== undefined && (
                      <span className="tr-chip tr-chip--lemon">
                        {countdown('Restocks in', store.weeklyEndsAt, now)}
                      </span>
                    )}
                  </div>
                  <p className="tr-small tr-muted" style={{ margin: 0 }}>
                    Four picks at a discount all week. Everything else is always in the Catalog at its full
                    price.
                  </p>
                  <OfferGrid offers={weekly} wallet={wallet} selectedId={selectedId} onSelect={select} />
                </section>
              )}
              {active === 'catalog' && (
                <CatalogSection offers={catalog} wallet={wallet} selectedId={selectedId} onSelect={select} />
              )}
              {active === 'purchases' && <PurchaseHistorySection />}
              {active === 'shards' && shardShop && (
                <section className="tr-col tr-shard-shop" aria-label="Crown Shards" data-testid="shard-shop">
                  <div className="tr-panel-head">
                    <h2 className="tr-title tr-h3 tr-grow">Crown Shards</h2>
                    <span className="tr-chip" aria-label={`${wallet.crownShards} Crown Shards`}>
                      <Coin currency="crownShards" /> {formatNumber(wallet.crownShards)}
                    </span>
                    <span className="tr-chip tr-chip--lemon">
                      {countdown('Restocks in', shardShop.rotationEndsAt, now)}
                    </span>
                  </div>
                  <p className="tr-small tr-muted" style={{ margin: 0 }}>
                    Royal exclusives sold only here, a new shelf every week. Unspent shards still combine into
                    a Crown every {formatNumber(shardShop.shardsPerCrown)}.
                  </p>
                  <div className="tr-featured-row">
                    {shards.map((o) => (
                      <FeaturedCard
                        key={o.id}
                        offer={o}
                        wallet={wallet}
                        selected={o.id === selectedId}
                        onSelect={() => select(o)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
          {selected && (
            <ItemDetail
              item={selected.item}
              {...(selected.title ? { title: selected.title } : {})}
              equipped={!selected.bundle && isEquipped(loadout, selected.item)}
              price={{
                currency: selected.currency,
                amount: selected.price,
                ...(selected.originalPrice !== undefined && selected.originalPrice > selected.price
                  ? { original: selected.originalPrice }
                  : {}),
              }}
              canAfford={!short}
              {...(short ? { priceNote: shortfallNote(selected, wallet) } : {})}
              onBuy={() => buy(selected)}
              onEquip={() => uiEvents.emit('equip', { slot: selected.item.slot, itemId: selected.item.id })}
              {...(selected.bundle ? { bundle: selected.bundle } : {})}
              {...(selected.currency !== 'crownShards'
                ? {
                    actions: (
                      <>
                        {!selected.item.owned && <WishlistButton itemId={selected.id} />}
                        <GiftButton offerId={selected.id} />
                      </>
                    ),
                  }
                : {})}
            />
          )}
        </>
      )}
    </DressingRoom>
  );
}
