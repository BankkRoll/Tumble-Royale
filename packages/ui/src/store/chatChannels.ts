/**
 * Global chat: tabs, public rooms, unread counts, the input's slash commands
 * and placeholders, as pure functions so the widget, the client router and
 * tests share one set of rules.
 *
 * The model is "just type": the default tab is always **All**, and All talks
 * to whichever public room the player is in right now, by priority:
 * - `show`: everyone in the current show or its live pre-show lobby (game server);
 * - `lobby`: members of a private-show lobby (matchmaker);
 * - `global`: everyone online in the menu (account API realtime gateway).
 *
 * Tabs are only All, Party (while in a party) and Whispers (once there is a
 * whisper conversation). System notices (joins, leaves, host changes, command
 * help) are not a tab: they show inline in every tab and can't be sent to.
 * Refusals (rate limit, chat ban, offline) are a single replaceable hint, not
 * feed lines, so a mashed Enter key never floods the chat.
 */
import type { PlayerRef } from './social.ts';

/** A chat tab (send target). */
export type ChatChannel = 'all' | 'party' | 'whisper';

/** What a line belongs to: a tab, or `system` (inline in every tab). */
export type ChatLineChannel = ChatChannel | 'system';

/** A public room that the All tab can talk to. */
export type PublicRoom = 'show' | 'lobby' | 'global';

/** How the player may use a public room. */
export type RoomAccess = 'off' | 'read' | 'write';

/** Tab order (also the order Tab cycles through). */
export const CHANNEL_ORDER: readonly ChatChannel[] = ['all', 'party', 'whisper'];

/** Which room All talks to when several exist: the most local one wins. */
export const ROOM_PRIORITY: readonly PublicRoom[] = ['show', 'lobby', 'global'];

/** Tab labels: words only. */
export const CHANNEL_LABEL: Readonly<Record<ChatChannel, string>> = {
  all: 'All',
  party: 'Party',
  whisper: 'Whispers',
};

/** One chat line. */
export interface ChatLine {
  id: string;
  /** Tab the line belongs to (default `all`). */
  channel?: ChatLineChannel;
  /** Public room of an `all` line (default `global`). */
  room?: PublicRoom;
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
  /** Discriminator shown as `Name#tag`. */
  tag?: string;
}

/** A short refusal shown once under the feed (replaced, never stacked). */
export interface ChatHint {
  text: string;
  /** Epoch ms shown. */
  at: number;
}

/** Chat widget state. */
export interface ChatState {
  /** Every tab's lines, oldest first. */
  lines: ChatLine[];
  /** Public rooms the player is in and whether they may type there. */
  rooms: Readonly<Record<PublicRoom, RoomAccess>>;
  /** In a party with someone else (Party tab exists). */
  party: boolean;
  /** Whispers can be sent (signed in and online). */
  whispers: boolean;
  active: ChatChannel;
  /** Unread lines per tab; All never counts (it is the default view). */
  unread: Readonly<Record<ChatChannel, number>>;
  /** The input is open. */
  open: boolean;
  /** `quick`: preset picker (gamepad) instead of the text field. */
  mode: 'text' | 'quick';
  /** Who `/r` answers: the last friend who whispered you. */
  replyTo: WhisperTarget | null;
  /** Who the Whispers tab is talking to. */
  whisperTo: WhisperTarget | null;
  hint: ChatHint | null;
}

/** Lines kept across all tabs. */
export const CHAT_KEEP = 200;

/** Shown when no public room is reachable. */
export const CHAT_OFFLINE = 'Chat needs the online servers';

/** Fresh state: All, with no room until a transport connects. */
export const INITIAL_CHAT: ChatState = {
  lines: [],
  rooms: { show: 'off', lobby: 'off', global: 'off' },
  party: false,
  whispers: false,
  active: 'all',
  unread: { all: 0, party: 0, whisper: 0 },
  open: false,
  mode: 'text',
  replyTo: null,
  whisperTo: null,
  hint: null,
};

/** Everything that changes chat state. */
export type ChatAction =
  | { type: 'receive'; line: ChatLine }
  | { type: 'room'; room: PublicRoom; access: RoomAccess }
  | { type: 'party'; on: boolean }
  | { type: 'whispers'; on: boolean }
  /** Drops a room's or a tab's lines (the room or party went away). */
  | { type: 'clear'; target: PublicRoom | 'party' | 'whisper' }
  | { type: 'focus'; channel: ChatChannel }
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'open'; mode?: 'text' | 'quick'; channel?: ChatChannel }
  | { type: 'close' }
  | { type: 'whisperTo'; target: WhisperTarget }
  | { type: 'hint'; text: string; at: number };

/**
 * The tab a line counts under.
 *
 * @param l - Line.
 */
export const channelOf = (l: ChatLine): ChatLineChannel => l.channel ?? 'all';

/**
 * The room an `all` line came from.
 *
 * @param l - Line.
 */
export const roomOf = (l: ChatLine): PublicRoom => l.room ?? 'global';

/**
 * The room All talks to right now, or null when none is reachable.
 *
 * @param s - Chat state (only `rooms` is read).
 * @example
 * publicRoom(state); // 'show' while in a show, 'global' in the menu
 */
export function publicRoom(s: Pick<ChatState, 'rooms'>): PublicRoom | null {
  return ROOM_PRIORITY.find((r) => s.rooms[r] !== 'off') ?? null;
}

/**
 * Tabs shown right now: All always, Party in a party, Whispers once there is
 * a conversation.
 *
 * @param s - Chat state.
 */
export function chatTabs(s: Pick<ChatState, 'party' | 'whispers' | 'whisperTo' | 'lines'>): ChatChannel[] {
  const tabs: ChatChannel[] = ['all'];
  if (s.party) tabs.push('party');
  if (s.whispers && (s.whisperTo || s.lines.some((l) => channelOf(l) === 'whisper'))) tabs.push('whisper');
  return tabs;
}

const isTab = (s: ChatState, c: ChatChannel): boolean => chatTabs(s).includes(c);

/** Keeps `active` on a tab that exists. */
function settle(s: ChatState): ChatState {
  return isTab(s, s.active) ? s : { ...s, active: 'all' };
}

/**
 * Whether a line shows in a tab: its own lines plus System notices; All shows
 * the current room only, so the menu's room doesn't leak into a show.
 */
function inTab(l: ChatLine, tab: ChatChannel, room: PublicRoom | null): boolean {
  const ch = channelOf(l);
  if (ch === 'system') return true;
  if (ch !== tab) return false;
  return tab !== 'all' || roomOf(l) === (room ?? 'global');
}

/**
 * Applies one action.
 *
 * @param s - Current state.
 * @param a - Action.
 * @returns The next state (the same object when nothing changed).
 * @example
 * state = reduceChat(state, { type: 'room', room: 'global', access: 'write' });
 */
export function reduceChat(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case 'receive': {
      if (s.lines.some((l) => l.id === a.line.id)) return s;
      const ch = channelOf(a.line);
      const lines = [...s.lines.slice(-(CHAT_KEEP - 1)), a.line];
      const counts = ch === 'party' || ch === 'whisper';
      const seen = s.open && s.active === ch;
      const unread = !counts || a.line.self || seen ? s.unread : { ...s.unread, [ch]: s.unread[ch] + 1 };
      const replyTo =
        ch === 'whisper' && !a.line.self && a.line.from.userId
          ? {
              userId: a.line.from.userId,
              name: a.line.from.name,
              ...(a.line.from.tag ? { tag: a.line.from.tag } : {}),
            }
          : s.replyTo;
      // The first whisper you get sets who the Whispers tab answers.
      const whisperTo = ch === 'whisper' && !s.whisperTo ? replyTo : s.whisperTo;
      return { ...s, lines, unread, replyTo, whisperTo };
    }
    case 'room':
      return s.rooms[a.room] === a.access ? s : { ...s, rooms: { ...s.rooms, [a.room]: a.access } };
    case 'party':
      if (s.party === a.on) return s;
      return settle({ ...s, party: a.on, unread: a.on ? s.unread : { ...s.unread, party: 0 } });
    case 'whispers':
      if (s.whispers === a.on) return s;
      return settle({ ...s, whispers: a.on });
    case 'clear': {
      const lines = s.lines.filter((l) =>
        a.target === 'party' || a.target === 'whisper'
          ? channelOf(l) !== a.target
          : channelOf(l) !== 'all' || roomOf(l) !== a.target,
      );
      if (lines.length === s.lines.length) return s;
      const unread =
        a.target === 'party' || a.target === 'whisper' ? { ...s.unread, [a.target]: 0 } : s.unread;
      return settle({ ...s, lines, unread });
    }
    case 'focus':
      if (!isTab(s, a.channel)) return s;
      return { ...s, active: a.channel, unread: { ...s.unread, [a.channel]: 0 } };
    case 'cycle': {
      const tabs = chatTabs(s);
      const i = tabs.indexOf(s.active);
      const next = tabs[(i + a.dir + tabs.length) % tabs.length] ?? 'all';
      return reduceChat(s, { type: 'focus', channel: next });
    }
    case 'open': {
      const channel = a.channel && isTab(s, a.channel) ? a.channel : s.active;
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
    case 'whisperTo': {
      const next = { ...s, whisperTo: a.target };
      return isTab(next, 'whisper')
        ? { ...next, active: 'whisper', unread: { ...s.unread, whisper: 0 } }
        : next;
    }
    case 'hint':
      return { ...s, hint: { text: a.text, at: a.at } };
  }
}

/**
 * Lines shown in a tab, oldest first: the tab's own lines plus System notices.
 *
 * @param s - Chat state.
 * @param tab - Tab.
 */
export function linesOf(s: ChatState, tab: ChatChannel): ChatLine[] {
  const room = publicRoom(s);
  return s.lines.filter((l) => inTab(l, tab, room));
}

/**
 * Lines for the collapsed feed: everything except other rooms' public lines.
 *
 * @param s - Chat state.
 */
export function feedLines(s: ChatState): ChatLine[] {
  const room = publicRoom(s) ?? 'global';
  return s.lines.filter((l) => channelOf(l) !== 'all' || roomOf(l) === room);
}

/** `Name#tag`, or just the name when there is no tag. */
export const nameTag = (p: { name: string; tag?: string | undefined }): string =>
  p.tag ? `${p.name}#${p.tag}` : p.name;

/** Why All can't take typed text right now, or null when it can. */
function allBlocked(s: Pick<ChatState, 'rooms'>): string | null {
  const room = publicRoom(s);
  if (!room) return CHAT_OFFLINE;
  if (s.rooms[room] === 'write') return null;
  // A read-only room is an offline show (bots only) or a show with no other humans.
  return s.rooms.global === 'off' ? CHAT_OFFLINE : 'Only quick pings here: no other players to read it';
}

/**
 * The input's placeholder: where the message goes.
 *
 * @param s - Chat state.
 * @example
 * chatPlaceholder(state); // 'Message everyone'
 */
export function chatPlaceholder(s: ChatState): string {
  switch (s.active) {
    case 'all':
      return allBlocked(s) ?? 'Message everyone';
    case 'party':
      return 'Message your party';
    case 'whisper':
      return s.whisperTo ? `Whisper ${nameTag(s.whisperTo)}` : 'Whisper with /w name message';
  }
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

/** What the input asked for. */
export type ChatCommand =
  | { kind: 'send'; to: PublicRoom | 'party'; text: string }
  | { kind: 'whisper'; to: WhisperTarget; text: string }
  | { kind: 'switch'; channel: ChatChannel; to?: WhisperTarget }
  | { kind: 'mute'; name: string; muted: boolean }
  | { kind: 'help' }
  /** Nothing sent; show this once as the inline hint. */
  | { kind: 'hint'; message: string }
  | { kind: 'none' };

/** Context for {@link parseChatInput}: the chat state plus a friend lookup. */
export interface CommandContext extends Pick<
  ChatState,
  'active' | 'rooms' | 'party' | 'whispers' | 'whisperTo' | 'replyTo'
> {
  /** Finds a friend by `name` or `name#tag` (case-insensitive). */
  findFriend(name: string): WhisperTarget | null;
}

/** `/help` text. */
export const CHAT_HELP = [
  'Just type and press Enter to talk to everyone',
  '/w name message: whisper a friend · /r message: reply',
  '/p message: party · /all message: everyone',
  '/mute name, /unmute name: hide or show a player',
  'Tab: next tab · Esc: close',
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

function toAll(ctx: CommandContext, text: string): ChatCommand {
  if (!text) return { kind: 'switch', channel: 'all' };
  const blocked = allBlocked(ctx);
  if (blocked) return { kind: 'hint', message: blocked };
  return { kind: 'send', to: publicRoom(ctx)!, text };
}

function toParty(ctx: CommandContext, text: string): ChatCommand {
  if (!ctx.party) return { kind: 'hint', message: "You're not in a party" };
  return text ? { kind: 'send', to: 'party', text } : { kind: 'switch', channel: 'party' };
}

/**
 * Parses what the player typed. Plain text always goes to the open tab; it
 * never produces an error, only a hint when the tab can't take it.
 *
 * @param raw - Input text.
 * @param ctx - Current chat state and friends.
 * @returns The action to take.
 * @example
 * parseChatInput('gg all', ctx); // { kind: 'send', to: 'global', text: 'gg all' }
 */
export function parseChatInput(raw: string, ctx: CommandContext): ChatCommand {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'none' };
  if (!text.startsWith('/')) {
    if (ctx.active === 'party') return toParty(ctx, text);
    if (ctx.active === 'whisper')
      return ctx.whisperTo
        ? { kind: 'whisper', to: ctx.whisperTo, text }
        : { kind: 'hint', message: 'Pick a friend first: /w name message' };
    return toAll(ctx, text);
  }
  const space = text.indexOf(' ');
  const cmd = (space < 0 ? text : text.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : text.slice(space + 1).trim();
  switch (cmd) {
    case '/w':
    case '/whisper':
    case '/msg':
    case '/tell': {
      if (!ctx.whispers) return { kind: 'hint', message: 'Whispers need the online servers' };
      if (!rest) return { kind: 'hint', message: 'Usage: /w name message' };
      const split = splitTarget(rest, ctx.findFriend);
      if (!split) return { kind: 'hint', message: `No friend called ${rest.split(' ')[0]}` };
      const [to, msg] = split;
      return msg ? { kind: 'whisper', to, text: msg } : { kind: 'switch', channel: 'whisper', to };
    }
    case '/r':
    case '/reply':
      if (!ctx.replyTo) return { kind: 'hint', message: 'Nobody has whispered you yet' };
      return rest
        ? { kind: 'whisper', to: ctx.replyTo, text: rest }
        : { kind: 'switch', channel: 'whisper', to: ctx.replyTo };
    case '/p':
    case '/party':
      return toParty(ctx, rest);
    case '/all':
    case '/a':
    case '/show':
    case '/lobby':
      return toAll(ctx, rest);
    case '/mute':
    case '/unmute':
      if (!rest) return { kind: 'hint', message: `Usage: ${cmd} name` };
      return { kind: 'mute', name: rest, muted: cmd === '/mute' };
    case '/help':
    case '/?':
      return { kind: 'help' };
    default:
      return { kind: 'hint', message: `Unknown command ${cmd}. Try /help` };
  }
}
