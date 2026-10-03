/**
 * In-show chat relay.
 *
 * Responsibilities:
 * - quick chat: only `@tumble/shared` preset ids are relayed, as the preset text;
 * - text chat: sanitised, slurs always masked, plus a fully masked variant for
 *   players with the chat filter on (see `filterChat`);
 * - per-player rate limit that survives reconnects (the per-connection guard
 *   resets with each new socket);
 * - chat bans: text from chat-banned accounts is dropped.
 */
import type { ChatMsg } from '@tumble/netcode';
import { filterChat, quickChat } from '@tumble/shared';
import { TokenBucket } from './antiCheat.ts';

/** Per-player chat limits. */
export interface ChatLimits {
  /** Sustained messages per second. */
  perSec: number;
  /** Burst size. */
  burst: number;
}

/** One message per two seconds sustained, five in a burst. */
export const DEFAULT_CHAT_LIMITS: ChatLimits = { perSec: 0.5, burst: 5 };

/** Outcome of {@link ChatRelay.handle}. */
export type ChatOutcome =
  | { kind: 'relay'; msg: ChatMsg }
  /** Dropped quietly (rate limited, chat-banned, empty). */
  | { kind: 'drop'; reason: 'rate' | 'banned' | 'empty' }
  /** Malformed: counts as a protocol violation. */
  | { kind: 'violation' };

/**
 * Decides what (if anything) to broadcast for a client's chat message.
 *
 * @example
 * const chat = new ChatRelay();
 * chat.register(slot.id, { chatBanned: ticket?.chatBanned ?? false }, now);
 * const out = chat.handle(slot.id, msg, now);
 * if (out.kind === 'relay') room.broadcast(out.msg);
 */
export class ChatRelay {
  private readonly players = new Map<number, { bucket: TokenBucket; chatBanned: boolean }>();

  constructor(private readonly limits: ChatLimits = DEFAULT_CHAT_LIMITS) {}

  /**
   * Registers (or re-registers) a player. Re-registering keeps the bucket so a
   * reconnect does not refill it.
   */
  register(id: number, opts: { chatBanned: boolean }, now: number): void {
    const cur = this.players.get(id);
    if (cur) cur.chatBanned = opts.chatBanned;
    else
      this.players.set(id, {
        bucket: new TokenBucket(this.limits.perSec, this.limits.burst, now),
        chatBanned: opts.chatBanned,
      });
  }

  /** Forgets a player (slot freed). */
  remove(id: number): void {
    this.players.delete(id);
  }

  /**
   * HOOK: chat bans. Text chat is refused for accounts whose join ticket
   * carries `chatBanned: true`. Quick-chat presets stay allowed: they are fixed
   * gameplay callouts and cannot carry abuse.
   */
  canSendText(id: number): boolean {
    return !(this.players.get(id)?.chatBanned ?? false);
  }

  /**
   * Validates, rate-limits and filters one client chat message.
   *
   * @param id - Sender's player id.
   * @param msg - Untrusted message.
   * @param now - Current time (ms).
   */
  handle(id: number, msg: Partial<ChatMsg>, now: number): ChatOutcome {
    const p = this.players.get(id);
    if (!p) return { kind: 'drop', reason: 'empty' };
    if (msg.quick !== undefined) {
      const preset = quickChat(msg.quick);
      if (!preset) return { kind: 'violation' };
      if (!p.bucket.take(now)) return { kind: 'drop', reason: 'rate' };
      return { kind: 'relay', msg: { t: 'chat', from: id, text: preset.text, quick: preset.id } };
    }
    if (!this.canSendText(id)) return { kind: 'drop', reason: 'banned' };
    const filtered = filterChat(msg.text);
    if (!filtered) return { kind: 'drop', reason: 'empty' };
    if (!p.bucket.take(now)) return { kind: 'drop', reason: 'rate' };
    return { kind: 'relay', msg: { t: 'chat', from: id, ...filtered } };
  }
}
