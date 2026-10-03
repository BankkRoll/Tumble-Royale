/**
 * Store, as a dressing room: the 3D Tumbler stays on stage at the left while
 * the side column lists a compact featured row and the daily picks. Selecting
 * an offer tries it on live; the docked detail buys it (with confirmation) and
 * then offers "Equip now". docs/design/SCREENS.md §5.2.
 */
import { useEffect, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Coin, ItemArt, ItemCard, Price } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, formatRemaining, useNow } from '../../components/hooks.ts';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { SLOT_NAMES, type StoreOffer } from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';
import { DressingRoom, ItemDetail, isEquipped, useActiveLoadout } from './DressingRoom.tsx';

function useWallet(): { gumballs: number; gems: number } {
  const gumballs = useUI((s) => s.profile?.gumballs ?? 0);
  const gems = useUI((s) => s.profile?.gems ?? 0);
  return { gumballs, gems };
}

function FeaturedCard({
  offer,
  selected,
  onSelect,
}: {
  offer: StoreOffer;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const item = offer.item;
  return (
    <button
      type="button"
      className={`tr-featured-card tr-item--${item.rarity}${selected ? ' is-selected' : ''}`}
      style={{ ['--art-a' as string]: item.art[0], ['--art-b' as string]: item.art[1] }}
      data-nav=""
      onClick={onSelect}
      aria-label={`${item.name}, ${rarityLabels[item.rarity]}`}
    >
      <span className="tr-featured-art">
        <ItemArt item={item} />
      </span>
      <span className="tr-col" style={{ gap: '0.15em', minWidth: 0, alignItems: 'flex-start' }}>
        {offer.tag && <span className="tr-featured-tag">{offer.tag}</span>}
        <b className="tr-clamp-2" style={{ maxWidth: '100%', lineHeight: 1.1 }}>
          {item.name}
        </b>
        <span className={`tr-rarity-band tr-rarity-band--${item.rarity}`}>
          {rarityLabels[item.rarity]} · {SLOT_NAMES[item.slot]}
        </span>
        {item.owned ? (
          <span className="tr-chip tr-chip--mint">Owned</span>
        ) : (
          <Price
            currency={offer.currency}
            amount={offer.price}
            {...(offer.originalPrice !== undefined ? { original: offer.originalPrice } : {})}
          />
        )}
      </span>
    </button>
  );
}

/** Store tab. */
export function StoreTab(): JSX.Element {
  const store = useUI((s) => s.store);
  const loadout = useActiveLoadout();
  const wallet = useWallet();
  const gemsLive = useUI((s) => s.store?.gemCheckout === 'enabled');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useNow(1000);
  const offers = store ? [...store.featured, ...store.daily] : [];
  const selected = offers.find((o) => o.id === selectedId) ?? null;

  useEffect(
    () =>
      uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
        if (!dialogId.startsWith('purchase:') || buttonId !== 'confirm') return;
        uiEvents.emit('purchase', { offerId: dialogId.slice('purchase:'.length) });
      }),
    [],
  );

  const select = (o: StoreOffer): void => {
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
  const buy = (o: StoreOffer): void => {
    ui.getState().showDialog({
      id: `purchase:${o.id}`,
      kind: 'purchase',
      title: 'Treat yourself?',
      body: `Spend ${formatNumber(o.price)} ${o.currency === 'gems' ? 'Gems' : 'Gumballs'} on ${o.item.name}?`,
      icon: o.item.icon,
    });
  };

  const tryingOn = selected && !isEquipped(loadout, selected.item) ? selected.item.name : null;
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
              <h2 className="tr-title tr-h3 tr-grow">Featured</h2>
              <span className="tr-chip tr-chip--lemon">
                New picks in {formatRemaining(store.rotationEndsAt - now)}
              </span>
              <Button size="sm" variant="premium" onClick={() => ui.getState().setCurrencyPanel('gems')}>
                <Coin currency="gems" /> Gems
              </Button>
            </div>
            <div className="tr-featured-row">
              {store.featured.map((o) => (
                <FeaturedCard
                  key={o.id}
                  offer={o}
                  selected={o.id === selectedId}
                  onSelect={() => select(o)}
                />
              ))}
            </div>
            <h2 className="tr-title tr-h3">Daily picks</h2>
            <div className="tr-item-grid tr-scroll">
              {store.daily.map((o, i) => (
                <ItemCard
                  key={o.id}
                  item={o.item}
                  selected={o.id === selectedId}
                  equipped={isEquipped(loadout, o.item)}
                  delay={i * 30}
                  onClick={() => select(o)}
                  footer={
                    o.item.owned ? (
                      <span className="tr-chip tr-chip--mint">Owned</span>
                    ) : (
                      <Price currency={o.currency} amount={o.price} />
                    )
                  }
                />
              ))}
            </div>
          </div>
          {selected && (
            <ItemDetail
              item={selected.item}
              equipped={isEquipped(loadout, selected.item)}
              price={{
                currency: selected.currency,
                amount: selected.price,
                ...(selected.originalPrice !== undefined ? { original: selected.originalPrice } : {}),
              }}
              canAfford={(selected.currency === 'gems' ? wallet.gems : wallet.gumballs) >= selected.price}
              {...((selected.currency === 'gems' ? wallet.gems : wallet.gumballs) < selected.price
                ? {
                    priceNote:
                      selected.currency === 'gems'
                        ? gemsLive
                          ? `Need ${formatNumber(selected.price - wallet.gems)} more Gems`
                          : 'Gems coming soon'
                        : `Need ${formatNumber(selected.price - wallet.gumballs)} more — earn Gumballs by playing`,
                  }
                : {})}
              onBuy={() => buy(selected)}
              onEquip={() => uiEvents.emit('equip', { slot: selected.item.slot, itemId: selected.item.id })}
              {...(selected.bundle ? { bundle: selected.bundle } : {})}
            />
          )}
        </>
      )}
    </DressingRoom>
  );
}
