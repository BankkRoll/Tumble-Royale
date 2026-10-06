/**
 * Pure routing rules for the pad and the Menu key, kept out of the app and
 * the show session so they can be tested without a browser.
 *
 * Responsibilities:
 * - {@link menuOwnsPad}: whether the D-pad / A / B / bumpers drive the UI
 *   (and gameplay ignores the pad);
 * - {@link padStartAction}: what pad Start does right now;
 * - {@link showMenuKeyAction}: what Esc / the Menu key does during a show.
 */
import { SHOW_MENU_SCREENS, menuOwnsInput, type UIState } from '@tumble/ui';

/** The UI fields the routing rules read. */
export type RoutingState = Pick<
  UIState,
  'inputMode' | 'dialog' | 'overlay' | 'screen' | 'eliminatedSheet' | 'watchChoice' | 'photo' | 'replay'
> & { elimReplay?: UIState['elimReplay'] };

/** Game-side facts the routing rules need. */
export interface RoutingContext {
  /** The player is running around the menu lobby (idle play owns the pad). */
  idlePlaying: boolean;
  /** A show (or Practice Island) session is running. */
  inShow: boolean;
  /** The running session reads Start / Esc itself (Practice Island's skip prompt). */
  sessionOwnsMenu: boolean;
}

/**
 * Whether menu navigation owns the gamepad: photo mode, the replay viewer and
 * the elimination replay always; otherwise menu screens, overlays, dialogs and the watch choice
 * (on any show screen, not only the round), unless idle play has the pad.
 *
 * @param s - UI state.
 * @param idlePlaying - The menu lobby's idle play is active.
 * @example
 * input.setGamepadGameplay(!menuOwnsPad(ui.getState(), menu.idlePlaying));
 */
export function menuOwnsPad(s: RoutingState, idlePlaying: boolean): boolean {
  return s.photo.active || s.replay !== null || !!s.elimReplay || (!idlePlaying && menuOwnsInput(s));
}

/** What pad Start does. */
export type PadStartAction =
  'none' | 'exitPhoto' | 'leaveIdlePlay' | 'openShowMenu' | 'closeOverlay' | 'openSettings';

/**
 * Pad Start: the in-game menu on every show screen, Settings in the menus.
 * Practice Island handles Start itself (its skip prompt), so the app stays
 * out of it there.
 *
 * @param s - UI state.
 * @param ctx - Game-side facts.
 */
export function padStartAction(s: RoutingState, ctx: RoutingContext): PadStartAction {
  if (ctx.inShow && ctx.sessionOwnsMenu) return 'none';
  // The elimination replay takes Start as its skip; it must not also open the menu underneath.
  if (s.dialog || s.elimReplay) return 'none';
  if (s.photo.active) return 'exitPhoto';
  if (ctx.idlePlaying) return 'leaveIdlePlay';
  if (ctx.inShow && SHOW_MENU_SCREENS.has(s.screen))
    return s.overlay === 'none' ? 'openShowMenu' : 'closeOverlay';
  if (s.overlay === 'settings') return 'closeOverlay';
  if (s.overlay === 'none' && s.inputMode === 'menu' && s.screen !== 'splash' && s.screen !== 'welcome')
    return 'openSettings';
  return 'none';
}

/**
 * Esc / the Menu key during a show: opens the in-game menu on every show
 * screen (so Leave show is always reachable) and closes it again. Other
 * overlays close through menu navigation's Back instead.
 *
 * @param s - UI state.
 * @returns `open`, `close`, or null when the key is not the show menu's.
 */
export function showMenuKeyAction(
  s: Pick<UIState, 'screen' | 'overlay' | 'dialog'>,
): 'open' | 'close' | null {
  if (s.dialog || !SHOW_MENU_SCREENS.has(s.screen)) return null;
  if (s.overlay === 'none') return 'open';
  if (s.overlay === 'inGameMenu') return 'close';
  return null;
}
