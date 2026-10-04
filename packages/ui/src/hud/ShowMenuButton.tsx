/**
 * The visible way to the in-game menu (and Leave show) on show screens that
 * have no HUD: match found, the pre-show lobby, the show intro, round loading
 * and the waits between rounds. Esc / Menu / pad Start do the same; this is
 * for players who don't know that, and for mouse and touch.
 *
 * Practice Island keeps its own Skip button, so this stays hidden there.
 */
import { memo, type JSX } from 'react';
import { Icon } from '../components/icons/index.tsx';
import { openInGameMenu } from '../screens/overlays/InGameMenu.tsx';
import { MENU_INPUT_SCREENS } from '../store/defaults.ts';
import { SHOW_MENU_SCREENS } from '../store/inputOwnership.ts';
import type { ScreenId } from '../store/types.ts';
import { useUI, type UIState } from '../store/uiStore.ts';
import { useTutorialUI } from '../tutorial/store.ts';

/**
 * Whether the show screen needs the button: the round has the HUD gear, and
 * menu-input screens (results, victory, the wall) take Esc / B themselves.
 *
 * @param screen - Current screen.
 */
export function showMenuButtonScreen(screen: ScreenId): boolean {
  return SHOW_MENU_SCREENS.has(screen) && screen !== 'round' && !MENU_INPUT_SCREENS.has(screen);
}

/**
 * Whether the button shows: in a show, on a screen that needs it, with
 * nothing else open over it.
 *
 * @param s - UI state.
 */
export function showMenuButtonVisible(
  s: Pick<UIState, 'showSeat' | 'screen' | 'overlay' | 'photo'>,
): boolean {
  return s.showSeat !== null && s.overlay === 'none' && !s.photo.active && showMenuButtonScreen(s.screen);
}

/** Top-right "Menu" pill over HUD-less show screens. */
export const ShowMenuButton = memo(function ShowMenuButton(): JSX.Element | null {
  const visible = useUI(showMenuButtonVisible);
  const tutorial = useTutorialUI((t) => t.phase !== 'hidden');
  if (!visible || tutorial) return null;
  return (
    <button
      type="button"
      className="tr-show-menu-btn tr-interactive"
      aria-label="Show menu"
      data-testid="show-menu"
      onClick={openInGameMenu}
    >
      <Icon name="gear" size="1.1em" /> Menu
    </button>
  );
});
