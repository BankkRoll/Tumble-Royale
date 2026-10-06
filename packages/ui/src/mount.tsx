/**
 * `mountUI(root)`: renders the overlay into the client's `#ui` element, loads
 * fonts and styles, wires keyboard/gamepad navigation and touch detection.
 */
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.tsx';
import { installKeyboardInset } from './hud/keyboardInset.ts';
import { createNavigator, installKeyboardNav } from './nav/navigation.ts';
import { setNavigator, ui } from './store/uiStore.ts';
import { FONT_STYLESHEET_URL } from './theme/tokens.ts';
import './theme/base.css';
import './theme/screens.css';
import './theme/hud.css';
import './theme/wall.css';
import './theme/lobby.css';
import './theme/lobbyGames.css';
import './theme/menu.css';
import './theme/progression.css';
import './theme/account.css';
import './theme/social.css';
import './theme/clubs.css';
import './theme/replay.css';
import './theme/share.css';
import './theme/vote.css';

/** Options for `mountUI`. */
export interface MountOptions {
  /** Inject the Google Fonts `<link>` (default true). */
  loadFonts?: boolean;
  /** Wrap in React StrictMode (default false; doubles effects in dev). */
  strict?: boolean;
}

/** Handle returned by `mountUI`. */
export interface UIHandle {
  /** Unmounts the overlay and removes listeners. */
  unmount: () => void;
}

function ensureFonts(): void {
  if (document.querySelector(`link[href="${FONT_STYLESHEET_URL}"]`)) return;
  for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = href;
    if (href.includes('gstatic')) pre.crossOrigin = '';
    document.head.appendChild(pre);
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_STYLESHEET_URL;
  document.head.appendChild(link);
}

/**
 * Mounts the React overlay.
 * @param rootEl The `#ui` element (sits above the game canvas).
 * @returns Handle with `unmount`.
 * @example
 * const handle = mountUI(document.getElementById('ui')!);
 * ui.getState().setScreen('splash');
 */
export function mountUI(rootEl: HTMLElement, opts: MountOptions = {}): UIHandle {
  if (opts.loadFonts !== false) ensureFonts();
  // The overlay must never eat canvas input where it's transparent.
  rootEl.style.pointerEvents = 'none';

  const touchQuery = window.matchMedia('(pointer: coarse)');
  const syncTouch = (): void => ui.getState().setTouch(touchQuery.matches || navigator.maxTouchPoints > 0);
  syncTouch();
  touchQuery.addEventListener('change', syncTouch);
  const uninstallKbInset = installKeyboardInset();

  const root: Root = createRoot(rootEl);
  root.render(
    opts.strict ? (
      <StrictMode>
        <App />
      </StrictMode>
    ) : (
      <App />
    ),
  );

  let uninstallKeys: (() => void) | null = null;
  // The `.tr-root` element exists after the first commit.
  const raf = requestAnimationFrame(() => {
    const trRoot = rootEl.querySelector<HTMLElement>('.tr-root') ?? rootEl;
    const navigate = createNavigator(trRoot);
    setNavigator(navigate);
    uninstallKeys = installKeyboardNav(navigate);
  });

  return {
    unmount: () => {
      cancelAnimationFrame(raf);
      uninstallKeys?.();
      setNavigator(null);
      touchQuery.removeEventListener('change', syncTouch);
      uninstallKbInset();
      root.unmount();
    },
  };
}
