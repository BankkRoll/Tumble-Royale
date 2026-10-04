/**
 * Global chat: one public room for everyone connected to the realtime
 * gateway, so a player can just type and talk without picking anyone.
 *
 * Responsibilities:
 * - {@link sendGlobalChat}: chat-ban check, the shared chat filter (slurs
 *   always masked, a fully masked copy for players with the filter on) and a
 *   per-account KV rate limit, then a publish on {@link GLOBAL_CHAT_CHANNEL};
 * - {@link GlobalChatRoom}: each gateway subscribes once, fans every line out
 *   to all of its sockets and keeps the last {@link GLOBAL_CHAT_HISTORY}
 *   lines so a fresh connection doesn't open on an empty room.
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
import type { AppContext } from '../context.ts';
import { activeBans } from '../http/auth.ts';
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
 * @returns The relayed line.
 * @throws {ApiError} 403 `chat_banned`, 400 `empty_message`, 429 `chat_rate`.
 * @example
 * await sendGlobalChat(ctx, auth.userId, 'hi all');
 */
export async function sendGlobalChat(ctx: AppContext, userId: string, raw: unknown): Promise<GlobalChatLine> {
  await requireFlag(ctx, 'chat.global', 'Global chat is switched off right now');
  const bans = await activeBans(ctx, userId);
  if (bans.some((b) => b.scope === 'chat' || b.scope === 'all'))
    throw forbidden('chat_banned', 'Chat is disabled on this account');
  const filtered = filterChat(raw);
  if (!filtered) throw badRequest('empty_message', 'Say something first');
  const now = ctx.now().getTime();
  const window = Math.floor(now / GLOBAL_CHAT_WINDOW_MS);
  const count = await ctx.kv.incr(`global-chat-rate:${userId}:${window}`, GLOBAL_CHAT_WINDOW_MS * 2);
  if (count > GLOBAL_CHAT_MAX) throw new ApiError(429, 'chat_rate', 'Slow down a little');
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
