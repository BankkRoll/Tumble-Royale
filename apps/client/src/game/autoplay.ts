/**
 * `?autoplay=1` UI driver: clicks through the first-launch screens and presses
 * PLAY so a whole show runs unattended (e2e tests, soak runs, attract mode).
 * In-show decisions (spectate after elimination, continue after victory) are
 * made by the show session itself.
 */
import { randomTumblerName, tumblerSwatches, ui, uiEvents, type ScreenId } from '@tumble/ui';

/**
 * Installs the driver.
 *
 * @param shows - How many shows to queue before stopping (default 1).
 * @returns Uninstall function.
 */
export function installAutoplay(shows = 1): () => void {
  let played = 0;
  let timer = 0;
  let last: ScreenId | null = null;
  const later = (ms: number, fn: () => void): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
  const onScreen = (screen: ScreenId): void => {
    if (screen === last) return;
    last = screen;
    switch (screen) {
      case 'splash':
        later(4200, () => uiEvents.emit('start'));
        break;
      case 'welcome':
        later(900, () => {
          const primary = tumblerSwatches[Math.floor(Math.random() * tumblerSwatches.length)] ?? '#ff6fb5';
          uiEvents.emit('welcomeDone', { name: randomTumblerName(Math.random), colors: { primary, secondary: '#ffd23f', pattern: 'dots' } });
        });
        break;
      case 'tutorialPrompt':
        later(700, () => uiEvents.emit('tutorialChoice', { accept: false, dontAskAgain: true }));
        break;
      case 'menu':
        if (played < shows) {
          later(2600, () => {
            if (ui.getState().screen !== 'menu') return;
            played++;
            const st = ui.getState();
            // Same path as a player pressing PLAY on the Play tab's start card.
            const mode = st.playMode === 'online' && st.onlineStatus.state === 'online' ? 'online' : 'offline';
            uiEvents.emit('play', { playlistId: st.selectedPlaylist, mode });
          });
        }
        break;
      default:
        break;
    }
  };
  onScreen(ui.getState().screen);
  const unsub = ui.subscribe((s) => onScreen(s.screen));
  return () => {
    window.clearTimeout(timer);
    unsub();
  };
}
