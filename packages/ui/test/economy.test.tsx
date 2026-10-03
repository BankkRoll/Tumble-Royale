/**
 * Server-rendered checks for the economy UI: the Crown Shard shelf in the
 * Store, honest Gem checkout states in the wallet popover, and the Season
 * Pass clock announcing the next season near the end.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { CurrencyPanel } from '../src/screens/menu/CurrencyPanel.tsx';
import { NEXT_SEASON_TEASE_MS, SeasonClock } from '../src/screens/menu/PassTab.tsx';
import { StoreTab } from '../src/screens/menu/StoreTab.tsx';
import { ui } from '../src/store/uiStore.ts';
import {
  SLOT_NAMES,
  type CosmeticItem,
  type GemPackOffer,
  type SeasonPassData,
  type StoreData,
} from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };

const item = (id: string, name: string, slot: CosmeticItem['slot']): CosmeticItem => ({
  id,
  name,
  slot,
  rarity: 'epic',
  icon: '',
  art: ['#6b2fd6', '#ffd23f'],
  owned: false,
});

const packs: GemPackOffer[] = [
  { id: 'gems.500', name: 'Handful of Gems', gems: 500, price: '$4.99' },
  { id: 'gems.1100', name: 'Pouch of Gems', gems: 1100, price: '$9.99' },
];

function store(extra: Partial<StoreData> = {}): StoreData {
  return {
    featured: [],
    daily: [],
    rotationEndsAt: Date.now() + 3600e3,
    shardShop: {
      offers: [
        { id: 'shards:back.royal-train', item: item('back.royal-train', 'Royal Train', 'back'), price: 30 },
        {
          id: 'shards:footsteps.royal-fanfare',
          item: item('footsteps.royal-fanfare', 'Royal Fanfare', 'footsteps'),
          price: 30,
        },
      ],
      rotationEndsAt: Date.now() + 2 * 86400e3 + 60e3,
      shardsPerCrown: 60,
    },
    ...extra,
  };
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

beforeEach(() => {
  const s = ui.getState();
  s.setProfile({
    id: 'me',
    name: 'Sprinkles',
    tag: '1234',
    level: 3,
    xp: 0,
    xpToNext: 100,
    gumballs: 500,
    gems: 120,
    crowns: 0,
    crownShards: 12,
    colors,
    isGuest: true,
    stats: { shows: 1, finals: 0, roundsQualified: 1, bestStreak: 0 },
  });
  s.setInventory({ items: [], loadouts: [{ name: 'L1', colors, items: {}, emotes: [] }], activeLoadout: 0 });
});

describe('Crown Shard shop', () => {
  it('lists the weekly exclusives with slot names, shard prices and the balance', () => {
    ui.getState().setStoreData(store());
    const html = renderToStaticMarkup(<StoreTab />);
    expect(html).toContain('data-testid="shard-shop"');
    const t = text(html);
    expect(t).toContain('Crown Shards');
    expect(t).toContain('Royal Train');
    expect(t).toContain(SLOT_NAMES.back);
    expect(t).toContain(SLOT_NAMES.footsteps);
    expect(t).toContain('Restocks in 2d');
    expect(html).toContain('tr-coin--shard');
    expect(html).toContain('aria-label="12 Crown Shards"');
  });

  it('hides the section when there is no shelf', () => {
    ui.getState().setStoreData(store({ shardShop: { offers: [], rotationEndsAt: 0, shardsPerCrown: 60 } }));
    expect(renderToStaticMarkup(<StoreTab />)).not.toContain('shard-shop');
  });
});

describe('Gem checkout honesty', () => {
  const render = (extra: Partial<StoreData>): string => {
    ui.getState().setStoreData(store(extra));
    ui.getState().setCurrencyPanel('gems');
    return renderToStaticMarkup(<CurrencyPanel />);
  };

  it('always explains how to earn Gems by playing', () => {
    const t = text(render({}));
    expect(t).toContain('earn Gems by playing');
    expect(t).toContain('Weekly challenges');
    expect(t).toContain('First Crown of the day');
  });

  it('shows "Coming soon" and no invented packs when no provider is available', () => {
    const html = render({});
    expect(html).toContain('data-testid="gem-coming-soon"');
    expect(text(html)).toContain('Coming soon — Secure checkout via Stripe');
    expect(html).not.toContain('tr-gem-pack');
  });

  it('lists real packs read-only when the server cannot take payments', () => {
    const html = render({ gemPacks: packs, gemCheckout: 'comingSoon' });
    expect(html).toContain('data-testid="gem-coming-soon"');
    expect(text(html)).toContain('cannot be bought yet');
    const buttons = html.match(/<button[^>]*tr-gem-pack[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toContain('disabled');
    expect(html).not.toContain('$4.99');
  });

  it('enables packs with real prices when Stripe is configured', () => {
    const html = render({ gemPacks: packs, gemCheckout: 'enabled' });
    expect(html).not.toContain('gem-coming-soon');
    expect(html).not.toContain('Test purchase');
    expect(html).toContain('$4.99');
    const buttons = html.match(/<button[^>]*tr-gem-pack[^>]*>/g) ?? [];
    for (const b of buttons) expect(b).not.toContain('disabled');
  });

  it('labels the dev fake provider as a test purchase', () => {
    const html = render({ gemPacks: packs, gemCheckout: 'test' });
    expect(html).toContain('data-testid="gem-test-mode"');
    expect(text(html)).toContain('Test purchase (dev)');
    expect(html).not.toContain('$4.99');
    const buttons = html.match(/<button[^>]*tr-gem-pack[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).not.toContain('disabled');
  });
});

describe('Season Pass clock', () => {
  const now = Date.parse('2026-11-25T00:00:00Z');
  const pass = (endsAt: number): SeasonPassData => ({
    seasonName: 'Season 1: Sugar Rush',
    seasonNumber: 1,
    endsAt,
    nextSeason: { number: 2, name: 'Season 2: Frosting Frenzy', startsAt: endsAt },
    currentTier: 1,
    tierProgress: 0,
    premium: false,
    premiumPrice: 950,
    tiers: [],
  });

  it('shows the time left early in the season without teasing the next one', () => {
    const t = text(renderToStaticMarkup(<SeasonClock pass={pass(now + 40 * 86400e3)} now={now} />));
    expect(t).toContain('Season 1 · ends in 40d');
    expect(t).not.toContain('Season 2 starts');
  });

  it('announces the next season near the end', () => {
    const t = text(renderToStaticMarkup(<SeasonClock pass={pass(now + 6 * 86400e3)} now={now} />));
    expect(6 * 86400e3).toBeLessThan(NEXT_SEASON_TEASE_MS);
    expect(t).toContain('Season 1 · ends in 6d');
    expect(t).toContain('Season 2 starts in 6d');
    expect(t).toContain('unclaimed rewards are added automatically');
  });
});
