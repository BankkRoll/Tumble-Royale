/**
 * Where the touch controls show and what they offer.
 *
 * Touch players get the on-screen controls wherever their Tumbler can move:
 * - the round (and the tutorial, which runs on the round screen);
 * - the pre-show platform (offline and live online lobbies);
 * - the menu platform while idle play is on (party hangout, lobby games),
 *   where the menu chrome steps aside and a Done button brings it back.
 *
 * Pure so the visibility rules are unit-tested without rendering.
 */
import type { UIState } from '../store/uiStore.ts';

/** On-screen action buttons. */
export type TouchActionKey = 'jump' | 'dive' | 'grab';

/** Where the touch layer is showing. */
export type TouchContext = 'round' | 'preShow' | 'menu';

/** What the touch layer offers right now. */
export interface TouchMode {
  context: TouchContext;
  /** Joystick and action buttons are live (false keeps only the camera drag, e.g. while out of the round). */
  controls: boolean;
  /** Action buttons, in layout order. */
  buttons: readonly TouchActionKey[];
  /** The emote wheel button (only where the wheel is drawn). */
  emote: boolean;
  /** Camera drag surface (only where something reads the look). */
  look: boolean;
  /** A Done button that hands the screen back to the menu. */
  done: boolean;
}

/** The state {@link touchMode} reads. */
export type TouchModeInput = Pick<
  UIState,
  | 'isTouch'
  | 'screen'
  | 'overlay'
  | 'dialog'
  | 'menuTab'
  | 'idlePlay'
  | 'preShow'
  | 'replay'
  | 'inspectedProfile'
  | 'currencyPanel'
> & {
  hud: Pick<UIState['hud'], 'device' | 'localStatus'>;
  photo: Pick<UIState['photo'], 'active'>;
  lobbyGames: Pick<UIState['lobbyGames'], 'pickerOpen'>;
};

const ALL: readonly TouchActionKey[] = ['jump', 'dive', 'grab'];

/**
 * The touch layer for the current UI state.
 *
 * @param s - UI state.
 * @returns What to show, or null when the touch layer is hidden.
 * @example
 * const mode = useUI(useShallow(touchMode)); // `buttons` is a shared constant, so shallow equality holds
 */
export function touchMode(s: TouchModeInput): TouchMode | null {
  if (!s.isTouch || s.hud.device !== 'touch' || s.photo.active || s.replay !== null) return null;
  const free = s.overlay === 'none' && s.dialog === null;
  switch (s.screen) {
    case 'round':
      return {
        context: 'round',
        controls: free && s.hud.localStatus === 'playing',
        buttons: ALL,
        emote: true,
        look: true,
        done: false,
      };
    case 'preShow':
      if (!s.preShow) return null;
      return { context: 'preShow', controls: free, buttons: ALL, emote: false, look: false, done: false };
    case 'menu': {
      const menuOpen = s.lobbyGames.pickerOpen || s.inspectedProfile !== null || s.currencyPanel !== 'none';
      if (!s.idlePlay || s.menuTab !== 'play' || !free || menuOpen) return null;
      return { context: 'menu', controls: true, buttons: ALL, emote: false, look: true, done: true };
    }
    default:
      return null;
  }
}
