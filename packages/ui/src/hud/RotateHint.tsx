/**
 * "Turn your phone sideways" hint for touch players holding the phone upright
 * during a show: the course camera, the HUD and the touch controls are laid
 * out for landscape, and portrait shows a sliver of the course. Dismissing it
 * keeps it away for the rest of the session.
 */
import { useEffect, useState, type JSX } from 'react';
import { Icon } from '../components/icons/index.tsx';
import { useUI } from '../store/uiStore.ts';
import type { ScreenId } from '../store/types.ts';

/** Screens where the course is on screen and landscape matters. */
const HINT_SCREENS: ReadonlySet<ScreenId> = new Set(['preShow', 'roundIntro', 'rules', 'round']);

let dismissedThisSession = false;

/** Inputs for {@link shouldHintRotate}. */
export interface RotateHintState {
  touch: boolean;
  portrait: boolean;
  screen: ScreenId;
  dismissed: boolean;
}

/**
 * Whether the rotate hint shows.
 *
 * @param s - Device, orientation, screen and whether the player dismissed it.
 */
export function shouldHintRotate(s: RotateHintState): boolean {
  return s.touch && s.portrait && !s.dismissed && HINT_SCREENS.has(s.screen);
}

const portraitQuery = (): MediaQueryList | undefined =>
  typeof window !== 'undefined' ? window.matchMedia?.('(orientation: portrait)') : undefined;

function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(() => portraitQuery()?.matches ?? false);
  useEffect(() => {
    const query = portraitQuery();
    if (!query) return;
    const on = (): void => setPortrait(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return portrait;
}

/** The hint chip (renders nothing when it does not apply). */
export function RotateHint(): JSX.Element | null {
  const touch = useUI((s) => s.isTouch);
  const screen = useUI((s) => s.screen);
  const portrait = usePortrait();
  const [dismissed, setDismissed] = useState(dismissedThisSession);
  if (!shouldHintRotate({ touch, portrait, screen, dismissed })) return null;
  return (
    <div className="tr-rotate-hint tr-interactive" role="status" data-testid="rotate-hint">
      <span className="tr-rotate-hint-phone" aria-hidden />
      <span>Turn your phone sideways to see more of the course</span>
      <button
        type="button"
        className="tr-rotate-hint-close"
        aria-label="Dismiss"
        onClick={() => {
          dismissedThisSession = true;
          setDismissed(true);
        }}
      >
        <Icon name="close" size="0.9em" />
      </button>
    </div>
  );
}
