/**
 * Who owns keyboard and gamepad input right now: the menus, the text chat or
 * the Tumbler.
 *
 * Responsibilities:
 * - {@link SHOW_MENU_SCREENS}: in-show screens where Esc / Menu / pad Start
 *   open the in-game menu (so Leave show is reachable from every one);
 * - {@link watchChoiceVisible} / {@link menuOwnsInput}: when menu navigation
 *   takes the keys and the pad instead of gameplay;
 * - {@link isTypingTarget} / {@link keyboardBusy}: when a text field or the
 *   open chat owns the keyboard, so global hotkeys (spectate Q/E, hold Space
 *   to skip, any-key skips) must ignore the key.
 */
import { social } from './social.ts';
import type { ScreenId } from './types.ts';
import type { UIState } from './uiStore.ts';

/**
 * Screens of a running show where the Menu key opens the in-game menu: the
 * whole flow from the match being found to the end-of-show wall. Rewards and
 * the menus come after the show is over.
 */
export const SHOW_MENU_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'matchFound',
  'preShow',
  'showIntro',
  'roundLoading',
  'roundIntro',
  'rules',
  'round',
  'roundResults',
  'betweenRounds',
  'finalHype',
  'victory',
  'winnerCam',
  'playerWall',
]);

/**
 * Whether the "Keep watching / Leave show" choice is on screen: the in-round
 * sheet on `round`, the card over every other show screen.
 *
 * @param s - UI state.
 */
export function watchChoiceVisible(s: Pick<UIState, 'screen' | 'eliminatedSheet' | 'watchChoice'>): boolean {
  return s.screen === 'round' ? s.eliminatedSheet : s.watchChoice !== null;
}

/**
 * Whether menu navigation owns the keys and the pad: menu screens, dialogs,
 * overlays and the watch choice. Gameplay ignores the pad meanwhile.
 *
 * @param s - UI state.
 */
export function menuOwnsInput(
  s: Pick<UIState, 'inputMode' | 'dialog' | 'overlay' | 'screen' | 'eliminatedSheet' | 'watchChoice'>,
): boolean {
  return s.inputMode === 'menu' || s.dialog !== null || s.overlay !== 'none' || watchChoiceVisible(s);
}

/** Input types that take no typed text (keys there are still hotkeys). */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * Whether a key event's target is a place the player types into.
 *
 * @param target - `KeyboardEvent.target`.
 * @example
 * if (isTypingTarget(e.target)) return; // the chat field keeps Q, E and Space
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase());
}

/**
 * Whether a global keyboard hotkey must stand down: the key went to a text
 * field, or the chat input is open (it owns every key until closed).
 *
 * @param e - The key event (only `target` is read).
 */
export function keyboardBusy(e: { target: EventTarget | null }): boolean {
  return isTypingTarget(e.target) || social.getState().chat.open;
}
