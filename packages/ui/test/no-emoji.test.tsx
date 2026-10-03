/**
 * Product rule: no emoji on buttons, tabs or chips. Server-renders every
 * main-menu tab, the wallet popovers, settings/friends/notifications sheets
 * and the custom show screen with representative data, then scans the text
 * of every button, tab and chip for emoji codepoints.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { CustomLobbyScreen } from '../src/screens/CustomLobby.tsx';
import { MainMenu } from '../src/screens/menu/MainMenu.tsx';
import { SettingsSheet } from '../src/screens/overlays/SettingsSheet.tsx';
import { FriendsSheet, NotificationsPanel } from '../src/screens/overlays/SocialSheets.tsx';
import { ui } from '../src/store/uiStore.ts';
import { MENU_TABS, type CosmeticItem, type PassTier, type Rarity } from '../src/store/types.ts';

/** Pictographic emoji + dingbats/arrows commonly used as emoji glyphs. */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}\u{FE0F}]/u;

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };
const rarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

function item(i: number, slot: CosmeticItem['slot'] = 'headwear'): CosmeticItem {
  return {
    id: `headwear.test-${i}`,
    name: `Test Hat ${i}`,
    slot,
    rarity: rarities[i % 6] as Rarity,
    icon: '🎩',
    art: ['#ffd6f2', '#ffd23f'],
    owned: i % 2 === 0,
  };
}

function seed(): void {
  const items = Array.from({ length: 12 }, (_, i) => item(i, i % 3 === 0 ? 'emote' : 'headwear'));
  const tiers: PassTier[] = Array.from({ length: 30 }, (_, i) => ({
    tier: i + 1,
    free:
      i % 2 === 0
        ? { item: items[i % 12] as CosmeticItem, claimed: i < 3 }
        : { currency: { kind: 'gumballs', amount: 100 }, claimed: false },
    premium: { item: items[(i + 5) % 12] as CosmeticItem, claimed: false },
  }));
  const s = ui.getState();
  ui.setState({ screen: 'menu' });
  s.setProfile({
    id: 'me',
    name: 'Sprinkles',
    tag: '1234',
    level: 12,
    xp: 300,
    xpToNext: 900,
    gumballs: 1200,
    gems: 0,
    crowns: 2,
    colors,
    isGuest: true,
    rank: { tier: 'gold', division: 2, rp: 120, rpToNext: 280 },
    stats: {
      shows: 10,
      finals: 3,
      roundsQualified: 20,
      bestStreak: 1,
      bestTimes: [{ round: 'Gumdrop Gauntlet', timeSec: 61.2 }],
      totals: { jumps: 10, dives: 4, grabs: 2 },
      recentForm: ['crown', 'final', 'eliminated'],
    },
    showcase: items.slice(0, 3),
  });
  s.setInventory({ items, loadouts: [{ name: 'L1', colors, items: {}, emotes: [] }], activeLoadout: 0 });
  s.setStoreData({
    featured: [{ id: 'o1', item: items[1] as CosmeticItem, currency: 'gems', price: 800, tag: 'FEATURED' }],
    daily: [{ id: 'o2', item: items[2] as CosmeticItem, currency: 'gumballs', price: 400 }],
    rotationEndsAt: Date.now() + 3600e3,
  });
  s.setPass({
    seasonName: 'Season 1: Sugar Rush',
    seasonNumber: 1,
    endsAt: Date.now() + 9e8,
    currentTier: 4,
    tierProgress: 0.4,
    premium: false,
    premiumPrice: 950,
    tiers,
  });
  s.setChallenges({
    list: [
      {
        id: 'a',
        cadence: 'daily',
        title: 'Play 3 shows',
        icon: '🎪',
        progress: 3,
        goal: 3,
        reward: { kind: 'gumballs', amount: 30 },
        claimed: false,
        canReroll: true,
        metric: 'showsPlayed',
      },
      {
        id: 'b',
        cadence: 'daily',
        title: 'Dive 40 times',
        icon: '🤿',
        progress: 10,
        goal: 40,
        reward: { kind: 'xp', amount: 500 },
        claimed: false,
        canReroll: true,
        metric: 'dives',
      },
      {
        id: 'c',
        cadence: 'weekly',
        title: 'Win a Crown',
        icon: '🏆',
        progress: 0,
        goal: 1,
        reward: { kind: 'gumballs', amount: 300 },
        claimed: false,
        canReroll: false,
        metric: 'crowns',
      },
    ],
    dailyResetsAt: Date.now() + 3600e3,
    weeklyResetsAt: Date.now() + 86400e3,
    rerollsLeft: 1,
    rerollsPerDay: 1,
  });
  s.setLeaderboard(
    'crowns',
    [
      { rank: 1, playerId: 'x', name: 'Jellybean', value: 9, colors },
      { rank: 2, playerId: 'y', name: 'Fizz', value: 5, colors, isBot: true },
      { rank: 3, playerId: 'z', name: 'Pop', value: 4, colors },
      { rank: 4, playerId: 'me', name: 'Sprinkles', value: 2, colors, isSelf: true },
    ],
    { scope: 'global', source: 'local', updatedAt: Date.now() },
  );
  s.setNews([
    {
      id: 'n1',
      title: 'Season 1',
      body: 'Hello',
      tag: 'SEASON',
      art: ['#fff', '#000'],
      icon: '🍭',
      featured: true,
      unread: true,
      blocks: [{ type: 'paragraph', text: 'x' }],
    },
  ]);
  s.setNotifications([{ id: 'n', kind: 'invite', title: 'Invite', time: Date.now() }]);
  s.setFriends([{ id: 'f', name: 'Pal', tag: '1', presence: 'online', colors }]);
  s.setPlaylists(
    [
      {
        id: 'main-show',
        name: 'Main Show',
        description: 'x',
        players: 40,
        teamSize: 1,
        art: ['#fff', '#000'],
        icon: '🎪',
      },
    ],
    'main-show',
  );
  s.setParty({
    code: 'ABCDEF',
    maxSize: 4,
    members: [{ id: 'me', name: 'Sprinkles', colors, ready: true, isLeader: true, isSelf: true }],
  });
  s.setRoundCatalog([{ id: 'r', name: 'Gumdrop Gauntlet', type: 'race' }]);
  s.setOnlineStatus({ state: 'offline' });
}

/** Text of every button / tab / chip in the markup. */
function controlTexts(html: string): string[] {
  const out: string[] = [];
  const re =
    /<(button|a)\b[^>]*>([\s\S]*?)<\/\1>|<span[^>]*class="[^"]*\btr-(?:chip|info-chip|lane-chip|tab|ch-reward|price|currency|pr-name|tier-num)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
  for (const m of html.matchAll(re)) {
    const inner = (m[2] ?? m[3] ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');
    out.push(inner.trim());
  }
  return out;
}

function expectNoEmoji(html: string, where: string): void {
  const bad = controlTexts(html).filter((t) => EMOJI.test(t));
  expect(bad, `${where}: emoji in controls`).toEqual([]);
}

describe('no emoji on buttons, tabs or chips', () => {
  beforeEach(seed);

  for (const tab of MENU_TABS) {
    it(`menu tab: ${tab}`, () => {
      ui.setState({ menuTab: tab });
      expectNoEmoji(renderToStaticMarkup(<MainMenu />), tab);
    });
  }

  it('tab bar is text only (no icons)', () => {
    const html = renderToStaticMarkup(<MainMenu />);
    const tabs = [
      ...html.matchAll(/<button[^>]*role="tab"[^>]*data-tab="[^"]+"[^>]*>([\s\S]*?)<\/button>/g),
    ].map((m) => m[1] ?? '');
    expect(tabs.length).toBe(MENU_TABS.length);
    for (const t of tabs) expect(t).not.toMatch(/<svg|<img/);
  });

  it('wallet popovers', () => {
    ui.setState({ currencyPanel: 'gumballs' });
    expectNoEmoji(renderToStaticMarkup(<MainMenu />), 'gumballs');
    ui.setState({ currencyPanel: 'gems' });
    const gems = renderToStaticMarkup(<MainMenu />);
    expectNoEmoji(gems, 'gems');
    expect(gems).toContain('Secure checkout via Stripe');
    ui.setState({ currencyPanel: 'none' });
  });

  it('matchmaking card', () => {
    expectNoEmoji(renderToStaticMarkup(<MainMenu matchmaking />), 'matchmaking');
  });

  it('sheets and custom show', () => {
    expectNoEmoji(renderToStaticMarkup(<SettingsSheet />), 'settings');
    expectNoEmoji(renderToStaticMarkup(<FriendsSheet />), 'friends');
    expectNoEmoji(renderToStaticMarkup(<NotificationsPanel />), 'notifications');
    expectNoEmoji(renderToStaticMarkup(<CustomLobbyScreen />), 'custom');
  });
});
