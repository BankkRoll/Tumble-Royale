/**
 * Phase 6 acceptance: a 40-player ranked rating update.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeRankedUpdate,
  DEFAULT_RATING,
  PLACEMENT_MATCHES,
  rpFromRating,
  type RankedEntrant,
} from '../src/ranked/rating.ts';
import { tierForRp, tierLabel } from '../src/ranked/tiers.ts';
import { buildShow, createTestApi, type TestApi } from './helpers.ts';

/** 40 entrants; every 4th slot is a bot. Humans are placed and share a prior. */
function lobby(prior?: RankedEntrant['prior']): RankedEntrant[] {
  return Array.from({ length: 40 }, (_, i) => ({
    key: `k${String(i).padStart(2, '0')}`,
    isBot: i % 4 === 3,
    placement: i + 1,
    ...(prior ? { prior } : {}),
  }));
}

const settled = { mu: 25, sigma: 6, rp: rpFromRating(25, 6), placementsLeft: 0 };

describe('ranked rating update (40 players)', () => {
  const entrants = lobby(settled);
  const out = computeRankedUpdate(entrants);

  it('rates every human and no bot', () => {
    expect(out).toHaveLength(30);
    const botKeys = new Set(entrants.filter((e) => e.isBot).map((e) => e.key));
    expect(out.some((o) => botKeys.has(o.key))).toBe(false);
  });

  it('higher placements gain, lower placements lose, monotonically', () => {
    const muDeltas = out.map((o) => o.muAfter - o.muBefore);
    for (let i = 1; i < muDeltas.length; i++) expect(muDeltas[i]!).toBeLessThan(muDeltas[i - 1]!);
    expect(muDeltas[0]!).toBeGreaterThan(0);
    expect(muDeltas.at(-1)!).toBeLessThan(0);
    const rp = out.map((o) => o.rpDelta);
    for (let i = 1; i < rp.length; i++) expect(rp[i]!).toBeLessThanOrEqual(rp[i - 1]!);
    expect(rp[0]!).toBeGreaterThan(0);
    expect(rp.at(-1)!).toBeLessThan(0);
  });

  it('reduces uncertainty on average (tau dynamics may nudge extremes up slightly)', () => {
    const tau = 25 / 300;
    for (const o of out) expect(o.sigmaAfter).toBeLessThanOrEqual(Math.sqrt(o.sigmaBefore ** 2 + tau ** 2));
    const mean = out.reduce((s, o) => s + o.sigmaAfter, 0) / out.length;
    expect(mean).toBeLessThan(settled.sigma);
  });

  it('is zero-sum in mu among humans when no bots are present, and near it with bots', () => {
    const humansOnly = computeRankedUpdate(lobby(settled).map((e) => ({ ...e, isBot: false })));
    const sum = humansOnly.reduce((s, o) => s + (o.muAfter - o.muBefore), 0);
    expect(Math.abs(sum)).toBeLessThan(1e-6);

    const withBots = out.reduce((s, o) => s + (o.muAfter - o.muBefore), 0);
    const magnitude = out.reduce((s, o) => s + Math.abs(o.muAfter - o.muBefore), 0);
    expect(Math.abs(withBots)).toBeLessThan(0.15 * magnitude);
  });

  it('keeps visible RP roughly balanced across the lobby', () => {
    const net = out.reduce((s, o) => s + o.rpDelta, 0);
    const winnerBonus = out[0]!.placement === 1 ? 15 : 0;
    expect(Math.abs(net - winnerBonus)).toBeLessThan(out.length * 3);
  });

  it('excludes bots from updates but keeps them in the ordering', () => {
    // Moving a bot from last to first must push every human down a place and reduce their gains.
    const botFirst = lobby(settled).map((e) => (e.key === 'k39' ? { ...e, placement: 0 } : e));
    const shifted = computeRankedUpdate(botFirst);
    const base = new Map(out.map((o) => [o.key, o]));
    for (const o of shifted) expect(o.muAfter).toBeLessThan(base.get(o.key)!.muAfter);
  });

  it('is deterministic regardless of input order', () => {
    const shuffled = [...entrants].reverse();
    expect(computeRankedUpdate(shuffled)).toEqual(out);
    expect(computeRankedUpdate(entrants)).toEqual(out);
  });

  it('beating a stronger lobby is worth more RP', () => {
    const strongLobby = lobby({ mu: 32, sigma: 6, rp: 3000, placementsLeft: 0 }).map((e) =>
      e.key === 'k00' ? { ...e, prior: { ...settled, rp: 3000 } } : e,
    );
    const evenLobby = lobby({ mu: 25, sigma: 6, rp: 3000, placementsLeft: 0 });
    const strong = computeRankedUpdate(strongLobby).find((o) => o.key === 'k00')!;
    const even = computeRankedUpdate(evenLobby).find((o) => o.key === 'k00')!;
    expect(strong.rpDelta).toBeGreaterThan(even.rpDelta);
  });

  it('runs placements before showing RP', () => {
    let prior = { mu: DEFAULT_RATING.mu, sigma: DEFAULT_RATING.sigma, rp: 0, placementsLeft: PLACEMENT_MATCHES };
    for (let match = 1; match <= PLACEMENT_MATCHES; match++) {
      const res = computeRankedUpdate(lobby().map((e) => (e.key === 'k00' ? { ...e, prior } : e))).find((o) => o.key === 'k00')!;
      prior = { mu: res.muAfter, sigma: res.sigmaAfter, rp: res.rpAfter, placementsLeft: res.placementsLeft };
      if (match < PLACEMENT_MATCHES) {
        expect(res.tierAfter.tier).toBe('unranked');
        expect(res.rpAfter).toBe(0);
      } else {
        expect(res.placementsLeft).toBe(0);
        expect(res.rpAfter).toBe(rpFromRating(res.muAfter, res.sigmaAfter));
        expect(res.tierAfter.tier).not.toBe('unranked');
      }
    }
  });
});

describe('tiers', () => {
  it('maps RP to tiers and divisions', () => {
    expect(tierForRp(0, 0)).toEqual({ tier: 'bronze', division: 3 });
    expect(tierForRp(1199, 0)).toEqual({ tier: 'bronze', division: 1 });
    expect(tierForRp(2500, 0)).toEqual({ tier: 'gold', division: 3 });
    expect(tierForRp(5999, 0)).toEqual({ tier: 'diamond', division: 1 });
    expect(tierForRp(9000, 0)).toEqual({ tier: 'champion', division: 1 });
    expect(tierForRp(9000, 0, 12)).toEqual({ tier: 'crown_league', division: 0 });
    expect(tierForRp(9000, 0, 600)).toEqual({ tier: 'champion', division: 1 });
    expect(tierForRp(9000, 2)).toEqual({ tier: 'unranked', division: 0 });
    expect(tierLabel({ tier: 'gold', division: 2 })).toBe('GOLD II');
  });
});

describe('ranked ingest', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it('persists ratings and rank history for a ranked show', async () => {
    const top = await api.guest();
    const bottom = await api.guest();
    const res = await api.postMatch(
      buildShow({ queue: 'ranked', humans: [{ userId: top.id, placement: 2 }, { userId: bottom.id, placement: 39 }] }),
    );
    expect(res.statusCode).toBe(200);
    const rewards = res.json().rewards as { userId: string; ranked: { placementsLeft: number; tierAfter: { tier: string } } }[];
    for (const r of rewards) expect(r.ranked).toMatchObject({ placementsLeft: PLACEMENT_MATCHES - 1, tierAfter: { tier: 'unranked' } });
    const topCard = (await api.req('GET', `/profile/${top.id}`, { token: bottom.accessToken })).json();
    expect(topCard.ranked).toEqual([expect.objectContaining({ queue: 'ranked', placementsLeft: PLACEMENT_MATCHES - 1 })]);
  });
});
