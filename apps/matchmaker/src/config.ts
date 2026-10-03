/**
 * Environment configuration for the matchmaker.
 *
 * Responsibilities:
 * - Parse and validate every environment variable once, at boot, reporting
 *   every problem together.
 * - Provide development defaults that line up with the API and game server;
 *   secrets have none and come from the environment or the `.env` files
 *   `pnpm setup:env` writes.
 * - Refuse to boot without secrets, with placeholder secrets, or in
 *   production on the in-process store unless that is explicitly allowed.
 */
import { EnvIssues, type Env } from '@tumble/shared/env';
import type { TrustProxy } from '@tumble/shared/proxy';
import { z } from 'zod';

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
  API_URL: optional,
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
  /** Signs internal calls to the API (`INTERNAL_HMAC_SECRET`, shared with the API); set whenever `apiUrl` is. */
  internalHmacSecret: string | undefined;
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
  /**
   * Reverse proxies allowed to set X-Forwarded-For (`TRUST_PROXY`): false
   * (default, the socket address is the client), a hop count or proxy
   * addresses/CIDRs.
   */
  trustProxy: TrustProxy;
  /** Requests per minute per IP address, across all instances sharing the store. */
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
 * @throws {EnvConfigError} Listing every malformed variable and missing or
 *   placeholder secret (`INTERNAL_HMAC_SECRET` only when the API is used), and
 *   `REDIS_URL` in production unless `ALLOW_MEMORY_STORE=1`.
 */
export function loadConfig(env: Env = process.env): MatchmakerConfig {
  const issues = new EnvIssues(env);
  const jwtSecret = issues.secret('JWT_SECRET', 32);
  const gameTicketSecret = issues.secret('GAME_TICKET_SECRET', 16);
  const gameServerSecret = issues.secret('GAME_SERVER_SECRET', 16);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) issues.addSchemaIssues(parsed.error.issues);
  // Every field has a default, so parsing {} lets the remaining checks run and
  // report alongside the schema issues.
  const e = parsed.success ? parsed.data : EnvSchema.parse({});
  const production = e.NODE_ENV === 'production';
  const trustProxy = issues.trustProxy();
  const apiUrl = e.API_URL ?? (e.NODE_ENV === 'development' ? 'http://localhost:7360' : undefined);
  const internalHmacSecret = apiUrl ? issues.secret('INTERNAL_HMAC_SECRET', 16) : undefined;
  if (production && !e.REDIS_URL && e.ALLOW_MEMORY_STORE !== '1') {
    issues.add(
      'REDIS_URL',
      'is required in production: queues, lobbies and the server registry would live in ' +
        'process memory, vanish on restart and not be shared between instances. ' +
        'Set ALLOW_MEMORY_STORE=1 to run a single instance on memory anyway.',
    );
  }
  issues.throwIfAny('matchmaker');
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    memoryStoreInProduction: production && !e.REDIS_URL,
    jwtSecret,
    gameTicketSecret,
    gameServerSecret,
    apiUrl: apiUrl?.replace(/\/$/, ''),
    internalHmacSecret,
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
    trustProxy,
    rateLimitMax: e.RATE_LIMIT_MAX,
    userRateLimitMax: e.USER_RATE_LIMIT_MAX,
    tickMs: e.NODE_ENV === 'test' ? 0 : e.TICK_MS,
    logLevel: e.LOG_LEVEL,
  };
}
