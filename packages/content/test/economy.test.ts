import { describe, expect, it } from 'vitest';
import { COSMETICS, getCosmetic } from '../src/cosmetics/index.ts';
import {
  AUTHORED_SEASONS,
  GEM_EARN,
  PASS_TIERS,
  SEASON_LENGTH_MONTHS,
  SEASON_PASS,
  SHARDS_PER_CROWN,
  SHARD_SHOP_SLOTS,
  levelMilestoneGems,
  levelRangeGems,
  nextSeason,
  nextUtcWeekStart,
  passForSeason,
  seasonAt,
  seasonById,
  seasonByNumber,
  shardPrice,
  shardShopAt,
  shardShopForWeek,
  shardShopPool,
  unclaimedPassRewards,
  utcWeekKey,
  xpForLevel,
} from '../src/progression/index.ts';

const totalPassXp = SEASON_PASS.tiers.reduce((s, t) => s + t.xp, 0);

describe('season schedule', () => {
  it('resolves the authored seasons by date, boundaries inclusive at the start', () => {
    expect(seasonAt(new Date('2026-10-02T12:00:00Z')).id).toBe('s1');
    expect(seasonAt(new Date('2026-11-30T23:59:59.999Z')).id).toBe('s1');
    expect(seasonAt(new Date('2026-12-01T00:00:00Z')).id).toBe('s2');
    // Pre-launch clocks still see the first season.
    expect(seasonAt(new Date('2020-01-01T00:00:00Z')).id).toBe('s1');
  });

  it('keeps generating contiguous seasons after the authored list runs out', () => {
    const last = AUTHORED_SEASONS[AUTHORED_SEASONS.length - 1]!;
    let prev = seasonByNumber(last.number);
    for (let n = last.number + 1; n < last.number + 40; n++) {
      const s = seasonByNumber(n);
      expect(s.generated).toBe(true);
      expect(s.id).toBe(`s${n}`);
      expect(s.startsAt).toBe(prev.endsAt);
      const start = new Date(s.startsAt);
      const end = new Date(s.endsAt);
      expect(end.getUTCDate()).toBe(1);
      expect(
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth(),
      ).toBe(SEASON_LENGTH_MONTHS);
      expect(s.name).toMatch(new RegExp(`^Season ${n}: `));
      expect(passForSeason(s).tiers).toHaveLength(PASS_TIERS);
      prev = s;
    }
  });

  it('always has a current and a next season, even decades out', () => {
    const far = new Date('2061-05-17T08:00:00Z');
    const s = seasonAt(far);
    expect(Date.parse(s.startsAt)).toBeLessThanOrEqual(far.getTime());
    expect(Date.parse(s.endsAt)).toBeGreaterThan(far.getTime());
    expect(nextSeason(s).startsAt).toBe(s.endsAt);
    expect(seasonById(s.id)).toEqual(s);
    expect(seasonById('nope')).toBeUndefined();
  });
});

describe('season rollover rule', () => {
  it('grants every unlocked unclaimed free reward, premium only with premium', () => {
    const xp = SEASON_PASS.tiers.slice(0, 5).reduce((s, t) => s + t.xp, 0);
    const free = unclaimedPassRewards(SEASON_PASS, xp, { free: [1, 2], premium: [] }, false);
    expect(free.every((r) => r.track === 'free')).toBe(true);
    expect(free.map((r) => r.tier)).toEqual([3, 4, 5]);
    const both = unclaimedPassRewards(SEASON_PASS, xp, { free: [1, 2], premium: [1] }, true);
    expect(both.filter((r) => r.track === 'premium').map((r) => r.tier)).toEqual([2, 3, 4, 5]);
  });

  it('grants nothing for locked tiers or an untouched pass', () => {
    expect(unclaimedPassRewards(SEASON_PASS, 0, { free: [], premium: [] }, true)).toEqual([]);
    const all = unclaimedPassRewards(SEASON_PASS, totalPassXp * 2, { free: [], premium: [] }, true);
    expect(all).toHaveLength(PASS_TIERS * 2);
  });
});

describe('Crown Shard shop', () => {
  it('stocks only shard exclusives, each priced below one Crown', () => {
    const pool = shardShopPool();
    expect(pool.length).toBeGreaterThanOrEqual(SHARD_SHOP_SLOTS * 2);
    for (const c of pool) {
      expect(c.price).toBeNull();
      const p = shardPrice(c);
      expect(p).not.toBeNull();
      expect(p!).toBeLessThan(SHARDS_PER_CROWN);
    }
    expect(shardPrice(getCosmetic('headwear.tiara')!)).toBeNull();
  });

  it('rotates deterministically each ISO week, with at most one legendary', () => {
    const a = shardShopForWeek('2026-W40', 'x');
    expect(shardShopForWeek('2026-W40', 'x')).toEqual(a);
    expect(a.offers).toHaveLength(SHARD_SHOP_SLOTS);
    expect(new Set(a.offers.map((o) => o.itemId)).size).toBe(SHARD_SHOP_SLOTS);
    const shelves = Array.from({ length: 30 }, (_, i) => shardShopForWeek(`2027-W${i + 1}`, 'x'));
    for (const s of shelves)
      expect(s.offers.filter((o) => o.rarity === 'legendary').length).toBeLessThanOrEqual(1);
    expect(new Set(shelves.map((s) => s.offers.map((o) => o.itemId).join())).size).toBeGreaterThan(1);
  });

  it('restocks on Monday 00:00 UTC', () => {
    const sun = new Date('2026-10-04T23:00:00Z');
    const r = shardShopAt(sun);
    expect(r.week).toBe(utcWeekKey(sun));
    expect(r.refreshesAt).toBe('2026-10-05T00:00:00.000Z');
    expect(nextUtcWeekStart(new Date('2026-10-05T00:00:00Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('keeps shard exclusives off every other unlock path', () => {
    const exclusives = COSMETICS.filter((c) => c.source === 'shards');
    const onPass = new Set(
      SEASON_PASS.tiers
        .flatMap((t) => [...t.free, ...t.premium])
        .flatMap((r) => (r.kind === 'cosmetic' ? [r.itemId] : [])),
    );
    for (const c of exclusives) expect(onPass.has(c.id)).toBe(false);
  });
});

describe('free Gem earn paths', () => {
  it('pays level milestones only on every Nth level', () => {
    expect(levelMilestoneGems(GEM_EARN.levelMilestoneEvery)).toBe(GEM_EARN.levelMilestone);
    expect(levelMilestoneGems(GEM_EARN.levelMilestoneEvery + 1)).toBe(0);
    expect(levelRangeGems(9, 31)).toBe(3 * GEM_EARN.levelMilestone);
    expect(levelRangeGems(10, 10)).toBe(0);
  });

  it('lets a free player save up for the next Premium Pass within a season', () => {
    const freeTrackGems = SEASON_PASS.tiers
      .flatMap((t) => t.free)
      .reduce((s, r) => s + (r.kind === 'gems' ? r.amount : 0), 0);
    expect(freeTrackGems).toBeGreaterThan(0);
    // A casual season (see docs/design/ECONOMY.md): half the weeklies, two first-Crowns a week, one milestone.
    const weeks = 13;
    const casual =
      freeTrackGems / 2 +
      weeks * 3 * GEM_EARN.weeklyChallenge +
      weeks * 2 * GEM_EARN.firstCrownOfDay +
      GEM_EARN.levelMilestone;
    expect(casual).toBeGreaterThanOrEqual(SEASON_PASS.premiumPriceGems);
    expect(xpForLevel(GEM_EARN.levelMilestoneEvery)).toBeGreaterThan(0);
  });
});
