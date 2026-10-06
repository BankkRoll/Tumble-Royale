/**
 * Club chat: one channel per club, relayed through the realtime gateway
 * (`club_chat` events) like party chat, and persisted briefly so a member who
 * opens the chat sees the conversation they missed.
 *
 * Every line goes through the same gates as the other channels: the
 * `clubs.enabled` kill switch, chat and full bans (read through the shared
 * ban cache, which every instance drops the moment a moderator acts), the
 * shared chat filter (slurs always masked, a fully masked copy for players
 * with the filter on) and a per-account KV rate limit that holds across tabs
 * and API instances. Members who blocked the sender, or whom the sender
 * blocked, never receive the line, live or in history.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { CLUB_CHAT_HISTORY, clubCan, filterChat } from '@tumble/shared';
import type { AppContext } from '../context.ts';
import { clubMessages, clubs, profiles } from '../db/schema.ts';
import { activeBans } from '../http/auth.ts';
import { ApiError, badRequest, forbidden } from '../http/errors.ts';
import { requireFlag } from '../liveops/state.ts';
import type { ClubChatLine } from '../realtime/notifier.ts';
import { rememberChatLine } from '../social/chatEvidence.ts';
import { blockedEitherWay, socialRef } from '../social/friends.ts';
import { clubMemberIds, liveClub, requireMembership } from './service.ts';

/** Lines one account may send per {@link CLUB_CHAT_WINDOW_MS}. */
export const CLUB_CHAT_MAX = 6;
/** Rate-limit window. */
export const CLUB_CHAT_WINDOW_MS = 10_000;

/** Message shown while operators have clubs switched off. */
export const CLUBS_OFF_MESSAGE = 'Clubs are switched off right now';

/**
 * Sends one line to the caller's club.
 *
 * @param ctx - Shared services.
 * @param userId - Sender.
 * @param raw - Untrusted text.
 * @returns The relayed line.
 * @throws {ApiError} 503 `feature_disabled`, 404 not in a club, 403 `chat_banned`,
 *   400 `empty_message`, 429 `chat_rate`.
 * @example
 * await sendClubChat(ctx, auth.userId, 'anyone up for a show?');
 */
export async function sendClubChat(ctx: AppContext, userId: string, raw: unknown): Promise<ClubChatLine> {
  await requireFlag(ctx, 'clubs.enabled', CLUBS_OFF_MESSAGE);
  const m = await requireMembership(ctx.db, userId);
  if (!clubCan(m.role, 'chat')) throw forbidden('club_role', 'You cannot chat in this club');
  const bans = await activeBans(ctx, userId);
  if (bans.some((b) => b.scope === 'chat' || b.scope === 'all'))
    throw forbidden('chat_banned', 'Chat is disabled on this account');
  const filtered = filterChat(raw);
  if (!filtered) throw badRequest('empty_message', 'Say something first');
  const now = ctx.now();
  const window = Math.floor(now.getTime() / CLUB_CHAT_WINDOW_MS);
  const count = await ctx.kv.incr(`club-chat-rate:${userId}:${window}`, CLUB_CHAT_WINDOW_MS * 2);
  if (count > CLUB_CHAT_MAX) throw new ApiError(429, 'chat_rate', 'Slow down a little');
  const [row] = await ctx.db
    .insert(clubMessages)
    .values({
      clubId: m.clubId,
      userId,
      text: filtered.text,
      masked: filtered.masked ?? null,
      createdAt: now,
    })
    .returning({ id: clubMessages.id });
  await ctx.db
    .update(clubs)
    .set({ lastActivityAt: now })
    .where(and(eq(clubs.id, m.clubId), sql`${clubs.lastActivityAt} < ${now}`));
  const line: ClubChatLine = {
    id: String(row!.id),
    clubId: m.clubId,
    from: await socialRef(ctx.db, userId),
    ...filtered,
    at: now.getTime(),
  };
  const hidden = await blockedEitherWay(ctx.db, userId);
  const members = await clubMemberIds(ctx.db, m.clubId);
  await ctx.notifier.notifyMany(
    members.filter((id) => !hidden.has(id)),
    { type: 'club_chat', ...line },
  );
  await rememberChatLine(ctx.kv, userId, {
    channel: 'club',
    text: line.text,
    at: line.at,
    club: m.clubId,
  });
  return line;
}

/**
 * The newest {@link CLUB_CHAT_HISTORY} lines of a club, oldest first, minus
 * senders the viewer blocked or was blocked by.
 *
 * @param ctx - Shared services.
 * @param clubId - Club.
 * @param viewerId - Who is reading (a member; the caller checked).
 */
export async function clubChatHistory(
  ctx: AppContext,
  clubId: string,
  viewerId: string,
): Promise<ClubChatLine[]> {
  await liveClub(ctx.db, clubId);
  const rows = await recentClubMessages(ctx, clubId, CLUB_CHAT_HISTORY);
  const hidden = await blockedEitherWay(ctx.db, viewerId);
  return rows.filter((l) => !hidden.has(l.from.userId));
}

/**
 * Recent club chat with sender names, oldest first (history and moderator evidence).
 *
 * @param ctx - Shared services.
 * @param clubId - Club (live or disbanded).
 * @param limit - Most lines.
 */
export async function recentClubMessages(
  ctx: AppContext,
  clubId: string,
  limit: number,
): Promise<ClubChatLine[]> {
  const rows = await ctx.db
    .select({
      id: clubMessages.id,
      userId: clubMessages.userId,
      text: clubMessages.text,
      masked: clubMessages.masked,
      createdAt: clubMessages.createdAt,
      name: profiles.displayName,
      tag: profiles.tag,
    })
    .from(clubMessages)
    .leftJoin(profiles, eq(profiles.userId, clubMessages.userId))
    .where(eq(clubMessages.clubId, clubId))
    .orderBy(desc(clubMessages.id))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: String(r.id),
    clubId,
    from: { userId: r.userId, name: r.name ?? 'Unknown', tag: r.tag ?? '0000' },
    text: r.text,
    ...(r.masked ? { masked: r.masked } : {}),
    at: r.createdAt.getTime(),
  }));
}
