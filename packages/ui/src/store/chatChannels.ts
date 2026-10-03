/**
 * Global chat: channels, unread counts and the input's slash commands, as pure
 * functions so the widget, the client router and tests share one set of rules.
 *
 * Channels:
 * - `show`: everyone in the current show or its pre-show lobby (game server);
 * - `lobby`: members of a private-show lobby (matchmaker);
 * - `party`: party members (account API);
 * - `whisper`: direct messages with friends (account API);
 * - `system`: local notices (joins, leaves, kicks, party events, command help).
 */
import type { PlayerRef } from './social.ts';

/** A chat channel (tab). */
export type ChatChannel = 'show' | 'lobby' | 'party' | 'whisper' | 'system';

/** Tab order (also the order Tab cycles through). */
export const CHANNEL_ORDER: readonly ChatChannel[] = ['show', 'lobby', 'party', 'whisper', 'system'];

/** Tab labels: words only. */
export const CHANNEL_LABEL: Readonly<Record<ChatChannel, string>> = {
  show: 'Show',
  lobby: 'Lobby',
  party: 'Party',
  whisper: 'Whispers',
  system: 'System',
};

/** One chat line. */
export interface ChatLine {
  id: string;
  /** Channel the line belongs to (default `show`). */
  channel?: ChatChannel;
  from: PlayerRef;
  /** Whisper recipient (outgoing whispers show "To <name>"). */
  to?: PlayerRef;
  /** Text with slurs masked (filter off). */
  text: string;
  /** Fully masked text, when it differs (filter on). */
  masked?: string;
  /** Quick-chat preset id; such lines are pings, not typed text. */
  quick?: string;
  /** Sent by the local player. */
  self?: boolean;
  /** Epoch ms received. */
  at: number;
  /** Accent colour (the sender's Tumbler). */
  color?: string;
}

/** A player you can whisper. */
export interface WhisperTarget {
  userId: string;
  name: string;
}

/** Chat widget state. */
export interface ChatState {
  /** Every channel's lines, oldest first. */
  lines: ChatLine[];
  /** Channels that exist in the current context (tabs shown). */
  available: Readonly<Record<ChatChannel, boolean>>;
  /** Channels the player can type into right now. */
  writable: Readonly<Record<ChatChannel, boolean>>;
  active: ChatChannel;
  unread: Readonly<Record<ChatChannel, number>>;
  /** The input is open. */
  open: boolean;
  /** `quick`: preset picker (gamepad) instead of the text field. */
  mode: 'text' | 'quick';
  /** Who `/r` answers: the last friend who whispered you. */
  replyTo: WhisperTarget | null;
  /** Who the Whispers tab is talking to. */
  whisperTo: WhisperTarget | null;
}

/** Lines kept across all channels. */
export const CHAT_KEEP = 200;

const none = (): Record<ChatChannel, number> => ({ show: 0, lobby: 0, party: 0, whisper: 0, system: 0 });
const flags = (on: ChatChannel[]): Record<ChatChannel, boolean> => ({
  show: on.includes('show'),
  lobby: on.includes('lobby'),
  party: on.includes('party'),
  whisper: on.includes('whisper'),
  system: on.includes('system'),
});

/** Fresh state: only System exists. */
export const INITIAL_CHAT: ChatState = {
  lines: [],
  available: flags(['system']),
  writable: flags([]),
  active: 'system',
  unread: none(),
  open: false,
  mode: 'text',
  replyTo: null,
  whisperTo: null,
};

/** Everything that changes chat state. */
export type ChatAction =
  | { type: 'receive'; line: ChatLine }
  /** Turns a channel on or off; `writable` defaults to `on`. */
  | { type: 'available'; channel: ChatChannel; on: boolean; writable?: boolean }
  | { type: 'clear'; channel: ChatChannel }
  | { type: 'focus'; channel: ChatChannel }
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'open'; mode?: 'text' | 'quick'; channel?: ChatChannel }
  | { type: 'close' }
  | { type: 'whisperTo'; target: WhisperTarget };

/**
 * The channel a line counts under.
 *
 * @param l - Line.
 */
export const channelOf = (l: ChatLine): ChatChannel => l.channel ?? 'show';

/** The most useful available channel: where the action is. */
function preferred(available: Readonly<Record<ChatChannel, boolean>>): ChatChannel {
  return CHANNEL_ORDER.find((c) => available[c] && c !== 'system') ?? 'system';
}

/**
 * Applies one action.
 *
 * @param s - Current state.
 * @param a - Action.
 * @returns The next state (the same object when nothing changed).
 * @example
 * state = reduceChat(state, { type: 'available', channel: 'party', on: true });
 */
export function reduceChat(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case 'receive': {
      const ch = channelOf(a.line);
      if (s.lines.some((l) => l.id === a.line.id)) return s;
      const lines = [...s.lines.slice(-(CHAT_KEEP - 1)), a.line];
      const seen = s.open && s.active === ch;
      const unread = a.line.self || seen ? s.unread : { ...s.unread, [ch]: s.unread[ch] + 1 };
      const replyTo =
        ch === 'whisper' && !a.line.self && a.line.from.userId
          ? { userId: a.line.from.userId, name: a.line.from.name }
          : s.replyTo;
      // The first whisper you get sets who the Whispers tab answers.
      const whisperTo = ch === 'whisper' && !s.whisperTo ? replyTo : s.whisperTo;
      return { ...s, lines, unread, replyTo, whisperTo };
    }
    case 'available': {
      const writable = a.on && (a.writable ?? true);
      if (s.available[a.channel] === a.on && s.writable[a.channel] === writable) return s;
      const available = { ...s.available, [a.channel]: a.on, system: true };
      const next = { ...s, available, writable: { ...s.writable, [a.channel]: writable } };
      if (!a.on) {
        next.unread = { ...s.unread, [a.channel]: 0 };
        if (s.active === a.channel) next.active = preferred(available);
      } else if (s.active === 'system' && !s.open && a.channel !== 'system') {
        // Land on the live conversation, not the notice log.
        next.active = preferred(available);
      }
      return next;
    }
    case 'clear':
      return {
        ...s,
        lines: s.lines.filter((l) => channelOf(l) !== a.channel),
        unread: { ...s.unread, [a.channel]: 0 },
      };
    case 'focus':
      if (!s.available[a.channel]) return s;
      return { ...s, active: a.channel, unread: { ...s.unread, [a.channel]: 0 } };
    case 'cycle': {
      const tabs = CHANNEL_ORDER.filter((c) => s.available[c]);
      const i = tabs.indexOf(s.active);
      const next = tabs[(i + a.dir + tabs.length) % tabs.length] ?? 'system';
      return reduceChat(s, { type: 'focus', channel: next });
    }
    case 'open': {
      const channel = a.channel && s.available[a.channel] ? a.channel : s.active;
      return {
        ...s,
        open: true,
        mode: a.mode ?? 'text',
        active: channel,
        unread: { ...s.unread, [channel]: 0 },
      };
    }
    case 'close':
      return s.open ? { ...s, open: false, mode: 'text' } : s;
    case 'whisperTo':
      return {
        ...s,
        whisperTo: a.target,
        active: s.available.whisper ? 'whisper' : s.active,
        unread: { ...s.unread, whisper: 0 },
      };
  }
}

/** Visible lines of one channel. */
export function linesOf(s: ChatState, channel: ChatChannel): ChatLine[] {
  return s.lines.filter((l) => channelOf(l) === channel);
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

/** What the input asked for. */
export type ChatCommand =
  | { kind: 'send'; channel: Exclude<ChatChannel, 'whisper' | 'system'>; text: string }
  | { kind: 'whisper'; to: WhisperTarget; text: string }
  | { kind: 'switch'; channel: ChatChannel; to?: WhisperTarget }
  | { kind: 'mute'; name: string; muted: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

/** Context for {@link parseChatInput}. */
export interface CommandContext {
  active: ChatChannel;
  available: Readonly<Record<ChatChannel, boolean>>;
  writable: Readonly<Record<ChatChannel, boolean>>;
  whisperTo: WhisperTarget | null;
  replyTo: WhisperTarget | null;
  /** Finds a friend by `name` or `name#tag` (case-insensitive). */
  findFriend(name: string): WhisperTarget | null;
}

/** `/help` text. */
export const CHAT_HELP = [
  '/w name message: whisper a friend',
  '/r message: reply to the last whisper',
  '/party, /all, /lobby: switch channel (add a message to send it there)',
  '/mute name, /unmute name: hide or show a player',
  'Tab: next channel · Esc: close',
];

/**
 * Splits "name with spaces rest of message" by trying the longest known name
 * first, since display names may contain spaces.
 */
function splitTarget(rest: string, find: CommandContext['findFriend']): [WhisperTarget, string] | null {
  const words = rest.split(' ');
  for (let n = Math.min(words.length, 4); n >= 1; n--) {
    const hit = find(words.slice(0, n).join(' '));
    if (hit) return [hit, words.slice(n).join(' ').trim()];
  }
  return null;
}

function publicChannel(ctx: CommandContext): 'show' | 'lobby' | null {
  if (ctx.available.show) return 'show';
  if (ctx.available.lobby) return 'lobby';
  return null;
}

function sendTo(ctx: CommandContext, channel: ChatChannel, text: string): ChatCommand {
  if (!ctx.available[channel]) return { kind: 'error', message: `No ${channel} chat right now` };
  if (!text) return { kind: 'switch', channel };
  if (channel === 'system') return { kind: 'error', message: 'System messages are read-only' };
  if (channel === 'whisper') {
    if (!ctx.whisperTo) return { kind: 'error', message: 'Pick a friend first: /w name message' };
    return { kind: 'whisper', to: ctx.whisperTo, text };
  }
  if (!ctx.writable[channel])
    return {
      kind: 'error',
      message:
        channel === 'show' ? 'Only quick pings here: there is no one to read it' : "You can't type here",
    };
  return { kind: 'send', channel, text };
}

/**
 * Parses what the player typed.
 *
 * @param raw - Input text.
 * @param ctx - Current channels and friends.
 * @returns The action to take.
 * @example
 * parseChatInput('/w Zippy Noodle gg', ctx); // { kind: 'whisper', to: {...}, text: 'gg' }
 */
export function parseChatInput(raw: string, ctx: CommandContext): ChatCommand {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'none' };
  if (!text.startsWith('/')) return sendTo(ctx, ctx.active, text);
  const space = text.indexOf(' ');
  const cmd = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : text.slice(space + 1).trim();
  switch (cmd) {
    case '/w':
    case '/whisper':
    case '/msg':
    case '/tell': {
      if (!ctx.available.whisper) return { kind: 'error', message: 'Whispers need the online servers' };
      if (!rest) return { kind: 'error', message: 'Usage: /w name message' };
      const split = splitTarget(rest, ctx.findFriend);
      if (!split) return { kind: 'error', message: `No friend called ${rest.split(' ')[0]}` };
      const [to, msg] = split;
      return msg ? { kind: 'whisper', to, text: msg } : { kind: 'switch', channel: 'whisper', to };
    }
    case '/r':
    case '/reply':
      if (!ctx.replyTo) return { kind: 'error', message: 'Nobody has whispered you yet' };
      return rest
        ? { kind: 'whisper', to: ctx.replyTo, text: rest }
        : { kind: 'switch', channel: 'whisper', to: ctx.replyTo };
    case '/p':
    case '/party':
      return sendTo(ctx, 'party', rest);
    case '/all':
    case '/a':
    case '/show': {
      const ch = publicChannel(ctx);
      return ch ? sendTo(ctx, ch, rest) : { kind: 'error', message: 'No show or lobby chat right now' };
    }
    case '/lobby':
      return sendTo(ctx, ctx.available.lobby ? 'lobby' : 'show', rest);
    case '/mute':
    case '/unmute':
      if (!rest) return { kind: 'error', message: `Usage: ${cmd} name` };
      return { kind: 'mute', name: rest, muted: cmd === '/mute' };
    case '/help':
    case '/?':
      return { kind: 'help' };
    default:
      return { kind: 'error', message: `Unknown command ${cmd}. Try /help` };
  }
}
