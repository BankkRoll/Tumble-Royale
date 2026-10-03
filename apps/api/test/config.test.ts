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

const prod = testEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db/tumble' });

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
        METRICS_TOKEN: 'scrape-me',
        RETENTION_EVENTS_DAYS: '0',
        RETENTION_GUEST_DAYS: '365',
      }),
    ).ops;
    expect(ops).toMatchObject({ dbPoolMax: 25, migrateOnBoot: false, metricsToken: 'scrape-me' });
    expect(ops.retention).toMatchObject({ eventsDays: 0, guestDays: 365, sessionGraceDays: 7 });
    // Tests drive the retention job by hand.
    expect(ops.retention.intervalMs).toBe(0);
    expect(issueNames(testEnv({ DB_POOL_MAX: '0', MIGRATE_ON_BOOT: 'yes' }))).toEqual([
      'DB_POOL_MAX',
      'MIGRATE_ON_BOOT',
    ]);
  });

  it('keeps zero-setup memory state outside production', () => {
    expect(loadConfig(testEnv({ NODE_ENV: 'development' })).memoryStoreInProduction).toBe(false);
  });
});
