/**
 * Global chat: one public room for everyone connected to the realtime
 * gateway, so a player can just type and talk without picking anyone.
 *
 * Responsibilities:
 * - {@link sendGlobalChat}: chat-ban check, the posting requirement (a linked
 *   sign-in, or a guest account at least `GLOBAL_CHAT_MIN_ACCOUNT_AGE_MINUTES`
 *   old), the shared chat filter (slurs always masked, a fully masked copy for
 *   players with the filter on) and KV rate limits per account and per client
 *   IP, then a publish on {@link GLOBAL_CHAT_CHANNEL};
 * - {@link GlobalChatRoom}: each gateway subscribes once, fans every line out
 *   to all of its sockets and keeps the last {@link GLOBAL_CHAT_HISTORY}
 *   lines so a fresh connection doesn't open on an empty room, minus lines of
 *   accounts since banned or deleted ({@link GlobalChatRoom.forget}).
 *
 * Blocks are applied by the client (it already hides blocked and muted
 * players everywhere), which keeps the fan-out a single publish instead of a
 * per-recipient block lookup on every line.
 *
 * NOTE: one room for now; per-region rooms would key the channel and history
 * by region.
 */
import { randomUUID } from 'node:crypto';
import { filterChat } from '@tumble/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { users } from '../db/schema.ts';
import { activeBans } from '../http/auth.ts';
import { hitWindow } from '../http/rate-limit.ts';
import { requireFlag } from '../liveops/state.ts';
import { ApiError, badRequest, forbidden } from '../http/errors.ts';
import type { KV } from '../kv/index.ts';
import type { SocialRef } from '../realtime/notifier.ts';
import { rememberChatLine } from './chatEvidence.ts';
import { socialRef } from './friends.ts';

/** Lines one account may send per {@link GLOBAL_CHAT_WINDOW_MS}. */
export const GLOBAL_CHAT_MAX = 5;
/** Rate-limit window. */
export const GLOBAL_CHAT_WINDOW_MS = 10_000;
/** Recent lines replayed to each new connection. */
export const GLOBAL_CHAT_HISTORY = 50;
/** KV pub/sub channel every gateway listens on. */
export const GLOBAL_CHAT_CHANNEL = 'chat:global';

/** A relayed global chat line. */
export interface GlobalChatLine {
  /** Unique id (clients dedupe history against live lines with it). */
  id: string;
  from: SocialRef;
  /** Slurs masked; shown with the chat filter off. */
  text: string;
  /** Fully masked copy, when it differs from `text`. */
  masked?: string;
  /** Epoch ms. */
  at: number;
}

/**
 * Sends one line to the global room.
 *
 * @param ctx - Shared services.
 * @param userId - Sender.
 * @param raw - Untrusted text.
 * @param ip - Sender's client address, for the cap shared by every account
 *   on it; server-side callers omit it.
 * @returns The relayed line.
 * @throws {ApiError} 403 `chat_banned` / `chat_too_new`, 400 `empty_message`,
 *   429 `chat_rate`.
 * @example
 * await sendGlobalChat(ctx, auth.userId, 'hi all', clientAddress);
 */
export async function sendGlobalChat(
  ctx: AppContext,
  userId: string,
  raw: unknown,
  ip?: string,
): Promise<GlobalChatLine> {
  await requireFlag(ctx, 'chat.global', 'Global chat is switched off right now');
  const bans = await activeBans(ctx, userId);
  if (bans.some((b) => b.scope === 'chat' || b.scope === 'all'))
    throw forbidden('chat_banned', 'Chat is disabled on this account');
  const filtered = filterChat(raw);
  if (!filtered) throw badRequest('empty_message', 'Say something first');
  const now = ctx.now().getTime();
  await requireSeasonedAccount(ctx, userId, now);
  const window = Math.floor(now / GLOBAL_CHAT_WINDOW_MS);
  const count = await ctx.kv.incr(`global-chat-rate:${userId}:${window}`, GLOBAL_CHAT_WINDOW_MS * 2);
  if (count > GLOBAL_CHAT_MAX) throw new ApiError(429, 'chat_rate', 'Slow down a little');
  // SECURITY: per-account limits multiply with every guest minted, so one
  // address also shares a budget across all of its accounts.
  const ipMax = ctx.config.abuse.globalChatIpMax;
  if (ip && !(await hitWindow(ctx.kv, `global-chat:ip:${ip}`, ipMax, GLOBAL_CHAT_WINDOW_MS, now)))
    throw new ApiError(429, 'chat_rate', 'Slow down a little');
  const line: GlobalChatLine = {
    id: randomUUID(),
    from: await socialRef(ctx.db, userId),
    ...filtered,
    at: now,
  };
  await ctx.kv.publish(GLOBAL_CHAT_CHANNEL, JSON.stringify(line));
  await rememberChatLine(ctx.kv, userId, { channel: 'global', text: line.text, at: now });
  return line;
}

/**
 * Refuses throwaway accounts: a guest must have existed for
 * `GLOBAL_CHAT_MIN_ACCOUNT_AGE_MINUTES` before it may post, so a chat ban
 * cannot be shrugged off by minting a fresh guest. Accounts with a linked
 * sign-in (email or OAuth) are not guests and may post at once.
 */
async function requireSeasonedAccount(ctx: AppContext, userId: string, now: number): Promise<void> {
  const minAge = ctx.config.abuse.globalChatMinAccountAgeMs;
  if (minAge <= 0) return;
  const [u] = await ctx.db
    .select({ isGuest: users.isGuest, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!u?.isGuest) return;
  const waitMs = u.createdAt.getTime() + minAge - now;
  if (waitMs > 0)
    throw forbidden(
      'chat_too_new',
      `New guest accounts can post in global chat in ${Math.ceil(waitMs / 60_000)} min, or right away after linking a sign-in`,
    );
}

/**
 * One gateway's view of the global room: a single KV subscription fanned out
 * to every local socket, plus the recent history.
 *
 * @example
 * const room = new GlobalChatRoom((line) => broadcast({ type: 'global_chat', ...line }));
 * await room.start(ctx.kv);
 */
export class GlobalChatRoom {
  private readonly recent: GlobalChatLine[] = [];
  private unsubscribe: (() => Promise<void>) | null = null;

  /**
   * @param deliver - Called once per line with every local socket as the audience.
   */
  constructor(private readonly deliver: (line: GlobalChatLine) => void) {}

  /** Subscribes to the room channel. */
  async start(kv: KV): Promise<void> {
    this.unsubscribe = await kv.subscribe(GLOBAL_CHAT_CHANNEL, (msg) => {
      let line: GlobalChatLine;
      try {
        line = JSON.parse(msg) as GlobalChatLine;
      } catch {
        return;
      }
      this.recent.push(line);
      if (this.recent.length > GLOBAL_CHAT_HISTORY) this.recent.shift();
      this.deliver(line);
    });
  }

  /**
   * Drops a sender's lines from the history replayed to new connections,
   * after they were banned or deleted their account.
   *
   * @param userId - Sender to forget.
   */
  forget(userId: string): void {
    for (let i = this.recent.length - 1; i >= 0; i--)
      if (this.recent[i]!.from.userId === userId) this.recent.splice(i, 1);
  }

  /** The last {@link GLOBAL_CHAT_HISTORY} lines, oldest first. */
  history(): GlobalChatLine[] {
    return this.recent.slice();
  }

  /** Drops the subscription. */
  async stop(): Promise<void> {
    await this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
