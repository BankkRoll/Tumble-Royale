/**
 * Process lifecycle for the Node services: signals, crash handling and an
 * ordered shutdown. Node only (touches `process`).
 *
 * Responsibilities:
 * - First SIGTERM/SIGINT: run the registered closers newest-first, bounded by
 *   a timeout, then exit 0 (1 if they failed or timed out).
 * - Second signal while shutting down: exit immediately (130), the escape
 *   hatch for an operator pressing Ctrl+C twice.
 * - A signal during startup, before anything registered a closer, exits at
 *   once: half-open resources (a Postgres migration transaction) roll back
 *   when their connections close with the process.
 * - `uncaughtException` / `unhandledRejection`: log at fatal, report to a
 *   Sentry-compatible DSN when configured, try a short shutdown, exit 1. A
 *   crash while handling a crash exits at once instead of looping.
 */
import { hostname } from 'node:os';
import { parseSentryDsn, sendToSentry } from './sentry.ts';

/** The pino-compatible subset of a logger the lifecycle writes to. */
export interface LifecycleLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
}

/** Options for {@link installLifecycle}. */
export interface LifecycleOptions {
  /** Service name for logs and crash reports (`api`, `matchmaker`, `game-server`). */
  service: string;
  log: LifecycleLogger;
  /** Upper bound on a signal-initiated shutdown (default 15 s). */
  shutdownTimeoutMs?: number;
  /** Upper bound on the shutdown after a crash (default 5 s). */
  crashShutdownTimeoutMs?: number;
  /** Sentry-compatible DSN for crash reports. */
  sentryDsn?: string | undefined;
  environment?: string;
  release?: string;
  /** Process seam (tests). */
  process?: Pick<NodeJS.Process, 'on' | 'exit'>;
  /** HTTP client for crash reports (tests). */
  fetch?: typeof fetch;
}

/** Handle returned by {@link installLifecycle}. */
export interface Lifecycle {
  /** True once shutdown started; readiness endpoints answer 503 from then on. */
  readonly shuttingDown: boolean;
  /** Registers a closer; closers run newest-first (reverse of startup order). */
  onShutdown(close: (reason: string) => Promise<void> | void): void;
  /** Swaps the logger once the service's own logger exists. */
  setLogger(log: LifecycleLogger): void;
  /** Starts the shutdown as a signal would (tests, admin endpoints). */
  shutdown(reason: string): Promise<void>;
  /** Reports an error to the crash DSN without exiting. */
  report(err: unknown, context?: Record<string, unknown>): Promise<void>;
}

/** Console logger used until the service's own logger is ready. */
export const consoleLogger: LifecycleLogger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', ...obj, msg })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', ...serializable(obj), msg })),
  fatal: (obj, msg) => console.error(JSON.stringify({ level: 'fatal', ...serializable(obj), msg })),
};

function serializable(obj: object): object {
  const o = obj as { err?: unknown };
  if (!(o.err instanceof Error)) return obj;
  return { ...obj, err: { type: o.err.name, message: o.err.message, stack: o.err.stack } };
}

const timeout = (ms: number): Promise<'timeout'> =>
  new Promise((r) => setTimeout(() => r('timeout'), ms).unref());

/**
 * Installs signal and crash handlers. Call once, first thing in `main`.
 *
 * @example
 * const life = installLifecycle({ service: 'api', log: consoleLogger, sentryDsn: process.env.SENTRY_DSN });
 * const app = await buildApp(config);
 * life.setLogger(app.log);
 * life.onShutdown(() => app.close());
 */
export function installLifecycle(opts: LifecycleOptions): Lifecycle {
  const proc = opts.process ?? process;
  const closers: ((reason: string) => Promise<void> | void)[] = [];
  const sentry = opts.sentryDsn ? parseSentryDsn(opts.sentryDsn) : null;
  let log = opts.log;
  let stopping: Promise<void> | null = null;
  let crashing = false;

  const runClosers = async (reason: string, limitMs: number): Promise<boolean> => {
    const work = (async () => {
      let ok = true;
      for (const close of [...closers].reverse()) {
        try {
          await close(reason);
        } catch (err) {
          ok = false;
          log.error({ err }, `[${opts.service}] shutdown step failed`);
        }
      }
      return ok;
    })();
    const r = await Promise.race([work, timeout(limitMs)]);
    if (r === 'timeout') {
      log.error({ timeoutMs: limitMs }, `[${opts.service}] shutdown timed out; exiting anyway`);
      return false;
    }
    return r;
  };

  const report = async (err: unknown, context: Record<string, unknown> = {}): Promise<void> => {
    if (!sentry) return;
    const e = err instanceof Error ? err : new Error(String(err));
    await Promise.race([
      sendToSentry(
        sentry,
        {
          type: e.name,
          message: e.message,
          ...(e.stack ? { stack: e.stack } : {}),
          platform: 'node',
          timestamp: new Date().getTime() / 1000,
          ...(opts.environment ? { environment: opts.environment } : {}),
          ...(opts.release ? { release: opts.release } : {}),
          tags: { service: opts.service, host: hostname() },
          extra: context,
        },
        opts.fetch,
      ),
      timeout(2000),
    ]);
  };

  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log.info({ reason }, `[${opts.service}] shutting down`);
      const ok = await runClosers(reason, opts.shutdownTimeoutMs ?? 15_000);
      log.info({ reason, clean: ok }, `[${opts.service}] stopped`);
      proc.exit(ok ? 0 : 1);
    })();
    return stopping;
  };

  const onSignal = (signal: string): void => {
    if (stopping) {
      log.error({ signal }, `[${opts.service}] second ${signal} during shutdown; exiting now`);
      proc.exit(130);
      return;
    }
    void shutdown(signal);
  };

  const onCrash = (kind: string, err: unknown): void => {
    if (crashing) {
      // A crash inside crash handling (a closer threw synchronously, the logger broke): stop now.
      proc.exit(1);
      return;
    }
    crashing = true;
    try {
      log.fatal({ err, kind }, `[${opts.service}] ${kind}; exiting`);
    } catch {
      // Logging is best effort here.
    }
    void (async () => {
      await report(err, { kind }).catch(() => undefined);
      if (!stopping) await runClosers(kind, opts.crashShutdownTimeoutMs ?? 5000);
      proc.exit(1);
    })();
  };

  proc.on('SIGTERM', () => onSignal('SIGTERM'));
  proc.on('SIGINT', () => onSignal('SIGINT'));
  proc.on('uncaughtException', (err: Error) => onCrash('uncaughtException', err));
  proc.on('unhandledRejection', (reason: unknown) => onCrash('unhandledRejection', reason));

  return {
    get shuttingDown() {
      return stopping !== null || crashing;
    },
    onShutdown: (close) => void closers.push(close),
    setLogger: (l) => void (log = l),
    shutdown,
    report,
  };
}
