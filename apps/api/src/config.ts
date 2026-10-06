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
 * - Refuse half-configured sign-in providers (an id without its secret, an
 *   incomplete or unreadable Apple key) instead of silently hiding them.
 */
import { createPrivateKey } from 'node:crypto';
import { EnvIssues, type Env } from '@tumble/shared/env';
import { readMetricsExposure, type MetricsExposure } from '@tumble/shared/metrics';
import type { TrustProxy } from '@tumble/shared/proxy';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

// An empty value (`ALLOW_EMBEDDED_DB=` in a .env or compose file) means unset.
const flag = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.enum(['0', '1']).optional(),
);

/** Self-hosting and operations knobs (pool, migrations, retention, metrics). */
const OpsEnvSchema = z.object({
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
  ALLOW_EMBEDDED_DB: flag,
  MIGRATE_ON_BOOT: flag,
  SENTRY_DSN: optionalString,
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(360),
  RETENTION_SESSION_GRACE_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().min(0).default(90),
  RETENTION_GUEST_DAYS: z.coerce.number().int().min(0).default(0),
  MATCHMAKER_URL: optionalString.pipe(z.string().url().optional()),
  STATUS_SAMPLE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
});

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
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  TWITCH_CLIENT_ID: optionalString,
  TWITCH_CLIENT_SECRET: optionalString,
  APPLE_CLIENT_ID: optionalString,
  APPLE_TEAM_ID: optionalString,
  APPLE_KEY_ID: optionalString,
  APPLE_PRIVATE_KEY: optionalString,
  DEV_ADMIN_EMAIL: optionalString.pipe(z.string().email().optional()),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  SMTP_URL: optionalString,
  SMTP_FROM: optionalString,
  NAME_CHANGE_COOLDOWN_DAYS: z.coerce.number().int().min(0).default(30),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  PRESENCE_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(8_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ...OpsEnvSchema.shape,
});

/** OAuth client credentials for one provider. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Sign in with Apple credentials. Apple has no static client secret: every
 * token exchange presents a short-lived ES256 JWT signed with the `.p8` key.
 */
export interface AppleClientConfig {
  /** Services ID (`APPLE_CLIENT_ID`), e.g. `com.example.tumble.web`. */
  clientId: string;
  /** Apple Developer team id (`APPLE_TEAM_ID`), the client secret's issuer. */
  teamId: string;
  /** Id of the Sign in with Apple key (`APPLE_KEY_ID`). */
  keyId: string;
  /** PKCS#8 PEM of that key (`APPLE_PRIVATE_KEY`; `\n` escapes are accepted). */
  privateKey: string;
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
  github: OAuthClientConfig | undefined;
  twitch: OAuthClientConfig | undefined;
  apple: AppleClientConfig | undefined;
  /**
   * Development only (`DEV_ADMIN_EMAIL`): the account with this address is
   * made admin at boot while no staff exist, and a one-time console sign-in
   * link is logged. Refused in production; ignored in tests.
   */
  devAdminEmail: string | undefined;
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
  /** Self-hosting and operations settings. */
  ops: ApiOpsConfig;
  /** Voice chat ICE servers and the TURN secret. */
  voice: VoiceServerConfig;
}

/**
 * Where voice peers find each other. TURN credentials are minted per user and
 * room from `turnSecret` (the TURN REST scheme, coturn's `static-auth-secret`).
 */
export interface VoiceServerConfig {
  /** `stun:` URLs from `VOICE_ICE_SERVERS`, handed out as is. */
  stunUrls: string[];
  /** `turn:` / `turns:` URLs from `VOICE_ICE_SERVERS`, handed out with short-lived credentials. */
  turnUrls: string[];
  /** `VOICE_TURN_SECRET`; never leaves the server. */
  turnSecret: string | undefined;
  /**
   * Voice may be switched on at all (`voice.enabled` still has to be on): a
   * TURN relay is configured, or `VOICE_REQUIRE_TURN=0` (the default outside
   * production, for LAN play and local testing).
   */
  available: boolean;
}

/** Data-retention policy; a 0 day count keeps that data forever. */
export interface RetentionConfig {
  /** How often the job runs (`RETENTION_INTERVAL_MINUTES`, 0 = never). */
  intervalMs: number;
  /** Delete sessions this long after they expired (`RETENTION_SESSION_GRACE_DAYS`, 7). */
  sessionGraceDays: number;
  /** Delete non-audit analytics events older than this (`RETENTION_EVENTS_DAYS`, 90). */
  eventsDays: number;
  /** Delete guest accounts unseen for this long (`RETENTION_GUEST_DAYS`, 0 = off). */
  guestDays: number;
}

/** Operations settings of the API. */
export interface ApiOpsConfig {
  /** Postgres pool size per instance (`DB_POOL_MAX`, 10). */
  dbPoolMax: number;
  /** Apply migrations at boot (`MIGRATE_ON_BOOT`, default on). Off when a separate `migrate` step runs them. */
  migrateOnBoot: boolean;
  /** `/metrics` exposure: `METRICS_TOKEN`, `INTERNAL_PORT`, `INTERNAL_HOST`. */
  metrics: MetricsExposure;
  /** Sentry-compatible DSN for crash reports. */
  sentryDsn: string | undefined;
  retention: RetentionConfig;
  /** Public status page. */
  status: StatusConfig;
}

/** Public status page settings. */
export interface StatusConfig {
  /**
   * Matchmaker base URL the API probes for the Matchmaking and Game servers
   * components (`MATCHMAKER_URL`, the same variable the game servers read);
   * absent → those components are not shown.
   */
  matchmakerUrl: string | undefined;
  /** Uptime sampling interval (`STATUS_SAMPLE_SECONDS`, 60; 0 = no history). */
  sampleIntervalMs: number;
}

const ICE_URL = /^(stun|turn|turns):[^\s,]+$/;

function readVoice(issues: EnvIssues, nodeEnv: ApiConfig['env']): VoiceServerConfig {
  const urls = (issues.optional('VOICE_ICE_SERVERS') ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const bad = urls.filter((u) => !ICE_URL.test(u));
  if (bad.length)
    issues.add('VOICE_ICE_SERVERS', `must be stun:, turn: or turns: URLs (got "${bad.join(', ')}")`);
  const valid = urls.filter((u) => ICE_URL.test(u));
  const turnUrls = valid.filter((u) => !u.startsWith('stun:'));
  const stunUrls = valid.filter((u) => u.startsWith('stun:'));
  const secret = issues.optional('VOICE_TURN_SECRET');
  if (secret !== undefined && secret.length < 16)
    issues.add('VOICE_TURN_SECRET', 'must be at least 16 characters');
  else if (turnUrls.length > 0 && secret === undefined)
    issues.add('VOICE_TURN_SECRET', 'is required when VOICE_ICE_SERVERS lists a turn: or turns: URL');
  const requireTurn = issues.flag('VOICE_REQUIRE_TURN', nodeEnv === 'production');
  const relay = turnUrls.length > 0 && secret !== undefined && secret.length >= 16;
  return {
    stunUrls,
    turnUrls: relay ? turnUrls : [],
    turnSecret: relay ? secret : undefined,
    available: relay || !requireTurn,
  };
}

/**
 * One OAuth client from `<PREFIX>_CLIENT_ID` and `<PREFIX>_CLIENT_SECRET`.
 * Half a pair is reported: it is a typo that would otherwise silently hide
 * the provider.
 */
function pair(issues: EnvIssues, prefix: string): OAuthClientConfig | undefined {
  const idKey = `${prefix}_CLIENT_ID`;
  const secretKey = `${prefix}_CLIENT_SECRET`;
  const id = issues.optional(idKey);
  const secret = issues.optional(secretKey);
  if (id && secret) return { clientId: id, clientSecret: secret };
  if (id) issues.add(secretKey, `is required when ${idKey} is set`);
  if (secret) issues.add(idKey, `is required when ${secretKey} is set`);
  return undefined;
}

const APPLE_KEYS = ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'] as const;

function readApple(issues: EnvIssues): AppleClientConfig | undefined {
  const [clientId, teamId, keyId, rawKey] = APPLE_KEYS.map((k) => issues.optional(k));
  if (!clientId && !teamId && !keyId && !rawKey) return undefined;
  if (!clientId || !teamId || !keyId || !rawKey) {
    for (const k of APPLE_KEYS) {
      if (!issues.optional(k))
        issues.add(k, `is required for Sign in with Apple (set all of ${APPLE_KEYS.join(', ')})`);
    }
    return undefined;
  }
  // NOTE: a .env value cannot portably span lines, so the PEM may arrive on
  // one line with literal `\n` escapes.
  const privateKey = rawKey.replace(/\\n/g, '\n');
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'ec') throw new Error('not an EC key');
  } catch {
    issues.add(
      'APPLE_PRIVATE_KEY',
      'must be the contents of the .p8 key file Apple issued (-----BEGIN PRIVATE KEY----- …)',
    );
    return undefined;
  }
  return { clientId, teamId, keyId, privateKey };
}

/**
 * Parses an environment map into an {@link ApiConfig}.
 *
 * @param env - Usually `process.env`; tests pass a literal map.
 * @returns The validated configuration.
 * @throws {EnvConfigError} Listing every malformed variable and missing or
 *   placeholder secret, `REDIS_URL` in production unless `ALLOW_MEMORY_STORE=1`,
 *   `STRIPE_WEBHOOK_SECRET` whenever `STRIPE_SECRET_KEY` is set, and
 *   `VOICE_TURN_SECRET` whenever `VOICE_ICE_SERVERS` lists a TURN URL.
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
  if (e.NODE_ENV === 'production' && !e.DATABASE_URL && e.ALLOW_EMBEDDED_DB !== '1') {
    issues.add(
      'DATABASE_URL',
      'is required in production: the embedded PGlite database is single-process, has no backups ' +
        'tooling and cannot be shared between API instances. Set ALLOW_EMBEDDED_DB=1 to run on it anyway.',
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
  const metrics = readMetricsExposure(issues, e.PORT);
  const voice = readVoice(issues, e.NODE_ENV);
  // SECURITY: ADMIN_TOKEN is optional, but when set it is a full admin
  // credential, so a copied `change-me` or a short value must not boot.
  const adminToken =
    issues.optional('ADMIN_TOKEN') === undefined ? undefined : issues.secret('ADMIN_TOKEN', 16) || undefined;
  const oauth = {
    discord: pair(issues, 'DISCORD'),
    google: pair(issues, 'GOOGLE'),
    github: pair(issues, 'GITHUB'),
    twitch: pair(issues, 'TWITCH'),
    apple: readApple(issues),
  };
  // SECURITY: the dev seed makes an admin reachable through a link printed to
  // the log; a real deployment must never do that.
  if (e.DEV_ADMIN_EMAIL && e.NODE_ENV === 'production') {
    issues.add(
      'DEV_ADMIN_EMAIL',
      'is for local development only; unset it and create the first admin with `pnpm admin staff bootstrap`',
    );
  }
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
    adminToken,
    publicWebUrl: e.PUBLIC_WEB_URL.replace(/\/$/, ''),
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    corsOrigins,
    ...oauth,
    devAdminEmail: e.NODE_ENV === 'development' ? e.DEV_ADMIN_EMAIL?.toLowerCase() : undefined,
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
    ops: {
      dbPoolMax: e.DB_POOL_MAX,
      migrateOnBoot: e.MIGRATE_ON_BOOT !== '0',
      metrics,
      sentryDsn: e.SENTRY_DSN,
      retention: {
        intervalMs: e.NODE_ENV === 'test' ? 0 : e.RETENTION_INTERVAL_MINUTES * 60_000,
        sessionGraceDays: e.RETENTION_SESSION_GRACE_DAYS,
        eventsDays: e.RETENTION_EVENTS_DAYS,
        guestDays: e.RETENTION_GUEST_DAYS,
      },
      status: {
        matchmakerUrl: e.MATCHMAKER_URL?.replace(/\/$/, ''),
        sampleIntervalMs: e.NODE_ENV === 'test' ? 0 : e.STATUS_SAMPLE_SECONDS * 1000,
      },
    },
    voice,
  };
}
