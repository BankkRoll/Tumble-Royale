/**
 * Environment configuration for the matchmaker.
 */
import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
const DEV_TICKET_SECRET = 'dev-only-game-ticket-secret-change-me-0123';
const DEV_SERVER_SECRET = 'dev-only-game-server-secret';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7370),
  REDIS_URL: optional,
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  GAME_TICKET_SECRET: z.string().min(16).default(DEV_TICKET_SECRET),
  GAME_SERVER_SECRET: z.string().min(16).default(DEV_SERVER_SECRET),
  DEFAULT_GAME_SERVER_URL: optional,
  TARGET_SIZE: z.coerce.number().int().min(2).max(60).default(40),
  MAX_WAIT_MS: z.coerce.number().int().min(1000).default(25_000),
  HOT_MAX_WAIT_MS: z.coerce.number().int().min(1000).default(12_000),
  HOT_THRESHOLD: z.coerce.number().int().min(1).default(80),
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
  /** Verifies API access tokens and party queue tickets (shared with the API). */
  jwtSecret: string;
  /** Signs join tickets; shared with game servers, which verify them. */
  gameTicketSecret: string;
  /** Bearer secret game servers use to register and heartbeat. */
  gameServerSecret: string;
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
  /** Matchmaking tick interval; 0 in tests (ticks are driven manually). */
  tickMs: number;
  logLevel: string;
}

/**
 * Parses environment variables.
 *
 * @throws When malformed, or in production with development secrets.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): MatchmakerConfig {
  const e = EnvSchema.parse(env);
  if (e.NODE_ENV === 'production') {
    for (const [name, value, dev] of [
      ['JWT_SECRET', e.JWT_SECRET, DEV_JWT_SECRET],
      ['GAME_TICKET_SECRET', e.GAME_TICKET_SECRET, DEV_TICKET_SECRET],
      ['GAME_SERVER_SECRET', e.GAME_SERVER_SECRET, DEV_SERVER_SECRET],
    ] as const) {
      if (value === dev) throw new Error(`${name} must be set in production`);
    }
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    gameTicketSecret: e.GAME_TICKET_SECRET,
    gameServerSecret: e.GAME_SERVER_SECRET,
    defaultGameServerUrl:
      e.DEFAULT_GAME_SERVER_URL ?? (e.NODE_ENV === 'development' ? 'ws://localhost:7350' : undefined),
    targetSize: e.TARGET_SIZE,
    maxWaitMs: e.MAX_WAIT_MS,
    hotMaxWaitMs: e.HOT_MAX_WAIT_MS,
    hotThreshold: e.HOT_THRESHOLD,
    tickMs: e.NODE_ENV === 'test' ? 0 : e.TICK_MS,
    logLevel: e.LOG_LEVEL,
  };
}
