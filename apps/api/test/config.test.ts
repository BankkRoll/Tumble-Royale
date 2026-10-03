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

const prod = testEnv({ NODE_ENV: 'production' });

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
