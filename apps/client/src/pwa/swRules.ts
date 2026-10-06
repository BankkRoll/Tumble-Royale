/**
 * Service worker routing and caching rules, as pure functions so they are
 * unit-tested without a browser (the worker in `sw.ts` only wires them to
 * events).
 *
 * The worker is an allowlist: it answers only for files it precached, the
 * game's own page routes, and `config.json`. Everything else (the account API,
 * matchmaker, game server, OAuth and checkout returns, other origins) passes
 * straight to the network untouched, so a self-hosted layout that moves the
 * API to another path can never be served a stale or cached response.
 */

/** Prefix shared by every cache this worker owns (others on the origin are left alone). */
export const CACHE_PREFIX = 'tumble-';

/** How the worker answers a request. */
export type Route =
  /** Not ours: let the browser fetch it as if there were no worker. */
  | { kind: 'passthrough' }
  /** A page route of the game: network first (fresh deploys), cached app shell offline. */
  | { kind: 'shell' }
  /** Runtime config: network first, last good copy only when offline. */
  | { kind: 'config' }
  /** A precached build file: cache first (hashed names never change content). */
  | { kind: 'precache'; key: string };

/** What {@link routeRequest} needs to know about a request. */
export interface RequestInfo {
  url: string;
  method: string;
  /** `Request.mode` (`navigate` for page loads). */
  mode: string;
  /** True when the request carries an `Authorization` header. */
  authorized?: boolean;
}

/** Facts about the deployment the worker runs in. */
export interface RouteContext {
  /** The worker's origin. */
  origin: string;
  /** Registration scope path, with leading and trailing slash (Vite `base`). */
  base: string;
  /** Precached paths relative to `base` (e.g. `index.html`, `assets/index-abc.js`). */
  precached: ReadonlySet<string>;
}

/**
 * Client-routed page paths (relative to `base`) that the host rewrites to
 * `index.html`: party invites, OAuth and email sign-in returns, Stripe returns.
 * Keep in sync with `public/_redirects` and `vercel.json`.
 */
export function isShellPath(rel: string): boolean {
  return (
    rel === '' ||
    rel === 'index.html' ||
    rel === 'store' ||
    /^join\/[^/]+\/?$/.test(rel) ||
    /^auth(\/.*)?$/.test(rel)
  );
}

/**
 * Decides how the worker answers a request.
 *
 * @param req - The request.
 * @param ctx - Deployment facts.
 * @returns The route; `passthrough` for anything the worker must not touch.
 * @example
 * routeRequest({ url: 'https://play.example/api/me', method: 'GET', mode: 'cors' }, ctx).kind;
 * // 'passthrough'
 */
export function routeRequest(req: RequestInfo, ctx: RouteContext): Route {
  // SECURITY: only plain GETs are ever answered from a cache; credentials-bearing calls never are.
  if (req.method !== 'GET' || req.authorized) return { kind: 'passthrough' };
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { kind: 'passthrough' };
  }
  if (url.origin !== ctx.origin || !url.pathname.startsWith(ctx.base)) return { kind: 'passthrough' };
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice(ctx.base.length));
  } catch {
    return { kind: 'passthrough' };
  }
  if (req.mode === 'navigate') return isShellPath(rel) ? { kind: 'shell' } : { kind: 'passthrough' };
  if (rel === 'config.json') return { kind: 'config' };
  // A query string means a dynamic request (cache busters, signed URLs); never serve it from the precache.
  // shouldPrecache again: a precache written by an older worker version may
  // still hold files (such as the status page) that are now network-only.
  if (url.search === '' && ctx.precached.has(rel) && shouldPrecache(rel))
    return { kind: 'precache', key: rel };
  return { kind: 'passthrough' };
}

/**
 * Whether a build output file belongs in the precache: everything the game
 * page can load, minus source maps, host config, the worker itself and the
 * sandbox's dev pages (only `index.html` is the game).
 *
 * @param rel - Path relative to the output directory, `/`-separated.
 */
export function shouldPrecache(rel: string): boolean {
  if (rel.endsWith('.map')) return false;
  if (rel === 'sw.js' || rel === 'config.json' || rel === '_redirects' || rel === '_headers') return false;
  if (rel.endsWith('.html')) return rel === 'index.html';
  // The admin console's entry chunk and stylesheet (Vite names them after the
  // `admin` input): players must never download the console, not even into a cache.
  if (/^assets\/admin-[\w-]+\.(js|css)$/.test(rel)) return false;
  // The status page must always come from the network: a cached copy would
  // be useless exactly when the service is down.
  if (/^assets\/status-[\w-]+\.(js|css)$/.test(rel)) return false;
  return !rel.startsWith('.') && !rel.includes('/.');
}

/**
 * Name of the precache for a build version.
 *
 * @param version - Content hash of the build's file list.
 */
export function precacheName(version: string): string {
  return `${CACHE_PREFIX}precache-${version}`;
}

/** Cache holding the last good `config.json` (survives updates: it is not tied to a build). */
export const CONFIG_CACHE = `${CACHE_PREFIX}config`;

/**
 * Caches to delete when a version activates: this worker's older precaches.
 * Caches from other apps on the origin and the config cache are kept.
 *
 * @param keys - `caches.keys()`.
 * @param version - The activating version.
 * @returns Cache names to delete.
 */
export function staleCaches(keys: readonly string[], version: string): string[] {
  const keep = new Set([precacheName(version), CONFIG_CACHE]);
  return keys.filter((k) => k.startsWith(CACHE_PREFIX) && !keep.has(k));
}

/**
 * Whether a network response may be stored as the offline copy of `config.json`:
 * only a real JSON 200 (SPA hosts answer a missing file with `index.html`).
 *
 * @param status - HTTP status.
 * @param contentType - `Content-Type` header.
 */
export function cacheableConfig(status: number, contentType: string | null): boolean {
  return status === 200 && (contentType ?? '').includes('json');
}

/** How long a page load waits for the network before falling back to the cached shell (lie-fi). */
export const SHELL_TIMEOUT_MS = 4000;

/**
 * Whether a page load should show the network's answer rather than the
 * cached shell. Redirects and normal pages pass through; a down server (5xx)
 * or a host without the SPA rewrites (404) gets the offline-capable shell
 * when one is cached.
 *
 * @param status - HTTP status (0 for an opaque redirect).
 * @param type - `Response.type`.
 */
export function preferNetworkPage(status: number, type: string): boolean {
  if (type === 'opaqueredirect') return true;
  return status > 0 && status < 500 && status !== 404;
}
