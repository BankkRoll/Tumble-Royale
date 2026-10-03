/**
 * Shared React hooks: clocks, count-ups, timed sequences, accessibility and
 * streamer-mode helpers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUI } from '../store/uiStore.ts';
import type { ShowPlayer } from '../store/types.ts';

/**
 * Re-renders every `intervalMs` and returns `Date.now()`.
 * @param intervalMs Tick rate; keep ≥ 250 for countdown labels.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Ease-out cubic for count-ups. */
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Animates a number from its previous value (or `from`) to `target`.
 * @param target Value to count to.
 * @param durationMs Animation length.
 * @param opts.from Initial value on first mount (default: target, i.e. no animation).
 * @param opts.onStep Called on each integer change (e.g. tick sounds).
 */
export function useCountUp(
  target: number,
  durationMs = 600,
  opts: { from?: number; onStep?: (v: number) => void; delayMs?: number } = {},
): number {
  const [value, setValue] = useState(opts.from ?? target);
  const valueRef = useRef(value);
  const onStep = useRef(opts.onStep);
  onStep.current = opts.onStep;
  const reduce = useReducedMotion();

  useEffect(() => {
    const start = valueRef.current;
    if (start === target) return;
    if (reduce || durationMs <= 0) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    let t0 = -1;
    const delay = opts.delayMs ?? 0;
    const tick = (now: number): void => {
      if (t0 < 0) t0 = now + delay;
      const p = Math.min(1, Math.max(0, (now - t0) / durationMs));
      const v = Math.round(start + (target - start) * easeOut(p));
      if (v !== valueRef.current) {
        valueRef.current = v;
        setValue(v);
        onStep.current?.(v);
      }
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // opts.delayMs is read once per target change on purpose.
  }, [target, durationMs, reduce]);

  return value;
}

/**
 * Runs a list of timed steps after mount (or when `key` changes) and returns
 * the index of the latest step reached. Timers are cleared on unmount.
 * @param delays Cumulative ms offsets for steps 1..n (step 0 is immediate).
 * @param key Restart the sequence when this changes.
 * @example const step = useSequence([400, 900, 1600]); // 0 → 1 @400ms → 2 @900ms → 3 @1600ms
 */
export function useSequence(delays: readonly number[], key: unknown = 0): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
    const ids = delays.map((d, i) => window.setTimeout(() => setStep(i + 1), d));
    return () => ids.forEach((id) => window.clearTimeout(id));
    // delays are expected to be static literals per component.
  }, [key]);
  return step;
}

/** Calls `fn` after `ms` (cancelled on unmount / dep change). */
export function useTimeout(fn: () => void, ms: number | null, deps: readonly unknown[] = []): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = window.setTimeout(() => ref.current(), ms);
    return () => window.clearTimeout(id);
  }, [ms, ...deps]);
}

/** True when Reduce Motion is on in settings. */
export function useReducedMotion(): boolean {
  return useUI((s) => s.settings.accessibility.reduceMotion);
}

/** True when Reduce Flashing is on in settings. */
export function useReducedFlashing(): boolean {
  return useUI((s) => s.settings.accessibility.reduceFlashing);
}

/**
 * Display name honouring Streamer Mode: other humans become "Tumbler N".
 * Bots keep their generated names (they're not personal data).
 */
export function useDisplayName(): (
  p: Pick<ShowPlayer, 'id' | 'name' | 'isLocal' | 'isBot' | 'isParty'>,
) => string {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  return useCallback(
    (p) => (streamer && !p.isLocal && !p.isBot && !p.isParty ? `Tumbler ${p.id + 1}` : p.name),
    [streamer],
  );
}

/** Formats seconds as `m:ss`. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Formats a duration in ms as `1d 4h`, `05:12:33` or `0:42`. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Thousands-separated integer. */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** English ordinal (`1st`, `2nd`, `23rd`). */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
