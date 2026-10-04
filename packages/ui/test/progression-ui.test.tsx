/**
 * Server-rendered checks for the daily login card, the seasonal and
 * milestone challenge sections, the achievements view (hidden achievements
 * never leak) and the collection log (filters, completion, sources).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { AchievementsView } from '../src/screens/menu/AchievementsView.tsx';
import { ChallengesTab } from '../src/screens/menu/ChallengesTab.tsx';
import { CollectionView, filterCollection } from '../src/screens/menu/CollectionView.tsx';
import { LoginStreakCard, streakStatus } from '../src/screens/menu/LoginStreak.tsx';
import { ProfileTab } from '../src/screens/menu/ProfileTab.tsx';
import { ui } from '../src/store/uiStore.ts';
import type {
  AchievementsData,
  CollectionData,
  CosmeticItem,
  LoginStreakData,
  Rarity,
} from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

/** Pictographic emoji + dingbats/arrows commonly used as emoji glyphs. */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]|\u{FE0F}/u;

const NOW = Date.now();
const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

const item = (
  id: string,
  name: string,
  slot: CosmeticItem['slot'],
  rarity: Rarity,
  owned: boolean,
): CosmeticItem => ({
  id,
  name,
  slot,
  rarity,
  icon: '',
  art: ['#6b2fd6', '#ffd23f'],
  owned,
});

function streak(over: Partial<LoginStreakData> = {}): LoginStreakData {
  return {
    streak: 3,
    best: 5,
    claimedToday: false,
    canClaim: true,
    nextClaimAt: NOW,
    breaksAt: NOW + 5 * 3600e3,
    next: { day: 4, rewards: [{ kind: 'xp', amount: 750 }] },
    ladder: Array.from({ length: 7 }, (_, i) => ({
      day: i + 1,
      rewards:
        i === 6
          ? [
              { kind: 'gumballs' as const, amount: 250 },
              { kind: 'gems' as const, amount: 20 },
            ]
          : [{ kind: 'gumballs' as const, amount: 50 }],
      state: i < 3 ? ('claimed' as const) : i === 3 ? ('today' as const) : ('upcoming' as const),
    })),
    ...over,
  };
}

const achievements: AchievementsData = {
  unlocked: 2,
  total: 4,
  categories: [
    { id: 'crowns', name: 'Crowns', unlocked: 2, total: 3 },
    { id: 'grabs', name: 'Grabs', unlocked: 0, total: 1 },
  ],
  list: [
    {
      id: 'crown-collector-1',
      category: 'crowns',
      title: 'Crown Collector I',
      description: 'Win 1 Crowns',
      hidden: false,
      unlocked: true,
      unlockedAt: Date.UTC(2026, 9, 2),
      progress: 1,
      target: 1,
      tier: { tier: 1, tiers: 4 },
      rewards: [
        { kind: 'xp', amount: 1000 },
        { kind: 'item', item: item('upper.medal', 'Gold Medal', 'upper', 'common', true) },
      ],
    },
    {
      id: 'crown-collector-2',
      category: 'crowns',
      title: 'Crown Collector II',
      description: 'Win 5 Crowns',
      hidden: false,
      unlocked: false,
      progress: 3,
      target: 5,
      tier: { tier: 2, tiers: 4 },
      rewards: [{ kind: 'crownShards', amount: 5 }],
    },
    {
      id: 'so-close',
      category: 'crowns',
      title: 'So Close',
      description: 'Finish a show in second place',
      hidden: true,
      unlocked: true,
      unlockedAt: Date.UTC(2026, 9, 3),
      progress: 1,
      target: 1,
      rewards: [{ kind: 'gumballs', amount: 100 }],
    },
    {
      id: 'hidden-1',
      category: 'grabs',
      title: '???',
      description: 'Hidden achievement. Keep playing to discover it.',
      hidden: true,
      unlocked: false,
      progress: null,
      target: null,
      rewards: [],
    },
  ],
};

const collection: CollectionData = {
  owned: 2,
  total: 4,
  percent: 50,
  entries: [
    {
      item: item('headwear.flower', 'Daisy Crown', 'headwear', 'common', true),
      sources: [{ kind: 'achievement', label: 'Achievement: Party Animal I' }],
      acquiredAt: Date.UTC(2026, 9, 1),
    },
    {
      item: item('headwear.halo', 'Halo', 'headwear', 'epic', false),
      sources: [{ kind: 'store', label: 'Item Shop' }],
    },
    {
      item: item('back.shell', 'Snail Shell', 'back', 'rare', false),
      sources: [{ kind: 'achievement', label: 'Achievement: Still Standing II' }],
    },
    {
      item: item('trail.bubbles', 'Bubbles', 'trail', 'common', true),
      sources: [
        { kind: 'pass', label: 'Season Pass tier 12 (Premium)' },
        { kind: 'store', label: 'Item Shop' },
      ],
    },
  ],
};

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
    crowns: 2,
    colors,
    isGuest: true,
    stats: { shows: 1, finals: 0, roundsQualified: 1, bestStreak: 0 },
  });
  s.setLoginStreak(null);
  s.setAchievements(null);
  s.setCollection(null);
  s.setChallenges({
    list: [
      {
        id: 'd1',
        cadence: 'daily',
        title: 'Play 3 shows',
        icon: '',
        progress: 1,
        goal: 3,
        reward: { kind: 'gumballs', amount: 30 },
        claimed: false,
        canReroll: true,
        metric: 'showsPlayed',
      },
      {
        id: 's1',
        cadence: 'seasonal',
        title: 'Win 3 Crowns this season',
        icon: '',
        progress: 1,
        goal: 3,
        reward: { kind: 'xp', amount: 8000 },
        gems: 25,
        claimed: false,
        canReroll: false,
        metric: 'crowns',
      },
      {
        id: 'm1',
        cadence: 'milestone',
        title: 'Reach 100 finals',
        icon: '',
        progress: 100,
        goal: 100,
        reward: { kind: 'xp', amount: 15000 },
        item: item('color.toasted', 'Toasted Marshmallow', 'colors', 'epic', false),
        claimed: false,
        canReroll: false,
        metric: 'finalsReached',
      },
      {
        id: 'm2',
        cadence: 'milestone',
        title: 'Play 500 shows',
        icon: '',
        progress: 500,
        goal: 500,
        reward: { kind: 'gumballs', amount: 1500 },
        claimed: true,
        canReroll: false,
        metric: 'showsPlayed',
      },
    ],
    dailyResetsAt: NOW + 3600e3,
    weeklyResetsAt: NOW + 86400e3,
    rerollsLeft: 1,
    rerollsPerDay: 1,
    season: { name: 'Season 1: Sugar Rush', endsAt: NOW + 3 * 86400e3 + 60e3 },
  });
});

describe('daily login card', () => {
  it('renders nothing offline', () => {
    expect(renderToStaticMarkup(<LoginStreakCard />)).toBe('');
  });

  it('offers today’s claim with the ladder and the deadline', () => {
    ui.getState().setLoginStreak(streak());
    const html = renderToStaticMarkup(<LoginStreakCard />);
    const t = text(html);
    expect(t).toContain('3-day streak');
    expect(t).toContain('Claim day 4');
    expect(t).toContain('Best 5');
    expect(t).toMatch(/Claim within \d\d:\d\d:\d\d to keep your streak/);
    expect(html.match(/tr-streak-day is-claimed/g)).toHaveLength(3);
    expect(html).toContain('tr-streak-day is-today');
    expect(html).toContain('is-big');
    expect(html).toContain('data-testid="streak-claim"');
  });

  it('shows the stamp and the next opening once claimed', () => {
    ui.getState().setLoginStreak(
      streak({ claimedToday: true, canClaim: false, streak: 4, nextClaimAt: NOW + 2 * 3600e3 }),
    );
    const html = renderToStaticMarkup(<LoginStreakCard />);
    expect(html).not.toContain('data-testid="streak-claim"');
    expect(text(html)).toContain('Claimed');
    expect(text(html)).toMatch(/Next reward in 0[12]:\d\d:\d\d/);
  });

  it('explains a fresh start', () => {
    const s = streak({ streak: 0, breaksAt: null, best: 0 });
    expect(streakStatus(s, NOW)).toBe('Claim once a day. Miss a day and the streak starts over.');
    ui.getState().setLoginStreak(s);
    expect(text(renderToStaticMarkup(<LoginStreakCard />))).toContain('Start a streak');
  });
});

describe('challenges tab', () => {
  it('adds seasonal and milestone sections with their own timers', () => {
    const html = renderToStaticMarkup(<ChallengesTab />);
    const t = text(html);
    expect(html).toContain('data-testid="challenges-seasonal"');
    expect(html).toContain('data-testid="challenges-milestone"');
    expect(html).not.toContain('data-testid="challenges-weekly"');
    expect(t).toContain('Seasonal · Season 1: Sugar Rush');
    expect(t).toMatch(/Ends in 3d 0h/);
    expect(t).toContain('Permanent · 1/2 done');
    expect(t).toContain('Toasted Marshmallow');
    expect(html.match(/data-testid="challenge-claim"/g)).toHaveLength(1);
  });

  it('shows the login card above the board when signed in', () => {
    ui.getState().setLoginStreak(streak());
    const html = renderToStaticMarkup(<ChallengesTab />);
    expect(html.indexOf('data-testid="login-streak"')).toBeLessThan(html.indexOf('tr-ch-board'));
  });
});

describe('achievements view', () => {
  it('explains that achievements need an online account', () => {
    expect(renderToStaticMarkup(<AchievementsView />)).toContain('data-testid="achievements-offline"');
  });

  it('lists progress, tiers, rewards and unlock dates, and keeps hidden ones secret', () => {
    ui.getState().setAchievements(achievements);
    const html = renderToStaticMarkup(<AchievementsView />);
    const t = text(html);
    expect(t).toContain('2 / 4');
    expect(t).toContain('3 / 5');
    expect(t).toContain('Gold Medal');
    expect(t).toMatch(/Unlocked .*2026/);
    expect(t).toContain('Crowns 2/3');
    expect(html).toContain('data-testid="achievement-hidden-1"');
    expect(t).toContain('???');
    expect(t).toContain('Secret');
    expect(t).toContain('So Close');
    const hidden = html.slice(html.indexOf('data-testid="achievement-hidden-1"'));
    expect(hidden).not.toContain('tr-ach-progress');
    expect(hidden.slice(0, 600)).not.toContain('tr-grant');
    // Locked goals come before unlocked ones in a category.
    expect(html.indexOf('achievement-crown-collector-2')).toBeLessThan(
      html.indexOf('achievement-crown-collector-1'),
    );
  });
});

describe('collection log', () => {
  it('filters by slot, rarity and ownership, counting the filter scope', () => {
    const hats = filterCollection(collection, { slot: 'headwear', rarity: 'all', owned: 'all' });
    expect(hats).toMatchObject({ owned: 1, total: 2 });
    expect(hats.entries).toHaveLength(2);
    const missing = filterCollection(collection, { slot: 'all', rarity: 'all', owned: 'missing' });
    expect(missing.entries.map((e) => e.item.id)).toEqual(['headwear.halo', 'back.shell']);
    expect(missing).toMatchObject({ owned: 2, total: 4 });
    const commons = filterCollection(collection, { slot: 'all', rarity: 'common', owned: 'owned' });
    expect(commons.entries.map((e) => e.item.id)).toEqual(['headwear.flower', 'trail.bubbles']);
    expect(filterCollection(collection, { slot: 'emote', rarity: 'all', owned: 'all' }).entries).toEqual([]);
  });

  it('shows completion, the grid and where the first item comes from', () => {
    ui.getState().setCollection(collection);
    const html = renderToStaticMarkup(<CollectionView />);
    const t = text(html);
    expect(t).toContain('50%');
    expect(t).toContain('2 / 4');
    expect(html.match(/class="tr-item tr-item--/g)).toHaveLength(4);
    expect(t).toContain('Where it comes from');
    expect(t).toContain('Achievement: Party Animal I');
    expect(t).toMatch(/Owned since/);
  });
});

describe('profile sections', () => {
  it('keeps the card and swaps the right side for achievements or the collection', () => {
    ui.getState().setAchievements(achievements);
    ui.getState().setCollection(collection);
    const overview = renderToStaticMarkup(<ProfileTab />);
    expect(overview).toContain('data-testid="profile-card"');
    expect(overview).toContain('aria-label="Profile sections"');
    expect(overview).not.toContain('data-testid="achievements"');
    const ach = renderToStaticMarkup(<ProfileTab initialSection="achievements" />);
    expect(ach).toContain('data-testid="profile-card"');
    expect(ach).toContain('data-testid="achievements"');
    expect(ach).not.toContain('data-testid="profile-stats"');
    const col = renderToStaticMarkup(<ProfileTab initialSection="collection" />);
    expect(col).toContain('data-testid="collection"');
  });

  it('puts no emoji on the new controls', () => {
    ui.getState().setAchievements(achievements);
    ui.getState().setCollection(collection);
    ui.getState().setLoginStreak(streak());
    for (const html of [
      renderToStaticMarkup(<ProfileTab initialSection="achievements" />),
      renderToStaticMarkup(<ProfileTab initialSection="collection" />),
      renderToStaticMarkup(<ChallengesTab />),
    ]) {
      const controls = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
        (m[1] ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' '),
      );
      expect(controls.filter((c) => EMOJI.test(c))).toEqual([]);
    }
  });
});
