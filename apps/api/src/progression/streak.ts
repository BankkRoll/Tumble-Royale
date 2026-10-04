/**
 * Daily login streak: one claim per UTC day, a 7-day reward ladder that
 * repeats, and a streak that breaks after a missed day.
 *
 * Responsibilities:
 * - The state view ({@link streakView}): today's claim, the streak as it
 *   stands (0 once broken), when it breaks and what the next claim pays.
 * - The claim ({@link claimLoginStreak}). The day always comes from the server
 *   clock; the client sends nothing. Concurrency: the streak row is locked
 *   and then advanced with a conditional update that only matches when today
 *   is not yet claimed, so of two simultaneous claims exactly one pays. The
 *   ledger ref `login:<day>` is a second guard on the currency.
 * - Feeding the `bestLoginStreak` achievement metric.
 *
 * A clock that steps backwards (a claim recorded for a later day than today)
 * is treated as already claimed rather than letting the streak rewind.
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Catalog, CatalogGrant, CatalogLoginDay } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { loginStreaks } from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { readWallet } from '../economy/wallet.ts';
import { conflict } from '../http/errors.ts';
import { dayKey, nextUtcMidnight } from '../util/time.ts';
import { recordAchievementProgress, unlockAchievements, type AchievementUnlock } from './achievements.ts';
import { addXp } from './xp.ts';

const DAY_MS = 86_400_000;

type StreakRow = typeof loginStreaks.$inferSelect;

/**
 * The ladder day for a streak length.
 *
 * @param ladder - The login ladder.
 * @param streak - Consecutive days including the claim (>= 1).
 */
export function ladderDay(ladder: readonly CatalogLoginDay[], streak: number): CatalogLoginDay {
  const n = Math.max(1, Math.floor(streak));
  return ladder[(n - 1) % ladder.length]!;
}

/** Where a row stands relative to `today`. */
function standing(row: Pick<StreakRow, 'current' | 'lastClaimDay'> | undefined, now: Date) {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - DAY_MS));
  const last = row?.lastClaimDay ?? null;
  const claimedToday = last !== null && last >= today;
  // A claim dated after today means the clock stepped back; keep the streak as it was.
  const alive = claimedToday || last === yesterday;
  const current = alive ? (row?.current ?? 0) : 0;
  const next = claimedToday ? current + 1 : last === yesterday ? current + 1 : 1;
  return { today, last, claimedToday, alive, current, next };
}

/**
 * The streak card.
 *
 * @param db - Database or transaction.
 * @param catalog - The login ladder.
 * @param userId - Player.
 * @param now - Server clock.
 */
export async function streakView(db: DbOrTx, catalog: Catalog, userId: string, now: Date) {
  const [row] = await db.select().from(loginStreaks).where(eq(loginStreaks.userId, userId));
  const s = standing(row, now);
  const ladder = catalog.loginLadder;
  const cycle = ladder.length;
  // Claimed today: the cycle ends on the day just claimed. Otherwise it ends
  // the day before the next claim, which is "today".
  const position = s.claimedToday ? ((s.current - 1) % cycle) + 1 : ((s.next - 1) % cycle) + 1;
  const nextDay = ladderDay(ladder, s.next);
  const tomorrow = nextUtcMidnight(now);
  return {
    streak: s.current,
    best: row?.best ?? 0,
    claims: row?.claims ?? 0,
    today: s.today,
    claimedToday: s.claimedToday,
    canClaim: !s.claimedToday,
    /** Start of the next UTC day: when the next claim opens (if claimed) or the streak breaks. */
    nextClaimAt: s.claimedToday ? tomorrow.toISOString() : now.toISOString(),
    /** If today goes unclaimed, the streak is gone at this instant. */
    breaksAt:
      s.alive && s.current > 0 ? (s.claimedToday ? nextUtcMidnight(tomorrow) : tomorrow).toISOString() : null,
    next: { streak: s.next, day: nextDay.day, rewards: nextDay.rewards },
    ladder: ladder.map((d) => ({
      day: d.day,
      rewards: d.rewards,
      state: s.claimedToday
        ? d.day <= position
          ? ('claimed' as const)
          : ('upcoming' as const)
        : d.day < position
          ? ('claimed' as const)
          : d.day === position
            ? ('today' as const)
            : ('upcoming' as const),
    })),
  };
}

/** A login reward as granted. */
export type GrantedLoginReward = CatalogGrant & { granted: boolean };

/** Result of {@link claimLoginStreak}. */
export interface LoginClaim {
  day: string;
  streak: number;
  best: number;
  /** Ladder day 1..7 this claim paid. */
  ladderDay: number;
  rewards: GrantedLoginReward[];
  achievements: AchievementUnlock[];
  level: { before: number; after: number };
  wallet: { gumballs: number; gems: number; crownShards: number };
}

/**
 * Claims today's login reward.
 *
 * @param tx - Open transaction.
 * @param catalog - Ladder, level curve, achievements.
 * @param userId - Player (guests included).
 * @param now - Server clock.
 * @throws {ApiError} 409 `already_claimed` when today (or a later day) was claimed.
 */
export async function claimLoginStreak(
  tx: DbOrTx,
  catalog: Catalog,
  userId: string,
  now: Date,
): Promise<LoginClaim> {
  await tx.insert(loginStreaks).values({ userId }).onConflictDoNothing();
  const [row] = await tx.select().from(loginStreaks).where(eq(loginStreaks.userId, userId)).for('update');
  const s = standing(row, now);
  if (s.claimedToday) throw conflict('already_claimed', "Today's login reward was already claimed");
  const streak = s.next;
  const advanced = await tx
    .update(loginStreaks)
    .set({
      current: streak,
      best: sql`greatest(${loginStreaks.best}, ${streak})`,
      lastClaimDay: s.today,
      claims: sql`${loginStreaks.claims} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(loginStreaks.userId, userId),
        or(isNull(loginStreaks.lastClaimDay), ne(loginStreaks.lastClaimDay, s.today)),
      ),
    )
    .returning({ best: loginStreaks.best });
  if (!advanced.length) throw conflict('already_claimed', "Today's login reward was already claimed");

  const day = ladderDay(catalog.loginLadder, streak);
  const ref = `login:${s.today}`;
  const rewards: GrantedLoginReward[] = [];
  let xp = 0;
  for (const r of day.rewards) {
    if (r.type === 'xp') {
      xp += r.amount;
      rewards.push({ ...r, granted: true });
    } else if (r.type === 'cosmetic') {
      // The content schema keeps cosmetics off the ladder; nothing to grant.
      rewards.push({ ...r, granted: false });
    } else {
      const res = await applyLedger(tx, {
        userId,
        currency: r.type,
        delta: r.amount,
        reason: 'login_reward',
        ref,
      });
      rewards.push({ ...r, granted: res.applied });
    }
  }
  await recordAchievementProgress(tx, catalog, userId, { max: { bestLoginStreak: streak } }, now);
  const unlocked = await unlockAchievements(tx, catalog, userId, now);
  const level = await addXp(tx, catalog, userId, xp + unlocked.xp);
  return {
    day: s.today,
    streak,
    best: advanced[0]!.best,
    ladderDay: day.day,
    rewards,
    achievements: unlocked.unlocks,
    level: { before: level.levelBefore, after: level.levelAfter },
    wallet: await readWallet(tx, userId),
  };
}
