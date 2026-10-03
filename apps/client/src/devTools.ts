/**
 * Build-level switches for developer tooling and deployment endpoints.
 *
 * Dev URL options (`?debug`, `?autoplay`, `?ts`, endpoint overrides, …) and the
 * sandbox pages only exist in `vite dev` and `vite build --mode sandbox`.
 * Production builds ignore them: several would let a crafted link change how
 * the game behaves, and the endpoint overrides could send a player's login
 * tokens to another server.
 */

/** True when developer URL options are honoured. */
export const DEV_TOOLS: boolean = import.meta.env.DEV || import.meta.env.MODE === 'sandbox';

/**
 * Reads a developer-only URL parameter.
 *
 * @returns The value, or `null` in production builds.
 */
export function devParam(params: URLSearchParams, key: string): string | null {
  return DEV_TOOLS ? params.get(key) : null;
}

/** Where the client finds its services. */
export interface Endpoints {
  /** Account API base URL (absolute, no trailing slash). */
  api: string;
  /** Matchmaker base URL (absolute, no trailing slash). */
  matchmaker: string;
  /** Game server WebSocket URL; null means `/gs/ws` on this origin. */
  gameServer: string | null;
}

const sameOrigin = (path: string): string =>
  typeof location === 'undefined' ? path : `${location.origin}${path}`;

/**
 * Service endpoints. Resolution order:
 *
 * 1. `/config.json` served next to the page, applied at boot by
 *    `loadRuntimeConfig` (one build runs on any domain).
 * 2. `VITE_API_URL`, `VITE_MATCHMAKER_URL`, `VITE_GAME_SERVER_URL` baked in
 *    at build time.
 * 3. Production builds: same-origin `/api`, `/mm` and `/gs/ws` (the reverse
 *    proxy layout in `deploy/`). Dev and sandbox builds: the local dev stack.
 */
export const ENDPOINTS: Endpoints = {
  api: import.meta.env.VITE_API_URL || (DEV_TOOLS ? 'http://localhost:7360' : sameOrigin('/api')),
  matchmaker:
    import.meta.env.VITE_MATCHMAKER_URL || (DEV_TOOLS ? 'http://localhost:7370' : sameOrigin('/mm')),
  gameServer: import.meta.env.VITE_GAME_SERVER_URL || null,
};
