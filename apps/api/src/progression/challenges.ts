/**
 * Daily (3) and weekly (6) challenges: deterministic assignment per period,
 * progress from match results, one daily reroll and reward claims.
 *
 * The initial set for a period comes from content's `pickChallenges`, which
 * every server and client derives from the period key alone; rows are created
 * lazily (GET /challenges or a match ingest) and a reroll swaps one row.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { hashString, Rng } from '@tumble/shared';
import type { Catalog, ChallengeMetric } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { challengeProgress } from '../db/schema.ts';
import { readWallet } from '../economy/wallet.ts';
import { ApiError, conflict, notFound } from '../http/errors.ts';
import { dayKey, isoWeekKey, nextIsoWeekStart, nextUtcMidnight } from '../util/time.ts';
import { addXp, grantReward } from './xp.ts';

/** Challenges per period. */
export const CHALLENGE_SLOTS = { daily: 3, weekly: 6 } as const;
/** Daily rerolls allowed. */
export const DAILY_REROLLS = 1;

type Period = keyof typeof CHALLENGE_SLOTS;
type Row = typeof challengeProgress.$inferSelect;

const periodKey = (period: Period, now: Date): string => (period === 'daily' ? dayKey(now) : isoWeekKey(now));

/**
 * Ensures the player has challenges for the current day and week.
 *
 * @returns Current rows for both periods, ordered by period then slot.
 */
export async function ensureChallenges(tx: DbOrTx, catalog: Catalog, userId: string, now: Date): Promise<Row[]> {
  const out: Row[] = [];
  for (const period of ['daily', 'weekly'] as const) {
    const key = periodKey(period, now);
    let rows = await tx
      .select()
      .from(challengeProgress)
      .where(and(eq(challengeProgress.userId, userId), eq(challengeProgress.period, period), eq(challengeProgress.periodKey, key)));
    if (rows.length === 0) {
      const picks = catalog.pickChallenges(period, key).slice(0, CHALLENGE_SLOTS[period]);
      if (picks.length) {
        await tx
          .insert(challengeProgress)
          .values(picks.map((c, slot) => ({ userId, challengeId: c.id, period, periodKey: key, slot, target: c.target })))
          .onConflictDoNothing();
      }
      rows = await tx
        .select()
        .from(challengeProgress)
        .where(and(eq(challengeProgress.userId, userId), eq(challengeProgress.period, period), eq(challengeProgress.periodKey, key)));
    }
    out.push(...rows.sort((a, b) => a.slot - b.slot));
  }
  return out;
}

/** A challenge's progress change caused by one match. */
export interface ChallengeUpdate {
  challengeId: string;
  title: string;
  period: Period;
  before: number;
  progress: number;
  target: number;
  completed: boolean;
}

/**
 * Applies per-match metric increments to the player's active challenges.
 *
 * @param metrics - Increment per metric for this match.
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
    const progress = Math.min(row.target, row.progress + inc);
    const completed = progress >= row.target;
    await tx
      .update(challengeProgress)
      .set({ progress, ...(completed ? { completedAt: now } : {}) })
      .where(eq(challengeProgress.id, row.id));
    updates.push({ challengeId: def.id, title: def.title, period: row.period as Period, before: row.progress, progress, target: row.target, completed });
  }
  return updates;
}

/** Challenges view with refresh timers. */
export async function challengesView(tx: DbOrTx, catalog: Catalog, userId: string, now: Date) {
  const rows = await ensureChallenges(tx, catalog, userId, now);
  const defs = new Map(catalog.challenges.map((c) => [c.id, c]));
  const view = (r: Row) => {
    const d = defs.get(r.challengeId);
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
      reward: { xp: d?.rewardXp ?? 0, gumballs: d?.rewardGumballs ?? 0 },
      rerolled: r.rerolled,
    };
  };
  const daily = rows.filter((r) => r.period === 'daily');
  return {
    daily: daily.map(view),
    weekly: rows.filter((r) => r.period === 'weekly').map(view),
    rerollsLeft: Math.max(0, DAILY_REROLLS - daily.filter((r) => r.rerolled).length),
    dailyRefreshesAt: nextUtcMidnight(now).toISOString(),
    weeklyRefreshesAt: nextIsoWeekStart(now).toISOString(),
  };
}

/**
 * Replaces an incomplete daily challenge with a different one (once per day).
 *
 * @throws {ApiError} 404, 409 `reroll_used` / `challenge_completed`, 400 for weekly.
 */
export async function rerollChallenge(tx: DbOrTx, catalog: Catalog, userId: string, rowId: string, now: Date) {
  const rows = await ensureChallenges(tx, catalog, userId, now);
  const row = rows.find((r) => r.id === rowId);
  if (!row) throw notFound('Challenge');
  if (row.period !== 'daily') throw new ApiError(400, 'not_rerollable', 'Only daily challenges can be rerolled');
  if (row.completedAt) throw conflict('challenge_completed', 'Completed challenges cannot be rerolled');
  const daily = rows.filter((r) => r.period === 'daily');
  if (daily.filter((r) => r.rerolled).length >= DAILY_REROLLS) throw conflict('reroll_used', 'Daily reroll already used');
  const assigned = new Set(daily.map((r) => r.challengeId));
  const pool = catalog.challenges.filter((c) => c.period === 'daily' && !assigned.has(c.id));
  if (!pool.length) throw conflict('no_alternatives', 'No other daily challenges available');
  const rng = new Rng(hashString(`reroll:${userId}:${row.periodKey}:${row.slot}`));
  const pick = rng.pick(pool);
  await tx
    .update(challengeProgress)
    .set({ challengeId: pick.id, target: pick.target, progress: 0, rerolled: true })
    .where(eq(challengeProgress.id, row.id));
  return challengesView(tx, catalog, userId, now);
}

/**
 * Claims a completed challenge: grants its XP (player + pass) and Gumballs once.
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
  const def = catalog.challenges.find((c) => c.id === row.challengeId);
  const claimed = await tx
    .update(challengeProgress)
    .set({ claimedAt: now })
    .where(and(eq(challengeProgress.id, row.id), isNull(challengeProgress.claimedAt)))
    .returning({ id: challengeProgress.id });
  if (!claimed.length) throw conflict('already_claimed', 'Challenge already claimed');
  const xp = await addXp(tx, catalog, userId, def?.rewardXp ?? 0);
  if (def?.rewardGumballs) {
    await grantReward(tx, userId, { type: 'gumballs', amount: def.rewardGumballs }, 'challenge_reward', `challenge:${row.id}`);
  }
  return { id: row.id, xp, gumballs: def?.rewardGumballs ?? 0, wallet: await readWallet(tx, userId) };
}
