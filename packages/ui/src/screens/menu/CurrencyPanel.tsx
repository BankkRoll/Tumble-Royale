/**
 * Top-bar wallet popovers.
 *
 * - Gumballs (soft currency) are only ever earned by playing: the popover
 *   explains how and links to Challenges and the Season Pass. Never a purchase.
 * - Gems (premium currency): what they're for, how to earn them by playing,
 *   and the Gem packs the account API lists. Packs are buyable only when the
 *   API can complete a purchase (`StoreData.gemCheckout`): `enabled` (Stripe)
 *   or `test` (dev fake provider, labelled "Test purchase (dev)"). Otherwise
 *   they are read-only under "Coming soon — Secure checkout via Stripe".
 *   No placeholder packs are ever invented.
 */
import { useEffect, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Coin } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { Icon, type IconName } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { MenuTab } from '../../store/types.ts';

/** Free Gem sources (docs/design/ECONOMY.md §3); amounts live in content. */
const GEM_EARN: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'challenges',
    title: 'Weekly challenges',
    body: 'Every weekly challenge you claim pays Gems on top of its usual reward.',
  },
  {
    icon: 'crown',
    title: 'First Crown of the day',
    body: 'Your first Crown each day comes with a Gem bonus.',
  },
  {
    icon: 'star',
    title: 'Level milestones',
    body: 'Every tenth account level pays a stack of Gems.',
  },
  {
    icon: 'pass',
    title: 'Season Pass',
    body: 'Spotlight tiers on the free track pay Gems; premium tiers pay back most of the pass.',
  },
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
  const mode = store?.gemCheckout ?? 'comingSoon';
  const buyable = mode === 'enabled' || mode === 'test';
  const packs = store?.gemPacks ?? [];
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
        store items. Never pay-to-win — everything is cosmetic. You can <b>earn Gems by playing</b>:
      </p>
      <ul className="tr-wallet-ways" data-testid="gem-earn">
        {GEM_EARN.map((e) => (
          <li key={e.title}>
            <Icon name={e.icon} size="1.8em" />
            <span className="tr-col" style={{ gap: 0 }}>
              <b>{e.title}</b>
              <span className="tr-small tr-muted">{e.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {mode === 'test' && (
        <div className="tr-wallet-soon" role="note" data-testid="gem-test-mode">
          <Icon name="gear" size="1.4em" />
          <span className="tr-col" style={{ gap: 0 }}>
            <b>Test purchase (dev)</b>
            <span className="tr-small">
              Development server: packs credit instantly, no real money is taken.
            </span>
          </span>
        </div>
      )}
      {!buyable && (
        <div className="tr-wallet-soon" role="note" data-testid="gem-coming-soon">
          <Icon name="lock" size="1.4em" />
          <span className="tr-col" style={{ gap: 0 }}>
            <b>Coming soon — Secure checkout via Stripe</b>
            <span className="tr-small">
              {packs.length > 0
                ? 'Gem packs are listed for reference and cannot be bought yet.'
                : 'Gem packs are listed here when you play online.'}
            </span>
          </span>
        </div>
      )}
      {packs.length > 0 && (
        <div className="tr-gem-grid">
          {packs.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`tr-gem-pack${buyable ? '' : ' is-soon'}`}
              data-nav=""
              disabled={!buyable}
              aria-label={`${p.name}: ${p.gems} Gems, ${
                mode === 'test' ? 'test purchase (dev)' : buyable ? p.price : 'coming soon'
              }`}
              onClick={() => {
                if (!buyable) return;
                playCue('ui.confirm');
                uiEvents.emit('buyGems', { packId: p.id });
              }}
            >
              <Coin currency="gems" />
              <b>{formatNumber(p.gems)}</b>
              <span className="tr-small">{p.name}</span>
              <span className="tr-gem-pack-price">
                {mode === 'test' ? 'Test purchase (dev)' : buyable ? p.price : 'Soon'}
              </span>
            </button>
          ))}
        </div>
      )}
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
