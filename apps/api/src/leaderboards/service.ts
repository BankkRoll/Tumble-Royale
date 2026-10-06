/**
 * Leaderboards: live sorted sets in KV, rebuilt from Postgres on a cold cache.
 *
 * Boards (`type`):
 * - `crowns`          Crowns this season
 * - `crowns_weekly`   Crowns this ISO week ("Wins this week")
 * - `crowns_all_time` lifetime Crowns (shows won plus Crowns from shards)
 * - `ranked`          visible RP for the season's ranked queue (placed players only)
 * - `win_streak`      best win streak
 * Scopes: `global`, `regional` (caller's or `?region=`), `friends` (computed from Postgres).
 *
 * Every write sets a player's score to what Postgres says it is now, never
 * adds a delta. That makes a write idempotent (a replayed show, or a retry
 * after a failure, writes the same value) and lets a cold rebuild and live
 * writes run in any order: both read committed state, and a per-board KV lock
 * keeps one from overwriting the other with an older read. Custom-lobby shows
 * never count, in the live boards or a rebuild.
 *
 * Boards are partitioned by the show's own season and ISO week, so a result
 * arriving after a rollover lands in the board it belongs to.
 */
import { and, eq, gt, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { REGIONS } from '../accounts/accounts.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { matches, matchParticipants, playerStats, profiles, ratings, users } from '../db/schema.ts';
import { withLock, type KV } from '../kv/index.ts';
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

/** How long a rebuilt board is trusted before the next read rebuilds it again. */
const BUILT_TTL_MS = 7 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;

/** One leaderboard row. */
export interface BoardEntry {
  rank: number;
  userId: string;
  displayName: string;
  tag: string;
  score: number;
}

/** Which partition of a board: the season and the instant (for the ISO week). */
export interface BoardPartition {
  /** Season id; defaults to the live season. */
  seasonId?: string;
  /** Any instant in the week; defaults to now. */
  at?: Date;
}

function partition(ctx: AppContext, type: BoardType, p: Required<BoardPartition>): string {
  switch (type) {
    case 'crowns':
      return `crowns:${p.seasonId}`;
    case 'crowns_weekly':
      return `crowns:week:${isoWeekKey(p.at)}`;
    case 'crowns_all_time':
      return 'crowns:all';
    case 'ranked':
      return `rp:${p.seasonId}:${RANKED_QUEUE}`;
    case 'win_streak':
      return 'streak';
  }
}

function resolve(ctx: AppContext, p: BoardPartition | Date = {}): Required<BoardPartition> {
  const part = p instanceof Date ? { at: p } : p;
  return { seasonId: part.seasonId ?? ctx.catalog.season.id, at: part.at ?? ctx.now() };
}

/**
 * KV key for a board in a scope (`global` or a region id).
 *
 * @param p - The partition, or an instant in the live season.
 */
export function boardKey(
  ctx: AppContext,
  type: BoardType,
  area: string,
  p: BoardPartition | Date = {},
): string {
  return `lb:${partition(ctx, type, resolve(ctx, p))}:${area}`;
}

const builtKey = (key: string): string => `${key}:built`;
const lockKey = (key: string): string => `lb:${key}`;

function weekBounds(at: Date): { start: Date; end: Date } {
  const dow = at.getUTCDay() || 7;
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - (dow - 1)));
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

/** Scores straight from Postgres, optionally limited to some users / a region. */
async function scoresFromDb(
  db: DbOrTx,
  type: BoardType,
  p: Required<BoardPartition>,
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
          eq(ratings.seasonId, p.seasonId),
          eq(ratings.queue, RANKED_QUEUE),
          eq(ratings.placementsLeft, 0),
          ...conds,
        ),
      );
  }
  const week = weekBounds(p.at);
  const period =
    type === 'crowns'
      ? eq(matches.seasonId, p.seasonId)
      : and(gte(matches.endedAt, week.start), lt(matches.endedAt, week.end));
  const rows = await db
    .select({ userId: users.id, score: sql<string>`count(*)` })
    .from(matchParticipants)
    .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
    .innerJoin(users, eq(users.id, matchParticipants.userId))
    // Custom lobbies grant nothing, Crowns included.
    .where(and(eq(matchParticipants.crowned, true), ne(matches.queue, 'custom'), period, ...conds))
    .groupBy(users.id);
  return rows.map((r) => ({ userId: r.userId, score: Number(r.score) }));
}

/** Fills a board from Postgres. Caller holds the board's lock. */
async function rebuild(
  ctx: AppContext,
  type: BoardType,
  area: string,
  p: Required<BoardPartition>,
): Promise<void> {
  const key = boardKey(ctx, type, area, p);
  const rows = await scoresFromDb(ctx.db, type, p, area === 'global' ? {} : { region: area });
  for (const r of rows) await ctx.kv.zadd(key, r.score, r.userId);
  await ctx.kv.set(builtKey(key), '1', BUILT_TTL_MS);
}

/**
 * Rebuilds a board from Postgres the first time it is touched after a KV
 * restart (or once its marker expires). A busy lock means another instance
 * is rebuilding it right now; a reader then shows what is there already.
 */
async function ensureBuilt(
  ctx: AppContext,
  type: BoardType,
  area: string,
  p: Required<BoardPartition>,
): Promise<void> {
  const key = boardKey(ctx, type, area, p);
  if (await ctx.kv.get(builtKey(key))) return;
  try {
    await withLock(ctx.kv, lockKey(key), async () => {
      if (!(await ctx.kv.get(builtKey(key)))) await rebuild(ctx, type, area, p);
    });
  } catch {
    // Busy: someone else is rebuilding. Reads proceed on the partial board.
  }
}

/** A player's change after a show: the boards to refresh for them. */
export interface LeaderboardUpdate {
  userId: string;
  region: string;
  /** Boards whose score may have changed. */
  boards: BoardType[];
}

/**
 * Sets each listed board to the player's current score in Postgres (global
 * and their region). Idempotent, so a replayed or retried show may call it
 * again. Rejects when a board's lock stays busy; the caller retries later.
 *
 * @param ctx - Shared services.
 * @param u - The player and the boards to refresh.
 * @param p - The show's partition (its season and end time).
 */
export async function recordLeaderboards(
  ctx: AppContext,
  u: LeaderboardUpdate,
  p: BoardPartition = {},
): Promise<void> {
  const part = resolve(ctx, p);
  for (const type of u.boards) {
    const [own] = await scoresFromDb(ctx.db, type, part, { userIds: [u.userId] });
    for (const area of ['global', u.region]) {
      const key = boardKey(ctx, type, area, part);
      await withLock(ctx.kv, lockKey(key), async () => {
        // A cold board is rebuilt whole, this player's committed show included.
        if (!(await ctx.kv.get(builtKey(key)))) return rebuild(ctx, type, area, part);
        if (own) await ctx.kv.zadd(key, own.score, u.userId);
      });
    }
  }
}

/**
 * Moves a player's live regional rows after their region changes. Regional
 * scores always equal the global ones, so the global board is the source.
 *
 * @param from - Region the player left.
 * @param to - Region the player joined (already saved in Postgres).
 */
export async function moveLeaderboardRegion(
  ctx: AppContext,
  userId: string,
  from: string,
  to: string,
): Promise<void> {
  if (from === to) return;
  const part = resolve(ctx);
  for (const type of BOARD_TYPES) {
    await ctx.kv.zrem(boardKey(ctx, type, from, part), userId);
    const score = await ctx.kv.zscore(boardKey(ctx, type, 'global', part), userId);
    if (score === null) continue;
    const key = boardKey(ctx, type, to, part);
    await withLock(ctx.kv, lockKey(key), async () => {
      // A cold board is rebuilt from Postgres, which already has the new region.
      if (!(await ctx.kv.get(builtKey(key)))) return rebuild(ctx, type, to, part);
      await ctx.kv.zadd(key, score, userId);
    });
  }
}

/** Live season boards and weekly boards kept in KV: the live one and the one before. */
export const KEPT_PARTITIONS = 2;

/**
 * Every board key a player could be on: each board in every area, for the
 * live and previous season and week (older ones are pruned by
 * {@link pruneOldBoards}).
 */
function liveKeys(ctx: AppContext): string[] {
  const now = ctx.now();
  const live = ctx.catalog.seasonAt(now);
  const seasons = [live.number, live.number - 1].filter((n) => n > 0).map((n) => `s${n}`);
  const weeks = [now, new Date(now.getTime() - WEEK_MS)];
  const keys = new Set<string>();
  for (const area of ['global', ...REGIONS])
    for (const type of BOARD_TYPES)
      for (const seasonId of seasons)
        for (const at of weeks) keys.add(boardKey(ctx, type, area, { seasonId, at }));
  return [...keys];
}

/**
 * Removes a player from every live board, in every region and every kept
 * season and week partition (account deletion).
 */
export async function removeFromLeaderboards(ctx: AppContext, userId: string): Promise<void> {
  for (const key of liveKeys(ctx)) await ctx.kv.zrem(key, userId);
}

/**
 * Deletes season and weekly boards older than {@link KEPT_PARTITIONS}
 * (nothing reads them) for up to a year of weeks and every past season.
 *
 * @returns How many board keys were asked to be deleted.
 */
export async function pruneOldBoards(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const live = ctx.catalog.seasonAt(now);
  const keys: string[] = [];
  for (const area of ['global', ...REGIONS]) {
    for (let n = 1; n <= live.number - KEPT_PARTITIONS; n++) {
      for (const type of ['crowns', 'ranked'] as const) {
        const key = boardKey(ctx, type, area, { seasonId: `s${n}` });
        keys.push(key, builtKey(key));
      }
    }
    for (let w = KEPT_PARTITIONS; w < KEPT_PARTITIONS + 52; w++) {
      const key = boardKey(ctx, 'crowns_weekly', area, { at: new Date(now.getTime() - w * WEEK_MS) });
      keys.push(key, builtKey(key));
    }
  }
  for (let i = 0; i < keys.length; i += 200) await ctx.kv.del(...keys.slice(i, i + 200));
  return keys.length / 2;
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
 * Board order: higher score first, ties by member id descending, the order
 * Redis `ZREVRANGE` (and the in-process KV) gives. Friends boards sort with
 * it too, so a tie reads the same in every scope.
 */
export function compareEntries(
  a: { userId: string; score: number },
  b: { userId: string; score: number },
): number {
  return b.score - a.score || (a.userId < b.userId ? 1 : a.userId > b.userId ? -1 : 0);
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
  const part = resolve(ctx);
  let page: { userId: string; score: number; rank: number }[];
  let me: { score: number; rank: number } | null;
  if (opts.scope === 'friends') {
    const scores = await scoresFromDb(ctx.db, opts.type, part, {
      userIds: [opts.userId, ...opts.friendIds],
    });
    const sorted = scores.sort(compareEntries).map((s, i) => ({ ...s, rank: i + 1 }));
    page = sorted.slice(opts.offset, opts.offset + opts.limit);
    const mine = sorted.find((s) => s.userId === opts.userId);
    me = mine ? { score: mine.score, rank: mine.rank } : null;
  } else {
    const area = opts.scope === 'global' ? 'global' : opts.region;
    await ensureBuilt(ctx, opts.type, area, part);
    const key = boardKey(ctx, opts.type, area, part);
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
 * Resolves the displayed tier, promoting Champions in their region's top 500
 * of the season's ranked board to Crown League.
 *
 * @param u - The player's rating; `seasonId` defaults to the live season.
 */
export async function displayTier(
  ctx: AppContext,
  kv: KV,
  u: { userId: string; region: string; rp: number; placementsLeft: number; seasonId?: string },
): Promise<TierInfo> {
  const base = tierForRp(u.rp, u.placementsLeft);
  if (base.tier !== 'champion') return base;
  const part = resolve(ctx, { seasonId: u.seasonId ?? ctx.catalog.season.id });
  await ensureBuilt(ctx, 'ranked', u.region, part);
  const rank = await kv.zrevrank(boardKey(ctx, 'ranked', u.region, part), u.userId);
  return tierForRp(u.rp, u.placementsLeft, rank);
}
