/**
 * Seasonal soft reset of ranked ratings.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rankHistory, ratings } from '../src/db/schema.ts';
import { DEFAULT_RATING } from '../src/ranked/rating.ts';
import {
  SOFT_RESET_FACTOR,
  compressRating,
  ensureRankedSeason,
  softResetAnchor,
  softResetMatchId,
  softResetRatings,
} from '../src/ranked/season.ts';
import { tierForRp } from '../src/ranked/tiers.ts';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';

describe('soft reset formula', () => {
  it('pulls skill and RP halfway to the mean and restores uncertainty', () => {
    expect(SOFT_RESET_FACTOR).toBe(0.5);
    const anchor = { mu: 25, rp: 3000 };
    const top = compressRating({ mu: 35, sigma: 3, rp: 5000, placementsLeft: 0 }, anchor);
    expect(top.mu).toBe(30);
    expect(top.rp).toBe(4000);
    expect(top.sigma).toBeCloseTo(3 + 0.5 * (DEFAULT_RATING.sigma - 3));
    const low = compressRating({ mu: 15, sigma: 4, rp: 200, placementsLeft: 0 }, anchor);
    expect(low.mu).toBe(20);
    expect(low.rp).toBe(1600);
    // Never above the default uncertainty, never negative RP, placements carried.
    const fresh = compressRating({ mu: 25, sigma: 9, rp: 0, placementsLeft: 3 }, { mu: 25, rp: 0 });
    expect(fresh.sigma).toBeLessThanOrEqual(DEFAULT_RATING.sigma);
    expect(fresh.placementsLeft).toBe(3);
    expect(compressRating({ mu: 1, sigma: 2, rp: 0, placementsLeft: 0 }, { mu: 25, rp: -50 }).rp).toBe(0);
  });

  it('anchors μ on every row and RP on placed rows only', () => {
    expect(softResetAnchor([])).toEqual({ mu: DEFAULT_RATING.mu, rp: 0 });
    expect(
      softResetAnchor([
        { mu: 30, sigma: 3, rp: 4000, placementsLeft: 0 },
        { mu: 20, sigma: 3, rp: 2000, placementsLeft: 0 },
        { mu: 25, sigma: 8, rp: 0, placementsLeft: 4 },
      ]),
    ).toEqual({ mu: 25, rp: 3000 });
  });
});

describe('softResetRatings', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  async function seed(userId: string, seasonId: string, mu: number, sigma: number, rp: number, left = 0) {
    const tier = tierForRp(rp, left);
    await api.ctx.db.insert(ratings).values({
      userId,
      seasonId,
      queue: 'ranked',
      mu,
      sigma,
      rp,
      tier: tier.tier,
      division: tier.division,
      placementsLeft: left,
      matches: 12,
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    });
  }

  const rowsOf = (seasonId: string) =>
    api.ctx.db.select().from(ratings).where(eq(ratings.seasonId, seasonId)).orderBy(ratings.userId);

  it('carries every player into the new season, compressed, once', async () => {
    const [a, b, c] = [await api.guest(), await api.guest(), await api.guest()];
    await seed(a.id, 'sx-old', 35, 3, 5000);
    await seed(b.id, 'sx-old', 15, 4, 1000);
    await seed(c.id, 'sx-old', 25, 7, 0, 3);

    const first = await softResetRatings(api.ctx.db, 'sx-new', {
      fromSeasonId: 'sx-old',
      now: api.clock.now(),
    });
    expect(first).toEqual({ seasonId: 'sx-new', fromSeasonId: 'sx-old', reset: 3 });
    const next = new Map((await rowsOf('sx-new')).map((r) => [r.userId, r]));
    expect(next.get(a.id)).toMatchObject({
      mu: 30,
      rp: 4000,
      matches: 0,
      placementsLeft: 0,
      tier: 'platinum',
    });
    expect(next.get(b.id)).toMatchObject({ mu: 20, rp: 2000, tier: 'silver' });
    expect(next.get(c.id)).toMatchObject({ mu: 25, placementsLeft: 3, tier: 'unranked' });

    // Old season untouched: it is the season's final standings.
    const old = new Map((await rowsOf('sx-old')).map((r) => [r.userId, r]));
    expect(old.get(a.id)).toMatchObject({ mu: 35, rp: 5000, matches: 12 });

    // Audit trail in the new season's rank history.
    const audit = await api.ctx.db
      .select()
      .from(rankHistory)
      .where(eq(rankHistory.matchId, softResetMatchId('sx-new')));
    expect(audit).toHaveLength(3);
    expect(audit.find((h) => h.userId === a.id)).toMatchObject({
      rpBefore: 5000,
      rpAfter: 4000,
      seasonId: 'sx-new',
    });

    // Idempotent: a repeat writes nothing and changes nothing.
    const again = await softResetRatings(api.ctx.db, 'sx-new', { fromSeasonId: 'sx-old' });
    expect(again.reset).toBe(0);
    expect((await rowsOf('sx-new')).map((r) => [r.userId, r.mu, r.rp])).toEqual(
      [...next.values()].sort((x, y) => (x.userId < y.userId ? -1 : 1)).map((r) => [r.userId, r.mu, r.rp]),
    );
  });

  it('keeps a row the player already earned in the new season', async () => {
    const d = await api.guest();
    await seed(d.id, 'sy-old', 40, 2, 6000);
    await seed(d.id, 'sy-new', 26, 5, 1234);
    const r = await softResetRatings(api.ctx.db, 'sy-new', { fromSeasonId: 'sy-old' });
    expect(r.reset).toBe(0);
    const [row] = await api.ctx.db
      .select()
      .from(ratings)
      .where(and(eq(ratings.userId, d.id), eq(ratings.seasonId, 'sy-new')));
    expect(row).toMatchObject({ rp: 1234, mu: 26 });
  });

  it('finds the previous season on its own', async () => {
    const e = await api.guest();
    await seed(e.id, 'sz-old', 30, 3, 4000);
    await api.ctx.db
      .update(ratings)
      .set({ updatedAt: new Date('2027-01-01T00:00:00Z') })
      .where(eq(ratings.seasonId, 'sz-old'));
    const r = await softResetRatings(api.ctx.db, 'sz-new');
    expect(r.fromSeasonId).toBe('sz-old');
    expect(r.reset).toBeGreaterThanOrEqual(1);
  });

  it('the season hook runs once per season id and on start-up', async () => {
    const fresh = await createTestApi();
    try {
      // buildApp already ensured the active season (nothing to carry yet).
      expect(await fresh.ctx.kv.get(`ranked:season-reset:${fresh.ctx.catalog.season.id}`)).not.toBeNull();
      expect(await softResetRatings(fresh.ctx.db, 'whatever')).toEqual({
        seasonId: 'whatever',
        fromSeasonId: null,
        reset: 0,
      });
      const u = await fresh.guest();
      const tier = tierForRp(3000, 0);
      await fresh.ctx.db.insert(ratings).values({
        userId: u.id,
        seasonId: fresh.ctx.catalog.season.id,
        queue: 'ranked',
        mu: 32,
        sigma: 3,
        rp: 3000,
        tier: tier.tier,
        division: tier.division,
        placementsLeft: 0,
      });
      const first = await ensureRankedSeason(fresh.ctx, 'hook-next');
      expect(first?.reset).toBe(1);
      expect(await ensureRankedSeason(fresh.ctx, 'hook-next')).toBe(first);
      const [row] = await fresh.ctx.db
        .select()
        .from(ratings)
        .where(and(eq(ratings.userId, u.id), eq(ratings.seasonId, 'hook-next')));
      expect(row?.mu).toBe(32);
      expect(row?.rp).toBe(3000);
    } finally {
      await fresh.close();
    }
  });

  it('ranked ingestion still rates players after the hook', async () => {
    const h = await api.guest();
    const res = await api.postMatch(buildShow({ queue: 'ranked', humans: [{ userId: h.id, placement: 1 }] }));
    expect(res.statusCode).toBe(200);
    const [row] = await api.ctx.db
      .select()
      .from(ratings)
      .where(and(eq(ratings.userId, h.id), eq(ratings.seasonId, api.ctx.catalog.season.id)));
    expect(row?.matches).toBe(1);
  });
});
