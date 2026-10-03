/**
 * Minimal Sentry-compatible error sender (envelope API, no SDK), shared by
 * the browser client and the Node services. Works with Sentry, GlitchTip and
 * other servers that accept Sentry envelopes.
 *
 * Kept dependency-free on purpose: the official SDKs patch globals and add
 * hundreds of KiB, while all we need is "send this exception once".
 */

/** A parsed DSN: where envelopes go. */
export interface SentryTarget {
  /** `…/api/<project>/envelope/?sentry_key=…&sentry_version=7`. */
  url: string;
  dsn: string;
}

/** One error to report. */
export interface SentryErrorEvent {
  /** Exception class name, e.g. `TypeError`. */
  type: string;
  message: string;
  stack?: string;
  /** `javascript` (browser) or `node`. */
  platform: 'javascript' | 'node';
  /** Unix seconds. */
  timestamp: number;
  environment?: string;
  release?: string;
  /** Short identifiers, e.g. `{ service: 'api' }`. */
  tags?: Record<string, string>;
  /** Free-form context (request id, URL, user agent…). */
  extra?: Record<string, unknown>;
}

/**
 * Parses `https://<key>@<host>[/<path>]/<project>`.
 *
 * @param dsn - The DSN string.
 * @returns The envelope target, or null when the DSN is malformed.
 * @example
 * parseSentryDsn('https://abc@o1.ingest.sentry.io/42')?.url;
 * // 'https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=abc&sentry_version=7'
 */
export function parseSentryDsn(dsn: string): SentryTarget | null {
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.username) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (!project || !/^\d+$/.test(project)) return null;
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  const key = encodeURIComponent(decodeURIComponent(u.username));
  return {
    url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/?sentry_key=${key}&sentry_version=7`,
    dsn,
  };
}

const hex32 = (): string => globalThis.crypto.randomUUID().replace(/-/g, '');

/**
 * Builds the envelope body for one error event.
 *
 * @param target - From {@link parseSentryDsn}.
 * @param e - The error.
 * @returns Newline-delimited envelope text.
 */
export function sentryEnvelope(target: SentryTarget, e: SentryErrorEvent): string {
  const eventId = hex32();
  const event = {
    event_id: eventId,
    timestamp: e.timestamp,
    platform: e.platform,
    level: 'error',
    ...(e.environment ? { environment: e.environment } : {}),
    ...(e.release ? { release: e.release } : {}),
    ...(e.tags ? { tags: e.tags } : {}),
    extra: { ...e.extra, ...(e.stack ? { stack: e.stack.slice(0, 8000) } : {}) },
    exception: { values: [{ type: e.type.slice(0, 128), value: e.message.slice(0, 2000) }] },
  };
  return [
    JSON.stringify({
      event_id: eventId,
      sent_at: new Date(e.timestamp * 1000).toISOString(),
      dsn: target.dsn,
    }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
}

/**
 * Sends one error. Never throws: crash reporting must not cause crashes.
 *
 * @param target - From {@link parseSentryDsn}.
 * @param e - The error.
 * @param fetchFn - HTTP client (tests).
 * @returns True when the server accepted it.
 */
export async function sendToSentry(
  target: SentryTarget,
  e: SentryErrorEvent,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(target.url, {
      method: 'POST',
      // text/plain keeps browser requests "simple" (no CORS preflight); Sentry accepts it.
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: sentryEnvelope(target, e),
      keepalive: true,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
