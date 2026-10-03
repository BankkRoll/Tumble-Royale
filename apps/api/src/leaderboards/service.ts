/**
 * Leaderboards: live sorted sets in KV, rebuilt from Postgres on a cold cache.
 *
 * Boards (`type`):
 * - `crowns`          Crowns this season
 * - `crowns_weekly`   Crowns this ISO week ("Wins this week")
 * - `crowns_all_time` lifetime Crowns
 * - `ranked`          visible RP for the season's ranked queue (placed players only)
 * - `win_streak`      best win streak
 * Scopes: `global`, `regional` (caller's or `?region=`), `friends` (computed from Postgres).
 */
import { and, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { matches, matchParticipants, playerStats, profiles, ratings, users } from '../db/schema.ts';
import type { KV } from '../kv/index.ts';
import { tierForRp, type TierInfo } from '../ranked/tiers.ts';
import { isoWeekKey } from '../util/time.ts';

/** Board ids. */
export const BOARD_TYPES = ['crowns', 'crowns_weekly', 'crowns_all_time', 'ranked', 'win_streak'] as const;
/** A board id. */
export type BoardType = (typeof BOARD_TYPES)[number];
/** Board scopes. */
export type BoardScope = 'global' | 'regional' | 'friends';

/** The ranked queue id used for leaderboards and ratings. */
export const RANKED_QUEUE = 'ranked';

/** One leaderboard row. */
export interface BoardEntry {
  rank: number;
  userId: string;
  displayName: string;
  tag: string;
  score: number;
}

function partition(ctx: AppContext, type: BoardType, now: Date): string {
  switch (type) {
    case 'crowns':
      return `crowns:${ctx.catalog.season.id}`;
    case 'crowns_weekly':
      return `crowns:week:${isoWeekKey(now)}`;
    case 'crowns_all_time':
      return 'crowns:all';
    case 'ranked':
      return `rp:${ctx.catalog.season.id}:${RANKED_QUEUE}`;
    case 'win_streak':
      return 'streak';
  }
}

/** KV key for a board in a scope (`global` or a region id). */
export function boardKey(ctx: AppContext, type: BoardType, area: string, now: Date): string {
  return `lb:${partition(ctx, type, now)}:${area}`;
}

/** Updates live boards after a show for one player. */
export async function recordLeaderboards(
  ctx: AppContext,
  u: {
    userId: string;
    region: string;
    crowned: boolean;
    shardCrowns: number;
    bestStreak: number;
    rp: number | null;
  },
  now: Date,
): Promise<void> {
  const kv = ctx.kv;
  for (const area of ['global', u.region]) {
    if (u.crowned) {
      for (const t of ['crowns', 'crowns_weekly', 'crowns_all_time'] as const) {
        // A cold rebuild reads Postgres, which already includes this show.
        if (!(await ensureBuilt(ctx, t, area, now)))
          await kv.zincrby(boardKey(ctx, t, area, now), 1, u.userId);
      }
    }
    if (u.shardCrowns > 0 && !(await ensureBuilt(ctx, 'crowns_all_time', area, now))) {
      await kv.zincrby(boardKey(ctx, 'crowns_all_time', area, now), u.shardCrowns, u.userId);
    }
    if (u.bestStreak > 0) {
      await ensureBuilt(ctx, 'win_streak', area, now);
      await kv.zadd(boardKey(ctx, 'win_streak', area, now), u.bestStreak, u.userId);
    }
    if (u.rp !== null) {
      await ensureBuilt(ctx, 'ranked', area, now);
      await kv.zadd(boardKey(ctx, 'ranked', area, now), u.rp, u.userId);
    }
  }
}

/** Scores straight from Postgres, optionally limited to some users / a region. */
async function scoresFromDb(
  ctx: AppContext,
  db: DbOrTx,
  type: BoardType,
  now: Date,
  filter: { region?: string; userIds?: string[] },
): Promise<{ userId: string; score: number }[]> {
  const conds = [];
  if (filter.region) conds.push(eq(users.region, filter.region));
  if (filter.userIds) {
    if (filter.userIds.length === 0) return [];
    conds.push(inArray(users.id, filter.userIds));
  }
  if (type === 'crowns_all_time') {
    return db
      .select({ userId: profiles.userId, score: profiles.crowns })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(gt(profiles.crowns, 0), ...conds));
  }
  if (type === 'win_streak') {
    return db
      .select({ userId: playerStats.userId, score: playerStats.bestWinStreak })
      .from(playerStats)
      .innerJoin(users, eq(users.id, playerStats.userId))
      .where(and(gt(playerStats.bestWinStreak, 0), ...conds));
  }
  if (type === 'ranked') {
    return db
      .select({ userId: ratings.userId, score: ratings.rp })
      .from(ratings)
      .innerJoin(users, eq(users.id, ratings.userId))
      .where(
        and(
          eq(ratings.seasonId, ctx.catalog.season.id),
          eq(ratings.queue, RANKED_QUEUE),
          eq(ratings.placementsLeft, 0),
          ...conds,
        ),
      );
  }
  const seasonOrWeek =
    type === 'crowns' ? eq(matches.seasonId, ctx.catalog.season.id) : gte(matches.endedAt, weekStart(now));
  const rows = await db
    .select({ userId: users.id, score: sql<string>`count(*)` })
    .from(matchParticipants)
    .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
    .innerJoin(users, eq(users.id, matchParticipants.userId))
    .where(and(eq(matchParticipants.crowned, true), seasonOrWeek, ...conds))
    .groupBy(users.id);
  return rows.map((r) => ({ userId: r.userId, score: Number(r.score) }));
}

function weekStart(now: Date): Date {
  const dow = now.getUTCDay() || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow - 1)));
}

/**
 * Rebuilds a board from Postgres the first time it is touched after a KV
 * restart. A marker key prevents rebuilding a legitimately empty board.
 *
 * @returns True when this call rebuilt the board.
 */
async function ensureBuilt(ctx: AppContext, type: BoardType, area: string, now: Date): Promise<boolean> {
  const key = boardKey(ctx, type, area, now);
  if (!(await ctx.kv.setNX(`${key}:built`, '1', 7 * 86_400_000))) return false;
  if ((await ctx.kv.zcard(key)) > 0) return false;
  const rows = await scoresFromDb(ctx, ctx.db, type, now, area === 'global' ? {} : { region: area });
  for (const r of rows) await ctx.kv.zadd(key, r.score, r.userId);
  return true;
}

async function hydrate(
  db: DbOrTx,
  ids: string[],
): Promise<Map<string, { displayName: string; tag: string }>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ userId: profiles.userId, displayName: profiles.displayName, tag: profiles.tag })
    .from(profiles)
    .where(inArray(profiles.userId, ids));
  return new Map(rows.map((r) => [r.userId, r]));
}

/**
 * Reads a leaderboard page plus the caller's own row.
 *
 * @param friendIds - Accepted friends of the caller (only for `friends` scope).
 */
export async function readLeaderboard(
  ctx: AppContext,
  opts: {
    type: BoardType;
    scope: BoardScope;
    region: string;
    userId: string;
    friendIds: string[];
    limit: number;
    offset: number;
  },
): Promise<{
  type: BoardType;
  scope: BoardScope;
  region: string | null;
  entries: BoardEntry[];
  me: BoardEntry | null;
}> {
  const now = ctx.now();
  let page: { userId: string; score: number; rank: number }[];
  let me: { score: number; rank: number } | null;
  if (opts.scope === 'friends') {
    const scores = await scoresFromDb(ctx, ctx.db, opts.type, now, {
      userIds: [opts.userId, ...opts.friendIds],
    });
    const sorted = scores
      .sort((a, b) => b.score - a.score || (a.userId < b.userId ? -1 : 1))
      .map((s, i) => ({ ...s, rank: i + 1 }));
    page = sorted.slice(opts.offset, opts.offset + opts.limit);
    const mine = sorted.find((s) => s.userId === opts.userId);
    me = mine ? { score: mine.score, rank: mine.rank } : null;
  } else {
    const area = opts.scope === 'global' ? 'global' : opts.region;
    await ensureBuilt(ctx, opts.type, area, now);
    const key = boardKey(ctx, opts.type, area, now);
    const rows = await ctx.kv.zrevrange(key, opts.offset, opts.offset + opts.limit - 1);
    page = rows.map((r, i) => ({ userId: r.member, score: r.score, rank: opts.offset + i + 1 }));
    const rank = await ctx.kv.zrevrank(key, opts.userId);
    const score = await ctx.kv.zscore(key, opts.userId);
    me = rank !== null && score !== null ? { score, rank: rank + 1 } : null;
  }
  const names = await hydrate(ctx.db, [...new Set([...page.map((p) => p.userId), opts.userId])]);
  const label = (userId: string) => names.get(userId) ?? { displayName: 'Unknown', tag: '0000' };
  return {
    type: opts.type,
    scope: opts.scope,
    region: opts.scope === 'regional' ? opts.region : null,
    entries: page.map((p) => ({ rank: p.rank, userId: p.userId, score: p.score, ...label(p.userId) })),
    me: me ? { rank: me.rank, userId: opts.userId, score: me.score, ...label(opts.userId) } : null,
  };
}

/**
 * Resolves the displayed tier, promoting Champions in their region's top 500 to Crown League.
 */
export async function displayTier(
  ctx: AppContext,
  kv: KV,
  u: { userId: string; region: string; rp: number; placementsLeft: number },
): Promise<TierInfo> {
  const base = tierForRp(u.rp, u.placementsLeft);
  if (base.tier !== 'champion') return base;
  const now = ctx.now();
  await ensureBuilt(ctx, 'ranked', u.region, now);
  const rank = await kv.zrevrank(boardKey(ctx, 'ranked', u.region, now), u.userId);
  return tierForRp(u.rp, u.placementsLeft, rank);
}
