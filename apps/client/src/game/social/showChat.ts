/**
 * In-show chat for one show session.
 *
 * Responsibilities:
 * - quick pings (emote wheel, winner cam) and typed chat from the UI intents;
 * - online: sends through the game server (preset ids only for pings) and
 *   shows what the server relays, own lines included, so everyone sees the
 *   same filtered text;
 * - offline: shows the player's ping locally and lets a couple of seeded bots
 *   answer (cosmetic only; the sim never sees it);
 * - pushes lines to the HUD feed and speech bubbles over Tumblers, hiding
 *   anything the viewer muted, blocked or switched off;
 * - owns the widget's Show tab while the show runs (typing only online with
 *   other humans).
 */
import type { ChatMsg } from '@tumble/netcode';
import { quickChat, Rng, sanitizeChatText } from '@tumble/shared';
import { bindUI, social, ui, visibleChat, type ChatLine } from '@tumble/ui';
import { bubbleText, muteKey, planBotReplies, quickChatId } from './chatLogic.ts';
import { setChannel, setChatRoute } from './chatRouter.ts';

/** A participant as the chat needs it. */
export interface ChatPlayer {
  name: string;
  isBot: boolean;
  userId?: string;
  /** Body colour for the name in the feed. */
  color?: string;
}

/** What the show session provides. */
export interface ShowChatHost {
  localId(): number;
  player(id: number): ChatPlayer | undefined;
  /** Bots that may answer pings (offline). */
  botIds(): number[];
  /** Speech bubble over a Tumbler, when that Tumbler is on screen. */
  bubble(id: number, text: string): void;
}

/** Minimum gap between rounds of bot replies, so spamming pings doesn't spam bots. */
const BOT_REPLY_COOLDOWN_MS = 4000;

/**
 * The chat of one show.
 *
 * @example
 * const chat = new ShowChat(host, showSeed);
 * chat.setTransport((m) => net.sendLowFreq(m)); // online only
 * net.on('chat', (m) => chat.receive(m));
 */
export class ShowChat {
  private send: ((m: ChatMsg) => void) | null = null;
  private rng: Rng;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly offs: (() => void)[] = [];
  private lastBotReplies = -Infinity;
  private seq = 0;

  constructor(
    private readonly host: ShowChatHost,
    seed: number,
  ) {
    // Its own stream: bot chatter must never shift the sim's randomness.
    this.rng = new Rng((seed ^ 0x5c4a7) >>> 0);
    // Offline (until a transport arrives) the Show tab carries pings only.
    setChannel('show', false);
    setChannel('show', true, false);
    setChatRoute('show', (text) => this.sendText(text));
    this.offs.push(bindUI({ onQuickPing: ({ kind }) => this.quick(kind) }));
  }

  /**
   * Re-seeds the cosmetic RNG once the show seed is known (offline).
   *
   * @param seed - Show seed.
   */
  reseed(seed: number): void {
    this.rng = new Rng((seed ^ 0x5c4a7) >>> 0);
  }

  /**
   * Routes chat through the game server (online shows).
   *
   * @param send - Low-frequency message sender.
   */
  setTransport(send: (m: ChatMsg) => void): void {
    this.send = send;
  }

  /** Lets players type in the Show tab (online shows with other humans). */
  setTextEnabled(on: boolean): void {
    setChannel('show', true, on && this.send !== null);
  }

  /**
   * Sends a quick ping.
   *
   * @param kind - `quickPing` intent kind.
   */
  quick(kind: string): void {
    const id = quickChatId(kind);
    const preset = id ? quickChat(id) : undefined;
    if (!id || !preset) return;
    if (this.send) {
      this.send({ t: 'chat', from: -1, text: '', quick: id });
      return;
    }
    this.show(this.host.localId(), { text: preset.text, quick: id });
    this.scheduleBotReplies(id);
  }

  /**
   * Sends typed chat (online only; offline there is no one to read it).
   *
   * @param text - Raw input.
   */
  sendText(text: string): void {
    if (!this.send || !social.getState().chat.writable.show) return;
    const clean = sanitizeChatText(text);
    if (clean) this.send({ t: 'chat', from: -1, text: clean });
  }

  /**
   * Shows a message relayed by the game server.
   *
   * @param m - Relayed chat.
   */
  receive(m: Omit<ChatMsg, 't'>): void {
    this.show(m.from, m);
  }

  private show(
    id: number,
    m: { text: string; masked?: string | undefined; quick?: string | undefined },
  ): void {
    const p = this.host.player(id);
    const self = id === this.host.localId();
    const name = p?.name ?? 'Tumbler';
    const line: ChatLine = {
      id: `c${++this.seq}`,
      from: {
        name,
        key: muteKey({ userId: p?.userId, name }),
        ...(p?.userId ? { userId: p.userId } : {}),
        ...(p?.isBot ? { isBot: true } : {}),
      },
      text: m.text,
      ...(m.masked ? { masked: m.masked } : {}),
      ...(m.quick ? { quick: m.quick } : {}),
      ...(self ? { self: true } : {}),
      at: Date.now(),
      ...(p?.color ? { color: p.color } : {}),
    };
    social.getState().pushChat(line);
    const s = social.getState();
    const [shown] = visibleChat([line], {
      showChat: ui.getState().settings.gameplay.showChat,
      filter: ui.getState().settings.gameplay.chatFilter,
      muted: s.muted,
      blocked: s.blocked.map((b) => b.userId),
    });
    if (shown) this.host.bubble(id, bubbleText(shown.display));
  }

  private scheduleBotReplies(trigger: string): void {
    const now = Date.now();
    if (now - this.lastBotReplies < BOT_REPLY_COOLDOWN_MS) return;
    const replies = planBotReplies(this.rng, trigger, this.host.botIds());
    if (replies.length === 0) return;
    this.lastBotReplies = now;
    for (const r of replies) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        const preset = quickChat(r.presetId);
        if (preset && this.host.player(r.botId)) this.show(r.botId, { text: preset.text, quick: preset.id });
      }, r.delayMs);
      this.timers.add(t);
    }
  }

  /** Stops timers and listeners; clears the feed. */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const off of this.offs) off();
    this.offs.length = 0;
    setChatRoute('show', null);
    setChannel('show', false);
  }
}
