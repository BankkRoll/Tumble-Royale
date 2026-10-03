/**
 * Matchmaker → game server control calls. A private show's host can still
 * remove players after the lobby moved onto a game server (the live pre-show
 * platform), so the matchmaker forwards the kick to the server hosting the
 * match.
 *
 * SECURITY: requests are HMAC-SHA256 signed with `GAME_SERVER_SECRET` over
 * `<timestamp>.<nonce>.<body>` (headers `x-tumble-ts` / `x-tumble-nonce` /
 * `x-tumble-sig`). The game server rejects stale timestamps and any nonce it
 * has already seen inside the freshness window, so a captured request can be
 * replayed neither later nor immediately.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { GameServer } from './servers.ts';

/** Header carrying the signing time (ms since epoch). */
export const CONTROL_TS_HEADER = 'x-tumble-ts';
/** Header carrying the single-use request id. */
export const CONTROL_NONCE_HEADER = 'x-tumble-nonce';
/** Header carrying the hex HMAC. */
export const CONTROL_SIG_HEADER = 'x-tumble-sig';

/** What the matchmaker needs to reach a running match. */
export interface MatchTarget {
  matchId: string;
  serverUrl: string;
  /** The server's registration, when it registered (carries `controlUrl`). */
  server: GameServer | null;
}

/** Control channel to game servers (injectable for tests). */
export interface GameControl {
  /**
   * Removes a user from a running match and bars them from rejoining it.
   *
   * @returns True when the server confirmed.
   */
  kick(target: MatchTarget, userId: string): Promise<boolean>;
}

/**
 * Signs a control body.
 *
 * @param secret - `GAME_SERVER_SECRET`.
 * @param ts - Signing time (ms).
 * @param nonce - Single-use request id.
 * @param body - Exact request body.
 */
export function signControl(secret: string, ts: number, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');
}

/**
 * HTTP base of a game server: its registered `controlUrl` (the game server's
 * `CONTROL_URL`), else derived from the public WebSocket URL by dropping only
 * the trailing `/ws` segment, so a path prefix the reverse proxy routes on
 * survives: `wss://gs.example/ws` → `https://gs.example`,
 * `wss://play.example/gs/ws` → `https://play.example/gs`.
 *
 * @returns The base without a trailing slash, or null for an unusable URL.
 * @example
 * controlBase({ matchId: 'm', serverUrl: 'wss://play.example/gs/ws', server: null }); // 'https://play.example/gs'
 */
export function controlBase(target: MatchTarget): string | null {
  try {
    const explicit = target.server?.controlUrl;
    const u = new URL(explicit ?? target.serverUrl);
    if (explicit) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    } else {
      if (u.protocol === 'wss:') u.protocol = 'https:';
      else if (u.protocol === 'ws:') u.protocol = 'http:';
      else if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.pathname = u.pathname.replace(/\/ws\/*$/, '');
    }
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Real control channel over HTTP.
 *
 * @param secret - `GAME_SERVER_SECRET`.
 * @param now - Clock (ms).
 * @param fetchFn - HTTP client (tests).
 */
export function httpGameControl(
  secret: string,
  now: () => number = Date.now,
  fetchFn: typeof fetch = fetch,
): GameControl {
  return {
    async kick(target, userId) {
      const base = controlBase(target);
      if (!base) return false;
      const body = JSON.stringify({ matchId: target.matchId, userId });
      const ts = now();
      const nonce = randomUUID();
      try {
        const res = await fetchFn(`${base}/internal/kick`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [CONTROL_TS_HEADER]: String(ts),
            [CONTROL_NONCE_HEADER]: nonce,
            [CONTROL_SIG_HEADER]: signControl(secret, ts, nonce, body),
          },
          body,
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
