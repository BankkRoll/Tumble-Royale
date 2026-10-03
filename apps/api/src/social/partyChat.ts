/**
 * Party chat: text between party members in the menu, relayed through the
 * realtime gateway (`party_chat` events).
 *
 * Every line is sanitised and filtered with the shared chat filter (slurs
 * always masked, a fully masked copy for players with the filter on), rate
 * limited per account in KV so it holds across tabs and API instances, refused
 * for chat- or fully-banned accounts, and never delivered to members who
 * blocked the sender (or whom the sender blocked).
 */
import { randomUUID } from 'node:crypto';
import { filterChat } from '@tumble/shared';
import type { AppContext } from '../context.ts';
import { activeBans } from '../http/auth.ts';
import { ApiError, badRequest, forbidden, notFound } from '../http/errors.ts';
import type { PartyChatLine } from '../realtime/notifier.ts';
import { blockedEitherWay } from './friends.ts';
import type { PartyService } from './party.ts';

/** Lines allowed per {@link PARTY_CHAT_WINDOW_MS}. */
export const PARTY_CHAT_MAX = 6;
/** Rate-limit window. */
export const PARTY_CHAT_WINDOW_MS = 10_000;

/**
 * Sends one party chat line.
 *
 * @param ctx - Shared services.
 * @param parties - Party store.
 * @param userId - Sender.
 * @param raw - Untrusted text.
 * @returns The relayed line (as the sender sees it).
 * @throws {ApiError} 404 no party, 403 `chat_banned`, 400 `empty_message`, 429 `chat_rate`.
 */
export async function sendPartyChat(
  ctx: AppContext,
  parties: PartyService,
  userId: string,
  raw: unknown,
): Promise<PartyChatLine> {
  const party = await parties.current(userId);
  if (!party) throw notFound('Party');
  const bans = await activeBans(ctx, userId);
  if (bans.some((b) => b.scope === 'chat' || b.scope === 'all'))
    throw forbidden('chat_banned', 'Chat is disabled on this account');
  const filtered = filterChat(raw);
  if (!filtered) throw badRequest('empty_message', 'Say something first');
  const now = ctx.now().getTime();
  const window = Math.floor(now / PARTY_CHAT_WINDOW_MS);
  const count = await ctx.kv.incr(`party-chat-rate:${userId}:${window}`, PARTY_CHAT_WINDOW_MS * 2);
  if (count > PARTY_CHAT_MAX) throw new ApiError(429, 'chat_rate', 'Slow down a little');
  const me = party.members.find((m) => m.userId === userId)!;
  const line: PartyChatLine = {
    id: randomUUID(),
    partyId: party.id,
    from: { userId, name: me.displayName, tag: me.tag },
    ...filtered,
    at: now,
  };
  const hidden = await blockedEitherWay(ctx.db, userId);
  await ctx.notifier.notifyMany(
    party.members.map((m) => m.userId).filter((id) => !hidden.has(id)),
    { type: 'party_chat', ...line },
  );
  return line;
}
