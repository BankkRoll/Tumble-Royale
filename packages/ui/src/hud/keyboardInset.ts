/**
 * On-screen keyboard inset. Mobile browsers now shrink only the visual
 * viewport when the keyboard opens (Chrome on Android since 108, iOS Safari
 * always), so overlay UI pinned to the bottom of the layout viewport, like
 * the chat input, ends up under the keyboard. This publishes the covered
 * height as `--kb-inset` for that UI to lift itself by.
 */

/** Below this the "keyboard" is a collapsing toolbar or a rounding error, not a keyboard. */
const MIN_KEYBOARD_PX = 80;

/**
 * Height of the layout viewport hidden below the visual viewport.
 *
 * @param layoutHeight - `window.innerHeight`.
 * @param visualHeight - `visualViewport.height`.
 * @param visualTop - `visualViewport.offsetTop`.
 * @returns Pixels to lift bottom-anchored UI by (0 when no keyboard is up).
 * @example
 * keyboardInset(800, 480, 0); // 320
 */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const covered = Math.round(layoutHeight - visualHeight - visualTop);
  return covered >= MIN_KEYBOARD_PX ? covered : 0;
}

/**
 * Keeps `--kb-inset` on `target` in step with the visual viewport.
 *
 * @param target - Element that carries the variable (the document root by default).
 * @returns Stops listening and clears the variable.
 */
export function installKeyboardInset(target: HTMLElement = document.documentElement): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  let last = -1;
  const sync = (): void => {
    const px = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
    if (px === last) return;
    last = px;
    target.style.setProperty('--kb-inset', `${px}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
    target.style.removeProperty('--kb-inset');
  };
}
