/**
 * Token handling:
 * - verifies API access tokens (players) and party queue tickets (issued by
 *   the API's `POST /party/queue-ticket`), both HS256 with `JWT_SECRET`;
 * - signs join tickets (HS256 with `GAME_TICKET_SECRET`) that game servers
 *   verify before admitting a player.
 */
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const API_ISSUER = 'tumble-api';
/** Issuer claim of join tickets. */
export const TICKET_ISSUER = 'tumble-matchmaker';
/** Audience claim of join tickets. */
export const TICKET_AUDIENCE = 'tumble-game-server';
/** Join tickets are short-lived: the client connects right after `match_found`. */
export const JOIN_TICKET_TTL_SEC = 90;

const enc = (s: string) => new TextEncoder().encode(s);

/** A player authenticated by an API access token. */
export interface Player {
  userId: string;
  /** `name#tag`. */
  name: string;
  region: string;
}

/**
 * Verifies an API access token.
 *
 * @returns The player, or null when invalid/expired.
 */
export async function verifyAccess(secret: string, token: string, now: Date): Promise<Player | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), {
      issuer: API_ISSUER,
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') return null;
    return {
      userId: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : 'Tumbler',
      region: typeof payload.region === 'string' ? payload.region : 'na',
    };
  } catch {
    return null;
  }
}

const QueueTicketSchema = z.object({
  typ: z.literal('queue'),
  sub: z.string(),
  pid: z.string().min(1).max(80),
  leaderId: z.string(),
  playlistId: z.string().min(1).max(64),
  queue: z.enum(['casual', 'ranked']),
  teamSize: z.number().int().min(1).max(4),
  maxPlayers: z.number().int().min(2).max(60).optional(),
  minPlayers: z.number().int().min(1).max(60).optional(),
  botsAllowed: z.boolean().optional(),
  region: z.string().min(2).max(8),
  members: z
    .array(
      z.object({
        userId: z.string(),
        name: z.string(),
        mu: z.number(),
        sigma: z.number(),
        ordinal: z.number(),
      }),
    )
    .min(1)
    .max(4),
});

/** Verified party queue ticket. */
export type QueueTicket = z.infer<typeof QueueTicketSchema>;

/**
 * Verifies a queue ticket issued by the API.
 *
 * @returns The ticket, or null when invalid/expired/malformed.
 */
export async function verifyQueueTicket(
  secret: string,
  token: string,
  now: Date,
): Promise<QueueTicket | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), {
      issuer: API_ISSUER,
      algorithms: ['HS256'],
      currentDate: now,
    });
    const parsed = QueueTicketSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Custom lobby settings carried to the game server. */
export interface CustomSettings {
  playlistId: string;
  rounds: string[];
  maxPlayers: number;
  bots: boolean;
  roundTimeScale: number;
  lobbyCountdownSec: number;
  spectatorSlots: number;
}

/**
 * Join ticket claims. Game servers must verify signature, `iss`, `aud` and
 * `exp`, then admit `sub` into match `mid`.
 */
export interface JoinTicketClaims {
  /** User id. */
  sub: string;
  /** Display name `name#tag`. */
  name: string;
  /** Match id (also the API's results idempotency key). */
  mid: string;
  /** Game server id the match was placed on. */
  sid: string;
  /** Party id (`solo:<userId>` for solos). */
  pid: string;
  /** Team index in duos/squads, else null. */
  team: number | null;
  /** `player` or `spectator` (custom lobbies). */
  role: 'player' | 'spectator';
  playlistId: string;
  queue: 'casual' | 'ranked' | 'custom';
  region: string;
  /** Total lobby size, humans in the match and bots to add. */
  size: number;
  humans: number;
  bots: number;
  teamSize: number;
  /** Present for custom lobbies. */
  custom?: CustomSettings;
}

/**
 * Signs a join ticket.
 *
 * @param secret - `GAME_TICKET_SECRET`.
 * @param claims - Ticket contents.
 * @param now - Issue time.
 */
export async function signJoinTicket(secret: string, claims: JoinTicketClaims, now: Date): Promise<string> {
  const { sub, ...rest } = claims;
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ ...rest, typ: 'join' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(TICKET_ISSUER)
    .setAudience(TICKET_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + JOIN_TICKET_TTL_SEC)
    .sign(enc(secret));
}

/**
 * Verifies a join ticket (reference implementation for the game server).
 *
 * @returns Claims, or null when invalid/expired.
 */
export async function verifyJoinTicket(
  secret: string,
  token: string,
  now: Date,
): Promise<JoinTicketClaims | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), {
      issuer: TICKET_ISSUER,
      audience: TICKET_AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (payload.typ !== 'join' || typeof payload.sub !== 'string') return null;
    return payload as unknown as JoinTicketClaims;
  } catch {
    return null;
  }
}
