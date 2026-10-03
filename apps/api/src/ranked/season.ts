/**
 * Seasonal soft reset of ranked ratings (SPEC §12, SHOWS.md §4.5).
 *
 * When a new season starts, every rated player gets a new-season `ratings` row
 * compressed toward the previous season's mean, so the ladder re-sorts quickly
 * without wiping skill. The previous season's `ratings` and `rank_history`
 * rows are never touched: they are the season's final standings.
 *
 * Formula, per queue, with factor k = {@link SOFT_RESET_FACTOR} (0.5):
 * - μ̄ = mean μ of every previous-season row; R̄ = mean RP of placed rows
 *   (rows still in placements have no meaningful RP).
 * - μ' = μ̄ + k·(μ − μ̄)                       pull skill halfway to the mean
 * - σ' = σ + k·(σ₀ − σ), σ₀ = default σ       restore uncertainty so it moves
 * - RP' = max(0, round(R̄ + k·(RP − R̄)))      visible ladder compresses too
 * - placementsLeft is carried over: placed players stay placed, players
 *   mid-placement keep their remaining count.
 *
 * Idempotent per season id: rows are inserted with ON CONFLICT DO NOTHING (a
 * player who already has a new-season row keeps it), the audit entry in
 * `rank_history` is keyed by `season-reset:<seasonId>`, and a KV marker lets
 * other API instances skip the scan.
 */
import { desc, eq, max, ne } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { rankHistory, ratings } from '../db/schema.ts';
import { DEFAULT_RATING } from './rating.ts';
import { tierForRp } from './tiers.ts';

/** Fraction of the distance from the mean that survives a season reset. */
export const SOFT_RESET_FACTOR = 0.5;

/** `rank_history.match_id` of a season's soft-reset audit rows. */
export const softResetMatchId = (seasonId: string): string => `season-reset:${seasonId}`;

/** A rating row's values that the reset reads and writes. */
export interface SeasonRating {
  mu: number;
  sigma: number;
  rp: number;
  placementsLeft: number;
}

/** Population means a reset compresses toward. */
export interface SoftResetAnchor {
  mu: number;
  rp: number;
}

/**
 * The compression step for one rating. Pure.
 *
 * @param r - Previous-season rating.
 * @param anchor - Previous-season means (see {@link softResetAnchor}).
 * @param factor - Fraction of the distance from the mean to keep.
 * @returns The new season's starting rating.
 * @example
 * compressRating({ mu: 35, sigma: 3, rp: 5000, placementsLeft: 0 }, { mu: 25, rp: 3000 });
 * // { mu: 30, sigma: ~5.67, rp: 4000, placementsLeft: 0 }
 */
export function compressRating(
  r: SeasonRating,
  anchor: SoftResetAnchor,
  factor = SOFT_RESET_FACTOR,
): SeasonRating {
  const sigma0 = DEFAULT_RATING.sigma;
  return {
    mu: anchor.mu + factor * (r.mu - anchor.mu),
    sigma: Math.min(sigma0, r.sigma + factor * (sigma0 - r.sigma)),
    rp: Math.max(0, Math.round(anchor.rp + factor * (r.rp - anchor.rp))),
    placementsLeft: r.placementsLeft,
  };
}

/**
 * Means of a season's ratings: μ over every row, RP over placed rows only.
 *
 * @param rows - One queue's previous-season ratings.
 * @returns The anchor; defaults (μ 25, RP 0) for an empty season.
 */
export function softResetAnchor(rows: readonly SeasonRating[]): SoftResetAnchor {
  if (rows.length === 0) return { mu: DEFAULT_RATING.mu, rp: 0 };
  const placed = rows.filter((r) => r.placementsLeft === 0);
  return {
    mu: rows.reduce((s, r) => s + r.mu, 0) / rows.length,
    rp: placed.length ? placed.reduce((s, r) => s + r.rp, 0) / placed.length : 0,
  };
}

/** What a reset did. */
export interface SoftResetResult {
  seasonId: string;
  /** The season the ratings were carried from, or null when there was none. */
  fromSeasonId: string | null;
  /** New-season rows written by this call (0 on a repeat). */
  reset: number;
}

/**
 * The most recently active season other than `seasonId`.
 *
 * @param db - Database.
 * @param seasonId - The new season.
 */
async function previousSeason(db: DbOrTx, seasonId: string): Promise<string | null> {
  const [row] = await db
    .select({ seasonId: ratings.seasonId, last: max(ratings.updatedAt) })
    .from(ratings)
    .where(ne(ratings.seasonId, seasonId))
    .groupBy(ratings.seasonId)
    .orderBy(desc(max(ratings.updatedAt)), desc(ratings.seasonId))
    .limit(1);
  return row?.seasonId ?? null;
}

const CHUNK = 500;

/**
 * Seeds `seasonId`'s ratings from the previous season with the soft-reset
 * formula. Safe to call any number of times for the same season.
 *
 * @param db - Database.
 * @param seasonId - The season that just started.
 * @param opts - `fromSeasonId` to carry from (default: the most recently
 *   active other season); `now` for timestamps.
 * @returns How many players were carried over.
 */
export async function softResetRatings(
  db: DbOrTx,
  seasonId: string,
  opts: { fromSeasonId?: string; now?: Date } = {},
): Promise<SoftResetResult> {
  const from = opts.fromSeasonId ?? (await previousSeason(db, seasonId));
  if (!from || from === seasonId) return { seasonId, fromSeasonId: null, reset: 0 };
  const now = opts.now ?? new Date();
  const old = await db
    .select()
    .from(ratings)
    .where(eq(ratings.seasonId, from))
    .orderBy(ratings.queue, ratings.userId);
  const byQueue = new Map<string, typeof old>();
  for (const r of old) {
    let list = byQueue.get(r.queue);
    if (!list) byQueue.set(r.queue, (list = []));
    list.push(r);
  }
  let reset = 0;
  for (const [queue, rows] of byQueue) {
    const anchor = softResetAnchor(rows);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ prev: r, next: compressRating(r, anchor) }));
      const inserted = await db
        .insert(ratings)
        .values(
          chunk.map(({ prev, next }) => {
            const tier = tierForRp(next.rp, next.placementsLeft);
            return {
              userId: prev.userId,
              seasonId,
              queue,
              ...next,
              tier: tier.tier,
              division: tier.division,
              matches: 0,
              updatedAt: now,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ userId: ratings.userId });
      if (inserted.length === 0) continue;
      reset += inserted.length;
      const written = new Set(inserted.map((r) => r.userId));
      await db
        .insert(rankHistory)
        .values(
          chunk
            .filter(({ prev }) => written.has(prev.userId))
            .map(({ prev, next }) => {
              const tier = tierForRp(next.rp, next.placementsLeft);
              return {
                userId: prev.userId,
                seasonId,
                queue,
                matchId: softResetMatchId(seasonId),
                placement: 0,
                muBefore: prev.mu,
                muAfter: next.mu,
                sigmaBefore: prev.sigma,
                sigmaAfter: next.sigma,
                rpBefore: prev.rp,
                rpAfter: next.rp,
                tier: tier.tier,
                division: tier.division,
                createdAt: now,
              };
            }),
        )
        // NOTE: the history key is (match, user), so a second queue's reset row
        // for the same player is skipped; the ratings row is what matters.
        .onConflictDoNothing();
    }
  }
  return { seasonId, fromSeasonId: from, reset };
}

const markerKey = (seasonId: string): string => `ranked:season-reset:${seasonId}`;
const inFlight = new WeakMap<object, Map<string, Promise<SoftResetResult | null>>>();

/**
 * Hook for "the active season changed": runs {@link softResetRatings} once per
 * season id. Call it before anything reads or writes current-season ratings
 * (API start-up, ranked result ingestion). Cheap after the first call: a
 * per-process memo, then a KV marker shared by every API instance.
 *
 * @param ctx - Shared services; the active season is `ctx.catalog.season.id`
 *   unless `seasonId` is given.
 * @param seasonId - Season to ensure (e.g. the season a match result names).
 * @returns The reset result, or null when another instance already did it.
 */
export function ensureRankedSeason(
  ctx: AppContext,
  seasonId = ctx.catalog.season.id,
): Promise<SoftResetResult | null> {
  let memo = inFlight.get(ctx.db);
  if (!memo) inFlight.set(ctx.db, (memo = new Map()));
  const existing = memo.get(seasonId);
  if (existing) return existing;
  const run = (async () => {
    if (await ctx.kv.get(markerKey(seasonId))) return null;
    const result = await softResetRatings(ctx.db, seasonId, { now: ctx.now() });
    await ctx.kv.set(markerKey(seasonId), JSON.stringify({ ...result, at: ctx.now().toISOString() }));
    return result;
  })();
  memo.set(seasonId, run);
  // A failed reset must be retried on the next call, not memoised.
  run.catch(() => memo.delete(seasonId));
  return run;
}
