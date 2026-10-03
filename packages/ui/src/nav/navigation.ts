/**
 * Spatial focus navigation for keyboard and gamepad.
 *
 * Elements opt in with `data-nav`; containers declare `data-nav-scope="<priority>"`
 * (the highest-priority visible scope wins, so dialogs trap focus over sheets
 * over screens). `data-autofocus` marks the initial focus, `data-nav-back` the
 * element "Back" activates, and `data-nav-tabs` a tab strip for LB/RB.
 */
import { MENU_TABS, type NavDirection } from '../store/types.ts';
import { ui } from '../store/uiStore.ts';
import { uiEvents } from '../store/events.ts';
import { playCue } from '../audio-cues.ts';

function visible(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function activeScope(root: HTMLElement): HTMLElement {
  let best: HTMLElement = root;
  let bestPriority = -Infinity;
  root.querySelectorAll<HTMLElement>('[data-nav-scope]').forEach((s) => {
    const p = Number(s.dataset.navScope ?? 0);
    if (p >= bestPriority && visible(s)) {
      best = s;
      bestPriority = p;
    }
  });
  return best;
}

function candidates(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-nav]')).filter(visible);
}

function center(r: DOMRect): { x: number; y: number } {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

let lastNavFocus: HTMLElement | null = null;

/**
 * Scrolls only genuinely scrollable ancestors so `el` is visible.
 * `scrollIntoView` would also scroll `overflow: hidden` ancestors (the overlay
 * root), shoving the whole UI off-screen.
 */
export function scrollIntoNearest(el: HTMLElement, center = false): void {
  let p = el.parentElement;
  while (p) {
    const st = getComputedStyle(p);
    const sx = /(auto|scroll)/.test(st.overflowX) && p.scrollWidth > p.clientWidth;
    const sy = /(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight;
    if (sx || sy) {
      const pr = p.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (sx)
        dx = center
          ? r.left + r.width / 2 - (pr.left + pr.width / 2)
          : r.left < pr.left
            ? r.left - pr.left - 8
            : r.right > pr.right
              ? r.right - pr.right + 8
              : 0;
      if (sy)
        dy = center
          ? r.top + r.height / 2 - (pr.top + pr.height / 2)
          : r.top < pr.top
            ? r.top - pr.top - 8
            : r.bottom > pr.bottom
              ? r.bottom - pr.bottom + 8
              : 0;
      if (dx || dy) p.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
      return;
    }
    if (p.classList.contains('tr-root')) return;
    p = p.parentElement;
  }
}

function focusEl(el: HTMLElement): void {
  lastNavFocus?.classList.remove('is-nav-focus');
  el.focus({ preventScroll: true });
  scrollIntoNearest(el);
  el.classList.add('is-nav-focus');
  lastNavFocus = el;
  el.addEventListener('blur', () => el.classList.remove('is-nav-focus'), { once: true });
}

/**
 * Picks the best candidate in a direction: nearest along the axis, heavily
 * penalising perpendicular offset so rows/columns feel natural.
 */
function pickInDirection(
  from: HTMLElement,
  list: HTMLElement[],
  dir: 'up' | 'down' | 'left' | 'right',
): HTMLElement | null {
  const a = center(from.getBoundingClientRect());
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const b = center(el.getBoundingClientRect());
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let primary: number;
    let perp: number;
    switch (dir) {
      case 'right':
        primary = dx;
        perp = Math.abs(dy);
        break;
      case 'left':
        primary = -dx;
        perp = Math.abs(dy);
        break;
      case 'down':
        primary = dy;
        perp = Math.abs(dx);
        break;
      case 'up':
        primary = -dy;
        perp = Math.abs(dx);
        break;
    }
    if (primary <= 2) continue;
    const score = primary + perp * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function cycleTabs(scope: HTMLElement, delta: 1 | -1): boolean {
  const s = ui.getState();
  if (s.screen === 'menu' && s.overlay === 'none' && !s.dialog) {
    const i = MENU_TABS.indexOf(s.menuTab);
    const next = MENU_TABS[(i + delta + MENU_TABS.length) % MENU_TABS.length];
    if (next) {
      playCue('ui.tab');
      s.setMenuTab(next);
    }
    return true;
  }
  const strip = scope.querySelector<HTMLElement>('[data-nav-tabs]');
  if (!strip) return false;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).filter(visible);
  const cur = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  const next = tabs[(cur + delta + tabs.length) % tabs.length];
  next?.click();
  return Boolean(next);
}

/**
 * Creates the navigator bound to the overlay root.
 * @param root `.tr-root` element.
 * @returns `navigate(dir)`, installed into the store by `mountUI`.
 */
export function createNavigator(root: HTMLElement): (dir: NavDirection) => void {
  return (dir) => {
    const scope = activeScope(root);
    const list = candidates(scope);
    const active =
      document.activeElement instanceof HTMLElement &&
      scope.contains(document.activeElement) &&
      document.activeElement.hasAttribute('data-nav')
        ? document.activeElement
        : null;

    switch (dir) {
      case 'accept':
        if (active) active.click();
        else uiEvents.emit('navUnhandled', { dir });
        return;
      case 'back': {
        const back = scope.querySelector<HTMLElement>('[data-nav-back]');
        if (back && visible(back)) back.click();
        else uiEvents.emit('navUnhandled', { dir });
        return;
      }
      case 'tabPrev':
      case 'tabNext':
        if (!cycleTabs(scope, dir === 'tabNext' ? 1 : -1)) uiEvents.emit('navUnhandled', { dir });
        return;
      default: {
        if (list.length === 0) {
          uiEvents.emit('navUnhandled', { dir });
          return;
        }
        if (!active) {
          const first = scope.querySelector<HTMLElement>('[data-autofocus]') ?? list[0];
          if (first && visible(first)) focusEl(first);
          return;
        }
        const next = pickInDirection(active, list, dir);
        if (next) focusEl(next);
        else uiEvents.emit('navUnhandled', { dir });
      }
    }
  };
}

/**
 * Focuses the `data-autofocus` element of the active scope (if focus isn't
 * already inside it). Called after screen changes so pads can press A at once.
 */
export function focusInitial(root: HTMLElement): void {
  const scope = activeScope(root);
  if (document.activeElement instanceof HTMLElement && scope.contains(document.activeElement)) return;
  const el = scope.querySelector<HTMLElement>('[data-autofocus]');
  if (el && visible(el)) el.focus({ preventScroll: true });
}

const TEXT_INPUT = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * Installs keyboard handling: arrows/Escape/Q/E drive menus when the store is
 * in `menu` input mode (or a dialog/overlay is open).
 * @returns Uninstall function.
 */
export function installKeyboardNav(navigate: (dir: NavDirection) => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    const s = ui.getState();
    const menuish = s.inputMode === 'menu' || s.dialog !== null || s.overlay !== 'none' || s.eliminatedSheet;
    if (!menuish) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target && (TEXT_INPUT.test(target.tagName) || target.isContentEditable);
    const isRange = typing && (target as HTMLInputElement).type === 'range';

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        if (typing && !isRange) return;
        e.preventDefault();
        navigate(e.key === 'ArrowUp' ? 'up' : 'down');
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (typing) return;
        e.preventDefault();
        navigate(e.key === 'ArrowLeft' ? 'left' : 'right');
        return;
      case 'Escape':
        e.preventDefault();
        navigate('back');
        return;
      case 'q':
      case 'Q':
      case '[':
        if (typing || s.dialog) return;
        navigate('tabPrev');
        return;
      case 'e':
      case 'E':
      case ']':
        if (typing || s.dialog) return;
        navigate('tabNext');
        return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
