/**
 * Environment configuration for the API.
 *
 * Responsibilities:
 * - Parse and validate every environment variable the service reads, once, at
 *   boot, reporting every problem together.
 * - Provide development defaults for everything except secrets, which come
 *   from the environment or the `.env` files `pnpm setup:env` writes.
 * - Refuse to boot without secrets, with placeholder secrets, with a Stripe
 *   key but no webhook secret, or in production without Redis unless that is
 *   explicitly allowed.
 */
import { EnvIssues, type Env } from '@tumble/shared/env';
import type { TrustProxy } from '@tumble/shared/proxy';
import { z } from 'zod';

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
  PRESENCE_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(8_000),
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
  /**
   * Stripe credentials. The webhook secret is mandatory alongside the key:
   * without it refunds and chargebacks could never reach the ledger.
   */
  stripe: { secretKey: string; webhookSecret: string } | undefined;
  /** SMTP relay for sign-in emails; absent → console (dev) or email sign-in disabled (production). */
  smtp: { url: string; from: string } | undefined;
  nameChangeCooldownDays: number;
  /**
   * Reverse proxies allowed to set X-Forwarded-For (TRUST_PROXY): false
   * (default, the socket address is the client), a hop count or proxy
   * addresses/CIDRs.
   */
  trustProxy: TrustProxy;
  /** Requests per minute per client for the global rate limiter (shared across instances with Redis). */
  rateLimitMax: number;
  /** How long a user stays "online" after their last realtime connection closes. */
  presenceGraceMs: number;
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
 * @throws {EnvConfigError} Listing every malformed variable and missing or
 *   placeholder secret, `REDIS_URL` in production unless `ALLOW_MEMORY_STORE=1`,
 *   and `STRIPE_WEBHOOK_SECRET` whenever `STRIPE_SECRET_KEY` is set.
 */
export function loadConfig(env: Env = process.env): ApiConfig {
  const issues = new EnvIssues(env);
  const jwtSecret = issues.secret('JWT_SECRET', 32);
  const internalHmacSecret = issues.secret('INTERNAL_HMAC_SECRET', 16);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) issues.addSchemaIssues(parsed.error.issues);
  // Every field has a default, so parsing {} lets the remaining checks run and
  // report alongside the schema issues.
  const e = parsed.success ? parsed.data : EnvSchema.parse({});
  if (e.NODE_ENV === 'production' && !e.REDIS_URL && e.ALLOW_MEMORY_STORE !== '1') {
    issues.add(
      'REDIS_URL',
      'is required in production: parties, presence, leaderboards and nonces would live in ' +
        'process memory, vanish on restart and not be shared between instances. ' +
        'Set ALLOW_MEMORY_STORE=1 to run a single instance on memory anyway.',
    );
  }
  // WARNING: a live Stripe key without a webhook secret takes real money but
  // never hears about completions, refunds or chargebacks: paid Gems would
  // never arrive and refunded Gems would never be revoked.
  if (e.STRIPE_SECRET_KEY && !e.STRIPE_WEBHOOK_SECRET) {
    issues.add(
      'STRIPE_WEBHOOK_SECRET',
      'is required when STRIPE_SECRET_KEY is set: checkout completions, refunds and disputes ' +
        'arrive only through signed webhooks.',
    );
  }
  const trustProxy = issues.trustProxy();
  issues.throwIfAny('api');
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
    jwtSecret,
    internalHmacSecret,
    adminToken: e.ADMIN_TOKEN,
    publicWebUrl: e.PUBLIC_WEB_URL.replace(/\/$/, ''),
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    corsOrigins,
    discord: pair(e.DISCORD_CLIENT_ID, e.DISCORD_CLIENT_SECRET),
    google: pair(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET),
    stripe:
      e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET
        ? { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET }
        : undefined,
    smtp: e.SMTP_URL
      ? {
          url: e.SMTP_URL,
          from: e.SMTP_FROM ?? `Tumble Royale <no-reply@${new URL(e.PUBLIC_WEB_URL).hostname}>`,
        }
      : undefined,
    nameChangeCooldownDays: e.NAME_CHANGE_COOLDOWN_DAYS,
    trustProxy,
    rateLimitMax: e.RATE_LIMIT_MAX,
    presenceGraceMs: e.PRESENCE_GRACE_MS,
    logLevel: e.LOG_LEVEL,
  };
}
