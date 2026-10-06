/**
 * Challenges: daily (3), weekly (6), seasonal (8 per season) and permanent
 * milestones. Deterministic assignment per period, progress from match
 * results, one daily reroll and reward claims.
 *
 * Responsibilities:
 * - Lazily create a player's rows for the current UTC day, ISO week and
 *   season, plus every milestone ({@link ensureChallenges}). The rotating sets
 *   come from content's `pickChallenges`, which every server and client derive
 *   from the period key alone; a reroll swaps one daily row.
 * - Apply per-match metric increments to the active rows.
 * - Claims: XP (player + pass), Gumballs, Gems and a cosmetic, exactly once
 *   per row (the conditional `claimed_at` update is the guard).
 * - Settle challenges of an ended day, week or season: completed but unclaimed
 *   ones pay out automatically, like unclaimed pass tiers (ECONOMY.md §2.1);
 *   unfinished ones simply stop counting.
 *
 * Every boundary is UTC: days and weeks from `util/time.ts`, seasons from the
 * content schedule (always 00:00 UTC on the 1st), so DST never moves a reset.
 */
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { hashString, Rng } from '@tumble/shared';
import type { Catalog, CatalogChallenge, ChallengeMetric, ChallengePeriod } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { challengeProgress } from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { grantCosmetic, readWallet } from '../economy/wallet.ts';
import { ApiError, conflict, notFound } from '../http/errors.ts';
import { dayKey, isoWeekKey, nextIsoWeekStart, nextUtcMidnight } from '../util/time.ts';
import { addXp, type XpResult } from './xp.ts';

/** Active challenges per rotating period. Every milestone is active at once. */
export const CHALLENGE_SLOTS = { daily: 3, weekly: 6, seasonal: 8 } as const;
/** Daily rerolls allowed. */
export const DAILY_REROLLS = 1;
/** `period_key` of milestone rows: they never roll over. */
export const MILESTONE_PERIOD_KEY = 'all';

const PERIODS: readonly ChallengePeriod[] = ['daily', 'weekly', 'seasonal', 'milestone'];

type Row = typeof challengeProgress.$inferSelect;

/**
 * The key of the period live at `now`.
 *
 * @param catalog - Season schedule.
 * @param period - Challenge period.
 * @param now - Server clock.
 * @returns `YYYY-MM-DD`, `YYYY-Www`, a season id or {@link MILESTONE_PERIOD_KEY}.
 */
export function periodKey(catalog: Catalog, period: ChallengePeriod, now: Date): string {
  switch (period) {
    case 'daily':
      return dayKey(now);
    case 'weekly':
      return isoWeekKey(now);
    case 'seasonal':
      return catalog.seasonAt(now).id;
    case 'milestone':
      return MILESTONE_PERIOD_KEY;
  }
}

async function rowsOf(tx: DbOrTx, userId: string, period: ChallengePeriod, key: string): Promise<Row[]> {
  return tx
    .select()
    .from(challengeProgress)
    .where(
      and(
        eq(challengeProgress.userId, userId),
        eq(challengeProgress.period, period),
        eq(challengeProgress.periodKey, key),
      ),
    );
}

/** The definitions a period would start with, each with its slot. */
function initialPicks(
  catalog: Catalog,
  period: ChallengePeriod,
  key: string,
): { def: CatalogChallenge; slot: number }[] {
  if (period === 'milestone') return catalog.milestoneChallenges.map((def, slot) => ({ def, slot }));
  return catalog
    .pickChallenges(period, key)
    .slice(0, CHALLENGE_SLOTS[period])
    .map((def, slot) => ({ def, slot }));
}

/**
 * Ensures the player has rows for the current day, week and season and for
 * every milestone (milestones added to content later are filled in).
 *
 * @param tx - Open transaction.
 * @param catalog - Challenge pools and season schedule.
 * @param userId - Player.
 * @param now - Server clock.
 * @returns Current rows, ordered by period (daily, weekly, seasonal, milestone) then slot.
 */
export async function ensureChallenges(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  now: Date,
): Promise<Row[]> {
  const out: Row[] = [];
  for (const period of PERIODS) {
    const key = periodKey(catalog, period, now);
    let rows = await rowsOf(tx, userId, period, key);
    const have = new Set(rows.map((r) => r.challengeId));
    // Rotating periods are filled once; a rerolled row must not be re-added.
    const missing =
      period === 'milestone' || rows.length === 0
        ? initialPicks(catalog, period, key).filter((p) => !have.has(p.def.id))
        : [];
    if (missing.length) {
      await tx
        .insert(challengeProgress)
        .values(
          missing.map(({ def, slot }) => ({
            userId,
            challengeId: def.id,
            period,
            periodKey: key,
            slot,
            target: def.target,
          })),
        )
        .onConflictDoNothing();
      rows = await rowsOf(tx, userId, period, key);
    }
    out.push(...rows.sort((a, b) => a.slot - b.slot));
  }
  return out;
}

/** A challenge's progress change caused by one match. */
export interface ChallengeUpdate {
  challengeId: string;
  title: string;
  period: ChallengePeriod;
  before: number;
  progress: number;
  target: number;
  completed: boolean;
}

/**
 * Applies per-match metric increments to the player's active challenges.
 *
 * @param tx - Open transaction (the match ingest's).
 * @param catalog - Challenge definitions.
 * @param userId - Player.
 * @param metrics - Increment per metric for this match.
 * @param now - Server clock.
 * @returns Only the challenges whose progress changed.
 */
export async function applyChallengeProgress(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  metrics: Partial<Record<ChallengeMetric, number>>,
  now: Date,
): Promise<ChallengeUpdate[]> {
  const defs = new Map(catalog.challenges.map((c) => [c.id, c]));
  const rows = await ensureChallenges(tx, catalog, userId, now);
  const updates: ChallengeUpdate[] = [];
  for (const row of rows) {
    const def = defs.get(row.challengeId);
    if (!def || row.completedAt) continue;
    const inc = metrics[def.metric] ?? 0;
    if (inc <= 0) continue;
    // Computed in SQL and guarded on the challenge id: a reroll committed since
    // the rows were read swaps the row's challenge, and this show's progress
    // must not land on the new one (nor overwrite a concurrent show's).
    const [after] = await tx
      .update(challengeProgress)
      .set({
        progress: sql`least(${challengeProgress.target}, ${challengeProgress.progress} + ${inc})`,
        completedAt: sql`case when ${challengeProgress.progress} + ${inc} >= ${challengeProgress.target}
          then ${now.toISOString()}::timestamptz else null end`,
      })
      .where(
        and(
          eq(challengeProgress.id, row.id),
          eq(challengeProgress.challengeId, row.challengeId),
          isNull(challengeProgress.completedAt),
        ),
      )
      .returning({ progress: challengeProgress.progress, target: challengeProgress.target });
    if (!after) continue;
    updates.push({
      challengeId: def.id,
      title: def.title,
      period: row.period as ChallengePeriod,
      before: Math.min(row.progress, after.progress),
      progress: after.progress,
      target: after.target,
      completed: after.progress >= after.target,
    });
  }
  return updates;
}

/** What one claim paid. */
export interface ChallengePayout {
  /** Row id. */
  id: string;
  challengeId: string;
  title: string;
  period: ChallengePeriod;
  xp: XpResult;
  gumballs: number;
  gems: number;
  /** Cosmetic granted, or null (none, or already owned). */
  cosmetic: string | null;
}

/** Gems a claim pays: the weekly rate for weekly rows, the definition's own otherwise. */
function gemsFor(catalog: Catalog, period: string, def: CatalogChallenge | undefined): number {
  return period === 'weekly' ? catalog.gemEarn.weeklyChallenge : (def?.rewardGems ?? 0);
}

/**
 * Marks a completed row claimed and pays it. The conditional update makes a
 * concurrent second claim of the same row fail instead of paying twice.
 *
 * @throws {ApiError} 409 `already_claimed`.
 */
async function payClaim(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  row: Row,
  now: Date,
): Promise<ChallengePayout> {
  const claimed = await tx
    .update(challengeProgress)
    .set({ claimedAt: now })
    .where(and(eq(challengeProgress.id, row.id), isNull(challengeProgress.claimedAt)))
    .returning({ id: challengeProgress.id });
  if (!claimed.length) throw conflict('already_claimed', 'Challenge already claimed');
  const def = catalog.challenges.find((c) => c.id === row.challengeId);
  const ref = `challenge:${row.id}`;
  const xp = await addXp(tx, catalog, userId, def?.rewardXp ?? 0);
  const gumballs = def?.rewardGumballs ?? 0;
  if (gumballs > 0)
    await applyLedger(tx, { userId, currency: 'gumballs', delta: gumballs, reason: 'challenge_reward', ref });
  const gems = gemsFor(catalog, row.period, def);
  if (gems > 0)
    await applyLedger(tx, { userId, currency: 'gems', delta: gems, reason: 'challenge_reward', ref });
  const cosmetic =
    def?.rewardCosmetic && (await grantCosmetic(tx, userId, def.rewardCosmetic, 'challenge'))
      ? def.rewardCosmetic
      : null;
  return {
    id: row.id,
    challengeId: row.challengeId,
    title: def?.title ?? row.challengeId,
    period: row.period as ChallengePeriod,
    xp,
    gumballs,
    gems,
    cosmetic,
  };
}

/**
 * Pays every daily, weekly and seasonal challenge completed but never claimed
 * in a period that has ended, like unclaimed pass tiers: finishing a
 * challenge earns it, whether or not the player opened the board before the
 * reset. Idempotent: paid rows are marked claimed.
 *
 * @param tx - Open transaction.
 * @param catalog - Season schedule and definitions.
 * @param userId - Player.
 * @param now - Server clock.
 * @returns One payout per row settled by this call.
 */
export async function settleExpiredChallenges(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  now: Date,
): Promise<ChallengePayout[]> {
  const live = catalog.seasonAt(now);
  const current = { daily: dayKey(now), weekly: isoWeekKey(now) };
  const rows = await tx
    .select()
    .from(challengeProgress)
    .where(
      and(
        eq(challengeProgress.userId, userId),
        ne(challengeProgress.period, 'milestone'),
        isNotNull(challengeProgress.completedAt),
        isNull(challengeProgress.claimedAt),
      ),
    )
    .orderBy(challengeProgress.periodKey, challengeProgress.slot)
    .for('update');
  const out: ChallengePayout[] = [];
  for (const row of rows) {
    // Only periods strictly before the live one: a clock stepping back must
    // not settle a "future" period. `YYYY-MM-DD` and `YYYY-Www` keys sort in
    // time order as strings.
    if (row.period === 'seasonal') {
      const season = catalog.seasonById(row.periodKey);
      if (!season || season.number >= live.number) continue;
    } else if (row.period === 'daily' || row.period === 'weekly') {
      if (row.periodKey >= current[row.period]) continue;
    } else continue;
    out.push(await payClaim(tx, catalog, userId, row, now));
  }
  return out;
}

/**
 * The challenges board: every active row with its reward, refresh times and
 * whatever an ended season just settled.
 *
 * @param tx - Open transaction.
 * @param catalog - Definitions, cosmetics and season schedule.
 * @param userId - Player.
 * @param now - Server clock.
 */
export async function challengesView(tx: DbOrTx, catalog: Catalog, userId: string, now: Date) {
  const settled = await settleExpiredChallenges(tx, catalog, userId, now);
  const rows = await ensureChallenges(tx, catalog, userId, now);
  const defs = new Map(catalog.challenges.map((c) => [c.id, c]));
  const items = new Map(catalog.cosmetics.map((c) => [c.id, c]));
  const view = (r: Row) => {
    const d = defs.get(r.challengeId);
    const item = d?.rewardCosmetic ? items.get(d.rewardCosmetic) : undefined;
    return {
      id: r.id,
      challengeId: r.challengeId,
      title: d?.title ?? r.challengeId,
      metric: d?.metric ?? null,
      slot: r.slot,
      progress: r.progress,
      target: r.target,
      completed: r.completedAt !== null,
      claimed: r.claimedAt !== null,
      reward: {
        xp: d?.rewardXp ?? 0,
        gumballs: d?.rewardGumballs ?? 0,
        gems: gemsFor(catalog, r.period, d),
        cosmetic: item ? { id: item.id, name: item.name, slot: item.slot, rarity: item.rarity } : null,
      },
      rerolled: r.rerolled,
    };
  };
  const of = (period: ChallengePeriod) => rows.filter((r) => r.period === period);
  const daily = of('daily');
  const season = catalog.seasonAt(now);
  return {
    daily: daily.map(view),
    weekly: of('weekly').map(view),
    seasonal: of('seasonal').map(view),
    milestone: of('milestone').map(view),
    rerollsLeft: Math.max(0, DAILY_REROLLS - daily.filter((r) => r.rerolled).length),
    dailyRefreshesAt: nextUtcMidnight(now).toISOString(),
    weeklyRefreshesAt: nextIsoWeekStart(now).toISOString(),
    season: { id: season.id, name: season.name, endsAt: season.endsAt },
    seasonalRefreshesAt: season.endsAt,
    settled: settled.map((p) => ({
      id: p.id,
      challengeId: p.challengeId,
      period: p.period,
      title: p.title,
      xp: p.xp.xpAfter - p.xp.xpBefore,
      gumballs: p.gumballs,
      gems: p.gems,
      cosmetic: p.cosmetic,
    })),
  };
}

/**
 * Replaces an incomplete daily challenge with a different one (once per day).
 *
 * @throws {ApiError} 404, 409 `reroll_used` / `challenge_completed`, 400 for other periods.
 */
export async function rerollChallenge(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  rowId: string,
  now: Date,
) {
  await ensureChallenges(tx, catalog, userId, now);
  // SECURITY: the day's rows are locked before the checks, so two concurrent
  // rerolls serialise and the second sees the first's `rerolled` flag; the
  // match ingest's progress update waits too, instead of being overwritten.
  const daily = await tx
    .select()
    .from(challengeProgress)
    .where(
      and(
        eq(challengeProgress.userId, userId),
        eq(challengeProgress.period, 'daily'),
        eq(challengeProgress.periodKey, periodKey(catalog, 'daily', now)),
      ),
    )
    .orderBy(challengeProgress.slot)
    .for('update');
  const row = daily.find((r) => r.id === rowId);
  if (!row) {
    const [other] = await tx
      .select({ period: challengeProgress.period })
      .from(challengeProgress)
      .where(and(eq(challengeProgress.id, rowId), eq(challengeProgress.userId, userId)));
    if (other) throw new ApiError(400, 'not_rerollable', 'Only daily challenges can be rerolled');
    throw notFound('Challenge');
  }
  if (row.completedAt) throw conflict('challenge_completed', 'Completed challenges cannot be rerolled');
  if (daily.filter((r) => r.rerolled).length >= DAILY_REROLLS)
    throw conflict('reroll_used', 'Daily reroll already used');
  const assigned = new Set(daily.map((r) => r.challengeId));
  const pool = catalog.challenges.filter((c) => c.period === 'daily' && !assigned.has(c.id));
  if (!pool.length) throw conflict('no_alternatives', 'No other daily challenges available');
  const rng = new Rng(hashString(`reroll:${userId}:${row.periodKey}:${row.slot}`));
  const pick = rng.pick(pool);
  const swapped = await tx
    .update(challengeProgress)
    .set({ challengeId: pick.id, target: pick.target, progress: 0, rerolled: true })
    .where(
      and(
        eq(challengeProgress.id, row.id),
        isNull(challengeProgress.completedAt),
        eq(challengeProgress.rerolled, false),
      ),
    )
    .returning({ id: challengeProgress.id });
  if (!swapped.length) throw conflict('reroll_used', 'Daily reroll already used');
  return challengesView(tx, catalog, userId, now);
}

/**
 * Claims a completed challenge: grants its XP (player + pass), Gumballs, Gems
 * and cosmetic once.
 *
 * @throws {ApiError} 404, 409 `not_completed` / `already_claimed`.
 */
export async function claimChallenge(tx: DbOrTx, catalog: Catalog, userId: string, rowId: string, now: Date) {
  const [row] = await tx
    .select()
    .from(challengeProgress)
    .where(and(eq(challengeProgress.id, rowId), eq(challengeProgress.userId, userId)))
    .for('update');
  if (!row) throw notFound('Challenge');
  if (!row.completedAt) throw conflict('not_completed', 'Challenge not completed yet');
  if (row.claimedAt) throw conflict('already_claimed', 'Challenge already claimed');
  const paid = await payClaim(tx, catalog, userId, row, now);
  return {
    id: row.id,
    xp: paid.xp,
    gumballs: paid.gumballs,
    gems: paid.gems,
    cosmetic: paid.cosmetic,
    wallet: await readWallet(tx, userId),
  };
}
