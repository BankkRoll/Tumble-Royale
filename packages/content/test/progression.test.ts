import { describe, expect, it } from 'vitest';
import { getCosmetic } from '../src/cosmetics/index.ts';
import {
  CHALLENGE_POOL,
  CHALLENGE_SLOTS,
  LEVEL_TABLE,
  MAX_LEVEL,
  PASS_TIERS,
  REWARD_RULES,
  SEASON_PASS,
  computeShowRewards,
  levelForXp,
  passTierForXp,
  pickChallenges,
  xpForLevel,
} from '../src/progression/index.ts';

describe('level curve', () => {
  it('has 100 increasing levels and round-trips XP', () => {
    expect(LEVEL_TABLE).toHaveLength(MAX_LEVEL);
    for (let i = 1; i < MAX_LEVEL - 1; i++) expect(LEVEL_TABLE[i]!.xpToNext).toBeGreaterThanOrEqual(LEVEL_TABLE[i - 1]!.xpToNext);
    expect(levelForXp(0)).toEqual({ level: 1, intoLevel: 0, toNext: LEVEL_TABLE[0]!.xpToNext });
    for (const lvl of [2, 10, 50, 100]) {
      expect(levelForXp(xpForLevel(lvl)).level).toBe(lvl);
      expect(levelForXp(xpForLevel(lvl) - 1).level).toBe(lvl - 1);
    }
    expect(levelForXp(1e12).level).toBe(MAX_LEVEL);
  });
});

describe('show rewards', () => {
  const base = { roundsPlayed: 4, roundsQualified: 3, reachedFinal: true, wonCrown: false, place: 3, participants: 40, quit: false, firstShowOfDay: false };

  it('pays more for better outcomes', () => {
    const out = computeShowRewards({ ...base, roundsPlayed: 1, roundsQualified: 0, reachedFinal: false, place: 35 });
    const final = computeShowRewards(base);
    const crown = computeShowRewards({ ...base, wonCrown: true, place: 1 });
    expect(final.xp).toBeGreaterThan(out.xp);
    expect(crown.xp).toBeGreaterThan(final.xp);
    expect(crown.gumballs).toBeGreaterThan(final.gumballs);
    expect(crown.crowns).toBe(1);
    expect(final.crownShards).toBe(REWARD_RULES.reachedFinal.crownShards);
    expect(final.xp).toBe(final.lines.reduce((s, l) => s + l.xp, 0));
  });

  it('applies the first-show bonus and penalises quitting', () => {
    expect(computeShowRewards({ ...base, firstShowOfDay: true }).xp).toBe(computeShowRewards(base).xp * 2);
    const quit = computeShowRewards({ ...base, quit: true, reachedFinal: false });
    expect(quit.crowns).toBe(0);
    expect(quit.lines.some((l) => l.label === 'Show played')).toBe(false);
  });
});

describe('challenges', () => {
  it('rotates a deterministic, distinct set per period', () => {
    const a = pickChallenges('daily', '2026-10-02');
    expect(a).toHaveLength(CHALLENGE_SLOTS.daily);
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(pickChallenges('daily', '2026-10-02')).toEqual(a);
    const weekly = pickChallenges('weekly', '2026-W40');
    expect(weekly).toHaveLength(CHALLENGE_SLOTS.weekly);
    expect(weekly.every((c) => c.cadence === 'weekly')).toBe(true);
    const days = new Set(['01', '02', '03', '04', '05'].map((d) => pickChallenges('daily', `2026-10-${d}`).map((c) => c.id).join()));
    expect(days.size).toBeGreaterThan(1);
    expect(new Set(CHALLENGE_POOL.map((c) => c.id)).size).toBe(CHALLENGE_POOL.length);
  });
});

describe('season pass', () => {
  it('has 100 tiers, rewards on every premium tier and real pass items', () => {
    expect(SEASON_PASS.tiers).toHaveLength(PASS_TIERS);
    for (const t of SEASON_PASS.tiers) expect(t.premium.length).toBeGreaterThan(0);
    expect(SEASON_PASS.tiers.at(-1)!.premium[0]).toMatchObject({ kind: 'cosmetic', rarity: 'mythic' });
    const ids = SEASON_PASS.tiers.flatMap((t) => [...t.free, ...t.premium]).flatMap((r) => (r.kind === 'cosmetic' ? [r.itemId] : []));
    expect(new Set(ids).size).toBe(ids.length);
    const real = ids.filter((id) => getCosmetic(id));
    expect(real.length).toBeGreaterThan(0);
    for (const id of real) expect(getCosmetic(id)!.source).toBe('pass');
    expect(passTierForXp(0).tier).toBe(0);
    const total = SEASON_PASS.tiers.reduce((s, t) => s + t.xp, 0);
    expect(passTierForXp(total).tier).toBe(PASS_TIERS);
    expect(passTierForXp(SEASON_PASS.tiers[0]!.xp).tier).toBe(1);
  });
});
