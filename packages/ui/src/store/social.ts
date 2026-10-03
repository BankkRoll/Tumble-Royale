/**
 * Social UI state that the main store does not carry: friend requests, the
 * blocked list, local mutes, player search, the in-show and party chat feeds,
 * and the player action menu / report dialog.
 *
 * Kept in its own Zustand store so chat traffic never re-renders the menus,
 * and so the game can push it without touching the main `UIState` shape.
 * {@link visibleChat} is the single place that applies "Show chat", the chat
 * filter, mutes and blocks, so toggling any of them applies retroactively.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Presence, Relation, TumblerColors } from './types.ts';

/** Another player as the social UI refers to them. */
export interface PlayerRef {
  /** Account id; absent for bots and offline players. */
  userId?: string;
  name: string;
  tag?: string;
  /** Mute key: the account id, or `name:<name>` for players without one. */
  key: string;
  isBot?: boolean;
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

/** One chat line (in-show or party). */
export interface ChatLine {
  id: string;
  from: PlayerRef;
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
  /** In-show feed, oldest first. */
  showChat: ChatLine[];
  /** Party feed, oldest first. */
  partyChat: ChatLine[];
  /** Text chat is possible in this show (online with other humans). */
  chatEnabled: boolean;
  /** The in-show chat input is open. */
  chatOpen: boolean;
  /** Player action menu target. */
  playerMenu: PlayerRef | null;
  /** Report dialog target. */
  reportTarget: PlayerRef | null;

  setAvailability(a: SocialAvailability): void;
  setRequests(incoming: FriendRequest[], outgoing: FriendRequest[]): void;
  setBlocked(blocked: BlockedPlayer[]): void;
  setMuted(keys: string[]): void;
  setSearch(search: Partial<SocialState['search']>): void;
  pushShowChat(line: ChatLine): void;
  pushPartyChat(line: ChatLine): void;
  clearShowChat(): void;
  clearPartyChat(): void;
  setChatEnabled(on: boolean): void;
  setChatOpen(open: boolean): void;
  openPlayerMenu(p: PlayerRef | null): void;
  openReport(p: PlayerRef | null): void;
}

/** Lines kept per feed. */
export const CHAT_HISTORY = 50;

const push = (list: ChatLine[], line: ChatLine): ChatLine[] =>
  list.some((l) => l.id === line.id) ? list : [...list.slice(-(CHAT_HISTORY - 1)), line];

/** The social store (vanilla; read with {@link useSocial}). */
export const social = createStore<SocialState>()((set) => ({
  availability: 'connecting',
  incoming: [],
  outgoing: [],
  blocked: [],
  muted: [],
  search: { query: '', results: [], loading: false },
  showChat: [],
  partyChat: [],
  chatEnabled: false,
  chatOpen: false,
  playerMenu: null,
  reportTarget: null,

  setAvailability: (availability) => set({ availability }),
  setRequests: (incoming, outgoing) => set({ incoming, outgoing }),
  setBlocked: (blocked) => set({ blocked }),
  setMuted: (muted) => set({ muted }),
  setSearch: (search) => set((s) => ({ search: { ...s.search, ...search } })),
  pushShowChat: (line) => set((s) => ({ showChat: push(s.showChat, line) })),
  pushPartyChat: (line) => set((s) => ({ partyChat: push(s.partyChat, line) })),
  clearShowChat: () => set({ showChat: [], chatOpen: false }),
  clearPartyChat: () => set({ partyChat: [] }),
  setChatEnabled: (chatEnabled) => set((s) => ({ chatEnabled, chatOpen: chatEnabled && s.chatOpen })),
  setChatOpen: (chatOpen) => set({ chatOpen }),
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
 * player's own lines always show.
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
    if (!l.self) {
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
