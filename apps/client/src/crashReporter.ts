/**
 * Client crash reporting.
 *
 * Responsibilities:
 * - Catch uncaught errors and unhandled promise rejections.
 * - Batch them to the API's `POST /events` as `client.error` events, and to a
 *   Sentry-compatible DSN when `config.json` names one.
 * - Stay harmless: duplicates are folded, volume is capped per minute and per
 *   page load, and nothing the reporter itself does (a failed POST, a
 *   rejection inside a send) is ever reported again, so it cannot loop.
 */
import { parseSentryDsn, sendToSentry, type SentryTarget } from '@tumble/shared/sentry';

/** One captured error, as sent in `props`. */
export interface CrashReport {
  kind: 'error' | 'unhandledrejection';
  type: string;
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  col?: number;
  /** Page path (no query string: it can carry tokens). */
  path: string;
  /** Times this signature repeated before the batch was sent. */
  count: number;
}

/** Options for {@link CrashReporter}. */
export interface CrashReporterOptions {
  /** API base URL; reports go to `<apiUrl>/events`. Null disables the API sink. */
  apiUrl: string | null;
  sentryDsn?: string | undefined;
  fetch?: typeof fetch;
  /** Wall clock in ms. */
  now?: () => number;
  /** Batch delay (default 5 s). */
  flushMs?: number;
  /** Distinct reports per rolling minute (default 10). */
  perMinute?: number;
  /** Distinct reports per page load (default 50). */
  perSession?: number;
  release?: string;
}

const MAX_STACK = 4000;
const MAX_MESSAGE = 500;
const MAX_BATCH = 20;

function describe(reason: unknown): { type: string; message: string; stack?: string } {
  if (reason instanceof Error) {
    return {
      type: reason.name || 'Error',
      message: reason.message,
      ...(reason.stack ? { stack: reason.stack } : {}),
    };
  }
  let message: string;
  try {
    message = typeof reason === 'string' ? reason : JSON.stringify(reason);
  } catch {
    message = String(reason);
  }
  return { type: typeof reason === 'object' && reason !== null ? 'NonError' : typeof reason, message };
}

/**
 * Collects and ships uncaught client errors.
 *
 * @example
 * const reporter = new CrashReporter({ apiUrl: ENDPOINTS.api });
 * reporter.install(window);
 */
export class CrashReporter {
  private readonly queue = new Map<string, CrashReport>();
  private readonly sentry: SentryTarget | null;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly recent: number[] = [];
  private sent = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  /** Reports dropped by the rate limits (tests, diagnostics). */
  dropped = 0;
  /** Every error seen this page load, repeats and dropped ones included (analytics `error_count`). */
  captured = 0;

  constructor(private readonly opts: CrashReporterOptions) {
    this.sentry = opts.sentryDsn ? parseSentryDsn(opts.sentryDsn) : null;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Listens for `error` and `unhandledrejection` on `target` and flushes on
   * `pagehide`.
   *
   * @returns A function that removes the listeners.
   */
  install(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onError = (e: ErrorEvent): void => {
      // Resource load failures (img/script 404s) arrive as plain Events without `message`.
      if (typeof e.message !== 'string' && e.error === undefined) return;
      this.capture('error', e.error ?? e.message, {
        source: e.filename,
        line: e.lineno,
        col: e.colno,
      });
    };
    const onRejection = (e: PromiseRejectionEvent): void => this.capture('unhandledrejection', e.reason);
    const onHide = (): void => void this.flush();
    target.addEventListener('error', onError as EventListener);
    target.addEventListener('unhandledrejection', onRejection as EventListener);
    target.addEventListener('pagehide', onHide);
    return () => {
      target.removeEventListener('error', onError as EventListener);
      target.removeEventListener('unhandledrejection', onRejection as EventListener);
      target.removeEventListener('pagehide', onHide);
    };
  }

  /**
   * Records one error (deduplicated and rate limited).
   *
   * @param kind - Which global handler saw it.
   * @param reason - The thrown value.
   * @param where - Source location from an `ErrorEvent`.
   */
  capture(
    kind: CrashReport['kind'],
    reason: unknown,
    where: { source?: string; line?: number; col?: number } = {},
  ): void {
    // A send in progress that fails must not report itself.
    if (this.sending && kind === 'unhandledrejection') return;
    this.captured++;
    const d = describe(reason);
    const key = `${kind}|${d.type}|${d.message}|${where.source ?? ''}:${where.line ?? ''}`;
    const existing = this.queue.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    const t = this.now();
    while (this.recent.length && t - this.recent[0]! > 60_000) this.recent.shift();
    if (
      this.recent.length >= (this.opts.perMinute ?? 10) ||
      this.sent + this.queue.size >= (this.opts.perSession ?? 50) ||
      this.queue.size >= MAX_BATCH
    ) {
      this.dropped++;
      return;
    }
    this.recent.push(t);
    this.queue.set(key, {
      kind,
      type: d.type,
      message: d.message.slice(0, MAX_MESSAGE),
      ...(d.stack ? { stack: d.stack.slice(0, MAX_STACK) } : {}),
      ...(where.source ? { source: where.source.split('?')[0]!.slice(0, 300) } : {}),
      ...(where.line ? { line: where.line } : {}),
      ...(where.col ? { col: where.col } : {}),
      path: typeof location === 'undefined' ? '' : location.pathname.slice(0, 200),
      count: 1,
    });
    this.timer ??= setTimeout(() => void this.flush(), this.opts.flushMs ?? 5000);
  }

  /** Sends everything queued now. Never throws. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.size === 0) return;
    const batch = [...this.queue.values()];
    this.queue.clear();
    this.sent += batch.length;
    this.sending = true;
    try {
      await Promise.all([this.toApi(batch), ...batch.map((r) => this.toSentry(r))]);
    } catch {
      // Swallowed on purpose: reporting failures are never reported.
    } finally {
      this.sending = false;
    }
  }

  private async toApi(batch: CrashReport[]): Promise<void> {
    if (!this.opts.apiUrl) return;
    const ua = typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 300);
    await this.fetchFn(`${this.opts.apiUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // keepalive lets the pagehide flush outlive the page.
      keepalive: true,
      body: JSON.stringify({
        events: batch.map((r) => ({
          name: 'client.error',
          props: {
            ...r,
            ...(ua ? { ua } : {}),
            ...(this.opts.release ? { release: this.opts.release } : {}),
          },
        })),
      }),
    }).catch(() => undefined);
  }

  private async toSentry(r: CrashReport): Promise<void> {
    if (!this.sentry) return;
    await sendToSentry(
      this.sentry,
      {
        type: r.type,
        message: r.message,
        ...(r.stack ? { stack: r.stack } : {}),
        platform: 'javascript',
        timestamp: this.now() / 1000,
        ...(this.opts.release ? { release: this.opts.release } : {}),
        tags: { kind: r.kind },
        extra: { path: r.path, count: r.count, source: r.source, line: r.line, col: r.col },
      },
      this.fetchFn,
    );
  }
}
