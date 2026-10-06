/**
 * Weekly club goals (docs/design/ECONOMY.md §6).
 *
 * Responsibilities:
 * - {@link recordClubShow}: called by the match ingest, inside its
 *   transaction, for every member who played a granting show. It adds the
 *   member's contribution for the ISO week and advances the club's goals, so
 *   a replayed or duplicate match report (already refused by the `matches`
 *   primary key) can never count twice. Custom lobbies never reach it.
 * - Claims: a member who played at least one show for the club that week may
 *   claim each completed goal once. The reward is XP and Gumballs, paid under
 *   the ledger ref `club:<clubId>:<week>:<goalId>`; `club_reward_claims`,
 *   keyed by player, week and goal, is the guard, which also stops a player
 *   who hops clubs from collecting the same week's goal twice.
 * - Settlement: like seasonal challenges, completed goals of past weeks that
 *   an eligible member never claimed pay out automatically the next time the
 *   member looks at their club. Only the club they are still in settles:
 *   leaving a club forfeits its unclaimed rewards.
 *
 * Weeks are ISO weeks in UTC (`util/time.ts`), the same as weekly challenges.
 */
import { and, asc, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { CLUB_GOALS, clubGoalTarget, clubGoalTitle, type ClubGoal } from '@tumble/shared';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { clubContributions, clubGoalProgress, clubRewardClaims, clubs, profiles } from '../db/schema.ts';
import { applyLedger } from '../economy/ledger.ts';
import { readWallet } from '../economy/wallet.ts';
import { ApiError, conflict, forbidden, notFound } from '../http/errors.ts';
import { addXp } from '../progression/xp.ts';
import { isoWeekKey, nextIsoWeekStart } from '../util/time.ts';
import { requireMembership } from './service.ts';

/** What one member's show adds. */
export interface ClubShowCredit {
  clubId: string;
  userId: string;
  /** Rounds the member qualified from. */
  rounds: number;
  /** 1 when they won the Crown. */
  crowns: number;
}

/** A goal's change from one show (shown on the rewards screen). */
export interface ClubGoalUpdate {
  goalId: string;
  title: string;
  before: number;
  progress: number;
  target: number;
  /** True only for the show that completed it. */
  completed: boolean;
}

/** What one show did for the member's club. */
export interface ClubShowUpdate {
  clubId: string;
  name: string;
  tag: string;
  goals: ClubGoalUpdate[];
}

const amountFor = (goal: ClubGoal, c: ClubShowCredit): number =>
  goal.metric === 'shows' ? 1 : goal.metric === 'rounds' ? c.rounds : c.crowns;

/**
 * Credits one member's show to their club's week.
 *
 * @param tx - The match ingest's transaction.
 * @param credit - Club, member and what they did.
 * @param now - Server clock (picks the week).
 * @returns The club's goal changes, or null when the club is gone.
 */
export async function recordClubShow(
  tx: DbOrTx,
  credit: ClubShowCredit,
  now: Date,
): Promise<ClubShowUpdate | null> {
  const [club] = await tx
    .select({ id: clubs.id, name: clubs.name, tag: clubs.tag, memberCount: clubs.memberCount })
    .from(clubs)
    .where(and(eq(clubs.id, credit.clubId), sql`${clubs.disbandedAt} is null`));
  if (!club) return null;
  const week = isoWeekKey(now);
  await tx
    .insert(clubContributions)
    .values({
      clubId: club.id,
      week,
      userId: credit.userId,
      shows: 1,
      rounds: credit.rounds,
      crowns: credit.crowns,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [clubContributions.clubId, clubContributions.week, clubContributions.userId],
      set: {
        shows: sql`${clubContributions.shows} + 1`,
        rounds: sql`${clubContributions.rounds} + ${credit.rounds}`,
        crowns: sql`${clubContributions.crowns} + ${credit.crowns}`,
        updatedAt: now,
      },
    });
  await tx.update(clubs).set({ lastActivityAt: now }).where(eq(clubs.id, club.id));
  const goals: ClubGoalUpdate[] = [];
  for (const goal of CLUB_GOALS) {
    await tx
      .insert(clubGoalProgress)
      .values({ clubId: club.id, week, goalId: goal.id, target: clubGoalTarget(goal, club.memberCount) })
      .onConflictDoNothing();
    const inc = amountFor(goal, credit);
    if (inc <= 0) continue;
    const key = and(
      eq(clubGoalProgress.clubId, club.id),
      eq(clubGoalProgress.week, week),
      eq(clubGoalProgress.goalId, goal.id),
    );
    // Locked: members of one club finish shows concurrently.
    const [row] = await tx.select().from(clubGoalProgress).where(key).for('update');
    if (!row || row.completedAt) continue;
    const progress = Math.min(row.target, row.progress + inc);
    const completed = progress >= row.target;
    await tx
      .update(clubGoalProgress)
      .set({ progress, ...(completed ? { completedAt: now } : {}) })
      .where(key);
    goals.push({
      goalId: goal.id,
      title: clubGoalTitle(goal, row.target),
      before: row.progress,
      progress,
      target: row.target,
      completed,
    });
  }
  return { clubId: club.id, name: club.name, tag: club.tag, goals };
}

/** What one claim paid. */
export interface ClubGoalPayout {
  clubId: string;
  week: string;
  goalId: string;
  title: string;
  xp: number;
  gumballs: number;
  auto: boolean;
}

/**
 * Pays one completed goal to an eligible member, once.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services (catalog).
 * @param userId - Member.
 * @param clubId - Their current club.
 * @param week - ISO week of the goal.
 * @param goalId - Goal.
 * @param now - Server clock.
 * @param auto - Paid by settlement rather than a claim.
 * @throws {ApiError} 404 unknown goal, 409 `not_completed` / `already_claimed`, 403 `not_eligible`.
 */
async function payGoal(
  tx: DbOrTx,
  ctx: AppContext,
  userId: string,
  clubId: string,
  week: string,
  goalId: string,
  now: Date,
  auto: boolean,
): Promise<ClubGoalPayout> {
  const goal = CLUB_GOALS.find((g) => g.id === goalId);
  if (!goal) throw notFound('Club goal');
  const [row] = await tx
    .select()
    .from(clubGoalProgress)
    .where(
      and(
        eq(clubGoalProgress.clubId, clubId),
        eq(clubGoalProgress.week, week),
        eq(clubGoalProgress.goalId, goalId),
      ),
    );
  if (!row?.completedAt) throw conflict('not_completed', 'Your club has not finished that goal yet');
  const [mine] = await tx
    .select({ shows: clubContributions.shows })
    .from(clubContributions)
    .where(
      and(
        eq(clubContributions.clubId, clubId),
        eq(clubContributions.week, week),
        eq(clubContributions.userId, userId),
      ),
    );
  if (!mine || mine.shows < 1)
    throw forbidden('not_eligible', 'Play at least one show with the club that week to earn its rewards');
  const claimed = await tx
    .insert(clubRewardClaims)
    .values({ userId, week, goalId, clubId, claimedAt: now, auto })
    .onConflictDoNothing()
    .returning({ goalId: clubRewardClaims.goalId });
  if (claimed.length === 0) throw conflict('already_claimed', 'You already collected that goal this week');
  await addXp(tx, ctx.catalog, userId, goal.rewardXp);
  if (goal.rewardGumballs > 0)
    await applyLedger(tx, {
      userId,
      currency: 'gumballs',
      delta: goal.rewardGumballs,
      reason: 'club_reward',
      ref: `club:${clubId}:${week}:${goalId}`,
    });
  return {
    clubId,
    week,
    goalId,
    title: clubGoalTitle(goal, row.target),
    xp: goal.rewardXp,
    gumballs: goal.rewardGumballs,
    auto,
  };
}

/**
 * Claims a completed goal of the caller's club.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services.
 * @param userId - Member.
 * @param week - ISO week (`YYYY-Www`), current or past.
 * @param goalId - Goal.
 * @returns What was paid and the new wallet.
 */
export async function claimClubGoal(
  tx: DbOrTx,
  ctx: AppContext,
  userId: string,
  week: string,
  goalId: string,
) {
  const m = await requireMembership(tx, userId);
  const now = ctx.now();
  if (week > isoWeekKey(now)) throw notFound('Club goal');
  const payout = await payGoal(tx, ctx, userId, m.clubId, week, goalId, now, false);
  return { payout, wallet: await readWallet(tx, userId) };
}

/**
 * Pays every completed goal of past weeks that the member earned with their
 * current club and never claimed. Idempotent through the claim table.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services.
 * @param userId - Member.
 * @returns One payout per goal settled now.
 */
export async function settleClubWeeks(
  tx: DbOrTx,
  ctx: AppContext,
  userId: string,
): Promise<ClubGoalPayout[]> {
  const m = await requireMembership(tx, userId);
  const now = ctx.now();
  const due = await tx
    .select({ week: clubGoalProgress.week, goalId: clubGoalProgress.goalId })
    .from(clubGoalProgress)
    .innerJoin(
      clubContributions,
      and(
        eq(clubContributions.clubId, clubGoalProgress.clubId),
        eq(clubContributions.week, clubGoalProgress.week),
        eq(clubContributions.userId, userId),
      ),
    )
    .where(
      and(
        eq(clubGoalProgress.clubId, m.clubId),
        lt(clubGoalProgress.week, isoWeekKey(now)),
        isNotNull(clubGoalProgress.completedAt),
        sql`${clubContributions.shows} >= 1`,
        sql`not exists (select 1 from ${clubRewardClaims} where ${clubRewardClaims.userId} = ${userId}
              and ${clubRewardClaims.week} = ${clubGoalProgress.week}
              and ${clubRewardClaims.goalId} = ${clubGoalProgress.goalId})`,
      ),
    )
    .orderBy(asc(clubGoalProgress.week));
  const out: ClubGoalPayout[] = [];
  for (const d of due) {
    try {
      out.push(await payGoal(tx, ctx, userId, m.clubId, d.week, d.goalId, now, true));
    } catch (err) {
      // A concurrent view settled it first; nothing was written for this goal.
      if (!(err instanceof ApiError && err.code === 'already_claimed')) throw err;
    }
  }
  return out;
}

/**
 * The club's goals for this week, the member's standing and the
 * contribution leaderboard, after settling past weeks.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services.
 * @param userId - Member.
 */
export async function clubGoalsView(tx: DbOrTx, ctx: AppContext, userId: string) {
  const settled = await settleClubWeeks(tx, ctx, userId);
  const m = await requireMembership(tx, userId);
  const now = ctx.now();
  const week = isoWeekKey(now);
  const [club] = await tx
    .select({ memberCount: clubs.memberCount })
    .from(clubs)
    .where(eq(clubs.id, m.clubId));
  const rows = await tx
    .select()
    .from(clubGoalProgress)
    .where(and(eq(clubGoalProgress.clubId, m.clubId), eq(clubGoalProgress.week, week)));
  const claims = await tx
    .select({ goalId: clubRewardClaims.goalId })
    .from(clubRewardClaims)
    .where(and(eq(clubRewardClaims.userId, userId), eq(clubRewardClaims.week, week)));
  const board = await tx
    .select({
      userId: clubContributions.userId,
      shows: clubContributions.shows,
      rounds: clubContributions.rounds,
      crowns: clubContributions.crowns,
      displayName: profiles.displayName,
      tag: profiles.tag,
    })
    .from(clubContributions)
    .innerJoin(profiles, eq(profiles.userId, clubContributions.userId))
    .where(and(eq(clubContributions.clubId, m.clubId), eq(clubContributions.week, week)))
    .orderBy(desc(clubContributions.shows), desc(clubContributions.crowns), desc(clubContributions.rounds))
    .limit(50);
  const me = board.find((b) => b.userId === userId);
  const eligible = (me?.shows ?? 0) >= 1;
  return {
    week,
    refreshesAt: nextIsoWeekStart(now).toISOString(),
    eligible,
    goals: CLUB_GOALS.map((g) => {
      const row = rows.find((r) => r.goalId === g.id);
      const target = row?.target ?? clubGoalTarget(g, club?.memberCount ?? 1);
      return {
        goalId: g.id,
        title: clubGoalTitle(g, target),
        progress: row?.progress ?? 0,
        target,
        completed: Boolean(row?.completedAt),
        claimed: claims.some((c) => c.goalId === g.id),
        reward: { xp: g.rewardXp, gumballs: g.rewardGumballs },
      };
    }),
    contributions: board,
    settled,
  };
}
