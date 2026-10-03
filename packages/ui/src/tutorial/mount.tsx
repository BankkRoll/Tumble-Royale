/**
 * `mountTutorialOverlay(el)`: renders the Practice Island overlay into its own
 * React root, beside (not inside) the main UI root, so the tutorial ships
 * without touching the main overlay's composition.
 */
import { createRoot } from 'react-dom/client';
import { TUTORIAL_UI_DEFAULTS, tutorialUi } from './store.ts';
import { TutorialOverlay } from './TutorialOverlay.tsx';
import './tutorial.css';

/** Handle returned by {@link mountTutorialOverlay}. */
export interface TutorialOverlayHandle {
  /** Unmounts the overlay, removes its element and resets the store. */
  unmount: () => void;
}

/**
 * Mounts the tutorial overlay.
 *
 * @param host - Element to render into; created and appended to `<body>` when omitted.
 * @returns Handle with `unmount`.
 * @example
 * const overlay = mountTutorialOverlay();
 * tutorialUi.setState({ phase: 'intro', title: { title: 'Practice Island', subtitle: '…', skipKeys: ['Space'] } });
 * // …later
 * overlay.unmount();
 */
export function mountTutorialOverlay(host?: HTMLElement): TutorialOverlayHandle {
  const el = host ?? document.body.appendChild(document.createElement('div'));
  el.dataset.tutorialOverlay = '';
  el.style.pointerEvents = 'none';
  const root = createRoot(el);
  root.render(<TutorialOverlay />);
  return {
    unmount: () => {
      root.unmount();
      if (!host) el.remove();
      tutorialUi.setState({ ...TUTORIAL_UI_DEFAULTS });
    },
  };
}
