/**
 * Environment configuration for the API.
 *
 * Responsibilities:
 * - Parse and validate every environment variable the service reads, once, at boot.
 * - Provide safe development defaults so `pnpm dev` works with zero setup.
 * - Refuse to boot in production with development secrets.
 */
import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
const DEV_INTERNAL_SECRET = 'dev-only-internal-hmac-secret-change-me';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7360),
  DATABASE_URL: optionalString,
  PGLITE_DIR: z.string().default('./.data/pglite'),
  REDIS_URL: optionalString,
  ALLOW_MEMORY_STORE: optionalString,
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  INTERNAL_HMAC_SECRET: z.string().min(16).default(DEV_INTERNAL_SECRET),
  ADMIN_TOKEN: optionalString,
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:7360'),
  CORS_ORIGINS: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_CLIENT_SECRET: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  SMTP_URL: optionalString,
  SMTP_FROM: optionalString,
  NAME_CHANGE_COOLDOWN_DAYS: z.coerce.number().int().min(0).default(30),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** OAuth client credentials for one provider. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/** Fully resolved API configuration. */
export interface ApiConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  /** HTTP port to listen on. */
  port: number;
  /** Postgres connection string; absent → embedded PGlite. */
  databaseUrl: string | undefined;
  /** PGlite data directory; `memory://` keeps everything in RAM (tests). */
  pgliteDir: string;
  /** Redis connection string; absent → in-process KV. */
  redisUrl: string | undefined;
  /**
   * True when production runs on the in-process KV because `ALLOW_MEMORY_STORE=1`
   * was set explicitly; parties, presence and leaderboards are then lost on
   * restart and not shared between instances.
   */
  memoryStoreInProduction: boolean;
  /** HS256 secret for access tokens. Shared with the matchmaker, which verifies them. */
  jwtSecret: string;
  /** HMAC secret shared with game servers for `/internal/*` calls. */
  internalHmacSecret: string;
  /** Bearer token for admin-only internal routes; absent → those routes are disabled. */
  adminToken: string | undefined;
  /** Origin of the web client, used for redirects, invite links and magic links. */
  publicWebUrl: string;
  /** Public origin of this API, used to build OAuth redirect URIs. */
  publicApiUrl: string;
  /** Allowed CORS origins; `true` reflects any origin (development only). */
  corsOrigins: string[] | true;
  discord: OAuthClientConfig | undefined;
  google: OAuthClientConfig | undefined;
  stripe: { secretKey: string; webhookSecret: string | undefined } | undefined;
  /** SMTP relay for sign-in emails; absent → console (dev) or email sign-in disabled (production). */
  smtp: { url: string; from: string } | undefined;
  nameChangeCooldownDays: number;
  /** Requests per minute per client for the global rate limiter. */
  rateLimitMax: number;
  logLevel: string;
}

function pair(id: string | undefined, secret: string | undefined): OAuthClientConfig | undefined {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}

/**
 * Parses an environment map into an {@link ApiConfig}.
 *
 * @param env - Usually `process.env`; tests pass a literal map.
 * @returns The validated configuration.
 * @throws If a variable is malformed, or production runs with development
 *   secrets, or without `REDIS_URL` unless `ALLOW_MEMORY_STORE=1`.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const e = EnvSchema.parse(env);
  if (e.NODE_ENV === 'production') {
    if (e.JWT_SECRET === DEV_JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
    if (e.INTERNAL_HMAC_SECRET === DEV_INTERNAL_SECRET) {
      throw new Error('INTERNAL_HMAC_SECRET must be set in production');
    }
    if (!e.REDIS_URL && e.ALLOW_MEMORY_STORE !== '1') {
      throw new Error(
        'REDIS_URL must be set in production: parties, presence, leaderboards and nonces would live in ' +
          'process memory, vanish on restart and not be shared between instances. ' +
          'Set ALLOW_MEMORY_STORE=1 to run a single instance on memory anyway.',
      );
    }
  }
  const corsOrigins: string[] | true = e.CORS_ORIGINS
    ? e.CORS_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : e.NODE_ENV === 'production'
      ? [e.PUBLIC_WEB_URL]
      : true;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.NODE_ENV === 'test' ? 'memory://' : e.PGLITE_DIR,
    redisUrl: e.REDIS_URL,
    memoryStoreInProduction: e.NODE_ENV === 'production' && !e.REDIS_URL,
    jwtSecret: e.JWT_SECRET,
    internalHmacSecret: e.INTERNAL_HMAC_SECRET,
    adminToken: e.ADMIN_TOKEN,
    publicWebUrl: e.PUBLIC_WEB_URL.replace(/\/$/, ''),
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    corsOrigins,
    discord: pair(e.DISCORD_CLIENT_ID, e.DISCORD_CLIENT_SECRET),
    google: pair(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET),
    stripe: e.STRIPE_SECRET_KEY
      ? { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET }
      : undefined,
    smtp: e.SMTP_URL
      ? {
          url: e.SMTP_URL,
          from: e.SMTP_FROM ?? `Tumble Royale <no-reply@${new URL(e.PUBLIC_WEB_URL).hostname}>`,
        }
      : undefined,
    nameChangeCooldownDays: e.NAME_CHANGE_COOLDOWN_DAYS,
    rateLimitMax: e.RATE_LIMIT_MAX,
    logLevel: e.LOG_LEVEL,
  };
}
