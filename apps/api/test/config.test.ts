import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const prod = {
  NODE_ENV: 'production',
  JWT_SECRET: 'prod-jwt-secret-0123456789-abcdefghijklmnop',
  INTERNAL_HMAC_SECRET: 'prod-internal-hmac-secret-0123',
};

describe('production config', () => {
  it('refuses development secrets', () => {
    expect(() => loadConfig({ ...prod, JWT_SECRET: undefined, REDIS_URL: 'redis://r' })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => loadConfig({ ...prod, INTERNAL_HMAC_SECRET: undefined, REDIS_URL: 'redis://r' })).toThrow(
      /INTERNAL_HMAC_SECRET/,
    );
  });

  it('refuses to keep state in memory unless explicitly allowed', () => {
    expect(() => loadConfig(prod)).toThrow(/REDIS_URL/);
    expect(loadConfig({ ...prod, REDIS_URL: 'redis://r' }).memoryStoreInProduction).toBe(false);
    expect(loadConfig({ ...prod, ALLOW_MEMORY_STORE: '1' }).memoryStoreInProduction).toBe(true);
  });

  it('keeps zero-setup memory state outside production', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).memoryStoreInProduction).toBe(false);
  });
});
