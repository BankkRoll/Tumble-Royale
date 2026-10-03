/**
 * Motion toolkit: spring easing generation, standard durations/curves, and
 * small Web Animations API helpers used across screens.
 *
 * Springs are sampled into CSS `linear()` easing strings so CSS keyframes and
 * WAAPI share one physically-plausible curve without a JS animation loop.
 */

/** Spring parameters (unit mass). */
export interface SpringParams {
  stiffness: number;
  damping: number;
}

/** Standard durations in ms. */
export const DUR = { xs: 120, sm: 200, md: 320, lg: 520, xl: 700 } as const;

/** Cubic-bezier fallbacks and named curves. */
export const EASE = {
  backOut: 'cubic-bezier(.34,1.56,.64,1)',
  backIn: 'cubic-bezier(.36,0,.66,-.56)',
  gravity: 'cubic-bezier(.45,0,.95,.55)',
  out: 'cubic-bezier(.22,1,.36,1)',
  inOut: 'cubic-bezier(.65,0,.35,1)',
} as const;

/**
 * Samples a damped spring from 0 → 1 and returns a CSS `linear()` easing plus
 * the time it takes to settle.
 * @param params Stiffness/damping (critical damping ≈ 2·√k).
 * @param samples Number of points in the easing (more = smoother, longer string).
 * @returns `{ easing, durationMs }`.
 * @example const { easing, durationMs } = springEasing({ stiffness: 170, damping: 14 });
 */
export function springEasing(params: SpringParams, samples = 40): { easing: string; durationMs: number } {
  const { stiffness: k, damping: c } = params;
  const dt = 1 / 240;
  let x = 0;
  let v = 0;
  let t = 0;
  const trace: number[] = [];
  let settledFor = 0;
  // Integrate until the spring has rested near 1 for 80 ms (cap 2 s).
  while (t < 2) {
    const a = k * (1 - x) - c * v;
    v += a * dt;
    x += v * dt;
    t += dt;
    trace.push(x);
    if (Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02) settledFor += dt;
    else settledFor = 0;
    if (settledFor > 0.08) break;
  }
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const idx = Math.min(trace.length - 1, Math.round((i / samples) * (trace.length - 1)));
    points.push((trace[idx] ?? 1).toFixed(4));
  }
  points[points.length - 1] = '1';
  return { easing: `linear(0, ${points.slice(1).join(', ')})`, durationMs: Math.round(t * 1000) };
}

const cache = new Map<string, string>();
let linearSupported: boolean | null = null;

/**
 * Easing string for a spring, falling back to `backOut` when the browser lacks `linear()`.
 * @param params Spring params.
 */
export function spring(params: SpringParams = SPRINGS.default): string {
  if (linearSupported === null) {
    linearSupported = typeof CSS !== 'undefined' && CSS.supports('animation-timing-function', 'linear(0, 1)');
  }
  if (!linearSupported) return EASE.backOut;
  const key = `${params.stiffness}/${params.damping}`;
  let e = cache.get(key);
  if (!e) {
    e = springEasing(params).easing;
    cache.set(key, e);
  }
  return e;
}

/** Named spring presets (docs/design/SCREENS.md §0.3). */
export const SPRINGS = {
  default: { stiffness: 170, damping: 14 },
  soft: { stiffness: 120, damping: 16 },
  snappy: { stiffness: 320, damping: 18 },
  wobbly: { stiffness: 180, damping: 8 },
} as const satisfies Record<string, SpringParams>;

/**
 * Writes the spring easings onto an element as CSS custom properties
 * (`--ease-spring`, `--ease-spring-soft`, `--ease-spring-snappy`, `--ease-spring-wobbly`).
 */
export function installEasingVars(el: HTMLElement): void {
  el.style.setProperty('--ease-spring', spring(SPRINGS.default));
  el.style.setProperty('--ease-spring-soft', spring(SPRINGS.soft));
  el.style.setProperty('--ease-spring-snappy', spring(SPRINGS.snappy));
  el.style.setProperty('--ease-spring-wobbly', spring(SPRINGS.wobbly));
}

/** True when the root has Reduce Motion on (settings or OS). */
export function prefersReducedMotion(): boolean {
  const root = document.querySelector('.tr-root');
  if (root?.getAttribute('data-reduce-motion') === 'true') return true;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Plays a springy pop-in on an element.
 * @returns The animation (await `.finished`).
 */
export function popIn(el: Element, delay = 0, from = 0.4): Animation {
  if (prefersReducedMotion()) {
    return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay, fill: 'backwards' });
  }
  return el.animate(
    [
      { transform: `scale(${from})`, opacity: 0 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    { duration: DUR.lg, delay, easing: spring(), fill: 'backwards' },
  );
}

/** Squash-and-stretch press on an element. */
export function squash(el: Element, strength = 1): Animation | null {
  if (prefersReducedMotion()) return null;
  const s = 0.15 * strength;
  return el.animate(
    [
      { transform: 'scale(1,1)' },
      { transform: `scale(${1 + s},${1 - s})` },
      { transform: `scale(${1 - s / 3},${1 + s / 3})` },
      { transform: 'scale(1,1)' },
    ],
    { duration: 280, easing: 'ease-out' },
  );
}

/** Decaying rotational wobble. */
export function wobble(el: Element, degrees = 4): Animation | null {
  if (prefersReducedMotion()) return null;
  return el.animate(
    [0, 1, -0.8, 0.55, -0.35, 0.15, 0].map((m) => ({ transform: `rotate(${m * degrees}deg)` })),
    { duration: 600, easing: 'ease-out' },
  );
}

/** Horizontal "no" shake (invalid input). */
export function shakeNo(el: Element): Animation | null {
  if (prefersReducedMotion()) return null;
  return el.animate(
    [0, -10, 9, -7, 5, -2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: 420, easing: 'ease-out' },
  );
}

/** Screen shake for impacts; respects Reduce Shake/Motion via the root flags. */
export function screenShake(el: Element, px = 6, ms = 220): Animation | null {
  const root = document.querySelector('.tr-root');
  if (prefersReducedMotion() || root?.getAttribute('data-reduce-shake') === 'true') return null;
  const frames: Keyframe[] = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const decay = 1 - i / n;
    const x = (i % 2 === 0 ? 1 : -1) * px * decay;
    const y = (i % 3 === 0 ? -1 : 1) * px * 0.6 * decay;
    frames.push({ transform: `translate(${x}px, ${y}px)` });
  }
  return el.animate(frames, { duration: ms, easing: 'linear' });
}
