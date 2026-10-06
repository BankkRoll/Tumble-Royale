/**
 * Account deletion (`DELETE /me`).
 *
 * Responsibilities:
 * - Delete the user row and, through `ON DELETE CASCADE`, everything keyed to
 *   it: identities, sessions, profile, stats, inventory, loadouts, ledger,
 *   purchases, pass/challenge progress, ratings, friendships, reports, bans.
 * - Keep active bans as hashed-identifier marks (`moderation/ban-evasion.ts`)
 *   so a new account with the same login, email or device inherits them.
 * - Anonymise the player in other people's match history (names and stored
 *   reward summaries) and in club report evidence, and drop their
 *   analytics events (no foreign keys there).
 * - Clear KV state: party membership, presence, live leaderboard rows and
 *   recent chat kept as report evidence.
 * - Leave a short-lived tombstone so access tokens minted before the deletion
 *   stop working immediately instead of at their 15-minute expiry.
 * - Leave the player's club first: an owner's club passes to the
 *   longest-serving officer (else member); a club left empty is disbanded.
 * - Settle gifts: unopened gifts to the account go back to their senders,
 *   notes the account wrote are erased (`economy/gifts.ts`).
 * - Write an audit event.
 */
import { eq, sql } from 'drizzle-orm';
import { notifyClub, removeMember } from '../clubs/service.ts';
import type { AppContext } from '../context.ts';
import { clubReports, events, matches, matchParticipants, users } from '../db/schema.ts';
import { announceErasedGifts, settleGiftsOnErasure } from '../economy/gifts.ts';
import { invalidateBanCache } from '../http/auth.ts';
import { notFound } from '../http/errors.ts';
import { removeFromLeaderboards } from '../leaderboards/service.ts';
import { retainBans } from '../moderation/ban-evasion.ts';
import { forgetChatLines } from '../social/chatEvidence.ts';
import { forgetVoice } from '../voice/service.ts';
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
  const { removal: club, settled: gifts } = await ctx.db.transaction(async (tx) => {
    // Transaction-local; lets the ledger trigger accept this user's cascade (migration 0002).
    await tx.execute(sql`select set_config('tumble.erase_user', ${userId}, true)`);
    // Before the cascade: an owner's club passes to the next in line rather than losing its owner.
    const removal = await removeMember(tx, userId, now);
    // The show's stored reward summaries (replayed to game servers) name the
    // player too; only shows they were in need rewriting.
    await tx.execute(sql`
      update ${matches} set rewards = coalesce((
        select jsonb_agg(e order by ord) from jsonb_array_elements(${matches.rewards}) with ordinality as x(e, ord)
        where e->>'userId' is distinct from ${userId}
      ), '[]'::jsonb)
      where ${matches.id} in (
        select ${matchParticipants.matchId} from ${matchParticipants} where ${matchParticipants.userId} = ${userId}
      )`);
    // Club reports keep recent club chat as evidence; the player's lines go with them.
    await tx.execute(sql`
      update ${clubReports} set evidence = (
        select jsonb_agg(e order by ord) from jsonb_array_elements(${clubReports.evidence}) with ordinality as x(e, ord)
        where e->'from'->>'userId' is distinct from ${userId}
      )
      where ${clubReports.evidence} @> jsonb_build_array(jsonb_build_object('from', jsonb_build_object('userId', ${userId}::text)))`);
    await tx
      .update(matchParticipants)
      .set({ userId: null, name: DELETED_PLAYER_NAME })
      .where(eq(matchParticipants.userId, userId));
    await tx.delete(events).where(eq(events.userId, userId));
    // SECURITY: bans cascade away with the user row; keep them, keyed by
    // hashed identifiers, so deleting the account is no way out of a ban.
    await retainBans(tx, ctx, userId);
    // Before the cascade, while the senders of unopened gifts can still be refunded.
    const settled = await settleGiftsOnErasure(tx, ctx, userId);
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
    return { removal, settled };
  });

  await markErased(ctx.kv, userId);
  await forgetChatLines(ctx.kv, userId);
  await forgetVoice(ctx, userId);
  await invalidateBanCache(ctx, userId);
  await setPresence(ctx.kv, userId, 'offline', now.getTime());
  await removeFromLeaderboards(ctx, userId);
  await ctx.notifier.notifyMany(friends, { type: 'friend_removed', userId });
  if (club && !club.disbanded) {
    await notifyClub(ctx, club.clubId, { type: 'club_update', clubId: club.clubId });
    if (club.newOwnerId)
      await ctx.notifier.notifyUser(club.newOwnerId, {
        type: 'notification',
        kind: 'info',
        title: `You now own ${club.clubName}`,
        body: 'The previous owner left the club.',
      });
  }
  await announceErasedGifts(ctx, gifts);
}
