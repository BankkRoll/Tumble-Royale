import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvConfigError } from '@tumble/shared/env';
import { DEFAULT_SHOW_PLAYERS, MAX_PLAYERS } from '@tumble/shared';
import { loadConfig } from '../src/config.ts';
import { TEST_SECRETS, testEnv } from './helpers.ts';

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
  INTERNAL_HMAC_SECRET: undefined,
  REDIS_URL: 'redis://r',
  ALLOW_STANDALONE: '1',
});

describe('matchmaker config', () => {
  it('requires every secret and reports them together', () => {
    expect(issueNames({ NODE_ENV: 'test' })).toEqual([
      'JWT_SECRET',
      'GAME_TICKET_SECRET',
      'GAME_SERVER_SECRET',
    ]);
    expect(issueNames({ NODE_ENV: 'test', ...TEST_SECRETS, TARGET_SIZE: '1', JWT_SECRET: 'x' })).toEqual([
      'JWT_SECRET',
      'TARGET_SIZE',
    ]);
  });

  it('defaults lobbies to the full show size and caps them at MAX_PLAYERS', () => {
    const c = loadConfig(testEnv());
    expect(c.targetSize).toBe(DEFAULT_SHOW_PLAYERS);
    expect(c.hotThreshold).toBe(2 * DEFAULT_SHOW_PLAYERS);
    expect(loadConfig(testEnv({ TARGET_SIZE: String(MAX_PLAYERS) })).targetSize).toBe(MAX_PLAYERS);
    expect(issueNames(testEnv({ TARGET_SIZE: String(MAX_PLAYERS + 1) }))).toEqual(['TARGET_SIZE']);
  });

  it('refuses placeholder secrets copied from .env.example', () => {
    expect(issueNames(testEnv({ GAME_SERVER_SECRET: 'change-me' }))).toEqual(['GAME_SERVER_SECRET']);
  });

  it('needs INTERNAL_HMAC_SECRET only when it calls the API', () => {
    expect(loadConfig(prod).internalHmacSecret).toBeUndefined();
    expect(issueNames({ ...prod, API_URL: 'https://api.example.com' })).toEqual(['INTERNAL_HMAC_SECRET']);
    expect(issueNames(testEnv({ NODE_ENV: 'development', INTERNAL_HMAC_SECRET: undefined }))).toEqual([
      'INTERNAL_HMAC_SECRET',
    ]);
    expect(loadConfig(testEnv({ NODE_ENV: 'development' }))).toMatchObject({
      apiUrl: 'http://localhost:7360',
      internalHmacSecret: TEST_SECRETS.INTERNAL_HMAC_SECRET,
      defaultGameServerUrl: 'ws://localhost:7350',
    });
  });

  it('defaults CORS to PUBLIC_WEB_URL in production and anything in development', () => {
    expect(loadConfig({ ...prod, PUBLIC_WEB_URL: 'https://play.example.com/' }).allowedOrigins).toEqual([
      'https://play.example.com',
    ]);
    expect(loadConfig(testEnv({ NODE_ENV: 'development' })).allowedOrigins).toBe(true);
  });

  it('requires the account API in production unless explicitly standalone', () => {
    expect(issueNames({ ...prod, ALLOW_STANDALONE: undefined })).toEqual(['API_URL']);
    expect(issueNames({ ...prod, ALLOW_STANDALONE: undefined, API_URL: 'https://api.example.com' })).toEqual([
      'INTERNAL_HMAC_SECRET',
    ]);
  });

  it('bounds timer settings below the setTimeout limit', () => {
    expect(issueNames(testEnv({ MAX_WAIT_MS: '3000000000' }))).toEqual(['MAX_WAIT_MS']);
  });

  it('refuses to run production on memory unless explicitly allowed', () => {
    const noRedis = { ...prod, REDIS_URL: undefined };
    expect(issueNames(noRedis)).toEqual(['REDIS_URL']);
    expect(loadConfig({ ...noRedis, ALLOW_MEMORY_STORE: '1' }).memoryStoreInProduction).toBe(true);
    expect(loadConfig(prod).memoryStoreInProduction).toBe(false);
  });
});

describe('deploy/.env from pnpm setup:env --production', () => {
  it('boots the matchmaker in production behind the edge proxy', () => {
    const example = parseEnv(readFileSync(new URL('../../../deploy/.env.example', import.meta.url), 'utf8'));
    const env = Object.fromEntries(
      Object.entries(example).map(([k, v]) => [
        k,
        v === 'change-me' ? randomBytes(32).toString('base64url') : v,
      ]),
    );
    // setup:env writes the generated Redis password into REDIS_URL too.
    env.REDIS_URL = env.REDIS_URL!.replace('change-me', env.REDIS_PASSWORD!);
    expect(loadConfig(env)).toMatchObject({
      env: 'production',
      redisUrl: `redis://:${env.REDIS_PASSWORD}@redis:6379`,
      apiUrl: 'http://api:7360',
      allowedOrigins: ['https://example.com'],
      memoryStoreInProduction: false,
    });
  });
});
