/**
 * Friends: requests by `name#tag`, accept/decline/remove, block/unblock,
 * presence-annotated lists and recent players.
 */
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { friendships, matchParticipants, matches, profiles } from '../db/schema.ts';
import { requireUser } from '../http/auth.ts';
import { badRequest, conflict, notFound, parse } from '../http/errors.ts';
import { parseNameTag } from '../names/display-name.ts';
import { getPresenceMany, setPresence } from './presence.ts';

/** Maximum accepted friends per player. */
export const MAX_FRIENDS = 200;

const RequestBody = z.object({ nameTag: z.string().min(8).max(24) });
const UserBody = z.object({ userId: z.string().uuid() });
const UserParam = z.object({ userId: z.string().uuid() });
const PresenceBody = z.object({ status: z.enum(['online', 'in_menu', 'in_queue', 'in_match']) });

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
    .where(
      and(
        eq(friendships.status, 'blocked'),
        or(
          and(eq(friendships.userId, a), eq(friendships.friendId, b)),
          and(eq(friendships.userId, b), eq(friendships.friendId, a)),
        ),
      ),
    );
  return Boolean(row);
}

async function names(db: DbOrTx, ids: string[]) {
  if (!ids.length) return new Map<string, { displayName: string; tag: string; level: number }>();
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

const pairWhere = (a: string, b: string) =>
  or(
    and(eq(friendships.userId, a), eq(friendships.friendId, b)),
    and(eq(friendships.userId, b), eq(friendships.friendId, a)),
  );

/**
 * Registers friends and presence routes.
 *
 * @param app - Fastify instance.
 * @param ctx - Shared services.
 */
export function registerFriendRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/friends', async (req) => {
    const auth = await requireUser(ctx, req);
    const rows = await ctx.db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userId, auth.userId), eq(friendships.friendId, auth.userId)));
    const other = (r: (typeof rows)[number]) => (r.userId === auth.userId ? r.friendId : r.userId);
    const accepted = rows.filter((r) => r.status === 'accepted').map(other);
    const incoming = rows
      .filter((r) => r.status === 'pending' && r.friendId === auth.userId)
      .map((r) => r.userId);
    const outgoing = rows
      .filter((r) => r.status === 'pending' && r.userId === auth.userId)
      .map((r) => r.friendId);
    const blocked = rows
      .filter((r) => r.status === 'blocked' && r.userId === auth.userId)
      .map((r) => r.friendId);
    const info = await names(ctx.db, [...accepted, ...incoming, ...outgoing, ...blocked]);
    const presence = await getPresenceMany(ctx.kv, accepted);
    const card = (id: string) => ({
      userId: id,
      ...(info.get(id) ?? { displayName: 'Unknown', tag: '0000', level: 1 }),
    });
    return {
      friends: accepted.map((id) => ({ ...card(id), presence: presence.get(id)?.status ?? 'offline' })),
      incoming: incoming.map(card),
      outgoing: outgoing.map(card),
      blocked: blocked.map(card),
    };
  });

  app.post(
    '/friends/request',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const auth = await requireUser(ctx, req);
      const parsed = parseNameTag(parse(RequestBody, req.body).nameTag);
      if (!parsed) throw badRequest('invalid_name_tag', 'Use the format Name#1234');
      const [target] = await ctx.db
        .select({ id: profiles.userId, displayName: profiles.displayName, tag: profiles.tag })
        .from(profiles)
        .where(
          and(sql`lower(${profiles.displayName}) = lower(${parsed.name})`, eq(profiles.tag, parsed.tag)),
        );
      // Blocked pairs get the same 404 as a typo so blocking is not observable.
      if (!target || (await isBlockedEitherWay(ctx.db, auth.userId, target.id))) throw notFound('Player');
      if (target.id === auth.userId) throw badRequest('self_request', 'You cannot friend yourself');
      const result = await ctx.db.transaction(async (tx) => {
        const existing = await tx.select().from(friendships).where(pairWhere(auth.userId, target.id));
        if (existing.some((r) => r.status === 'accepted'))
          throw conflict('already_friends', 'Already friends');
        if (existing.some((r) => r.status === 'pending' && r.userId === auth.userId))
          return 'pending' as const;
        if ((await friendIds(tx, auth.userId)).length >= MAX_FRIENDS)
          throw conflict('friend_limit', 'Friend list is full');
        const reverse = existing.find((r) => r.status === 'pending' && r.userId === target.id);
        if (reverse) {
          await tx
            .update(friendships)
            .set({ status: 'accepted', updatedAt: ctx.now() })
            .where(and(eq(friendships.userId, target.id), eq(friendships.friendId, auth.userId)));
          return 'accepted' as const;
        }
        await tx.insert(friendships).values({ userId: auth.userId, friendId: target.id, status: 'pending' });
        return 'pending' as const;
      });
      const [me] = await ctx.db
        .select({ displayName: profiles.displayName, tag: profiles.tag })
        .from(profiles)
        .where(eq(profiles.userId, auth.userId));
      const from = { userId: auth.userId, displayName: me?.displayName ?? '', tag: me?.tag ?? '' };
      await ctx.notifier.notifyUser(
        target.id,
        result === 'accepted'
          ? { type: 'friend_accepted', by: { userId: from.userId, name: from.displayName, tag: from.tag } }
          : { type: 'friend_request', from: { userId: from.userId, name: from.displayName, tag: from.tag } },
      );
      return {
        status: result,
        user: { userId: target.id, displayName: target.displayName, tag: target.tag },
      };
    },
  );

  app.post('/friends/accept', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    if ((await friendIds(ctx.db, auth.userId)).length >= MAX_FRIENDS)
      throw conflict('friend_limit', 'Friend list is full');
    const updated = await ctx.db
      .update(friendships)
      .set({ status: 'accepted', updatedAt: ctx.now() })
      .where(
        and(
          eq(friendships.userId, userId),
          eq(friendships.friendId, auth.userId),
          eq(friendships.status, 'pending'),
        ),
      )
      .returning({ u: friendships.userId });
    if (!updated.length) throw notFound('Friend request');
    const [me] = await ctx.db
      .select({ displayName: profiles.displayName, tag: profiles.tag })
      .from(profiles)
      .where(eq(profiles.userId, auth.userId));
    await ctx.notifier.notifyUser(userId, {
      type: 'friend_accepted',
      by: { userId: auth.userId, name: me?.displayName ?? '', tag: me?.tag ?? '' },
    });
    return { status: 'accepted' };
  });

  app.post('/friends/decline', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    await ctx.db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userId, userId),
          eq(friendships.friendId, auth.userId),
          eq(friendships.status, 'pending'),
        ),
      );
    return reply.code(204).send();
  });

  app.delete('/friends/:userId', async (req, reply) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserParam, req.params);
    const removed = await ctx.db
      .delete(friendships)
      .where(and(pairWhere(auth.userId, userId), ne(friendships.status, 'blocked')))
      .returning({ s: friendships.status });
    if (removed.some((r) => r.s === 'accepted'))
      await ctx.notifier.notifyUser(userId, { type: 'friend_removed', userId: auth.userId });
    return reply.code(204).send();
  });

  app.post('/friends/block', async (req) => {
    const auth = await requireUser(ctx, req);
    const { userId } = parse(UserBody, req.body);
    if (userId === auth.userId) throw badRequest('self_block', 'You cannot block yourself');
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(friendships)
        .where(and(pairWhere(auth.userId, userId), ne(friendships.status, 'blocked')));
      await tx
        .insert(friendships)
        .values({ userId: auth.userId, friendId: userId, status: 'blocked' })
        .onConflictDoUpdate({
          target: [friendships.userId, friendships.friendId],
          set: { status: 'blocked', updatedAt: ctx.now() },
        });
    });
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
    return reply.code(204).send();
  });

  app.get('/friends/recent', async (req) => {
    const auth = await requireUser(ctx, req);
    const recentMatches = await ctx.db
      .select({ id: matches.id })
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
    const ids = [
      ...new Set(rows.flatMap((r) => (r.userId && r.userId !== auth.userId ? [r.userId] : []))),
    ].slice(0, 50);
    const info = await names(ctx.db, ids);
    return {
      players: ids.map((id) => ({
        userId: id,
        ...(info.get(id) ?? { displayName: 'Unknown', tag: '0000', level: 1 }),
      })),
    };
  });

  app.post('/presence', async (req) => {
    const auth = await requireUser(ctx, req);
    const { status } = parse(PresenceBody, req.body);
    await setPresence(ctx.kv, auth.userId, status, ctx.now().getTime());
    await ctx.notifier.notifyMany(await friendIds(ctx.db, auth.userId), {
      type: 'presence',
      userId: auth.userId,
      status,
    });
    return { status };
  });
}
