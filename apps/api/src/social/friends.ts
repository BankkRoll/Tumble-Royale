/**
 * Friends.
 *
 * Responsibilities:
 * - requests by `name#tag` or account id (search results, recent players,
 *   profile cards, chat), with friend and pending limits on both sides and
 *   auto-accept when the other player already asked;
 * - accept / decline / cancel / remove, block / unblock — each pushed live to
 *   the other side over the realtime gateway;
 * - presence-annotated lists (friends sorted by availability, requests newest
 *   first, blocked), player search and recent players with their relation;
 * - presence fan-out to friends ({@link broadcastPresence}).
 *
 * Blocking is never observable: a blocked pair gets the same 404 as a typo and
 * never appears in each other's search or recent players.
 */
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { lockXact } from '../db/locks.ts';
import { clubMembers, clubs, friendships, matchParticipants, matches, profiles } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { badRequest, conflict, notFound, parse } from '../http/errors.ts';
import { parseNameTag } from '../names/display-name.ts';
import { REPORTABLE_PRESENCE, type SocialRef } from '../realtime/notifier.ts';
import { refreshVoice } from '../voice/service.ts';
import { PRESENCE_RANK, presenceView, presenceViews, setPresence } from './presence.ts';

/** Maximum accepted friends per player. */
export const MAX_FRIENDS = 200;
/** Maximum requests a player may have waiting on others. */
export const MAX_PENDING_OUTGOING = 50;
/** Maximum requests waiting on one player. */
export const MAX_PENDING_INCOMING = 100;
/** Search results per query. */
export const SEARCH_LIMIT = 10;

const RequestBody = z.union([
  z.object({ nameTag: z.string().min(5).max(24) }),
  z.object({ userId: z.string().uuid() }),
]);
const UserBody = z.object({ userId: z.string().uuid() });
const UserParam = z.object({ userId: z.string().uuid() });
const PresenceBody = z.object({
  status: z.enum(REPORTABLE_PRESENCE),
  playlistId: z.string().min(1).max(64).optional(),
  lobbyCode: z
    .string()
    .regex(/^[A-Z0-9]{4,8}$/)
    .optional(),
});
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FRIENDS).default(MAX_FRIENDS),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const SearchQuery = z.object({ q: z.string().trim().min(2).max(24) });

/** How the caller relates to another player. */
export type Relation = 'self' | 'friend' | 'incoming' | 'outgoing' | 'none';

/** Accepted friend ids of a user. */
export async function friendIds(db: DbOrTx, userId: string): Promise<string[]> {
  const rows = await db
    .select({ a: friendships.userId, b: friendships.friendId })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'accepted'),
        or(eq(friendships.userId, userId), eq(friendships.friendId, userId)),
      ),
    );
  return rows.map((r) => (r.a === userId ? r.b : r.a));
}

/** True when either user blocked the other. */
export async function isBlockedEitherWay(db: DbOrTx, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ s: friendships.status })
    .from(friendships)
    .where(and(eq(friendships.status, 'blocked'), pairWhere(a, b)));
  return Boolean(row);
}

/**
 * Users in a blocked pair with `userId` (either direction).
 *
 * @returns Ids the user blocked or was blocked by.
 */
export async function blockedEitherWay(db: DbOrTx, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ a: friendships.userId, b: friendships.friendId })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'blocked'),
        or(eq(friendships.userId, userId), eq(friendships.friendId, userId)),
      ),
    );
  return new Set(rows.map((r) => (r.a === userId ? r.b : r.a)));
}

type Card = { displayName: string; tag: string; level: number };

async function names(db: DbOrTx, ids: string[]): Promise<Map<string, Card>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: profiles.userId,
      displayName: profiles.displayName,
      tag: profiles.tag,
      level: profiles.level,
    })
    .from(profiles)
    .where(inArray(profiles.userId, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** `{userId, name, tag, club?}` for social events (`club` is the club tag). */
export async function socialRef(db: DbOrTx, userId: string): Promise<SocialRef> {
  const [me] = await db
    .select({ displayName: profiles.displayName, tag: profiles.tag, club: clubs.tag })
    .from(profiles)
    .leftJoin(clubMembers, eq(clubMembers.userId, profiles.userId))
    .leftJoin(clubs, eq(clubs.id, clubMembers.clubId))
    .where(eq(profiles.userId, userId));
  return { userId, name: me?.displayName ?? '', tag: me?.tag ?? '', ...(me?.club ? { club: me.club } : {}) };
}

function pairWhere(a: string, b: string) {
  return or(
    and(eq(friendships.userId, a), eq(friendships.friendId, b)),
    and(eq(friendships.userId, b), eq(friendships.friendId, a)),
  );
}

async function pendingCount(db: DbOrTx, userId: string, dir: 'in' | 'out'): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'pending'),
        eq(dir === 'out' ? friendships.userId : friendships.friendId, userId),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Relations between the caller and several players (blocked pairs read as `none`;
 * callers filter those out first).
 */
async function relations(db: DbOrTx, me: string, ids: string[]): Promise<Map<string, Relation>> {
  const out = new Map<string, Relation>(ids.map((id) => [id, id === me ? 'self' : 'none']));
  if (!ids.length) return out;
  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(eq(friendships.userId, me), inArray(friendships.friendId, ids)),
        and(eq(friendships.friendId, me), inArray(friendships.userId, ids)),
      ),
    );
  for (const r of rows) {
    const other = r.userId === me ? r.friendId : r.userId;
    if (r.status === 'accepted') out.set(other, 'friend');
    else if (r.status === 'pending') out.set(other, r.userId === me ? 'outgoing' : 'incoming');
  }
  return out;
}

/**
 * Pushes a user's current presence to all their friends.
 *
 * @param ctx - Shared services.
 * @param userId - Whose presence changed.
 */
export async function broadcastPresence(ctx: AppContext, userId: string): Promise<void> {
  const ids = await friendIds(ctx.db, userId);
  if (!ids.length) return;
  const view = await presenceView(ctx.kv, userId);
  await ctx.notifier.notifyMany(ids, { type: 'presence', userId, ...view });
}

/** Resolves a request target from `name#tag` or an id; blocked pairs read as not found. */
async function findTarget(
  ctx: AppContext,
  me: string,
  body: z.infer<typeof RequestBody>,
): Promise<{ id: string; displayName: string; tag: string }> {
  let target: { id: string; displayName: string; tag: string } | undefined;
  const cols = { id: profiles.userId, displayName: profiles.displayName, tag: profiles.tag };
  if ('userId' in body) {
    [target] = await ctx.db.select(cols).from(profiles).where(eq(profiles.userId, body.userId));
  } else {
    const parsed = parseNameTag(body.nameTag);
    if (!parsed) throw badRequest('invalid_name_tag', 'Use the format Name#1234');
    [target] = await ctx.db
      .select(cols)
      .from(profiles)
      .where(and(sql`lower(${profiles.displayName}) = lower(${parsed.name})`, eq(profiles.tag, parsed.tag)));
  }
  if (!target || (await isBlockedEitherWay(ctx.db, me, target.id))) throw notFound('Player');
  if (target.id === me) throw badRequest('self_request', 'You cannot friend yourself');
  return target;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Registers friends and presence routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerFriendRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/friends', async (req) => {
    const auth = await requireUser(ctx, req);
    const page = parse(ListQuery, req.query);
    const rows = await ctx.db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userId, auth.userId), eq(friendships.friendId, auth.userId)));
    const other = (r: (typeof rows)[number]) => (r.userId === auth.userId ? r.friendId : r.userId);
    const newest = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      b.createdAt.getTime() - a.createdAt.getTime();
    const accepted = rows.filter((r) => r.status === 'accepted');
    const incoming = rows.filter((r) => r.status === 'pending' && r.friendId === auth.userId).sort(newest);
    const outgoing = rows.filter((r) => r.status === 'pending' && r.userId === auth.userId).sort(newest);
    const blocked = rows.filter((r) => r.status === 'blocked' && r.userId === auth.userId).sort(newest);
    const info = await names(ctx.db, rows.map(other));
    const presence = await presenceViews(ctx.kv, accepted.map(other));
    const card = (id: string) => ({
      userId: id,
      ...(info.get(id) ?? { displayName: 'Unknown', tag: '0000', level: 1 }),
    });
    const friends = accepted
      .map((r) => {
        const id = other(r);
        const p = presence.get(id) ?? { status: 'offline' as const };
        const { status, ...activity } = p;
        return { ...card(id), presence: status, ...activity, since: r.updatedAt.toISOString() };
      })
      .sort(
        (a, b) =>
          PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence] ||
          a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }),
      );
    const withAt = (r: (typeof rows)[number]) => ({ ...card(other(r)), at: r.createdAt.toISOString() });
    return {
      friends: friends.slice(page.offset, page.offset + page.limit),
      total: friends.length,
      incoming: incoming.map(withAt),
      outgoing: outgoing.map(withAt),
      blocked: blocked.map(withAt),
      limits: { friends: MAX_FRIENDS, pendingOutgoing: MAX_PENDING_OUTGOING },
    };
  });

  app.get('/friends/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(ctx, req);
    const { q } = parse(SearchQuery, req.query);
    const [namePart, tagPart] = q.split('#') as [string, string | undefined];
    const name = namePart.trim().toLowerCase();
    if (name.length < 2) return { players: [] };
    if (tagPart !== undefined && !/^\d{0,4}$/.test(tagPart)) return { players: [] };
    const hidden = await blockedEitherWay(ctx.db, auth.userId);
    const rows = await ctx.db
      .select({
        userId: profiles.userId,
        displayName: profiles.displayName,
        tag: profiles.tag,
        level: profiles.level,
      })
      .from(profiles)
      .where(
        and(
          sql`lower(${profiles.displayName}) like ${`${escapeLike(name)}%`}`,
          ne(profiles.userId, auth.userId),
          ...(tagPart ? [sql`${profiles.tag} like ${`${tagPart}%`}`] : []),
        ),
      )
      .orderBy(
        sql`lower(${profiles.displayName}) = ${name} desc`,
        sql`length(${profiles.displayName})`,
        profiles.displayName,
        profiles.tag,
      )
      // Over-fetch so hidden (blocked) rows don't shrink the page.
      .limit(SEARCH_LIMIT + Math.min(hidden.size, 50));
    const visible = rows.filter((r) => !hidden.has(r.userId)).slice(0, SEARCH_LIMIT);
    const rel = await relations(
      ctx.db,
      auth.userId,
      visible.map((r) => r.userId),
    );
    return { players: visible.map((r) => ({ ...r, relation: rel.get(r.userId) ?? 'none' })) };
  });

  app.post(
    '/friends/request',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const target = await findTarget(ctx, auth.userId, parse(RequestBody, req.body));
      const result = await ctx.db.transaction(async (tx) => {
        // Two players asking each other at once would otherwise both miss the reverse row and leave two pending ones.
        await lockXact(tx, 'friend-pair', ...[auth.userId, target.id].sort());
        const existing = await tx.select().from(friendships).where(pairWhere(auth.userId, target.id));
        if (existing.some((r) => r.status === 'accepted'))
          throw conflict('already_friends', 'Already friends');
        if (existing.some((r) => r.status === 'pending' && r.userId === auth.userId))
          return 'pending' as const;
        if ((await friendIds(tx, auth.userId)).length >= MAX_FRIENDS)
          throw conflict('friend_limit', 'Your friend list is full');
        const reverse = existing.find((r) => r.status === 'pending' && r.userId === target.id);
        if (reverse) {
          if ((await friendIds(tx, target.id)).length >= MAX_FRIENDS)
            throw conflict('target_friend_limit', "That player's friend list is full");
          await tx
            .update(friendships)
            .set({ status: 'accepted', updatedAt: ctx.now() })
            .where(and(eq(friendships.userId, target.id), eq(friendships.friendId, auth.userId)));
          return 'accepted' as const;
        }
        if ((await pendingCount(tx, auth.userId, 'out')) >= MAX_PENDING_OUTGOING)
          throw conflict('pending_limit', 'Too many requests waiting; cancel some first');
        if ((await pendingCount(tx, target.id, 'in')) >= MAX_PENDING_INCOMING)
          throw conflict('target_pending_limit', "That player can't take more requests right now");
        await tx.insert(friendships).values({
          userId: auth.userId,
          friendId: target.id,
          status: 'pending',
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        });
        return 'pending' as const;
      });
      const from = await socialRef(ctx.db, auth.userId);
      if (result === 'accepted') {
        await ctx.notifier.notifyUser(target.id, { type: 'friend_accepted', by: from });
        await sharePresence(ctx, auth.userId, target.id);
      } else {
        await ctx.notifier.notifyUser(target.id, { type: 'friend_request', from });
      }
      return {
        status: result,
        user: { userId: target.id, displayName: target.displayName, tag: target.tag },
      };
    },
  );

  app.post('/friends/accept', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    await ctx.db.transaction(async (tx) => {
      const [pending] = await tx
        .select({ u: friendships.userId })
        .from(friendships)
        .where(
          and(
            eq(friendships.userId, userId),
            eq(friendships.friendId, auth.userId),
            eq(friendships.status, 'pending'),
          ),
        );
      if (!pending) throw notFound('Friend request');
      if ((await friendIds(tx, auth.userId)).length >= MAX_FRIENDS)
        throw conflict('friend_limit', 'Your friend list is full');
      if ((await friendIds(tx, userId)).length >= MAX_FRIENDS)
        throw conflict('target_friend_limit', "That player's friend list is full");
      await tx
        .update(friendships)
        .set({ status: 'accepted', updatedAt: ctx.now() })
        .where(and(eq(friendships.userId, userId), eq(friendships.friendId, auth.userId)));
    });
    await ctx.notifier.notifyUser(userId, {
      type: 'friend_accepted',
      by: await socialRef(ctx.db, auth.userId),
    });
    await sharePresence(ctx, auth.userId, userId);
    return { status: 'accepted' };
  });

  app.post('/friends/decline', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    const removed = await ctx.db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userId, userId),
          eq(friendships.friendId, auth.userId),
          eq(friendships.status, 'pending'),
        ),
      )
      .returning({ u: friendships.userId });
    if (removed.length)
      await ctx.notifier.notifyUser(userId, { type: 'friend_request_removed', userId: auth.userId });
    return reply.code(204).send();
  });

  /** Cancels an outgoing request. */
  app.delete('/friends/request/:userId', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserParam, req.params);
    const removed = await ctx.db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userId, auth.userId),
          eq(friendships.friendId, userId),
          eq(friendships.status, 'pending'),
        ),
      )
      .returning({ u: friendships.userId });
    if (removed.length)
      await ctx.notifier.notifyUser(userId, { type: 'friend_request_removed', userId: auth.userId });
    return reply.code(204).send();
  });

  /** Removes a friend (or any pending request either way). */
  app.delete('/friends/:userId', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserParam, req.params);
    const removed = await ctx.db
      .delete(friendships)
      .where(and(pairWhere(auth.userId, userId), ne(friendships.status, 'blocked')))
      .returning({ s: friendships.status });
    await notifyRemoval(ctx, auth.userId, userId, removed);
    return reply.code(204).send();
  });

  app.post('/friends/block', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    if (userId === auth.userId) throw badRequest('self_block', 'You cannot block yourself');
    const [exists] = await ctx.db
      .select({ id: profiles.userId })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    if (!exists) throw notFound('Player');
    const removed = await ctx.db.transaction(async (tx) => {
      const gone = await tx
        .delete(friendships)
        .where(and(pairWhere(auth.userId, userId), ne(friendships.status, 'blocked')))
        .returning({ s: friendships.status });
      await tx
        .insert(friendships)
        .values({
          userId: auth.userId,
          friendId: userId,
          status: 'blocked',
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .onConflictDoUpdate({
          target: [friendships.userId, friendships.friendId],
          set: { status: 'blocked', updatedAt: ctx.now() },
        });
      return gone;
    });
    // The blocked player sees an ordinary removal; the block itself stays private.
    await notifyRemoval(ctx, auth.userId, userId, removed);
    await refreshVoice(ctx, [auth.userId, userId]);
    return { status: 'blocked' };
  });

  app.delete('/friends/block/:userId', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserParam, req.params);
    await ctx.db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userId, auth.userId),
          eq(friendships.friendId, userId),
          eq(friendships.status, 'blocked'),
        ),
      );
    await refreshVoice(ctx, [auth.userId, userId]);
    return reply.code(204).send();
  });

  app.get('/friends/recent', async (req) => {
    const auth = await requireUser(ctx, req);
    const recentMatches = await ctx.db
      .select({ id: matches.id, endedAt: matches.endedAt })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(eq(matchParticipants.userId, auth.userId))
      .orderBy(desc(matches.endedAt))
      .limit(5);
    if (!recentMatches.length) return { players: [] };
    const rows = await ctx.db
      .select({ userId: matchParticipants.userId, matchId: matchParticipants.matchId })
      .from(matchParticipants)
      .where(
        and(
          inArray(
            matchParticipants.matchId,
            recentMatches.map((m) => m.id),
          ),
          eq(matchParticipants.isBot, false),
        ),
      );
    const order = new Map(recentMatches.map((m, i) => [m.id, i]));
    rows.sort((a, b) => (order.get(a.matchId) ?? 99) - (order.get(b.matchId) ?? 99));
    const hidden = await blockedEitherWay(ctx.db, auth.userId);
    const ids = [
      ...new Set(
        rows.flatMap((r) =>
          r.userId && r.userId !== auth.userId && !hidden.has(r.userId) ? [r.userId] : [],
        ),
      ),
    ].slice(0, 50);
    const info = await names(ctx.db, ids);
    const rel = await relations(ctx.db, auth.userId, ids);
    const friendsOnly = ids.filter((id) => rel.get(id) === 'friend');
    const presence = await presenceViews(ctx.kv, friendsOnly);
    const lastMatch = new Map<string, string>();
    for (const r of rows) if (r.userId && !lastMatch.has(r.userId)) lastMatch.set(r.userId, r.matchId);
    return {
      players: ids.map((id) => ({
        userId: id,
        ...(info.get(id) ?? { displayName: 'Unknown', tag: '0000', level: 1 }),
        relation: rel.get(id) ?? 'none',
        // Presence is only shared between friends.
        ...(presence.has(id) ? { presence: presence.get(id)!.status } : {}),
        matchId: lastMatch.get(id) ?? null,
      })),
    };
  });

  app.post('/presence', async (req) => {
    const auth = await requireUser(ctx, req);
    const body = parse(PresenceBody, req.body);
    await setPresence(ctx.kv, auth.userId, body.status, ctx.now().getTime(), body);
    await broadcastPresence(ctx, auth.userId);
    return { status: body.status };
  });
}

/** After a friendship forms, each side learns the other's presence immediately. */
async function sharePresence(ctx: AppContext, a: string, b: string): Promise<void> {
  const [va, vb] = await Promise.all([presenceView(ctx.kv, a), presenceView(ctx.kv, b)]);
  await Promise.all([
    ctx.notifier.notifyUser(b, { type: 'presence', userId: a, ...va }),
    ctx.notifier.notifyUser(a, { type: 'presence', userId: b, ...vb }),
  ]);
}

async function notifyRemoval(
  ctx: AppContext,
  me: string,
  other: string,
  removed: { s: string }[],
): Promise<void> {
  if (removed.some((r) => r.s === 'accepted'))
    await ctx.notifier.notifyUser(other, { type: 'friend_removed', userId: me });
  else if (removed.some((r) => r.s === 'pending'))
    await ctx.notifier.notifyUser(other, { type: 'friend_request_removed', userId: me });
}
