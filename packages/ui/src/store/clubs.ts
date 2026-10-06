/**
 * Club UI state: the player's club (roster, role, join requests), invites
 * and requests in flight, discovery, the weekly goals and which part of the
 * social sheet is showing.
 *
 * Its own Zustand store so club refreshes never re-render the menus. The
 * game fills it from the account API and realtime events; the UI only reads
 * it and emits `club*` intents.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ClubEmblem, ClubJoinMode, ClubReportReason, ClubRole } from '@tumble/shared';
import type { Presence } from './types.ts';

export type { ClubEmblem, ClubJoinMode, ClubReportReason, ClubRole } from '@tumble/shared';

/** What other players see of a club. */
export interface ClubCardView {
  id: string;
  name: string;
  tag: string;
  description: string;
  emblem: ClubEmblem;
  joinMode: ClubJoinMode;
  memberCount: number;
  maxMembers: number;
}

/** One roster row. */
export interface ClubMemberView {
  userId: string;
  name: string;
  tag: string;
  level: number;
  role: ClubRole;
  presence: Presence;
  isSelf: boolean;
}

/** The player's own club. */
export interface MyClubView extends ClubCardView {
  members: ClubMemberView[];
}

/** An invite waiting on the player. */
export interface ClubInviteView {
  club: ClubCardView;
  from: { userId: string; name: string; tag: string } | null;
}

/** A join request waiting on the club (officers). */
export interface ClubJoinRequestView {
  userId: string;
  name: string;
  tag: string;
  level: number;
  /** Epoch ms. */
  at: number;
}

/** One weekly goal. */
export interface ClubGoalView {
  goalId: string;
  title: string;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
  reward: { xp: number; gumballs: number };
}

/** A member's share of this week. */
export interface ClubContributionView {
  userId: string;
  name: string;
  tag: string;
  shows: number;
  rounds: number;
  crowns: number;
}

/** The goals tab. */
export interface ClubGoalsView {
  week: string;
  /** Epoch ms of the next weekly reset. */
  refreshesAt: number;
  /** The player played at least one show for the club this week. */
  eligible: boolean;
  goals: ClubGoalView[];
  contributions: ClubContributionView[];
}

/** Where the club features stand. */
export type ClubStatus = 'idle' | 'loading' | 'ready' | 'error' | 'disabled';

/** Club page tabs. */
export type ClubTab = 'roster' | 'chat' | 'goals' | 'requests' | 'settings';

/** Club store state + setters. */
export interface ClubsState {
  status: ClubStatus;
  /** Last load failure, shown with Retry. */
  error: string | null;
  club: MyClubView | null;
  role: ClubRole | null;
  joinRequests: ClubJoinRequestView[];
  invites: ClubInviteView[];
  /** Clubs the player asked to join. */
  pending: ClubCardView[];
  goals: { status: 'idle' | 'loading' | 'ready' | 'error'; data: ClubGoalsView | null };
  discovery: {
    query: string;
    results: ClubCardView[];
    recommended: ClubCardView[];
    loading: boolean;
  };
  /** An action is in flight (buttons wait for it). */
  busy: boolean;
  /** The social sheet's section. */
  section: 'friends' | 'club';
  tab: ClubTab;

  setLoaded(v: {
    club: MyClubView | null;
    role: ClubRole | null;
    joinRequests: ClubJoinRequestView[];
    invites: ClubInviteView[];
    pending: ClubCardView[];
  }): void;
  setStatus(status: ClubStatus, error?: string | null): void;
  setGoals(goals: ClubsState['goals']): void;
  setDiscovery(d: Partial<ClubsState['discovery']>): void;
  setBusy(busy: boolean): void;
  setSection(section: ClubsState['section']): void;
  setTab(tab: ClubTab): void;
  /** Forget everything (signed out, removed from the club). */
  reset(): void;
}

const EMPTY = {
  status: 'idle' as ClubStatus,
  error: null,
  club: null,
  role: null,
  joinRequests: [],
  invites: [],
  pending: [],
  goals: { status: 'idle' as const, data: null },
  discovery: { query: '', results: [], recommended: [], loading: false },
  busy: false,
};

/** The club store (vanilla; read with {@link useClubs}). */
export const clubs = createStore<ClubsState>()((set) => ({
  ...EMPTY,
  section: 'friends',
  tab: 'roster',
  setLoaded: (v) =>
    set((s) => ({
      ...v,
      status: 'ready',
      error: null,
      // A tab the new role can't see falls back to the roster.
      tab: s.tab === 'requests' && !(v.role === 'owner' || v.role === 'officer') ? 'roster' : s.tab,
    })),
  setStatus: (status, error = null) => set({ status, error }),
  setGoals: (goals) => set({ goals }),
  setDiscovery: (d) => set((s) => ({ discovery: { ...s.discovery, ...d } })),
  setBusy: (busy) => set({ busy }),
  setSection: (section) => set({ section }),
  setTab: (tab) => set({ tab }),
  reset: () => set({ ...EMPTY, tab: 'roster' }),
}));

/**
 * React hook over the club store.
 *
 * @example
 * const club = useClubs((s) => s.club);
 */
export function useClubs<T>(selector: (s: ClubsState) => T): T {
  return useStore(clubs, selector);
}

/** Labels for join modes. */
export const JOIN_MODE_LABEL: Readonly<Record<ClubJoinMode, string>> = {
  open: 'Open: anyone can join',
  request: 'Request: officers approve',
  invite: 'Invite only',
};

/** Labels for roles. */
export const CLUB_ROLE_LABEL: Readonly<Record<ClubRole, string>> = {
  owner: 'Owner',
  officer: 'Officer',
  member: 'Member',
};

/** Labels for club report reasons. */
export const CLUB_REPORT_LABEL: Readonly<Record<ClubReportReason, string>> = {
  name: 'Offensive name or tag',
  description: 'Offensive description',
  emblem: 'Offensive emblem',
  chat: 'Club chat',
  other: 'Something else',
};
