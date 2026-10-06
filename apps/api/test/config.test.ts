import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvConfigError } from '@tumble/shared/env';
import { loadConfig } from '../src/config.ts';
import { testEnv } from './helpers.ts';

const issueNames = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof EnvConfigError) return err.issues.map((i) => i.name);
    throw err;
  }
  return [];
};

const prod = testEnv({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://db/tumble',
  PUBLIC_WEB_URL: 'https://play.example',
  PUBLIC_API_URL: 'https://play.example/api',
});

describe('api config', () => {
  it('requires secrets in every environment and reports all problems at once', () => {
    expect(issueNames({ NODE_ENV: 'development', PORT: 'x', PUBLIC_WEB_URL: 'nope' })).toEqual([
      'JWT_SECRET',
      'INTERNAL_HMAC_SECRET',
      'PORT',
      'PUBLIC_WEB_URL',
    ]);
  });

  it('refuses short secrets and placeholders copied from .env.example', () => {
    expect(issueNames(testEnv({ JWT_SECRET: 'too-short' }))).toEqual(['JWT_SECRET']);
    expect(issueNames(testEnv({ INTERNAL_HMAC_SECRET: 'change-me-change-me' }))).toEqual([
      'INTERNAL_HMAC_SECRET',
    ]);
  });

  it('refuses to keep production state in memory unless explicitly allowed', () => {
    expect(issueNames(prod)).toEqual(['REDIS_URL']);
    expect(loadConfig({ ...prod, REDIS_URL: 'redis://r' }).memoryStoreInProduction).toBe(false);
    expect(loadConfig({ ...prod, ALLOW_MEMORY_STORE: '1' }).memoryStoreInProduction).toBe(true);
  });

  it('requires the public URLs in production instead of defaulting to localhost', () => {
    const bare = { ...prod, REDIS_URL: 'redis://r', PUBLIC_WEB_URL: undefined, PUBLIC_API_URL: undefined };
    expect(issueNames(bare)).toEqual(['PUBLIC_WEB_URL', 'PUBLIC_API_URL']);
    expect(issueNames({ ...prod, REDIS_URL: 'redis://r' })).toEqual([]);
  });

  it('bounds the retention interval below the timer limit', () => {
    expect(issueNames(testEnv({ RETENTION_INTERVAL_MINUTES: '40000' }))).toEqual([
      'RETENTION_INTERVAL_MINUTES',
    ]);
    expect(issueNames(testEnv({ RETENTION_INTERVAL_MINUTES: '35000' }))).toEqual([]);
  });

  it('refuses the embedded database in production unless explicitly allowed', () => {
    const embedded = { ...prod, REDIS_URL: 'redis://r', DATABASE_URL: '' };
    expect(issueNames(embedded)).toEqual(['DATABASE_URL']);
    expect(issueNames({ ...embedded, ALLOW_EMBEDDED_DB: '1' })).toEqual([]);
    expect(issueNames({ ...embedded, ALLOW_EMBEDDED_DB: '' })).toEqual(['DATABASE_URL']);
    expect(issueNames(testEnv({ NODE_ENV: 'development' }))).toEqual([]);
  });

  it('parses the operations settings', () => {
    const ops = loadConfig(
      testEnv({
        DB_POOL_MAX: '25',
        MIGRATE_ON_BOOT: '0',
        METRICS_TOKEN: 'scrape-me-0123456789',
        INTERNAL_PORT: '9360',
        RETENTION_EVENTS_DAYS: '0',
        RETENTION_GUEST_DAYS: '365',
      }),
    ).ops;
    expect(ops).toMatchObject({
      dbPoolMax: 25,
      migrateOnBoot: false,
      metrics: { token: 'scrape-me-0123456789', internalPort: 9360 },
    });
    expect(ops.retention).toMatchObject({ eventsDays: 0, guestDays: 365, sessionGraceDays: 7 });
    // Tests drive the retention job by hand.
    expect(ops.retention.intervalMs).toBe(0);
    expect(issueNames(testEnv({ DB_POOL_MAX: '0', MIGRATE_ON_BOOT: 'yes' }))).toEqual([
      'DB_POOL_MAX',
      'MIGRATE_ON_BOOT',
    ]);
  });

  it('requires the Stripe webhook secret whenever a Stripe key is set', () => {
    expect(issueNames(testEnv({ STRIPE_SECRET_KEY: 'sk_test_123' }))).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect(issueNames(testEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: '  ' }))).toEqual([
      'STRIPE_WEBHOOK_SECRET',
    ]);
    const ok = loadConfig(testEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_abc' }));
    expect(ok.stripe).toEqual({ secretKey: 'sk_test_123', webhookSecret: 'whsec_abc' });
    expect(loadConfig(testEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).stripe).toBeUndefined();
  });

  it('keeps zero-setup memory state outside production', () => {
    expect(loadConfig(testEnv({ NODE_ENV: 'development' })).memoryStoreInProduction).toBe(false);
  });
});

describe('sign-in providers', () => {
  const appleKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const apple = {
    APPLE_CLIENT_ID: 'com.example.web',
    APPLE_TEAM_ID: 'TEAM',
    APPLE_KEY_ID: 'KEY',
    APPLE_PRIVATE_KEY: appleKey,
  };

  it('enables each OAuth provider only when both of its keys are set', () => {
    const c = loadConfig(
      testEnv({
        GITHUB_CLIENT_ID: 'gh',
        GITHUB_CLIENT_SECRET: 'gh-secret',
        TWITCH_CLIENT_ID: 'tw',
        TWITCH_CLIENT_SECRET: 'tw-secret',
      }),
    );
    expect(c.github).toEqual({ clientId: 'gh', clientSecret: 'gh-secret' });
    expect(c.twitch).toEqual({ clientId: 'tw', clientSecret: 'tw-secret' });
    expect([c.discord, c.google, c.apple]).toEqual([undefined, undefined, undefined]);
  });

  it('reports half a pair instead of silently hiding the provider', () => {
    expect(issueNames(testEnv({ GITHUB_CLIENT_ID: 'gh' }))).toEqual(['GITHUB_CLIENT_SECRET']);
    expect(issueNames(testEnv({ DISCORD_CLIENT_SECRET: 's' }))).toEqual(['DISCORD_CLIENT_ID']);
  });

  it('reads the Apple key with escaped newlines and refuses an incomplete or unreadable one', () => {
    const c = loadConfig(testEnv({ ...apple, APPLE_PRIVATE_KEY: appleKey.trim().replace(/\n/g, '\\n') }));
    expect(c.apple).toMatchObject({ clientId: 'com.example.web', teamId: 'TEAM', keyId: 'KEY' });
    expect(c.apple?.privateKey).toContain('\n');
    expect(issueNames(testEnv({ APPLE_CLIENT_ID: 'com.example.web' }))).toEqual([
      'APPLE_TEAM_ID',
      'APPLE_KEY_ID',
      'APPLE_PRIVATE_KEY',
    ]);
    expect(issueNames(testEnv({ ...apple, APPLE_PRIVATE_KEY: 'not a key' }))).toEqual(['APPLE_PRIVATE_KEY']);
  });
});

describe('ADMIN_TOKEN', () => {
  it('is optional, but refuses a placeholder or short value when set', () => {
    expect(loadConfig(testEnv()).adminToken).toBeUndefined();
    expect(loadConfig(testEnv({ ADMIN_TOKEN: '  ' })).adminToken).toBeUndefined();
    expect(issueNames(testEnv({ ADMIN_TOKEN: 'change-me' }))).toEqual(['ADMIN_TOKEN']);
    expect(issueNames(testEnv({ ADMIN_TOKEN: 'short' }))).toEqual(['ADMIN_TOKEN']);
    expect(
      loadConfig(testEnv({ ADMIN_TOKEN: 'a-long-enough-admin-token-0123456789abcdef' })).adminToken,
    ).toBe('a-long-enough-admin-token-0123456789abcdef');
  });
});

describe('DEV_ADMIN_EMAIL', () => {
  it('applies in development only and is refused in production', () => {
    expect(
      loadConfig(testEnv({ NODE_ENV: 'development', DEV_ADMIN_EMAIL: 'Dev@Localhost.test' })).devAdminEmail,
    ).toBe('dev@localhost.test');
    expect(loadConfig(testEnv({ DEV_ADMIN_EMAIL: 'dev@localhost.test' })).devAdminEmail).toBeUndefined();
    expect(issueNames({ ...prod, REDIS_URL: 'redis://r', DEV_ADMIN_EMAIL: 'dev@localhost.test' })).toEqual([
      'DEV_ADMIN_EMAIL',
    ]);
    expect(issueNames(testEnv({ DEV_ADMIN_EMAIL: 'not-an-email' }))).toEqual(['DEV_ADMIN_EMAIL']);
  });
});

describe('.env from pnpm setup:env (development)', () => {
  it('boots the API with the dev admin seed on', () => {
    const files = ['../../../.env.example', '../.env.example'];
    const merged = Object.assign(
      {},
      ...files.map((f) => parseEnv(readFileSync(new URL(f, import.meta.url), 'utf8'))),
    ) as Record<string, string>;
    const env = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [
        k,
        v === 'change-me' ? randomBytes(32).toString('base64url') : v,
      ]),
    );
    const c = loadConfig(env);
    expect(c).toMatchObject({ env: 'development', devAdminEmail: 'admin@tumble.localhost' });
    expect(c.adminToken).toBe(env.ADMIN_TOKEN);
  });
});

describe('deploy/.env from pnpm setup:env --production', () => {
  it('boots the API in production behind the edge proxy', () => {
    const example = parseEnv(readFileSync(new URL('../../../deploy/.env.example', import.meta.url), 'utf8'));
    const env = Object.fromEntries(
      Object.entries(example).map(([k, v]) => [
        k,
        v === 'change-me' ? randomBytes(32).toString('base64url') : v,
      ]),
    );
    expect(loadConfig(env)).toMatchObject({
      env: 'production',
      databaseUrl: expect.stringMatching(/^postgres:\/\/tumble:.+@postgres:5432\/tumble$/),
      redisUrl: 'redis://redis:6379',
      publicWebUrl: 'https://example.com',
      publicApiUrl: 'https://example.com/api',
      corsOrigins: ['https://example.com'],
      adminToken: env.ADMIN_TOKEN,
    });
  });
});
