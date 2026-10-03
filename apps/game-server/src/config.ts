/**
 * Environment parsing for the parts of the game server that talk to other
 * services: capacity (what the matchmaker may place here), results reporting
 * and the matchmaker link. Kept apart from `main.ts` so the rules are testable without booting
 * Rapier or opening a port.
 */
import { hostname } from 'node:os';

/** Process environment shape. */
export type Env = Record<string, string | undefined>;

/** Reads a numeric variable, falling back when unset, empty or not a number. */
export function envNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) ? v : fallback;
}

/** How much this process hosts. */
export interface CapacityConfig {
  /** Show size including bots for unticketed rooms (`ROOM_CAPACITY`, 40). */
  roomCapacity: number;
  /** Concurrent rooms (`MAX_ROOMS`, 10). */
  maxRooms: number;
  /**
   * Concurrent seats, humans and bots, advertised to the matchmaker
   * (`SERVER_CAPACITY`, default `MAX_ROOMS × ROOM_CAPACITY`).
   */
  serverCapacity: number;
}

/**
 * Resolves capacity so the seat and room limits agree by default: the
 * matchmaker can never place more full-size rooms than the room manager accepts.
 *
 * @param env - Usually `process.env`.
 */
export function capacityConfig(env: Env): CapacityConfig {
  const roomCapacity = envNumber(env, 'ROOM_CAPACITY', 40);
  const maxRooms = Math.max(1, Math.floor(envNumber(env, 'MAX_ROOMS', 10)));
  return {
    roomCapacity,
    maxRooms,
    serverCapacity: envNumber(env, 'SERVER_CAPACITY', maxRooms * roomCapacity),
  };
}

/** The account API's development `INTERNAL_HMAC_SECRET` (apps/api `src/config.ts`). */
export const DEV_INTERNAL_SECRET = 'dev-only-internal-hmac-secret-change-me';

/** Where and how show results are reported. */
export interface ResultsConfig {
  apiUrl: string;
  /** `INTERNAL_HMAC_SECRET`, shared with the API. */
  secret: string;
  /** Durable outbox directory (`RESULTS_OUTBOX_DIR`, `./.data/results-outbox`). */
  outboxDir: string;
}

/**
 * Resolves results reporting. In development it defaults to the local API
 * and its development secret, so `pnpm dev` records shows end to end; in
 * production both must be set explicitly and the development secret is refused.
 *
 * @param env - Usually `process.env`.
 * @returns The settings, or null when reporting is off (`REPORT_RESULTS=0`, tests, or unset in production).
 * @throws In production with the development secret.
 */
export function resultsConfig(env: Env): ResultsConfig | null {
  const production = env.NODE_ENV === 'production';
  const devDefaults = !production && env.NODE_ENV !== 'test';
  if (env.REPORT_RESULTS === '0') return null;
  const apiUrl = env.API_URL || (devDefaults ? 'http://localhost:7360' : undefined);
  const secret = env.INTERNAL_HMAC_SECRET || (devDefaults ? DEV_INTERNAL_SECRET : undefined);
  if (production && secret === DEV_INTERNAL_SECRET) {
    throw new Error('INTERNAL_HMAC_SECRET must be set to a real secret in production');
  }
  if (!apiUrl || !secret) return null;
  return { apiUrl, secret, outboxDir: env.RESULTS_OUTBOX_DIR || './.data/results-outbox' };
}

/** Matchmaker registration settings. */
export interface LinkConfig {
  matchmakerUrl: string;
  /** `GAME_SERVER_SECRET`. */
  secret: string;
  /** Id the matchmaker knows this server by; join tickets carry it as `sid`. */
  serverId: string;
  publicUrl: string;
  region: string;
}

/**
 * Resolves matchmaker registration, or null when `MATCHMAKER_URL` or
 * `GAME_SERVER_SECRET` is unset (the matchmaker then uses its development
 * default server).
 *
 * @param env - Usually `process.env`.
 * @param port - Listen port, for the default server id and public URL.
 */
export function linkConfig(env: Env, port: number): LinkConfig | null {
  const matchmakerUrl = env.MATCHMAKER_URL;
  const secret = env.GAME_SERVER_SECRET;
  if (!matchmakerUrl || !secret) return null;
  return {
    matchmakerUrl,
    secret,
    serverId: env.SERVER_ID ?? `gs-${hostname()}-${port}`,
    publicUrl: env.PUBLIC_WS_URL ?? `ws://localhost:${port}/ws`,
    region: env.REGION ?? 'na',
  };
}
