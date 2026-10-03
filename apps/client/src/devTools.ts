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

/**
 * Service endpoints, set per deployment with `VITE_API_URL`,
 * `VITE_MATCHMAKER_URL` and `VITE_GAME_SERVER_URL` at build time. The
 * defaults match the local dev stack.
 */
export const ENDPOINTS = {
  api: import.meta.env.VITE_API_URL ?? 'http://localhost:7360',
  matchmaker: import.meta.env.VITE_MATCHMAKER_URL ?? 'http://localhost:7370',
  /** Game server WebSocket URL; unset means `/gs/ws` on this origin (Vite proxy or a reverse proxy). */
  gameServer: import.meta.env.VITE_GAME_SERVER_URL ?? null,
} as const;
