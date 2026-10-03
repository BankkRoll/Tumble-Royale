/**
 * Launch configuration parsed once from the page URL.
 *
 * Every knob the game reads from `location.search` lives here so the rest of
 * the client never touches the query string directly.
 */
import type { BackendPreference } from '@tumble/render';
import type { QualityTier } from '@tumble/render/quality';

/** Parsed launch options. */
export interface GameConfig {
  /** GPU backend request (`?backend=auto|webgpu|webgl`). */
  backend: BackendPreference;
  /** `?debug=1`: lil-gui panel + stats overlay. */
  debug: boolean;
  /** `?autoplay=1`: a bot brain drives the local Tumbler and the UI auto-advances. */
  autoplay: boolean;
  /** `?shows=N` with autoplay: how many shows to start from the menu (0 = stop at the menu). */
  autoShows: number;
  /** `?ts=N`: global time scale (sim, director, flow timers). */
  timeScale: number;
  /** `?online=1`: play against the local game server instead of offline bots. */
  online: boolean;
  /** `?seed=N`: fixed offline show seed (random otherwise). */
  seed: number | null;
  /** `?tier=low|medium|high|ultra`: skip the benchmark and force a quality tier. */
  tier: QualityTier | null;
  /** `?api=0` disables the optional account API probe. */
  api: boolean;
  /** `?fresh=1`: ignore saved profile/settings (first-launch flow). */
  fresh: boolean;
  /** `?players=N`: offline show size (default: the playlist's). */
  players: number | null;
  /** `?playlist=<id>`: offline playlist override. */
  playlist: string | null;
  /** Account API base URL (`?apiUrl=`). */
  apiUrl: string;
  /** Matchmaker base URL (`?mmUrl=`). */
  mmUrl: string;
  /** `?mm=0` never matchmakes (Play always runs an offline show unless `?online=1`). */
  matchmaking: boolean;
}

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

function num(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the launch configuration.
 *
 * @param search - Query string (defaults to the current page's).
 * @returns The parsed config with defaults applied.
 * @example
 * const cfg = readConfig('?autoplay=1&ts=4');
 * cfg.timeScale; // 4
 */
export function readConfig(search: string = location.search): GameConfig {
  const p = new URLSearchParams(search);
  const backend = p.get('backend');
  const tier = p.get('tier');
  const ts = num(p.get('ts'));
  return {
    backend: backend === 'webgpu' || backend === 'webgl' ? backend : 'auto',
    debug: p.get('debug') === '1',
    autoplay: p.get('autoplay') === '1',
    autoShows: Math.max(0, num(p.get('shows')) ?? 1),
    timeScale: ts !== null && ts > 0 ? Math.min(ts, 16) : 1,
    online: p.get('online') === '1',
    seed: num(p.get('seed')),
    tier: tier && (TIERS as readonly string[]).includes(tier) ? (tier as QualityTier) : null,
    api: p.get('api') !== '0',
    fresh: p.get('fresh') === '1',
    players: num(p.get('players')),
    playlist: p.get('playlist'),
    apiUrl: p.get('apiUrl') ?? 'http://localhost:7360',
    mmUrl: p.get('mmUrl') ?? 'http://localhost:7370',
    matchmaking: p.get('mm') !== '0',
  };
}
