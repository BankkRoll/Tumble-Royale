/**
 * Environment configuration for the matchmaker.
 *
 * Responsibilities:
 * - Parse and validate every environment variable once, at boot.
 * - Provide development defaults that line up with the API and game server so
 *   `pnpm dev` works with zero setup.
 * - Refuse to boot in production with development secrets, or on the
 *   in-process store unless that is explicitly allowed.
 */
import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
const DEV_TICKET_SECRET = 'dev-only-game-ticket-secret-change-me-0123';
const DEV_SERVER_SECRET = 'dev-only-game-server-secret';
/** The API's development `INTERNAL_HMAC_SECRET`. */
const DEV_INTERNAL_SECRET = 'dev-only-internal-hmac-secret-change-me';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7370),
  REDIS_URL: optional,
  ALLOW_MEMORY_STORE: optional,
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  GAME_TICKET_SECRET: z.string().min(16).default(DEV_TICKET_SECRET),
  GAME_SERVER_SECRET: z.string().min(16).default(DEV_SERVER_SECRET),
  API_URL: optional,
  INTERNAL_HMAC_SECRET: z.string().min(16).default(DEV_INTERNAL_SECRET),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  ALLOWED_ORIGINS: optional,
  DEFAULT_GAME_SERVER_URL: optional,
  TARGET_SIZE: z.coerce.number().int().min(2).max(60).default(40),
  MAX_WAIT_MS: z.coerce.number().int().min(1000).default(25_000),
  HOT_MAX_WAIT_MS: z.coerce.number().int().min(1000).default(12_000),
  HOT_THRESHOLD: z.coerce.number().int().min(1).default(80),
  REGION_FALLBACK_MS: z.coerce.number().int().min(0).default(10_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  USER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  TICK_MS: z.coerce.number().int().min(50).default(500),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Resolved matchmaker configuration. */
export interface MatchmakerConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  /** HTTP/WS port (default 7370). */
  port: number;
  redisUrl: string | undefined;
  /**
   * True when production runs on the in-process store because
   * `ALLOW_MEMORY_STORE=1` was set; queues and lobbies are then lost on restart.
   */
  memoryStoreInProduction: boolean;
  /** Verifies API access tokens and party queue tickets (shared with the API). */
  jwtSecret: string;
  /** Signs join tickets; shared with game servers, which verify them. */
  gameTicketSecret: string;
  /** Bearer secret game servers use to register and heartbeat. */
  gameServerSecret: string;
  /** Account API base URL for ban lookups; absent → bans are not checked here. */
  apiUrl: string | undefined;
  /** Signs internal calls to the API (`INTERNAL_HMAC_SECRET`, shared with the API). */
  internalHmacSecret: string;
  /** Origins allowed to call from a browser; `true` reflects any origin (development only). */
  allowedOrigins: string[] | true;
  /** Fallback game server when none has registered (local dev). */
  defaultGameServerUrl: string | undefined;
  /** Default lobby size when a ticket does not specify one. */
  targetSize: number;
  /** Release a partially filled lobby (with bots) after this wait. */
  maxWaitMs: number;
  /** Shorter wait used when the region is busy. */
  hotMaxWaitMs: number;
  /** Players searching in a region at which it counts as busy. */
  hotThreshold: number;
  /** How long a released lobby waits for a server in its own region before trying others. */
  regionFallbackMs: number;
  /** Requests per minute per IP address. */
  rateLimitMax: number;
  /** Queue and lobby requests per minute per signed-in player. */
  userRateLimitMax: number;
  /** Matchmaking tick interval; 0 in tests (ticks are driven manually). */
  tickMs: number;
  logLevel: string;
}

const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

/**
 * Parses environment variables.
 *
 * @param env - Usually `process.env`; tests pass a literal map.
 * @throws When malformed, in production with development secrets, or in
 *   production without `REDIS_URL` unless `ALLOW_MEMORY_STORE=1`.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): MatchmakerConfig {
  const e = EnvSchema.parse(env);
  const production = e.NODE_ENV === 'production';
  if (production) {
    for (const [name, value, dev] of [
      ['JWT_SECRET', e.JWT_SECRET, DEV_JWT_SECRET],
      ['GAME_TICKET_SECRET', e.GAME_TICKET_SECRET, DEV_TICKET_SECRET],
      ['GAME_SERVER_SECRET', e.GAME_SERVER_SECRET, DEV_SERVER_SECRET],
    ] as const) {
      if (value === dev) throw new Error(`${name} must be set in production`);
    }
    if (e.API_URL && e.INTERNAL_HMAC_SECRET === DEV_INTERNAL_SECRET) {
      throw new Error('INTERNAL_HMAC_SECRET must be set in production when API_URL is set');
    }
    if (!e.REDIS_URL && e.ALLOW_MEMORY_STORE !== '1') {
      throw new Error(
        'REDIS_URL must be set in production: queues, lobbies and the server registry would live in ' +
          'process memory, vanish on restart and not be shared between instances. ' +
          'Set ALLOW_MEMORY_STORE=1 to run a single instance on memory anyway.',
      );
    }
  }
  const apiUrl = e.API_URL ?? (e.NODE_ENV === 'development' ? 'http://localhost:7360' : undefined);
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    memoryStoreInProduction: production && !e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    gameTicketSecret: e.GAME_TICKET_SECRET,
    gameServerSecret: e.GAME_SERVER_SECRET,
    apiUrl: apiUrl?.replace(/\/$/, ''),
    internalHmacSecret: e.INTERNAL_HMAC_SECRET,
    allowedOrigins: e.ALLOWED_ORIGINS
      ? splitList(e.ALLOWED_ORIGINS)
      : production
        ? [e.PUBLIC_WEB_URL.replace(/\/$/, '')]
        : true,
    defaultGameServerUrl:
      e.DEFAULT_GAME_SERVER_URL ?? (e.NODE_ENV === 'development' ? 'ws://localhost:7350' : undefined),
    targetSize: e.TARGET_SIZE,
    maxWaitMs: e.MAX_WAIT_MS,
    hotMaxWaitMs: e.HOT_MAX_WAIT_MS,
    hotThreshold: e.HOT_THRESHOLD,
    regionFallbackMs: e.REGION_FALLBACK_MS,
    rateLimitMax: e.RATE_LIMIT_MAX,
    userRateLimitMax: e.USER_RATE_LIMIT_MAX,
    tickMs: e.NODE_ENV === 'test' ? 0 : e.TICK_MS,
    logLevel: e.LOG_LEVEL,
  };
}
