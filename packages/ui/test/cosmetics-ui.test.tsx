/**
 * Server-rendered checks for the cosmetics screens: the Locker only lists
 * owned items, Season Pass cards say what/where/state, every preview type
 * draws on the player's own Tumbler (or as the real nameplate/banner), and
 * the Store fills its sections.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { CurrencyPreview, ItemPreview } from '../src/components/ItemPreview.tsx';
import { LockerTab } from '../src/screens/menu/LockerTab.tsx';
import { PassTab } from '../src/screens/menu/PassTab.tsx';
import { StoreTab } from '../src/screens/menu/StoreTab.tsx';
import { ui } from '../src/store/uiStore.ts';
import type { CosmeticItem, PassTier, StoreData, StoreOffer } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const PLAYER = { primary: '#12ab34', secondary: '#fedcba', pattern: 'dots' as const };

function item(
  id: string,
  name: string,
  slot: CosmeticItem['slot'],
  extra: Partial<CosmeticItem> = {},
): CosmeticItem {
  return { id, name, slot, rarity: 'epic', icon: '', art: ['#ffffff', '#000000'], owned: true, ...extra };
}

const HAT = item('headwear.halo', 'Angel Ring', 'headwear', {
  look: { kind: 'wearable', tint: ['#fff3a0'], hat: 'crown' },
});
const LOCKED_HAT = item('headwear.top-hat', 'Showtime Topper', 'headwear', {
  owned: false,
  look: { kind: 'wearable', tint: ['#2a2238'], hat: 'tophat' },
});
const EMOTE = item('emote.wave', 'Hiya!', 'emote', { look: { kind: 'pose', clip: 'wave' } });
const SKIN = item('color.mango', 'Mango Tango', 'colors', {
  look: { kind: 'skin', colors: ['#ffb000', '#b6ff3b', '#fff1c9'] },
});
const PLATE = item('nameplate.neon', 'Night Sign', 'nameplate', {
  look: {
    kind: 'nameplate',
    plate: { style: 'neon', bg: '#1e1530', bg2: '#2a1e45', text: '#7cf2ff', border: '#ff3bd4' },
  },
});
const BANNER = item('banner.orbit', 'Orbit', 'banner', {
  look: { kind: 'banner', banner: { motif: 'stars', colors: ['#0d0a1f', '#7cf2ff', '#ffd23f'] } },
});
const TRAIL = item('trail.stardust', 'Stardust Wake', 'trail', {
  look: { kind: 'trail', effect: 'stars', colors: ['#7cf2ff', '#ffd23f'] },
});
const STEPS = item('footsteps.bell', 'Jingle Toes', 'footsteps', {
  look: { kind: 'footsteps', pack: 'bell' },
});

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
    gems: 0,
    crowns: 0,
    colors: { primary: '#999999', secondary: '#888888', pattern: 'plain' },
    isGuest: true,
    stats: { shows: 1, finals: 0, roundsQualified: 1, bestStreak: 0 },
  });
  s.setInventory({
    items: [HAT, LOCKED_HAT, EMOTE],
    loadouts: [{ name: 'L1', colors: PLAYER, items: {}, emotes: [] }],
    activeLoadout: 0,
  });
  ui.setState({ thumbnails: {}, lockerSlot: null, storeSection: null });
});

describe('Locker', () => {
  it('lists only owned items, with no lock badges', () => {
    ui.setState({ lockerSlot: 'headwear' });
    const html = renderToStaticMarkup(<LockerTab />);
    expect(html).toContain('Angel Ring');
    expect(html).not.toContain('Showtime Topper');
    expect(html).not.toContain('tr-item-lock');
    expect(html).not.toContain('Owned only');
    expect(text(html)).toContain('Hat · Epic');
  });

  it('shows a friendly empty state with ways to get items', () => {
    ui.setState({ lockerSlot: 'trail' });
    const html = renderToStaticMarkup(<LockerTab />);
    expect(html).toContain('data-testid="locker-empty"');
    const t = text(html);
    expect(t).toContain('No Trail items yet');
    expect(t).toContain('Browse the Store');
    expect(t).toContain('Season Pass');
    expect(t).toContain('Crown Shard shop');
  });
});

describe('ItemPreview', () => {
  const render = (i: CosmeticItem): string => renderToStaticMarkup(<ItemPreview item={i} />);

  it('draws wearables on the player’s Tumbler in their loadout colours', () => {
    const html = render(HAT);
    expect(html).toContain('data-preview="wearer"');
    expect(html).toContain(PLAYER.primary);
    expect(html).toContain('Your Tumbler with Angel Ring');
  });

  it('uses the rendered 3D thumbnail when the game has one', () => {
    ui.setState({ thumbnails: { [HAT.id]: 'data:image/png;base64,AAAA' } });
    expect(render(HAT)).toContain('src="data:image/png;base64,AAAA"');
  });

  it('shows skin items as the player wearing that skin', () => {
    const html = render(SKIN);
    expect(html).toContain('#ffb000');
    expect(html).not.toContain(PLAYER.primary);
  });

  it('poses the player for emotes and marks them as motion', () => {
    const html = render(EMOTE);
    expect(html).toContain('data-preview="wearer"');
    expect(html).toContain('tr-ip-motion');
    expect(html).toContain(PLAYER.primary);
  });

  it('renders nameplates and banners as the real thing with the player’s name', () => {
    const plate = render(PLATE);
    expect(plate).toContain('data-preview="nameplate"');
    expect(plate).toContain('tr-nameplate--neon');
    expect(text(plate)).toContain('Sprinkles');
    expect(plate).not.toContain('>Tumbler<');
    const banner = render(BANNER);
    expect(banner).toContain('data-preview="banner"');
    expect(text(banner)).toContain('Sprinkles');
  });

  it('gives trails and footsteps a swatch', () => {
    expect(render(TRAIL)).toContain('data-preview="trail"');
    expect(render(TRAIL)).toContain('#7cf2ff');
    expect(render(STEPS)).toContain('data-preview="footsteps"');
  });

  it('draws currency and XP rewards as one consistent card', () => {
    for (const [kind, label] of [
      ['gumballs', 'Gumballs'],
      ['gems', 'Gems'],
      ['xp', 'XP'],
      ['crownShards', 'Crown Shards'],
    ] as const) {
      const html = renderToStaticMarkup(<CurrencyPreview kind={kind} amount={1500} />);
      expect(html).toContain('data-preview="currency"');
      expect(text(html)).toContain('1,500');
      expect(text(html)).toContain(label);
    }
  });
});

describe('Season Pass cards', () => {
  const tiers: PassTier[] = [
    { tier: 1, free: { item: HAT, claimed: true }, premium: { item: PLATE, claimed: false } },
    { tier: 2, free: { currency: { kind: 'gumballs', amount: 250 }, claimed: false } },
    { tier: 3, free: { item: { ...EMOTE, owned: false }, claimed: false } },
    { tier: 4, free: { item: { ...TRAIL, owned: false }, claimed: false } },
  ];
  beforeEach(() => {
    ui.getState().setPass({
      seasonName: 'Season 1: Sugar Rush',
      seasonNumber: 1,
      endsAt: Date.now() + 9e8,
      currentTier: 2,
      tierProgress: 0.5,
      premium: false,
      premiumPrice: 950,
      tiers,
    });
  });

  it('labels tier, lane, slot and state on every card', () => {
    const html = renderToStaticMarkup(<PassTab />);
    const cards = [...html.matchAll(/data-tier="(\d+)" data-track="(\w+)" data-state="(\w+)"/g)].map(
      (m) => `${m[1]}:${m[2]}:${m[3]}`,
    );
    expect(cards).toEqual([
      '1:free:claimed',
      '1:premium:premium',
      '2:free:claimable',
      '3:free:future',
      '4:free:future',
    ]);
    const t = text(html);
    expect(t).toContain('Hat · Epic');
    expect(t).toContain('Nameplate · Epic');
    expect(t).toContain('Tier 3');
    expect(t).toContain('Next tier');
    expect(t).toContain('2 tiers to go');
    expect(t).toContain('Premium: unlock to claim');
    expect(html).not.toContain('>Tumbler<');
  });

  it('gives claimable rewards a Claim action and shows currency as an amount card', () => {
    const html = renderToStaticMarkup(<PassTab />);
    expect(html.match(/data-testid="pass-card-claim"/g)).toHaveLength(1);
    expect(html).toContain('data-preview="currency"');
    expect(text(html)).toContain('250 Gumballs');
  });

  it('shows the next unlock in the header', () => {
    const html = renderToStaticMarkup(<PassTab />);
    expect(html).toContain('data-testid="pass-next"');
    expect(text(html)).toContain('Next unlock · Tier 3');
  });
});

describe('Store sections', () => {
  const offer = (i: CosmeticItem, price: number, extra: Partial<StoreOffer> = {}): StoreOffer => ({
    id: `offer:${i.id}`,
    item: i,
    currency: 'gumballs',
    price,
    ...extra,
  });
  const forSale = (i: CosmeticItem): CosmeticItem => ({ ...i, owned: false });
  const data = (): StoreData => ({
    featured: [offer(forSale(LOCKED_HAT), 3000, { featured: true, tag: 'Featured' })],
    daily: [offer(forSale(TRAIL), 2100, { originalPrice: 3000, tag: 'Deal of the day' }), offer(HAT, 400)],
    weekly: [offer(forSale(BANNER), 2550, { originalPrice: 3000 })],
    weeklyEndsAt: Date.now() + 3 * 86400e3 + 60e3,
    bundles: [
      {
        id: 'bundle:bundle.space-cadet',
        item: forSale(BANNER),
        bundle: [forSale(TRAIL), forSale(PLATE)],
        currency: 'gumballs',
        price: 6750,
        originalPrice: 9000,
        title: 'Space Cadet',
        blurb: 'Zero-gravity rounds.',
        featured: true,
      },
    ],
    catalog: [offer(forSale(LOCKED_HAT), 3000), offer(forSale(PLATE), 800), offer(HAT, 400)],
    rotationEndsAt: Date.now() + 3600e3,
  });

  it('leads with the hero bundle, featured items and daily picks', () => {
    ui.getState().setStoreData(data());
    const html = renderToStaticMarkup(<StoreTab />);
    expect(html).toContain('data-testid="store-hero-bundle"');
    expect(html).toContain('data-testid="store-daily"');
    const t = text(html);
    expect(t).toContain('Space Cadet');
    expect(t).toContain('Save 25%');
    expect(t).toContain('30% off');
    expect(t).toContain('Owned');
    expect(t).toContain('Hat · Epic');
    expect(html).toContain('data-afford="short"');
    for (const tab of ['Today', 'This week', 'Catalog']) expect(t).toContain(tab);
  });

  it('opens on the weekly shelf with its restock countdown', () => {
    ui.getState().setStoreData(data());
    ui.setState({ storeSection: 'week' });
    const html = renderToStaticMarkup(<StoreTab />);
    expect(html).toContain('data-testid="store-weekly"');
    expect(text(html)).toContain('Restocks in 3d');
  });

  it('browses the full catalog with slot filters and sorting', () => {
    ui.getState().setStoreData(data());
    ui.setState({ storeSection: 'catalog' });
    const html = renderToStaticMarkup(<StoreTab />);
    expect(html).toContain('data-testid="store-catalog"');
    const t = text(html);
    expect(t).toContain('3 items · 1 owned');
    expect(html).toContain('aria-label="Sort the catalog"');
    expect(t).toContain('Price: low to high');
    expect(html).toMatch(/aria-pressed="true"[^>]*>All</);
    expect(t).toContain('Nameplate');
  });
});
