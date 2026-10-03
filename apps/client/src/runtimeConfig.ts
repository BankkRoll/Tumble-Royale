/**
 * Deployment configuration read at boot from `/config.json`, so one client
 * build serves any domain without a rebuild.
 *
 * Responsibilities:
 * - Fetch `config.json` next to the page (under Vite's `base`), briefly and
 *   uncached; a missing file is normal and keeps the built-in defaults.
 * - Validate every field on its own: a bad value is skipped with a console
 *   warning instead of breaking boot, because a typo in a hand-edited file
 *   must never leave players at a blank page.
 * - Apply the endpoints to {@link ENDPOINTS} before anything reads them.
 *
 * File format (every key optional; relative paths resolve against the page's
 * origin):
 *
 * ```json
 * {
 *   "apiUrl": "/api",
 *   "matchmakerUrl": "/mm",
 *   "gameServerUrl": "/gs/ws",
 *   "reportErrors": true,
 *   "sentryDsn": "https://key@sentry.example.com/1"
 * }
 * ```
 */
import { ENDPOINTS, type Endpoints } from './devTools.ts';

/** Parsed `config.json`. */
export interface RuntimeConfig {
  apiUrl?: string;
  matchmakerUrl?: string;
  gameServerUrl?: string;
  /** Send uncaught errors to the API's `/events` (default true). */
  reportErrors?: boolean;
  /** Sentry-compatible DSN; errors also go there when set. */
  sentryDsn?: string;
}

/** Result of {@link parseRuntimeConfig}. */
export interface ParsedRuntimeConfig {
  config: RuntimeConfig;
  /** One line per ignored field. */
  warnings: string[];
}

const MAX_URL = 2048;

function resolveUrl(value: unknown, origin: string, protocols: readonly string[]): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value.trim(), origin);
  } catch {
    return null;
  }
  // A relative WebSocket path resolves to http(s) against the page; map it to ws(s).
  if (protocols.includes('ws:') && (url.protocol === 'http:' || url.protocol === 'https:'))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!protocols.includes(url.protocol)) return null;
  return url.href.replace(/\/$/, '');
}

/**
 * Validates a decoded `config.json`.
 *
 * @param raw - The decoded JSON.
 * @param origin - Page origin that relative URLs resolve against.
 * @returns The valid fields and a warning for each rejected one.
 * @example
 * parseRuntimeConfig({ apiUrl: '/api' }, 'https://play.example.com').config.apiUrl;
 * // 'https://play.example.com/api'
 */
export function parseRuntimeConfig(raw: unknown, origin: string): ParsedRuntimeConfig {
  const warnings: string[] = [];
  const config: RuntimeConfig = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config, warnings: ['config.json must contain a JSON object; using defaults'] };
  }
  const r = raw as Record<string, unknown>;
  const url = (key: 'apiUrl' | 'matchmakerUrl' | 'gameServerUrl', protocols: readonly string[]): void => {
    if (r[key] === undefined || r[key] === null) return;
    const v = resolveUrl(r[key], origin, protocols);
    if (v) config[key] = v;
    else warnings.push(`config.json: ignoring ${key} (expected a ${protocols.join('/')} URL or a path)`);
  };
  url('apiUrl', ['http:', 'https:']);
  url('matchmakerUrl', ['http:', 'https:']);
  url('gameServerUrl', ['ws:', 'wss:']);
  if (r.reportErrors !== undefined) {
    if (typeof r.reportErrors === 'boolean') config.reportErrors = r.reportErrors;
    else warnings.push('config.json: ignoring reportErrors (expected true or false)');
  }
  if (r.sentryDsn !== undefined && r.sentryDsn !== null && r.sentryDsn !== '') {
    const dsn = resolveUrl(r.sentryDsn, origin, ['https:', 'http:']);
    if (dsn && new URL(dsn).username) config.sentryDsn = dsn;
    else warnings.push('config.json: ignoring sentryDsn (expected https://<key>@<host>/<project>)');
  }
  return { config, warnings };
}

/** Options for {@link loadRuntimeConfig}. */
export interface LoadRuntimeConfigOptions {
  fetch?: typeof fetch;
  /** Defaults to `<base>config.json` on this origin. */
  url?: string;
  origin?: string;
  /** Give up after this long and boot with the defaults (default 3 s). */
  timeoutMs?: number;
  /** Endpoints object to update (tests). */
  endpoints?: Endpoints;
}

/**
 * Fetches `config.json` and applies its endpoints. Never throws: any failure
 * (absent file, timeout, HTML fallback page, invalid JSON) boots with the
 * defaults.
 *
 * @returns The applied configuration (empty when there was none).
 */
export async function loadRuntimeConfig(opts: LoadRuntimeConfigOptions = {}): Promise<RuntimeConfig> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const origin = opts.origin ?? location.origin;
  const target = opts.endpoints ?? ENDPOINTS;
  let raw: unknown;
  try {
    const res = await fetchFn(opts.url ?? `${import.meta.env.BASE_URL}config.json`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) return {};
    // NOTE: SPA hosts (and `vite dev`) answer unknown paths with index.html and a 200.
    if (!(res.headers.get('content-type') ?? '').includes('json')) return {};
    raw = await res.json();
  } catch (err) {
    console.warn('[config] config.json unavailable; using built-in endpoints', err);
    return {};
  }
  const { config, warnings } = parseRuntimeConfig(raw, origin);
  for (const w of warnings) console.warn(`[config] ${w}`);
  if (config.apiUrl) target.api = config.apiUrl;
  if (config.matchmakerUrl) target.matchmaker = config.matchmakerUrl;
  if (config.gameServerUrl) target.gameServer = config.gameServerUrl;
  return config;
}
