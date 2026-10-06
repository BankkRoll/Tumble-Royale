/**
 * Join tickets for swarm runs that need them: a spectator only watches a
 * running show when it holds a ticket for that show's match (an unticketed
 * late joiner opens a new dev room instead). Signs HS256 tickets the way the
 * matchmaker does, with `GAME_TICKET_SECRET` from the game server's
 * environment, for a game server running without a matchmaker link (it then
 * skips the server-id check).
 */
import { createHmac } from 'node:crypto';

/** What a swarm ticket says about its holder and the show. */
export interface SwarmTicket {
  /** Account id (also the name shown in the show). */
  sub: string;
  /** Shared match id: every client of one run joins the same room. */
  mid: string;
  role: 'player' | 'spectator';
  /** Players the show waits for. */
  humans: number;
  /** Show size; bots fill the seats players leave. */
  size: number;
}

const b64url = (s: string | Buffer): string =>
  Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Signs a join ticket valid for `ttlSec`.
 *
 * @param secret - The game server's `GAME_TICKET_SECRET`.
 * @param t - Ticket contents.
 * @param ttlSec - Lifetime (the matchmaker uses 90 s; a swarm needs its whole ramp).
 * @returns The compact JWS for `Hello.ticket`.
 * @example
 * signSwarmTicket(secret, { sub: 'swarm-0', mid: 'm_swarm1', role: 'player', humans: 40, size: 100 });
 */
export function signSwarmTicket(secret: string, t: SwarmTicket, ttlSec = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'tumble-matchmaker',
      aud: 'tumble-game-server',
      typ: 'join',
      iat: now,
      exp: now + ttlSec,
      sub: t.sub,
      name: `${t.sub}#0001`,
      mid: t.mid,
      sid: 'default',
      pid: `solo:${t.sub}`,
      team: null,
      role: t.role,
      playlistId: 'main-show',
      queue: 'casual',
      region: 'local',
      size: t.size,
      humans: t.humans,
      bots: Math.max(0, t.size - t.humans),
      teamSize: 1,
    }),
  );
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
