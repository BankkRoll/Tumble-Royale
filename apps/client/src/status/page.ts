/**
 * Status page controller: fetches the summary and history, renders, and
 * keeps refreshing.
 *
 * - The summary refreshes every 30 s while the tab is visible (and at once
 *   when it becomes visible again); the history every 10 min.
 * - A failed or malformed answer keeps the last good summary on screen with
 *   a "last known" note, or shows "can't reach the status service" when
 *   there never was one. It never throws.
 */
import type { StatusHistory, StatusSummary } from '@tumble/shared/status';
import { OVERALL_LABELS } from '@tumble/shared/status';
import { statusPage, type PageState } from './view.ts';
import { mount } from './vdom.ts';

/** How often the summary is re-read. */
export const SUMMARY_REFRESH_MS = 30_000;
/** How often the history is re-read. */
export const HISTORY_REFRESH_MS = 10 * 60_000;

/** What the controller needs from the page. */
export interface StatusPageOptions {
  /** Container to render into. */
  root: Element;
  /** API base URL (no trailing slash). */
  api: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  formatTime?: (iso: string) => string;
}

/** A running page. */
export interface StatusPageHandle {
  /** Re-reads the summary (and the history when `withHistory`), then renders. */
  refresh(withHistory?: boolean): Promise<void>;
  /** The state last rendered. */
  state(): PageState;
  stop(): void;
}

/**
 * Whether a value looks like a summary this page can render; anything else
 * (an HTML error page from a proxy, an older API) counts as unreachable.
 *
 * @param v - Parsed JSON.
 */
export function isSummary(v: unknown): v is StatusSummary {
  const s = v as Partial<StatusSummary> | null;
  return (
    !!s &&
    typeof s.overall === 'string' &&
    s.overall in OVERALL_LABELS &&
    Array.isArray(s.components) &&
    Array.isArray(s.incidents) &&
    !!s.maintenance &&
    typeof s.generatedAt === 'string'
  );
}

function isHistory(v: unknown): v is StatusHistory {
  const s = v as Partial<StatusHistory> | null;
  return !!s && Array.isArray(s.days) && Array.isArray(s.components) && Array.isArray(s.incidents);
}

const defaultFormat = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Starts the page: renders the loading state, fetches, then polls.
 *
 * @param opts - Container, API base and injectable clock and fetch.
 * @returns A handle (tests drive `refresh` directly).
 * @example
 * startStatusPage({ root: document.getElementById('status')!, api: ENDPOINTS.api });
 */
export function startStatusPage(opts: StatusPageOptions): StatusPageHandle {
  const fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  let state: PageState = {
    summary: null,
    history: null,
    unreachable: false,
    lastOk: null,
    now: now(),
    feeds: { atom: `${opts.api}/status/feed.atom`, json: `${opts.api}/status/feed.json` },
    formatTime: opts.formatTime ?? defaultFormat,
  };
  const render = () => mount(opts.root, statusPage(state));

  const getJson = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${opts.api}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  // Refreshes overlap when the API is slow (the timer, the tab becoming visible); an older
  // answer landing last must not paint over a newer one.
  let issued = 0;
  let summaryShown = 0;
  let historyShown = 0;
  /** When history last loaded; a failed load is retried on the next tick, not ten minutes later. */
  let lastHistory = -Infinity;

  const refresh = async (withHistory = false): Promise<void> => {
    const n = ++issued;
    const [summary, history] = await Promise.all([
      getJson('/status/summary').catch(() => null),
      withHistory ? getJson('/status/history').catch(() => null) : Promise.resolve(undefined),
    ]);
    const t = now();
    if (n > summaryShown) {
      summaryShown = n;
      state = isSummary(summary)
        ? { ...state, summary, unreachable: false, lastOk: t, now: t }
        : { ...state, unreachable: true, now: t };
    }
    if (isHistory(history) && n > historyShown) {
      historyShown = n;
      lastHistory = t;
      state = { ...state, history };
    }
    render();
  };

  render();
  void refresh(true);
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void refresh(now() - lastHistory >= HISTORY_REFRESH_MS);
  };
  const timer = setInterval(tick, SUMMARY_REFRESH_MS);
  const onVisible = () => {
    if (!document.hidden) tick();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  return {
    refresh,
    state: () => state,
    stop: () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
