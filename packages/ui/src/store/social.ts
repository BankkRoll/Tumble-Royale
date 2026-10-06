/**
 * Social UI state that the main store does not carry: friend requests, the
 * blocked list, local mutes, player search, the global chat (channels, unread,
 * input; see `chatChannels.ts`), and the player card / report dialog.
 *
 * Kept in its own Zustand store so chat traffic never re-renders the menus,
 * and so the game can push it without touching the main `UIState` shape.
 * {@link visibleChat} is the single place that applies "Show chat", the chat
 * filter, mutes and blocks, so toggling any of them applies retroactively.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { INITIAL_CHAT, reduceChat, type ChatAction, type ChatLine, type ChatState } from './chatChannels.ts';
import type { Presence, Relation, TumblerColors } from './types.ts';

export type { ChatLine } from './chatChannels.ts';

/** Another player as the social UI refers to them. */
export interface PlayerRef {
  /** Account id; absent for bots and offline players. */
  userId?: string;
  name: string;
  tag?: string;
  /** Mute key: the account id, or `name:<name>` for players without one. */
  key: string;
  isBot?: boolean;
  /** Club tag, shown as `[TAG]` beside the name (hidden for others in Streamer Mode). */
  club?: string;
}

/** A pending friend request. */
export interface FriendRequest {
  userId: string;
  name: string;
  tag: string;
  /** Epoch ms the request was sent. */
  at: number;
  colors: TumblerColors;
}

/** A blocked player. */
export interface BlockedPlayer {
  userId: string;
  name: string;
  tag: string;
}

/** A player search hit. */
export interface PlayerSearchResult {
  userId: string;
  name: string;
  tag: string;
  level: number;
  relation: Relation | 'self';
}

/** Where the friends features stand. */
export type SocialAvailability = 'online' | 'offline' | 'connecting';

/** Social store state + actions. */
export interface SocialState {
  /** Friends need the account API; offline the sheet shows an honest empty state. */
  availability: SocialAvailability;
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: BlockedPlayer[];
  /** Muted keys (see {@link PlayerRef.key}). */
  muted: string[];
  search: { query: string; results: PlayerSearchResult[]; loading: boolean };
  /** Global chat: every channel's lines, tabs, unread counts, input state. */
  chat: ChatState;
  /**
   * Unsent text in the chat input. Lives here, not in the widget, so a wipe or
   * a loading screen that unmounts the widget never loses a half-typed line.
   */
  chatDraft: string;
  /** Player action menu target. */
  playerMenu: PlayerRef | null;
  /** Report dialog target. */
  reportTarget: PlayerRef | null;

  setAvailability(a: SocialAvailability): void;
  setRequests(incoming: FriendRequest[], outgoing: FriendRequest[]): void;
  setBlocked(blocked: BlockedPlayer[]): void;
  setMuted(keys: string[]): void;
  setSearch(search: Partial<SocialState['search']>): void;
  /** Applies a chat action (see `reduceChat`). */
  dispatchChat(action: ChatAction): void;
  /** Shorthand for a `receive` action. */
  pushChat(line: ChatLine): void;
  setChatDraft(text: string): void;
  openPlayerMenu(p: PlayerRef | null): void;
  openReport(p: PlayerRef | null): void;
}

/** The social store (vanilla; read with {@link useSocial}). */
export const social = createStore<SocialState>()((set) => ({
  availability: 'connecting',
  incoming: [],
  outgoing: [],
  blocked: [],
  muted: [],
  search: { query: '', results: [], loading: false },
  chat: INITIAL_CHAT,
  chatDraft: '',
  playerMenu: null,
  reportTarget: null,

  setAvailability: (availability) => set({ availability }),
  setRequests: (incoming, outgoing) => set({ incoming, outgoing }),
  setBlocked: (blocked) => set({ blocked }),
  setMuted: (muted) => set({ muted }),
  setSearch: (search) => set((s) => ({ search: { ...s.search, ...search } })),
  dispatchChat: (action) =>
    set((s) => {
      const chat = reduceChat(s.chat, action);
      return chat === s.chat ? s : { chat };
    }),
  pushChat: (line) =>
    set((s) => {
      const chat = reduceChat(s.chat, { type: 'receive', line });
      return chat === s.chat ? s : { chat };
    }),
  setChatDraft: (chatDraft) => set({ chatDraft }),
  openPlayerMenu: (playerMenu) => set({ playerMenu }),
  openReport: (reportTarget) => set({ reportTarget, playerMenu: null }),
}));

/**
 * React hook over the social store.
 *
 * @example
 * const incoming = useSocial((s) => s.incoming);
 */
export function useSocial<T>(selector: (s: SocialState) => T): T {
  return useStore(social, selector);
}

/** Display rules for {@link visibleChat}. */
export interface ChatVisibility {
  /** Settings → "Show chat". */
  showChat: boolean;
  /** Settings → "Chat filter". */
  filter: boolean;
  muted: readonly string[];
  /** Blocked account ids. */
  blocked: readonly string[];
}

/** A chat line ready to render. */
export interface VisibleChatLine extends ChatLine {
  /** Text to show under the current settings. */
  display: string;
}

/**
 * Applies "Show chat", the chat filter, mutes and blocks to a feed. The local
 * player's own lines and System notices always show.
 *
 * @param lines - Feed, oldest first.
 * @param rules - Current settings and lists.
 * @returns Lines to render with their display text.
 * @example
 * visibleChat(feed, { showChat: true, filter: true, muted: [], blocked: [] });
 */
export function visibleChat(lines: readonly ChatLine[], rules: ChatVisibility): VisibleChatLine[] {
  const muted = new Set(rules.muted);
  const blocked = new Set(rules.blocked);
  const out: VisibleChatLine[] = [];
  for (const l of lines) {
    if (!l.self && l.channel !== 'system') {
      if (!rules.showChat) continue;
      if (muted.has(l.from.key)) continue;
      if (l.from.userId && blocked.has(l.from.userId)) continue;
    }
    out.push({ ...l, display: rules.filter && l.masked ? l.masked : l.text });
  }
  return out;
}

/** Friend presence labels shared by the friends sheet and profile cards. */
export const PRESENCE_LABEL: Readonly<Record<Presence, string>> = {
  online: 'Online',
  inMenu: 'In the menu',
  inQueue: 'In queue',
  inShow: 'In a show',
  offline: 'Offline',
};
