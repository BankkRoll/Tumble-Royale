/**
 * Spectator and broadcast tool rules shared by the UI and the game: camera
 * mode order and labels, the starting state for a show, which actions the
 * help card lists, and when the broadcast overlay replaces the personal HUD.
 * Pure, so the UI states are unit-tested without rendering.
 */
import type {
  BindAction,
  PadBindAction,
  SpectatorCamMode,
  SpectatorRosterEntry,
  SpectatorState,
} from './types.ts';
import type { UIState } from './uiStore.ts';

/** Camera modes in the order the camera key cycles through them. */
export const SPECTATOR_MODES: readonly SpectatorCamMode[] = ['follow', 'free', 'overview', 'director'];

/** Short label per camera mode. */
export const SPECTATOR_MODE_LABELS: Readonly<Record<SpectatorCamMode, string>> = {
  follow: 'Follow',
  free: 'Free camera',
  overview: 'Overview',
  director: 'Director',
};

/**
 * The mode after `mode` in {@link SPECTATOR_MODES}.
 *
 * @param mode - Current mode.
 * @example
 * nextSpectatorMode('director'); // 'follow'
 */
export function nextSpectatorMode(mode: SpectatorCamMode): SpectatorCamMode {
  const i = SPECTATOR_MODES.indexOf(mode);
  return SPECTATOR_MODES[(i + 1) % SPECTATOR_MODES.length] as SpectatorCamMode;
}

/**
 * Spectator tools at the start of a show: following, nothing pinned, the
 * personal HUD (broadcast overlay off).
 *
 * @param broadcast - Start with the broadcast overlay on (a private show's spectator seat).
 */
export function initialSpectatorState(broadcast = false): SpectatorState {
  return {
    live: false,
    mode: 'follow',
    pinnedId: null,
    roster: [],
    broadcast,
    help: false,
    chroma: false,
    note: null,
  };
}

/**
 * Whether the broadcast overlay is on screen (and the personal HUD, chat
 * and toasts are hidden): broadcast mode on, spectating, during a round.
 *
 * @param s - UI state.
 */
export function broadcastActive(s: Pick<UIState, 'spectator' | 'screen' | 'photo'>): boolean {
  return !!s.spectator?.live && s.spectator.broadcast && s.screen === 'round' && !s.photo.active;
}

/**
 * Lower-cased, accent-free form for matching ("Zoë" finds "zoe").
 *
 * @param s - Text.
 */
export function foldForSearch(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Filters the spectator roster by a typed query: name substring (case and
 * accent insensitive), or a place when the query is a number ("3" or "#3").
 * Rows carry names already masked for Streamer Mode, so a search can never
 * match the real name behind "Tumbler 12".
 *
 * @param rows - Roster rows.
 * @param query - What the viewer typed.
 * @returns Matching rows, order kept.
 * @example
 * searchRoster(rows, 'zoe'); // finds "Zoë"
 */
export function searchRoster(rows: readonly SpectatorRosterEntry[], query: string): SpectatorRosterEntry[] {
  const q = foldForSearch(query);
  if (!q) return [...rows];
  const place = /^#?(\d{1,3})$/.exec(q);
  const n = place ? Number(place[1]) : -1;
  return rows.filter((r) => foldForSearch(r.name).includes(q) || (n > 0 && r.place === n));
}

/** One row of the help card. */
export interface SpectatorHelpRow {
  /** The binding it shows (null: a fixed control described by `fixed`). */
  action: BindAction | null;
  /** Controller action when it differs from the keyboard one, or null when the pad has none. */
  pad: PadBindAction | null;
  label: string;
  /** Fixed glyphs for controls that are not rebindable: [keyboard, pad]. */
  fixed?: [string, string];
}

/** What the help card lists, in order. */
export const SPECTATOR_HELP: readonly SpectatorHelpRow[] = [
  { action: 'spectateCamera', pad: 'spectateCamera', label: 'Camera: follow, free, overview, director' },
  { action: 'spectatePrev', pad: 'spectatePrev', label: 'Previous player' },
  { action: 'spectateNext', pad: 'spectateNext', label: 'Next player' },
  { action: 'spectateLeader', pad: 'spectateLeader', label: 'Watch the leader' },
  { action: 'spectateRoster', pad: 'spectateRoster', label: 'Find a player' },
  { action: 'spectatePin', pad: 'spectatePin', label: 'Pin / unpin who you watch' },
  { action: 'broadcastOverlay', pad: 'broadcastOverlay', label: 'Broadcast overlay' },
  { action: 'broadcastChroma', pad: null, label: 'Chroma-key backdrop (broadcast)' },
  { action: 'broadcastHelp', pad: 'broadcastHelp', label: 'This help' },
  { action: null, pad: null, label: 'Free camera: move', fixed: ['WASD', 'Left stick'] },
  { action: null, pad: null, label: 'Free camera: down / up', fixed: ['Q / E, Space', 'LT / RT'] },
  { action: null, pad: null, label: 'Free camera: faster', fixed: ['Shift', 'L3'] },
  { action: null, pad: null, label: 'Look around', fixed: ['Mouse', 'Right stick'] },
];
