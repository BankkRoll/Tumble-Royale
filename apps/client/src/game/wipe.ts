/**
 * Screen changes that swap the 3D scene while the Tumble Wipe covers the
 * screen (outside a show session, which has its own flow-timed variant).
 */
import { ui, uiEvents, type ScreenId, type SetScreenOptions } from '@tumble/ui';

const FALLBACK_MS = 1600;

/**
 * Changes screen and runs `swap` once covered. With Reduce Motion (wipes
 * become fades) or a non-wipe transition, `swap` runs immediately; a timeout
 * guarantees it runs even if the cover event never arrives.
 *
 * @param screen - Target screen.
 * @param opts - Screen options; defaults to a wipe.
 * @param swap - The 3D swap.
 * @example
 * swapUnderWipe('menu', {}, () => director.show(new MenuView(...)));
 */
export function swapUnderWipe(screen: ScreenId, opts: SetScreenOptions, swap: () => void): void {
  const wipe = (opts.transition ?? 'wipe') === 'wipe' && !ui.getState().settings.accessibility.reduceMotion;
  let done = false;
  let off: (() => void) | null = null;
  const run = (): void => {
    if (done) return;
    done = true;
    off?.();
    window.clearTimeout(timer);
    try {
      swap();
    } catch (err) {
      console.error(`[game] scene swap for ${screen} failed`, err);
    }
  };
  const timer = wipe ? window.setTimeout(run, FALLBACK_MS) : 0;
  if (wipe) off = uiEvents.on('transitionCovered', ({ to }) => to === screen && run());
  ui.getState().setScreen(screen, { transition: 'wipe', ...opts });
  if (!wipe) run();
}
