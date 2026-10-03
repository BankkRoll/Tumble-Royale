/**
 * Matchmaker join tickets: HS256 JWTs signed with `GAME_TICKET_SECRET`
 * (`iss` tumble-matchmaker, `aud` tumble-game-server, `typ` join, 90 s expiry).
 *
 * Mirrors the matchmaker's reference `verifyJoinTicket` (apps/matchmaker
 * `src/tickets.ts`) with `node:crypto` so the game server needs no JOSE
 * dependency. Only HS256 is accepted; the `alg` header is checked so a
 * `none`/RS256 token can never pass.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Issuer claim of join tickets. */
export const TICKET_ISSUER = 'tumble-matchmaker';
/** Audience claim of join tickets. */
export const TICKET_AUDIENCE = 'tumble-game-server';
/** Secret the matchmaker uses outside production when `GAME_TICKET_SECRET` is unset. */
export const DEV_TICKET_SECRET = 'dev-only-game-ticket-secret-change-me-0123';

/** Custom lobby settings carried by custom-match tickets. */
export interface TicketCustomSettings {
  playlistId: string;
  rounds: string[];
  maxPlayers: number;
  bots: boolean;
  roundTimeScale: number;
  lobbyCountdownSec: number;
  spectatorSlots: number;
}

/** Verified join ticket claims (matchmaker `JoinTicketClaims`). */
export interface JoinTicketClaims {
  /** Account id. */
  sub: string;
  /** Display name `name#tag`. */
  name: string;
  /** Match id; also the API's results idempotency key. */
  mid: string;
  /** Game server id the match was placed on. */
  sid: string;
  /** Party id (`solo:<userId>` for solos). */
  pid: string;
  team: number | null;
  role: 'player' | 'spectator';
  playlistId: string;
  queue: 'casual' | 'ranked' | 'custom';
  region: string;
  /** Lobby size, humans in the match and bots to add. */
  size: number;
  humans: number;
  bots: number;
  teamSize: number;
  custom?: TicketCustomSettings;
  /** Chat-suspended account: its chat is never relayed. */
  mute?: boolean;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function json(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fromB64url(part).toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Verifies a join ticket.
 *
 * @param secret - `GAME_TICKET_SECRET`.
 * @param token - Compact JWS from the client's Hello.
 * @param nowMs - Wall clock (ms) for `exp`/`nbf`.
 * @returns Claims, or null when the signature, issuer, audience, type, expiry or shape is wrong.
 * @example
 * const claims = verifyJoinTicket(process.env.GAME_TICKET_SECRET!, hello.ticket, Date.now());
 */
export function verifyJoinTicket(secret: string, token: string, nowMs: number): JoinTicketClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = json(h);
  if (!header || header.alg !== 'HS256') return null;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = fromB64url(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const c = json(p);
  if (!c) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (c.iss !== TICKET_ISSUER || c.typ !== 'join') return null;
  const aud = c.aud;
  if (!(aud === TICKET_AUDIENCE || (Array.isArray(aud) && aud.includes(TICKET_AUDIENCE)))) return null;
  if (!isInt(c.exp) || c.exp <= nowSec) return null;
  if (c.nbf !== undefined && (!isInt(c.nbf) || c.nbf > nowSec + 5)) return null;
  if (typeof c.sub !== 'string' || typeof c.mid !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(c.mid))
    return null;
  if (!isInt(c.size) || !isInt(c.humans) || c.size < 1 || c.size > 60 || c.humans < 0) return null;
  const role = c.role === 'spectator' ? 'spectator' : 'player';
  const queue = c.queue === 'ranked' || c.queue === 'custom' ? c.queue : 'casual';
  return {
    sub: c.sub,
    name: typeof c.name === 'string' ? c.name : 'Tumbler',
    mid: c.mid,
    sid: typeof c.sid === 'string' ? c.sid : '',
    pid: typeof c.pid === 'string' ? c.pid : `solo:${c.sub}`,
    team: isInt(c.team) ? c.team : null,
    role,
    playlistId: typeof c.playlistId === 'string' ? c.playlistId : 'main-show',
    queue,
    region: typeof c.region === 'string' ? c.region : 'na',
    size: c.size,
    humans: c.humans,
    bots: isInt(c.bots) ? c.bots : Math.max(0, c.size - c.humans),
    teamSize: isInt(c.teamSize) ? c.teamSize : 1,
    ...(c.custom && typeof c.custom === 'object' ? { custom: c.custom as TicketCustomSettings } : {}),
    ...(c.mute === true ? { mute: true } : {}),
  };
}

/**
 * Signs a join ticket exactly like the matchmaker (tests and local tools).
 *
 * @param secret - `GAME_TICKET_SECRET`.
 * @param claims - Ticket contents.
 * @param nowMs - Issue time (ms).
 * @param ttlSec - Lifetime; the matchmaker uses 90 s.
 */
export function signJoinTicket(secret: string, claims: JoinTicketClaims, nowMs: number, ttlSec = 90): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256' })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        ...claims,
        typ: 'join',
        iss: TICKET_ISSUER,
        aud: TICKET_AUDIENCE,
        iat,
        exp: iat + ttlSec,
      }),
    ),
  );
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
