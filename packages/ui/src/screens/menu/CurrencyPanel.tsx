/**
 * Top-bar wallet popovers.
 *
 * - Gumballs (soft currency) are only ever earned by playing: the popover
 *   explains how and links to Challenges and the Season Pass. Never a purchase.
 * - Gems (premium currency): what they're for, plus the Gem packs in a clear
 *   disabled "Coming soon — secure checkout via Stripe" state until real
 *   checkout is enabled (`StoreData.gemCheckout === 'enabled'`).
 */
import { useEffect, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Coin } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { Icon, type IconName } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { GemPackOffer, MenuTab } from '../../store/types.ts';

/** Packs shown before the account API lists real ones (amounts only, never a price). */
const PREVIEW_PACKS: GemPackOffer[] = [
  { id: 'preview-small', name: 'Handful', gems: 500, price: '' },
  { id: 'preview-medium', name: 'Jar', gems: 1100, price: '' },
  { id: 'preview-large', name: 'Bucket', gems: 2400, price: '' },
  { id: 'preview-huge', name: 'Vault', gems: 5000, price: '' },
];

const EARN: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'ticket',
    title: 'Play shows',
    body: 'Every show pays out — more for each round you qualify from, lots for a Crown.',
  },
  {
    icon: 'challenges',
    title: 'Finish challenges',
    body: 'Daily and weekly challenges pay Gumballs and XP.',
  },
  {
    icon: 'pass',
    title: 'Climb the Season Pass',
    body: 'Free-track tiers drop Gumball stacks as you level up.',
  },
];

function go(tab: MenuTab): void {
  playCue('ui.click');
  const s = ui.getState();
  s.setCurrencyPanel('none');
  s.setMenuTab(tab);
}

function GumballsBody({ amount }: { amount: number }): JSX.Element {
  return (
    <>
      <div className="tr-wallet-hero tr-wallet-hero--gumballs">
        <Coin currency="gumballs" />
        <div className="tr-col" style={{ gap: 0 }}>
          <b className="tr-wallet-amount">{formatNumber(amount)}</b>
          <span className="tr-wallet-name">Gumballs</span>
        </div>
      </div>
      <p className="tr-small tr-wallet-lede">
        Gumballs are <b>earned by playing</b> — they're never sold. Spend them on store items.
      </p>
      <ul className="tr-wallet-ways">
        {EARN.map((e) => (
          <li key={e.title}>
            <Icon name={e.icon} size="1.8em" />
            <span className="tr-col" style={{ gap: 0 }}>
              <b>{e.title}</b>
              <span className="tr-small tr-muted">{e.body}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="tr-row tr-wallet-actions">
        <Button size="sm" variant="mint" onClick={() => go('challenges')} data-testid="earn-challenges">
          Challenges
        </Button>
        <Button size="sm" variant="primary" onClick={() => go('pass')} data-testid="earn-pass">
          Season Pass
        </Button>
        <Button size="sm" variant="secondary" onClick={() => go('store')}>
          Store
        </Button>
      </div>
    </>
  );
}

function GemsBody({ amount }: { amount: number }): JSX.Element {
  const store = useUI((s) => s.store);
  const live = store?.gemCheckout === 'enabled';
  const packs = store?.gemPacks && store.gemPacks.length > 0 ? store.gemPacks : PREVIEW_PACKS;
  return (
    <>
      <div className="tr-wallet-hero tr-wallet-hero--gems">
        <Coin currency="gems" />
        <div className="tr-col" style={{ gap: 0 }}>
          <b className="tr-wallet-amount">{formatNumber(amount)}</b>
          <span className="tr-wallet-name">Gems</span>
        </div>
      </div>
      <p className="tr-small tr-wallet-lede">
        Gems are the <b>premium currency</b>: they unlock the Premium Pass track and Legendary &amp; Mythic
        store items. Never pay-to-win — everything is cosmetic.
      </p>
      {!live && (
        <div className="tr-wallet-soon" role="note">
          <Icon name="lock" size="1.4em" />
          <span className="tr-col" style={{ gap: 0 }}>
            <b>Coming soon</b>
            <span className="tr-small">Secure checkout via Stripe</span>
          </span>
        </div>
      )}
      <div className="tr-gem-grid">
        {packs.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`tr-gem-pack${live ? '' : ' is-soon'}`}
            data-nav=""
            disabled={!live}
            aria-label={`${p.name}: ${p.gems} Gems${live ? `, ${p.price}` : ', coming soon'}`}
            onClick={() => {
              if (!live) return;
              playCue('ui.confirm');
              uiEvents.emit('buyGems', { packId: p.id });
            }}
          >
            <Coin currency="gems" />
            <b>{formatNumber(p.gems)}</b>
            <span className="tr-small">{p.name}</span>
            <span className="tr-gem-pack-price">{live ? p.price : 'Soon'}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The wallet popover (renders nothing when closed). */
export function CurrencyPanel(): JSX.Element | null {
  const panel = useUI((s) => s.currencyPanel);
  const gumballs = useUI((s) => s.profile?.gumballs ?? 0);
  const gems = useUI((s) => s.profile?.gems ?? 0);
  useEffect(() => {
    if (panel === 'none') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      ui.getState().setCurrencyPanel('none');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panel]);
  if (panel === 'none') return null;
  const close = (): void => {
    playCue('ui.back');
    ui.getState().setCurrencyPanel('none');
  };
  return (
    <div
      className="tr-wallet-wrap tr-interactive"
      data-nav-scope="12"
      role="dialog"
      aria-modal="true"
      aria-label={panel === 'gems' ? 'Gems' : 'Earn Gumballs'}
    >
      <div className="tr-wallet-dim" onClick={close} />
      <div className={`tr-panel tr-wallet tr-wallet--${panel} tr-enter-pop`} data-testid={`wallet-${panel}`}>
        <div className="tr-row">
          <h2 className="tr-title tr-h3 tr-grow">{panel === 'gems' ? 'Gems' : 'Earn Gumballs'}</h2>
          <button
            type="button"
            className="tr-icon-btn"
            data-nav=""
            data-nav-back=""
            aria-label="Close"
            onClick={close}
          >
            <Icon name="close" size="1em" />
          </button>
        </div>
        {panel === 'gems' ? <GemsBody amount={gems} /> : <GumballsBody amount={gumballs} />}
      </div>
    </div>
  );
}
