/**
 * Store: featured carousel, daily picks with rotation countdown, item modal
 * and purchase confirmation. docs/design/SCREENS.md §5.2.
 */
import { useEffect, useState, type JSX } from 'react';
import { ItemCard, Panel, Price } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, formatRemaining, useNow } from '../../components/hooks.ts';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { StoreOffer } from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';

function useAfford(offer: StoreOffer | null): { ok: boolean; missing: number } {
  const wallet = useUI((s) =>
    offer ? (offer.currency === 'gems' ? (s.profile?.gems ?? 0) : (s.profile?.gumballs ?? 0)) : 0,
  );
  if (!offer) return { ok: false, missing: 0 };
  return { ok: wallet >= offer.price, missing: Math.max(0, offer.price - wallet) };
}

function OfferModal({ offer, onClose }: { offer: StoreOffer; onClose: () => void }): JSX.Element {
  const { ok, missing } = useAfford(offer);
  const item = offer.item;
  const buy = (): void => {
    ui.getState().showDialog({
      id: `purchase:${offer.id}`,
      kind: 'purchase',
      title: 'Treat yourself?',
      body: `Spend ${formatNumber(offer.price)} ${offer.currency === 'gems' ? 'Gems' : 'Gumballs'} on ${item.name}?`,
      icon: item.icon,
    });
  };
  return (
    <div
      className="tr-modal-wrap tr-interactive"
      data-nav-scope="12"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
    >
      <div className="tr-dim" onClick={onClose} />
      <Panel enter="pop" tilt={-0.8} className={`tr-offer-modal tr-item-detail--${item.rarity}`}>
        <button
          type="button"
          className="tr-close"
          data-nav=""
          data-nav-back=""
          aria-label="Close"
          onClick={onClose}
        >
          ✕
        </button>
        <div
          className="tr-offer-art"
          style={{ ['--art-a' as string]: item.art[0], ['--art-b' as string]: item.art[1] }}
        >
          <span>{item.icon}</span>
        </div>
        <div className="tr-col" style={{ gap: '0.6em' }}>
          <span className={`tr-rarity-band tr-rarity-band--${item.rarity}`}>{rarityLabels[item.rarity]}</span>
          <h2 className="tr-title tr-h2">{item.name}</h2>
          {item.description && <p>{item.description}</p>}
          {offer.bundle && (
            <div className="tr-row tr-wrap">
              {offer.bundle.map((b) => (
                <span key={b.id} className="tr-chip">
                  {b.icon} {b.name}
                </span>
              ))}
            </div>
          )}
          <Price currency={offer.currency} amount={offer.price} original={offer.originalPrice} />
          <div className="tr-row tr-wrap">
            {item.owned ? (
              <span className="tr-chip tr-chip--mint">✓ Owned</span>
            ) : (
              <Button variant="mint" size="lg" autoFocusNav disabled={!ok} onClick={buy}>
                {ok ? 'Buy' : `Need ${formatNumber(missing)} more`}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => uiEvents.emit('tryOn', { slot: item.slot, itemId: item.id })}
            >
              👀 Try on
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function FeaturedCarousel({
  offers,
  onOpen,
}: {
  offers: StoreOffer[];
  onOpen: (o: StoreOffer) => void;
}): JSX.Element | null {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || offers.length < 2) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % offers.length), 6000);
    return () => window.clearInterval(id);
  }, [paused, offers.length]);
  if (offers.length === 0) return null;
  return (
    <div className="tr-carousel" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="tr-carousel-track" style={{ ['--i' as string]: String(index) }}>
        {offers.map((o, i) => (
          <button
            key={o.id}
            type="button"
            className={`tr-hero tr-hero--${o.item.rarity}${i === index ? ' is-current' : ''}`}
            style={{ ['--art-a' as string]: o.item.art[0], ['--art-b' as string]: o.item.art[1] }}
            data-nav=""
            onFocus={() => setIndex(i)}
            onClick={() => onOpen(o)}
          >
            {o.tag && <span className="tr-hero-tag">{o.tag}</span>}
            <span className="tr-hero-icon">{o.item.icon}</span>
            <span className="tr-hero-name tr-title">{o.item.name}</span>
            <span className="tr-row" style={{ justifyContent: 'space-between', width: '100%' }}>
              <span className={`tr-rarity-band tr-rarity-band--${o.item.rarity}`}>
                {rarityLabels[o.item.rarity]}
              </span>
              {o.item.owned ? (
                <span className="tr-chip tr-chip--mint">Owned</span>
              ) : (
                <Price currency={o.currency} amount={o.price} original={o.originalPrice} />
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="tr-carousel-dots" role="tablist" aria-label="Featured">
        {offers.map((o, i) => (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={o.item.name}
            onClick={() => setIndex(i)}
          />
        ))}
      </div>
    </div>
  );
}

/** Store tab. */
export function StoreTab(): JSX.Element {
  const store = useUI((s) => s.store);
  const [open, setOpen] = useState<StoreOffer | null>(null);
  const now = useNow(1000);

  useEffect(
    () =>
      uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
        if (!dialogId.startsWith('purchase:') || buttonId !== 'confirm') return;
        uiEvents.emit('purchase', { offerId: dialogId.slice('purchase:'.length) });
        setOpen(null);
      }),
    [],
  );

  if (!store) {
    return (
      <Panel className="tr-store">
        <div className="tr-empty">
          <span className="tr-gumball-spinner" />
          <p>Stocking the shelves…</p>
        </div>
      </Panel>
    );
  }
  return (
    <div className="tr-store">
      <Panel tilt={-0.4} className="tr-store-featured">
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">Featured</h2>
        </div>
        <FeaturedCarousel offers={store.featured} onOpen={setOpen} />
      </Panel>
      <Panel tilt={0.5} delay={80} className="tr-store-daily">
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">Daily picks</h2>
          <span className="tr-chip tr-chip--lemon">
            New picks in {formatRemaining(store.rotationEndsAt - now)}
          </span>
        </div>
        <div className="tr-item-grid tr-scroll">
          {store.daily.map((o, i) => (
            <ItemCard
              key={o.id}
              item={o.item}
              delay={i * 45}
              onClick={() => setOpen(o)}
              footer={
                o.item.owned ? (
                  <span className="tr-chip tr-chip--mint">Owned</span>
                ) : (
                  <Price currency={o.currency} amount={o.price} original={o.originalPrice} />
                )
              }
            />
          ))}
        </div>
      </Panel>
      {open && <OfferModal offer={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
