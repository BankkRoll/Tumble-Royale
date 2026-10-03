/**
 * Matchmaker → game server control calls. A private show's host can still
 * remove players after the lobby moved onto a game server (the live pre-show
 * platform), so the matchmaker forwards the kick to the server hosting the
 * match.
 *
 * Requests are HMAC-SHA256 signed with `GAME_SERVER_SECRET` over
 * `<timestamp>.<body>` (headers `x-tumble-ts` / `x-tumble-sig`); the game
 * server rejects stale timestamps, so a captured request cannot be replayed
 * later.
 */
import { createHmac } from 'node:crypto';
import type { GameServer } from './servers.ts';

/** Header carrying the signing time (ms since epoch). */
export const CONTROL_TS_HEADER = 'x-tumble-ts';
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
 * @param body - Exact request body.
 */
export function signControl(secret: string, ts: number, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

/**
 * HTTP base of a game server: its registered `controlUrl`, else derived from
 * the public WebSocket URL (`wss://gs.example/ws` → `https://gs.example`).
 */
export function controlBase(target: MatchTarget): string | null {
  if (target.server?.controlUrl) return target.server.controlUrl.replace(/\/$/, '');
  try {
    const u = new URL(target.serverUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    u.pathname = u.pathname.replace(/\/(gs\/)?ws\/?$/, '') || '/';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Real control channel over HTTP.
 *
 * @param secret - `GAME_SERVER_SECRET`.
 * @param now - Clock (ms).
 */
export function httpGameControl(secret: string, now: () => number = Date.now): GameControl {
  return {
    async kick(target, userId) {
      const base = controlBase(target);
      if (!base) return false;
      const body = JSON.stringify({ matchId: target.matchId, userId });
      const ts = now();
      try {
        const res = await fetch(`${base}/internal/kick`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [CONTROL_TS_HEADER]: String(ts),
            [CONTROL_SIG_HEADER]: signControl(secret, ts, body),
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
