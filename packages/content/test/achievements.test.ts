/**
 * Catalogue checks for achievements, seasonal and milestone challenges, the
 * login ladder and the collection log: ids, reward references, reachability of
 * every `challenge`-source cosmetic, and the read model's arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { COSMETICS, getCosmetic } from '../src/cosmetics/index.ts';
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_METRIC_KIND,
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_ID,
  ALL_CHALLENGES,
  CHALLENGE_POOL,
  CHALLENGE_SLOTS,
  LOGIN_STREAK_CYCLE,
  LOGIN_STREAK_LADDER,
  LoginStreakDaySchema,
  MILESTONE_CHALLENGES,
  PASS_TRACKS,
  SEASONAL_CHALLENGE_POOL,
  TUTORIAL_REWARD,
  achievementDescription,
  collectionLog,
  cosmeticSources,
  loginStreakDay,
  pickChallenges,
  sumGrants,
} from '../src/progression/index.ts';

describe('achievements', () => {
  it('has about forty achievements with unique ids across every category', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    for (const c of ACHIEVEMENT_CATEGORIES) expect(ACHIEVEMENTS.some((a) => a.category === c)).toBe(true);
    for (const a of ACHIEVEMENTS) {
      expect(ACHIEVEMENT_METRIC_KIND[a.metric]).toBeDefined();
      expect(a.rewards.length).toBeGreaterThan(0);
    }
  });

  it('numbers each series 1..n with rising targets', () => {
    const series = new Map<string, typeof ACHIEVEMENTS>();
    for (const a of ACHIEVEMENTS)
      if (a.series) series.set(a.series.id, [...(series.get(a.series.id) ?? []), a]);
    expect(series.size).toBeGreaterThanOrEqual(10);
    for (const [, list] of series) {
      list.forEach((a, i) => {
        expect(a.series).toMatchObject({ tier: i + 1, tiers: list.length });
        if (i > 0) expect(a.target).toBeGreaterThan(list[i - 1]!.target);
      });
    }
  });

  it('keeps a few hidden achievements', () => {
    const hidden = ACHIEVEMENTS.filter((a) => a.hidden);
    expect(hidden.length).toBeGreaterThanOrEqual(3);
    for (const a of hidden) expect(a.series).toBeUndefined();
  });

  it('only grants real challenge-source cosmetics', () => {
    for (const a of ACHIEVEMENTS)
      for (const r of a.rewards)
        if (r.kind === 'cosmetic') expect(getCosmetic(r.itemId)?.source, `${a.id}`).toBe('challenge');
  });

  it('fills in the target in descriptions', () => {
    expect(achievementDescription(ACHIEVEMENTS_BY_ID.get('crown-collector-2')!)).toBe('Win 5 Crowns');
    expect(achievementDescription(ACHIEVEMENTS_BY_ID.get('grabby-hands-3')!)).toBe(
      'Grab other Tumblers 10,000 times',
    );
  });

  it('sets the first wardrobe tier above what a new account starts with', () => {
    const starters = COSMETICS.filter((c) => c.source === 'default').length;
    const first = ACHIEVEMENTS.find((a) => a.metric === 'cosmeticsOwned')!;
    expect(first.target).toBeGreaterThan(starters + 10);
  });
});

describe('seasonal and milestone challenges', () => {
  it('picks a deterministic seasonal set per season id', () => {
    const s1 = pickChallenges('seasonal', 's1');
    expect(s1).toHaveLength(CHALLENGE_SLOTS.seasonal);
    expect(new Set(s1.map((c) => c.id)).size).toBe(s1.length);
    expect(s1.every((c) => c.cadence === 'seasonal')).toBe(true);
    expect(pickChallenges('seasonal', 's1')).toEqual(s1);
    const sets = new Set(
      ['s1', 's2', 's3', 's4'].map((s) =>
        pickChallenges('seasonal', s)
          .map((c) => c.id)
          .join(),
      ),
    );
    expect(sets.size).toBeGreaterThan(1);
  });

  it('keeps daily/weekly picks out of the seasonal pool and vice versa', () => {
    expect(CHALLENGE_POOL.every((c) => c.cadence === 'daily' || c.cadence === 'weekly')).toBe(true);
    expect(pickChallenges('daily', '2026-10-02').every((c) => c.cadence === 'daily')).toBe(true);
    expect(SEASONAL_CHALLENGE_POOL.length).toBeGreaterThan(CHALLENGE_SLOTS.seasonal);
  });

  it('has unique ids across every cadence and valid cosmetic rewards', () => {
    const all = [...CHALLENGE_POOL, ...SEASONAL_CHALLENGE_POOL, ...MILESTONE_CHALLENGES];
    expect(ALL_CHALLENGES.size).toBe(all.length);
    for (const c of all) {
      if (c.rewardCosmetic) expect(getCosmetic(c.rewardCosmetic)?.source).toBe('challenge');
      expect(c.rewardXp + c.rewardGumballs + c.rewardGems + (c.rewardCosmetic ? 1 : 0)).toBeGreaterThan(0);
    }
    expect(MILESTONE_CHALLENGES.every((c) => c.cadence === 'milestone')).toBe(true);
  });
});

describe('challenge-source cosmetics', () => {
  it('are each granted by exactly one achievement, challenge or the tutorial', () => {
    const grants = new Map<string, string[]>();
    const add = (id: string, by: string) => grants.set(id, [...(grants.get(id) ?? []), by]);
    for (const a of ACHIEVEMENTS) for (const r of a.rewards) if (r.kind === 'cosmetic') add(r.itemId, a.id);
    for (const c of ALL_CHALLENGES.values()) if (c.rewardCosmetic) add(c.rewardCosmetic, c.id);
    add(TUTORIAL_REWARD.cosmeticId, 'tutorial');
    for (const item of COSMETICS.filter((c) => c.source === 'challenge'))
      expect(grants.get(item.id), item.id).toHaveLength(1);
  });
});

describe('login streak ladder', () => {
  it('is a 7-day cycle with the biggest reward on day 7', () => {
    expect(LOGIN_STREAK_LADDER).toHaveLength(LOGIN_STREAK_CYCLE);
    const value = (d: (typeof LOGIN_STREAK_LADDER)[number]) => {
      const s = sumGrants(d.rewards);
      return (s.gumballs ?? 0) + (s.xp ?? 0) / 10 + (s.gems ?? 0) * 10 + (s.crownShards ?? 0) * 20;
    };
    const day7 = value(LOGIN_STREAK_LADDER[6]!);
    for (const d of LOGIN_STREAK_LADDER.slice(0, 6)) expect(value(d)).toBeLessThan(day7);
    for (const d of LOGIN_STREAK_LADDER)
      expect(d.rewards.map((r): string => r.kind)).not.toContain('cosmetic');
  });

  it('refuses a cosmetic on the ladder', () => {
    const bad = { day: 1, rewards: [{ kind: 'cosmetic', itemId: 'trail.bubbles' }] };
    expect(LoginStreakDaySchema.safeParse(bad).success).toBe(false);
  });

  it('wraps every seven days', () => {
    expect(loginStreakDay(1).day).toBe(1);
    expect(loginStreakDay(7).day).toBe(7);
    expect(loginStreakDay(8).day).toBe(1);
    expect(loginStreakDay(14).day).toBe(7);
    expect(loginStreakDay(0).day).toBe(1);
  });
});

describe('collection log', () => {
  it('gives every catalogue item at least one source, never a vague fallback', () => {
    for (const item of COSMETICS) {
      const sources = cosmeticSources(item.id);
      expect(sources.length, item.id).toBeGreaterThan(0);
      if (item.source === 'challenge') expect(sources.map((s) => s.label)).not.toContain('Challenges');
    }
    expect(cosmeticSources('headwear.no-such-thing')).toEqual([]);
  });

  it('names the pass tier for pass items and hides hidden achievement names', () => {
    const tier1 = PASS_TRACKS['sugar-rush']!.tiers[0]!.free[0]!;
    expect(tier1.kind).toBe('cosmetic');
    const id = (tier1 as { itemId: string }).itemId;
    expect(cosmeticSources(id)).toContainEqual({ kind: 'pass', label: 'Season Pass tier 1 (Free)' });
    const secret = ACHIEVEMENTS.find((a) => a.hidden && a.rewards.some((r) => r.kind === 'cosmetic'))!;
    const reward = secret.rewards.find((r) => r.kind === 'cosmetic') as { itemId: string };
    const labels = cosmeticSources(reward.itemId).map((s) => s.label);
    expect(labels).toEqual(['Hidden achievement']);
    expect(labels.join()).not.toContain(secret.title);
  });

  it('counts completion over the whole catalogue whatever the filter', () => {
    const owned = new Set(COSMETICS.filter((c) => c.slot === 'headwear').map((c) => c.id));
    const all = collectionLog((id) => owned.has(id));
    expect(all.total).toBe(COSMETICS.length);
    expect(all.owned).toBe(owned.size);
    expect(all.entries).toHaveLength(COSMETICS.length);
    expect(all.bySlot.headwear).toEqual({ owned: owned.size, total: owned.size });
    expect(all.percent).toBe(Math.floor((owned.size * 1000) / COSMETICS.length) / 10);
    const rarities = Object.values(all.byRarity).reduce((s, t) => s + t.total, 0);
    expect(rarities).toBe(COSMETICS.length);

    const hats = collectionLog((id) => owned.has(id), { slot: 'headwear', rarity: 'common' });
    expect(hats.entries.every((e) => e.slot === 'headwear' && e.rarity === 'common' && e.owned)).toBe(true);
    expect(hats.owned).toBe(all.owned);
    const missing = collectionLog((id) => owned.has(id), { owned: false });
    expect(missing.entries.some((e) => e.owned)).toBe(false);
    expect(missing.entries).toHaveLength(COSMETICS.length - owned.size);
  });

  it('never rounds an incomplete collection up to 100 percent', () => {
    const allButOne = collectionLog((id) => id !== COSMETICS[0]!.id);
    expect(allButOne.percent).toBeLessThan(100);
    expect(collectionLog(() => true).percent).toBe(100);
    expect(collectionLog(() => false).percent).toBe(0);
  });
});
