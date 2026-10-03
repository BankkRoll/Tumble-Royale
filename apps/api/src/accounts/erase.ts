/**
 * Account deletion (`DELETE /me`).
 *
 * Responsibilities:
 * - Delete the user row and, through `ON DELETE CASCADE`, everything keyed to
 *   it: identities, sessions, profile, stats, inventory, loadouts, ledger,
 *   purchases, pass/challenge progress, ratings, friendships, reports, bans.
 * - Anonymise the player in other people's match history and drop their
 *   analytics events (no foreign keys there).
 * - Clear KV state: party membership, presence and live leaderboard rows.
 * - Leave a short-lived tombstone so access tokens minted before the deletion
 *   stop working immediately instead of at their 15-minute expiry.
 * - Write an audit event.
 */
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { events, matchParticipants, users } from '../db/schema.ts';
import { notFound } from '../http/errors.ts';
import { removeFromLeaderboards } from '../leaderboards/service.ts';
import { friendIds } from '../social/friends.ts';
import { PartyService } from '../social/party.ts';
import { setPresence } from '../social/presence.ts';
import { markErased } from './tombstone.ts';

/** Name shown in match history for a deleted player. */
export const DELETED_PLAYER_NAME = 'Deleted player';

/**
 * Permanently deletes an account and everything it owns.
 *
 * @param ctx - Shared services.
 * @param userId - The account to delete.
 * @param audit - Request context recorded in the audit event.
 * @throws {ApiError} 404 when the user does not exist.
 */
export async function deleteAccount(
  ctx: AppContext,
  userId: string,
  audit: { ip: string; userAgent?: string | undefined },
): Promise<void> {
  const [user] = await ctx.db
    .select({ region: users.region, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound('User');
  const friends = await friendIds(ctx.db, userId);
  await new PartyService(ctx).leave(userId);

  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    // Transaction-local; lets the ledger trigger accept this user's cascade (migration 0002).
    await tx.execute(sql`select set_config('tumble.erase_user', ${userId}, true)`);
    await tx
      .update(matchParticipants)
      .set({ userId: null, name: DELETED_PLAYER_NAME })
      .where(eq(matchParticipants.userId, userId));
    await tx.delete(events).where(eq(events.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
    await tx.insert(events).values({
      userId,
      name: 'audit.account_deleted',
      props: {
        at: now.toISOString(),
        accountCreatedAt: user.createdAt.toISOString(),
        ip: audit.ip,
        userAgent: audit.userAgent?.slice(0, 256) ?? null,
      },
      createdAt: now,
    });
  });

  await markErased(ctx.kv, userId);
  await setPresence(ctx.kv, userId, 'offline', now.getTime());
  await removeFromLeaderboards(ctx, userId, user.region);
  await ctx.notifier.notifyMany(friends, { type: 'friend_removed', userId });
}
