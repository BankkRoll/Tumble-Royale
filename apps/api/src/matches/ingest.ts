/**
 * Match result ingestion: the only place gameplay turns into progression.
 *
 * Idempotency: the `matches` row (primary key = game-server match id) is
 * inserted first inside the transaction. A retry finds it and replays the
 * stored reward summaries; a concurrent duplicate blocks on the primary key,
 * fails with a unique violation after the first commits, and also replays.
 * Ledger rows are additionally keyed by match id as a second line of defence.
 * Achievement, challenge and event progress are written in the same
 * transaction, so they inherit this: a duplicate report never counts twice.
 *
 * Limited-time events count a show by its start, the game server's
 * `startedAt` (capped at the API clock, since a show cannot have started in
 * the future): a show that straddles an event's end still counts, one that
 * started after it does not, however late its result arrives.
 *
 * Custom lobbies are recorded (history, stats) but grant nothing, so private
 * lobbies cannot be used to farm rewards, rank or club goals.
 *
 * Club goals count a member's show for the club they are in when the result
 * is ingested, in the same transaction, so they are idempotent like the rest.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ChallengeMetric } from '../catalog.ts';
import { recordClubShow, type ClubShowUpdate } from '../clubs/goals.ts';
import { notifyClub } from '../clubs/service.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import {
  clubMembers,
  matches,
  matchParticipants,
  matchRounds,
  playerRoundStats,
  playerStats,
  profiles,
  rankHistory,
  ratings,
  roundResults,
  users,
} from '../db/schema.ts';
import { applyLedger, type Wallet } from '../economy/ledger.ts';
import { readWallet } from '../economy/wallet.ts';
import { recordEventShow, type EventShowUpdate } from '../events/progress.ts';
import { countingEvents } from '../events/state.ts';
import { badRequest, isUniqueViolation } from '../http/errors.ts';
import {
  displayTier,
  RANKED_QUEUE,
  recordLeaderboards,
  type BoardType,
  type LeaderboardUpdate,
} from '../leaderboards/service.ts';
import { DELETED_PLAYER_NAME } from '../accounts/erase.ts';
import { serverFlag } from '../liveops/state.ts';
import {
  notifyUnlocks,
  recordAchievementProgress,
  unlockAchievements,
  type AchievementUnlock,
} from '../progression/achievements.ts';
import { applyChallengeProgress, type ChallengeUpdate } from '../progression/challenges.ts';
import { addXp } from '../progression/xp.ts';
import { computeRankedUpdate, type RankedPrior } from '../ranked/rating.ts';
import { ensureRankedSeason } from '../ranked/season.ts';
import { tierLabel, type TierInfo } from '../ranked/tiers.ts';
import { dayKey } from '../util/time.ts';
import type { MatchResult } from './schema.ts';

/** One labelled line on the rewards screen. */
export interface RewardLine {
  label: string;
  amount: number;
}

/** Per-player reward summary, forwarded by the game server to the client. */
export interface PlayerRewardSummary {
  userId: string;
  participantKey: string;
  placement: number;
  crowned: boolean;
  roundsQualified: number;
  xp: { total: number; lines: RewardLine[] };
  level: { before: number; after: number };
  gumballs: { total: number; lines: RewardLine[] };
  /** Free Gems earned this show (first Crown of the day, level milestones). Absent on older stored results. */
  gems?: { total: number; lines: RewardLine[] };
  crownShards: number;
  /** Crowns created by converting Crown Shards this show. */
  crownsFromShards: number;
  pass: { xp: number; tierBefore: number; tierAfter: number };
  challenges: ChallengeUpdate[];
  /**
   * Achievements this show unlocked; their XP, Gumballs and Gems are already
   * in the lines above. Absent on older stored results.
   */
  achievements?: AchievementUnlock[];
  /** Limited-time events this show counted toward. Absent on older stored results. */
  events?: EventShowUpdate[];
  /** The player's club and its weekly goals this show moved. Absent outside a club. */
  club?: ClubShowUpdate;
  ranked: {
    rpBefore: number;
    rpAfter: number;
    rpDelta: number;
    tierBefore: TierInfo;
    tierAfter: TierInfo;
    label: string;
    placementsLeft: number;
  } | null;
  wallet: Wallet;
}

/** Response of `/internal/match-results`. */
export interface IngestResult {
  matchId: string;
  /** True when this match was already ingested and the stored summaries are replayed. */
  alreadyProcessed: boolean;
  rewards: PlayerRewardSummary[];
}

/**
 * Cross-field validation the schema cannot express.
 *
 * @throws {ApiError} 400 `inconsistent_result`.
 */
function checkConsistency(m: MatchResult): void {
  const fail = (msg: string) => {
    throw badRequest('inconsistent_result', msg);
  };
  const keys = new Set<string>();
  const userIds = new Set<string>();
  for (const p of m.participants) {
    if (keys.has(p.key)) fail(`duplicate participant key ${p.key}`);
    keys.add(p.key);
    if (p.isBot && p.userId) fail(`bot ${p.key} has a userId`);
    if (!p.isBot && !p.userId) fail(`human ${p.key} has no userId`);
    if (p.userId) {
      if (userIds.has(p.userId)) fail(`user ${p.userId} appears twice`);
      userIds.add(p.userId);
    }
  }
  const placed = new Set<string>();
  for (const pl of m.placements) {
    if (!keys.has(pl.key)) fail(`placement for unknown key ${pl.key}`);
    if (placed.has(pl.key)) fail(`duplicate placement for ${pl.key}`);
    placed.add(pl.key);
    if (pl.crowned && pl.placement !== 1) fail(`crowned participant ${pl.key} is not placement 1`);
  }
  if (placed.size !== keys.size) fail('every participant needs a placement');
  for (const r of m.rounds) {
    const seen = new Set<string>();
    for (const res of r.results) {
      if (!keys.has(res.key)) fail(`round ${r.roundId} references unknown key ${res.key}`);
      if (seen.has(res.key)) fail(`round ${r.roundId} lists ${res.key} twice`);
      seen.add(res.key);
    }
  }
  const start = Date.parse(m.startedAt);
  const end = Date.parse(m.endedAt);
  if (end < start || end - start > 3 * 3_600_000) fail('implausible match duration');
}

const QUALIFY_METRIC: Record<string, ChallengeMetric | undefined> = {
  race: 'racesQualified',
  survival: 'survivalsQualified',
  team: 'teamRoundsWon',
  hunt: 'huntRoundsQualified',
  logic: 'logicRoundsQualified',
};

/**
 * What still has to happen outside the transaction once a show committed:
 * leaderboard writes and player notifications. Kept in KV until done, so a
 * failure (KV hiccup, crash) is finished by the game server's retry, which
 * replays the stored result and runs whatever is left.
 */
interface PendingEffects {
  seasonId: string;
  /** The show's end, which picks its weekly board. */
  endedAt: string;
  leaderboards: LeaderboardUpdate[];
  notified: boolean;
}

/** Boards a Crown moves (the streak only ever grows on a win). */
const CROWN_BOARDS: readonly BoardType[] = ['crowns', 'crowns_weekly', 'crowns_all_time', 'win_streak'];

/** Long enough for the game server's outbox to retry; leaderboards also rebuild on their own. */
const PENDING_TTL_MS = 86_400_000;
const pendingKey = (matchId: string): string => `match:effects:${matchId}`;

async function replayStored(ctx: AppContext, matchId: string): Promise<IngestResult | null> {
  const [row] = await ctx.db
    .select({ rewards: matches.rewards })
    .from(matches)
    .where(eq(matches.id, matchId));
  if (!row) return null;
  const result = { matchId, alreadyProcessed: true, rewards: row.rewards as PlayerRewardSummary[] };
  const raw = await ctx.kv.get(pendingKey(matchId)).catch(() => null);
  if (raw) await finishEffects(ctx, result, JSON.parse(raw) as PendingEffects);
  return result;
}

/**
 * Runs the pending effects of a committed show. Each leaderboard write and
 * each notification is attempted on its own; leaderboard writes that fail
 * stay pending for the next replay (they are idempotent), notifications are
 * sent at most once.
 */
async function finishEffects(ctx: AppContext, result: IngestResult, pending: PendingEffects): Promise<void> {
  const failed: LeaderboardUpdate[] = [];
  for (const u of pending.leaderboards) {
    try {
      await recordLeaderboards(ctx, u, { seasonId: pending.seasonId, at: new Date(pending.endedAt) });
    } catch {
      failed.push(u);
    }
  }
  if (!pending.notified) await notifyShow(ctx, result);
  await (
    failed.length
      ? ctx.kv.set(
          pendingKey(result.matchId),
          JSON.stringify({ ...pending, leaderboards: failed, notified: true }),
          PENDING_TTL_MS,
        )
      : ctx.kv.del(pendingKey(result.matchId))
  ).catch(() => undefined);
}

/** Best effort: one failed delivery must not stop the rest. */
async function quietly(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch {
    // Realtime delivery is best effort; the player sees it all on next load.
  }
}

async function notifyShow(ctx: AppContext, result: IngestResult): Promise<void> {
  const clubGoalsDone = new Map<string, string[]>();
  for (const r of result.rewards)
    for (const g of r.club?.goals ?? [])
      if (g.completed)
        clubGoalsDone.set(r.club!.clubId, [...(clubGoalsDone.get(r.club!.clubId) ?? []), g.title]);
  for (const [clubId, titles] of clubGoalsDone) {
    for (const title of titles)
      await quietly(() =>
        notifyClub(ctx, clubId, {
          type: 'notification',
          kind: 'reward',
          title: 'Club goal complete!',
          body: title,
        }),
      );
    await quietly(() => notifyClub(ctx, clubId, { type: 'club_update', clubId }));
  }
  for (const r of result.rewards) {
    const notify = (event: Parameters<typeof ctx.notifier.notifyUser>[1]) =>
      quietly(() => ctx.notifier.notifyUser(r.userId, event));
    await notify({ type: 'wallet', ...r.wallet });
    for (const g of r.gems?.lines ?? [])
      await notify({ type: 'notification', kind: 'reward', title: `+${g.amount} Gems`, body: g.label });
    for (const c of r.challenges.filter((x) => x.completed))
      await notify({ type: 'notification', kind: 'reward', title: 'Challenge complete!', body: c.title });
    for (const e of r.events ?? []) {
      for (const c of e.challenges.filter((x) => x.completed))
        await notify({
          type: 'notification',
          kind: 'reward',
          title: 'Event challenge complete!',
          body: `${e.name}: ${c.title}`,
        });
      if (e.tierAfter > e.tierBefore)
        await notify({
          type: 'notification',
          kind: 'reward',
          title: `${e.name} reward unlocked`,
          body: `Tier ${e.tierAfter} is ready to claim.`,
        });
    }
    await quietly(() => notifyUnlocks(ctx, r.userId, r.achievements ?? []));
  }
}

/**
 * Promotes Champions in their region's top of the season board to Crown
 * League on the rewards screen, once the show's own RP is on the board, and
 * stores the label so a replay shows the same.
 */
async function crownLeagueTiers(
  ctx: AppContext,
  result: IngestResult,
  seasonId: string,
  regionOf: ReadonlyMap<string, string>,
): Promise<void> {
  let changed = false;
  for (const r of result.rewards) {
    if (!r.ranked || r.ranked.tierAfter.tier !== 'champion') continue;
    const tier = await displayTier(ctx, ctx.kv, {
      userId: r.userId,
      region: regionOf.get(r.userId) ?? 'na',
      rp: r.ranked.rpAfter,
      placementsLeft: r.ranked.placementsLeft,
      seasonId,
    });
    if (tier.tier === r.ranked.tierAfter.tier) continue;
    r.ranked = { ...r.ranked, tierAfter: tier, label: tierLabel(tier) };
    changed = true;
  }
  if (changed)
    await ctx.db.update(matches).set({ rewards: result.rewards }).where(eq(matches.id, result.matchId));
}

/**
 * Ingests a verified show summary.
 *
 * @param ctx - Shared services.
 * @param m - Schema-validated payload (signature already checked by the route).
 */
export async function ingestMatch(ctx: AppContext, m: MatchResult): Promise<IngestResult> {
  checkConsistency(m);
  const stored = await replayStored(ctx, m.matchId);
  if (stored) return stored;

  const seasonId = m.seasonId ?? ctx.catalog.season.id;
  // Only the live season is ever seeded: a late result for an old season must
  // not "reset" that season from the newer one.
  if (m.queue === 'ranked' && seasonId === ctx.catalog.season.id) await ensureRankedSeason(ctx, seasonId);
  const now = ctx.now();
  const grants = m.queue !== 'custom';
  const liveEvents = grants
    ? await countingEvents(ctx, Math.min(Date.parse(m.startedAt), now.getTime()))
    : [];
  const clubsOn = grants && (await serverFlag(ctx, 'clubs.enabled'));
  let pending: PendingEffects | null = null;
  let regions = new Map<string, string>();

  let result: IngestResult;
  try {
    result = await ctx.db.transaction(async (tx) => {
      await tx.insert(matches).values({
        id: m.matchId,
        queue: m.queue,
        playlistId: m.playlistId,
        seasonId,
        region: m.region,
        playerCount: m.participants.length,
        botCount: m.participants.filter((p) => p.isBot).length,
        startedAt: new Date(m.startedAt),
        endedAt: new Date(m.endedAt),
        rewards: [],
      });

      // Unknown user ids (deleted accounts, forged slots) are kept as anonymous history only.
      const claimed = m.participants.flatMap((p) => (p.userId ? [p.userId] : []));
      const known = claimed.length
        ? await tx
            .select({ id: users.id, region: users.region })
            .from(users)
            .where(inArray(users.id, claimed))
        : [];
      const regionOf = new Map(known.map((k) => [k.id, k.region]));
      regions = regionOf;

      const placementOf = new Map(m.placements.map((p) => [p.key, p]));
      const qualifiedRounds = new Map<string, number>();
      for (const r of m.rounds)
        for (const res of r.results)
          if (res.qualified) qualifiedRounds.set(res.key, (qualifiedRounds.get(res.key) ?? 0) + 1);

      await tx.insert(matchParticipants).values(
        m.participants.map((p) => ({
          matchId: m.matchId,
          participantKey: p.key,
          userId: p.userId && regionOf.has(p.userId) ? p.userId : null,
          isBot: p.isBot,
          // A result arriving after the account was deleted must not bring its name back.
          name: p.userId && !regionOf.has(p.userId) ? DELETED_PLAYER_NAME : p.name,
          team: p.team ?? null,
          placement: placementOf.get(p.key)!.placement,
          crowned: placementOf.get(p.key)!.crowned,
          roundsSurvived: qualifiedRounds.get(p.key) ?? 0,
        })),
      );
      await tx.insert(matchRounds).values(
        m.rounds.map((r, i) => ({
          matchId: m.matchId,
          roundIndex: i,
          roundId: r.roundId,
          roundType: r.roundType,
          durationMs: r.durationMs,
        })),
      );
      const resultRows = m.rounds.flatMap((r, i) =>
        r.results.map((res) => ({
          matchId: m.matchId,
          roundIndex: i,
          participantKey: res.key,
          qualified: res.qualified,
          position: res.position ?? null,
          score: res.score ?? null,
          timeMs: res.timeMs ?? null,
        })),
      );
      if (resultRows.length) await tx.insert(roundResults).values(resultRows);

      const humans = m.participants.filter((p) => !p.isBot && p.userId && regionOf.has(p.userId));
      const ranked =
        grants && m.queue === 'ranked'
          ? await rateLobby(tx, m, seasonId, regionOf, now)
          : new Map<string, RankedRow>();
      const rewards: PlayerRewardSummary[] = [];
      const leaderboardUpdates: LeaderboardUpdate[] = [];
      const humanIds = humans.map((h) => h.userId!);
      const clubOf = new Map(
        clubsOn && humanIds.length
          ? (
              await tx
                .select({ userId: clubMembers.userId, clubId: clubMembers.clubId })
                .from(clubMembers)
                .where(inArray(clubMembers.userId, humanIds))
            ).map((r) => [r.userId, r.clubId])
          : [],
      );

      for (const p of humans) {
        const userId = p.userId!;
        const pl = placementOf.get(p.key)!;
        const played = m.rounds.filter((r) => r.results.some((x) => x.key === p.key));
        const qualified = qualifiedRounds.get(p.key) ?? 0;
        const reachedFinal = m.rounds.some(
          (r) => r.roundType === 'final' && r.results.some((x) => x.key === p.key),
        );
        const [stats] = await tx
          .select()
          .from(playerStats)
          .where(eq(playerStats.userId, userId))
          .for('update');
        const firstOfDay = stats?.lastShowDay !== dayKey(now);
        const nonFinalQualified = played.filter(
          (r) => r.roundType !== 'final' && r.results.find((x) => x.key === p.key)?.qualified,
        ).length;
        const payout = grants
          ? ctx.catalog.showRewards({
              roundsPlayed: played.length,
              roundsQualified: nonFinalQualified,
              reachedFinal,
              wonCrown: pl.crowned,
              place: pl.placement,
              participants: m.participants.length,
              quit: p.quit === true,
              firstShowOfDay: firstOfDay,
            })
          : { lines: [], xp: 0, gumballs: 0, crownShards: 0 };
        const xpLines: RewardLine[] = payout.lines
          .filter((l) => l.xp > 0)
          .map((l) => ({ label: l.label, amount: l.xp }));
        const gbLines: RewardLine[] = payout.lines
          .filter((l) => l.gumballs > 0)
          .map((l) => ({ label: l.label, amount: l.gumballs }));
        const won = grants && pl.crowned;
        const prevStreak = stats?.currentWinStreak ?? 0;
        const streak = grants ? (won ? prevStreak + 1 : 0) : prevStreak;
        const bestStreak = Math.max(stats?.bestWinStreak ?? 0, streak);
        const qualifiedByType = new Map<string, number>();
        for (const r of played)
          if (r.results.find((x) => x.key === p.key)?.qualified)
            qualifiedByType.set(r.roundType, (qualifiedByType.get(r.roundType) ?? 0) + 1);

        // Before the match's own ledger grants, so Crown Shards from an
        // unlock join this show's shard-to-Crown conversion below.
        let achievements: AchievementUnlock[] = [];
        if (grants) {
          await recordAchievementProgress(
            tx,
            ctx.catalog,
            userId,
            {
              add: {
                showsPlayed: 1,
                crowns: pl.crowned ? 1 : 0,
                runnerUps: pl.placement === 2 && !pl.crowned ? 1 : 0,
                roundsQualified: qualified,
                racesQualified: qualifiedByType.get('race') ?? 0,
                survivalsQualified: qualifiedByType.get('survival') ?? 0,
                teamRoundsWon: qualifiedByType.get('team') ?? 0,
                huntRoundsQualified: qualifiedByType.get('hunt') ?? 0,
                logicRoundsQualified: qualifiedByType.get('logic') ?? 0,
                finalsReached: reachedFinal ? 1 : 0,
                grabs: p.stats?.grabs ?? 0,
                emotes: p.stats?.emotes ?? 0,
                partyShows: p.party ? 1 : 0,
              },
              max: { bestWinStreak: streak, mostGrabsInShow: p.stats?.grabs ?? 0 },
            },
            now,
          );
          const unlocked = await unlockAchievements(tx, ctx.catalog, userId, now);
          achievements = unlocked.unlocks;
        }
        const achievementLines = (type: 'xp' | 'gumballs' | 'gems'): RewardLine[] =>
          achievements.flatMap((a) =>
            a.rewards.flatMap((r) =>
              r.type === type && r.granted ? [{ label: `Achievement: ${a.title}`, amount: r.amount }] : [],
            ),
          );
        xpLines.push(...achievementLines('xp'));
        const xpTotal = payout.xp + achievementLines('xp').reduce((s, l) => s + l.amount, 0);
        let gbTotal = payout.gumballs;
        const shards = payout.crownShards;
        const ref = `match:${m.matchId}`;
        await applyLedger(tx, { userId, currency: 'gumballs', delta: gbTotal, reason: 'match_reward', ref });
        // Paid under their own `achievement:<id>` ledger refs; listed here for the rewards screen.
        for (const l of achievementLines('gumballs')) {
          gbLines.push(l);
          gbTotal += l.amount;
        }
        const shardBalance = (
          await applyLedger(tx, {
            userId,
            currency: 'crown_shards',
            delta: shards,
            reason: 'match_reward',
            ref,
          })
        ).balance;
        // Every full set of shards becomes a Crown (counted in the Crown total, not as a win).
        let crownsFromShards = 0;
        for (
          let left = shardBalance;
          left >= ctx.catalog.shardsPerCrown;
          left -= ctx.catalog.shardsPerCrown
        ) {
          crownsFromShards++;
          await applyLedger(tx, {
            userId,
            currency: 'crown_shards',
            delta: -ctx.catalog.shardsPerCrown,
            reason: 'shard_conversion',
            ref: `${ref}:${crownsFromShards}`,
          });
        }
        const xp = await addXp(tx, ctx.catalog, userId, xpTotal);
        if (xp.levelGumballs) {
          gbLines.push({ label: `Level up → ${xp.levelAfter}`, amount: xp.levelGumballs });
          gbTotal += xp.levelGumballs;
        }
        const gemLines: RewardLine[] = achievementLines('gems');
        if (xp.levelGems) gemLines.push({ label: `Level ${xp.levelAfter} milestone`, amount: xp.levelGems });
        const crownGems = ctx.catalog.gemEarn.firstCrownOfDay;
        if (grants && pl.crowned && crownGems > 0) {
          // Keyed by UTC day, so only the day's first Crown pays (the ledger rejects the rest).
          const g = await applyLedger(tx, {
            userId,
            currency: 'gems',
            delta: crownGems,
            reason: 'daily_crown',
            ref: `day:${dayKey(now)}`,
          });
          if (g.applied) gemLines.push({ label: 'First Crown of the day', amount: crownGems });
        }
        const crownsGained = (grants && pl.crowned ? 1 : 0) + crownsFromShards;
        if (crownsGained) {
          await tx
            .update(profiles)
            .set({ crowns: sql`${profiles.crowns} + ${crownsGained}` })
            .where(eq(profiles.userId, userId));
        }

        await tx
          .update(playerStats)
          .set({
            showsPlayed: sql`${playerStats.showsPlayed} + 1`,
            wins: sql`${playerStats.wins} + ${won ? 1 : 0}`,
            finals: sql`${playerStats.finals} + ${reachedFinal ? 1 : 0}`,
            roundsPlayed: sql`${playerStats.roundsPlayed} + ${played.length}`,
            roundsQualified: sql`${playerStats.roundsQualified} + ${qualified}`,
            currentWinStreak: streak,
            bestWinStreak: bestStreak,
            // A custom lobby pays nothing, so it must not use up the first-show bonus either.
            ...(grants ? { lastShowDay: dayKey(now) } : {}),
            updatedAt: now,
          })
          .where(eq(playerStats.userId, userId));
        for (const r of played) {
          const res = r.results.find((x) => x.key === p.key)!;
          await tx
            .insert(playerRoundStats)
            .values({
              userId,
              roundId: r.roundId,
              played: 1,
              qualified: res.qualified ? 1 : 0,
              bestTimeMs: res.qualified ? (res.timeMs ?? null) : null,
            })
            .onConflictDoUpdate({
              target: [playerRoundStats.userId, playerRoundStats.roundId],
              set: {
                played: sql`${playerRoundStats.played} + 1`,
                qualified: sql`${playerRoundStats.qualified} + ${res.qualified ? 1 : 0}`,
                bestTimeMs:
                  res.qualified && res.timeMs != null
                    ? sql`least(coalesce(${playerRoundStats.bestTimeMs}, ${res.timeMs}), ${res.timeMs})`
                    : sql`${playerRoundStats.bestTimeMs}`,
              },
            });
        }

        let challenges: ChallengeUpdate[] = [];
        if (grants) {
          const metrics: Partial<Record<ChallengeMetric, number>> = {
            ...p.stats,
            showsPlayed: 1,
            roundsPlayed: played.length,
            roundsQualified: qualified,
            finalsReached: reachedFinal ? 1 : 0,
            crowns: pl.crowned ? 1 : 0,
            topTenFinishes: pl.placement <= 10 ? 1 : 0,
            partyShows: p.party ? 1 : 0,
          };
          for (const [type, n] of qualifiedByType) {
            const metric = QUALIFY_METRIC[type];
            if (metric) metrics[metric] = (metrics[metric] ?? 0) + n;
          }
          challenges = await applyChallengeProgress(tx, ctx.catalog, userId, metrics, now);
        }
        const eventUpdates = liveEvents.length
          ? await recordEventShow(
              tx,
              liveEvents,
              userId,
              m.matchId,
              {
                playlistId: m.playlistId,
                roundsQualified: qualified,
                qualifiedByType: Object.fromEntries(qualifiedByType),
                reachedFinal,
                crowned: pl.crowned,
                placement: pl.placement,
              },
              now,
            )
          : [];

        const clubId = clubOf.get(userId);
        const club = clubId
          ? await recordClubShow(tx, { clubId, userId, rounds: qualified, crowns: pl.crowned ? 1 : 0 }, now)
          : null;

        const rk = ranked.get(userId);
        await tx
          .update(matchParticipants)
          .set({ xp: xpTotal, gumballs: gbTotal, crownShards: shards, rpDelta: rk ? rk.rpDelta : null })
          .where(and(eq(matchParticipants.matchId, m.matchId), eq(matchParticipants.participantKey, p.key)));

        rewards.push({
          userId,
          participantKey: p.key,
          placement: pl.placement,
          crowned: pl.crowned,
          roundsQualified: qualified,
          xp: { total: xpTotal, lines: xpLines },
          level: { before: xp.levelBefore, after: xp.levelAfter },
          gumballs: { total: gbTotal, lines: gbLines },
          gems: { total: gemLines.reduce((s, l) => s + l.amount, 0), lines: gemLines },
          crownShards: shards,
          crownsFromShards,
          pass: { xp: xp.passXp, tierBefore: xp.passTierBefore, tierAfter: xp.passTierAfter },
          challenges,
          achievements,
          events: eventUpdates,
          ...(club ? { club } : {}),
          ranked: rk
            ? {
                rpBefore: rk.rpBefore,
                rpAfter: rk.rpAfter,
                rpDelta: rk.rpDelta,
                tierBefore: rk.tierBefore,
                tierAfter: rk.tierAfter,
                label: tierLabel(rk.tierAfter),
                placementsLeft: rk.placementsLeft,
              }
            : null,
          wallet: await readWallet(tx, userId),
        });
        const boards = new Set<BoardType>();
        if (grants && pl.crowned) for (const b of CROWN_BOARDS) boards.add(b);
        if (crownsFromShards > 0) boards.add('crowns_all_time');
        if (rk && rk.placementsLeft === 0) boards.add('ranked');
        if (boards.size)
          leaderboardUpdates.push({ userId, region: regionOf.get(userId) ?? 'na', boards: [...boards] });
      }

      await tx.update(matches).set({ rewards }).where(eq(matches.id, m.matchId));
      pending = { seasonId, endedAt: m.endedAt, leaderboards: leaderboardUpdates, notified: false };
      // Written before the commit: a crash after it still leaves the effects
      // for the retry. If the commit fails instead, the next ingest overwrites it.
      // Without KV the show still counts; its effects then just run once below.
      await ctx.kv.set(pendingKey(m.matchId), JSON.stringify(pending), PENDING_TTL_MS).catch(() => undefined);
      return { matchId: m.matchId, alreadyProcessed: false, rewards };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await replayStored(ctx, m.matchId);
      if (again) return again;
    }
    throw err;
  }

  const effects = pending as PendingEffects | null;
  if (effects) await finishEffects(ctx, result, effects);
  try {
    await crownLeagueTiers(ctx, result, seasonId, regions);
  } catch {
    // The rewards screen then shows Champion; the profile resolves Crown League on its own.
  }
  return result;
}

interface RankedRow {
  rpBefore: number;
  rpAfter: number;
  rpDelta: number;
  tierBefore: TierInfo;
  tierAfter: TierInfo;
  placementsLeft: number;
}

/**
 * Runs the OpenSkill update for a ranked lobby and persists ratings + history.
 *
 * @returns Ranked outcome per user id.
 */
async function rateLobby(
  tx: DbOrTx,
  m: MatchResult,
  seasonId: string,
  regionOf: ReadonlyMap<string, string>,
  now: Date,
): Promise<Map<string, RankedRow>> {
  const humanIds = m.participants.flatMap((p) => (p.userId && regionOf.has(p.userId) ? [p.userId] : []));
  const rows = humanIds.length
    ? await tx
        .select()
        .from(ratings)
        .where(
          and(
            eq(ratings.seasonId, seasonId),
            eq(ratings.queue, RANKED_QUEUE),
            inArray(ratings.userId, humanIds),
          ),
        )
        .for('update')
    : [];
  const priorOf = new Map<string, RankedPrior>(
    rows.map((r) => [r.userId, { mu: r.mu, sigma: r.sigma, rp: r.rp, placementsLeft: r.placementsLeft }]),
  );
  const placementOf = new Map(m.placements.map((p) => [p.key, p.placement]));
  const keyToUser = new Map<string, string>();
  const outcomes = computeRankedUpdate(
    m.participants.map((p) => {
      // Humans without a known account are rated like bots (present in the
      // order, never updated) so a forged slot cannot gain or lose rating.
      const human = Boolean(p.userId && regionOf.has(p.userId));
      if (human) keyToUser.set(p.key, p.userId!);
      const prior = human ? priorOf.get(p.userId!) : undefined;
      return { key: p.key, isBot: !human, placement: placementOf.get(p.key)!, ...(prior ? { prior } : {}) };
    }),
  );
  const out = new Map<string, RankedRow>();
  for (const o of outcomes) {
    const userId = keyToUser.get(o.key)!;
    const values = {
      mu: o.muAfter,
      sigma: o.sigmaAfter,
      rp: o.rpAfter,
      tier: o.tierAfter.tier,
      division: o.tierAfter.division,
      placementsLeft: o.placementsLeft,
      updatedAt: now,
    };
    await tx
      .insert(ratings)
      .values({ userId, seasonId, queue: RANKED_QUEUE, matches: 1, ...values })
      .onConflictDoUpdate({
        target: [ratings.userId, ratings.seasonId, ratings.queue],
        set: { ...values, matches: sql`${ratings.matches} + 1` },
      });
    await tx.insert(rankHistory).values({
      userId,
      seasonId,
      queue: RANKED_QUEUE,
      matchId: m.matchId,
      placement: o.placement,
      muBefore: o.muBefore,
      muAfter: o.muAfter,
      sigmaBefore: o.sigmaBefore,
      sigmaAfter: o.sigmaAfter,
      rpBefore: o.rpBefore,
      rpAfter: o.rpAfter,
      tier: o.tierAfter.tier,
      division: o.tierAfter.division,
    });
    out.set(userId, {
      rpBefore: o.rpBefore,
      rpAfter: o.rpAfter,
      rpDelta: o.rpDelta,
      tierBefore: o.tierBefore,
      tierAfter: o.tierAfter,
      placementsLeft: o.placementsLeft,
    });
  }
  return out;
}
