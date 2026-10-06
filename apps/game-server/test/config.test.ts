import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvConfigError } from '@tumble/shared/env';
import { DEFAULT_SHOW_PLAYERS, MAX_PLAYERS } from '@tumble/shared';
import { DEFAULT_MAX_ROOMS, loadConfig } from '../src/config.ts';
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

describe('game server config', () => {
  it('has working defaults for everything but secrets', () => {
    const c = loadConfig(testEnv());
    expect(c).toMatchObject({
      env: 'test',
      port: 7350,
      fillWaitMs: 25_000,
      startAtHumans: DEFAULT_SHOW_PLAYERS,
      ticketedFillWaitMs: 15_000,
      devSim: null,
      ticketSecret: TEST_SECRETS.GAME_TICKET_SECRET,
      allowUnticketed: true,
      results: null,
      link: null,
      controlSecret: TEST_SECRETS.GAME_SERVER_SECRET,
    });
  });

  it('keeps the seat and room limits consistent by default', () => {
    expect(loadConfig(testEnv()).capacity).toEqual({
      roomCapacity: DEFAULT_SHOW_PLAYERS,
      maxRooms: DEFAULT_MAX_ROOMS,
      serverCapacity: DEFAULT_MAX_ROOMS * DEFAULT_SHOW_PLAYERS,
    });
    expect(issueNames(testEnv({ ROOM_CAPACITY: String(MAX_PLAYERS + 1) }))).toEqual(['ROOM_CAPACITY']);
    expect(loadConfig(testEnv({ ROOM_CAPACITY: String(MAX_PLAYERS) })).capacity.roomCapacity).toBe(
      MAX_PLAYERS,
    );
    expect(loadConfig(testEnv({ MAX_ROOMS: '4', ROOM_CAPACITY: '20' })).capacity.serverCapacity).toBe(80);
    expect(loadConfig(testEnv({ SERVER_CAPACITY: '120' })).capacity.serverCapacity).toBe(120);
  });

  it('requires the ticket secret and refuses example placeholders', () => {
    expect(issueNames(testEnv({ GAME_TICKET_SECRET: undefined }))).toEqual(['GAME_TICKET_SECRET']);
    expect(issueNames(testEnv({ GAME_TICKET_SECRET: 'change-me' }))).toEqual(['GAME_TICKET_SECRET']);
    expect(issueNames(testEnv({ GAME_TICKET_SECRET: 'short' }))).toEqual(['GAME_TICKET_SECRET']);
  });

  it('reports every invalid variable at once', () => {
    expect(
      issueNames({
        NODE_ENV: 'test',
        PORT: 'eighty',
        MAX_ROOMS: '0',
        GS_DEV: 'yes',
        API_URL: 'not a url',
      }),
    ).toEqual(['PORT', 'MAX_ROOMS', 'GS_DEV', 'GAME_TICKET_SECRET', 'API_URL']);
  });

  it('reports results to the local API by default in development', () => {
    expect(loadConfig(testEnv({ NODE_ENV: 'development' })).results).toEqual({
      apiUrl: 'http://localhost:7360',
      secret: TEST_SECRETS.INTERNAL_HMAC_SECRET,
      outboxDir: './.data/results-outbox',
    });
    expect(loadConfig(testEnv({ NODE_ENV: 'development', REPORT_RESULTS: '0' })).results).toBeNull();
    expect(issueNames(testEnv({ NODE_ENV: 'development', INTERNAL_HMAC_SECRET: undefined }))).toEqual([
      'INTERNAL_HMAC_SECRET',
    ]);
  });

  it('reports results in production only when API_URL is set', () => {
    const prod = testEnv({ NODE_ENV: 'production', INTERNAL_HMAC_SECRET: undefined });
    expect(loadConfig(prod).results).toBeNull();
    expect(loadConfig(prod).allowUnticketed).toBe(false);
    expect(issueNames({ ...prod, API_URL: 'https://api' })).toEqual(['INTERNAL_HMAC_SECRET']);
    expect(
      loadConfig({
        ...prod,
        API_URL: 'https://api/',
        INTERNAL_HMAC_SECRET: TEST_SECRETS.INTERNAL_HMAC_SECRET,
        RESULTS_OUTBOX_DIR: '/var/lib/tumble/outbox',
      }).results,
    ).toMatchObject({ apiUrl: 'https://api', outboxDir: '/var/lib/tumble/outbox' });
  });

  it('links to the matchmaker only with a URL, and then requires the server secret', () => {
    expect(loadConfig(testEnv()).link).toBeNull();
    expect(loadConfig(testEnv({ MATCHMAKER_URL: 'http://mm', SERVER_ID: 'gs-1' })).link).toMatchObject({
      serverId: 'gs-1',
      publicUrl: 'ws://localhost:7350/ws',
      region: 'na',
    });
    expect(issueNames(testEnv({ MATCHMAKER_URL: 'http://mm', GAME_SERVER_SECRET: undefined }))).toEqual([
      'GAME_SERVER_SECRET',
    ]);
    expect(issueNames(testEnv({ MATCHMAKER_URL: 'http://mm', PUBLIC_WS_URL: 'http://gs' }))).toEqual([
      'PUBLIC_WS_URL',
    ]);
  });

  it('locks HTTP exposure down in production', () => {
    expect(loadConfig(testEnv()).exposure).toEqual({
      debug: true,
      allowedOrigins: true,
      metricsToken: undefined,
      internalPort: undefined,
      internalHost: undefined,
      trustProxy: false,
      helloTimeoutMs: 5000,
      maxPendingPerIp: 8,
    });
    const prod = loadConfig(
      testEnv({ NODE_ENV: 'production', PUBLIC_WEB_URL: 'https://play.example/', ALLOW_UNTICKETED: '0' }),
    ).exposure;
    expect(prod).toMatchObject({ debug: false, allowedOrigins: ['https://play.example'] });
    const custom = loadConfig(
      testEnv({
        ALLOWED_ORIGINS: 'https://a.example/, https://b.example',
        METRICS_TOKEN: 'metrics-token-0123456789',
        INTERNAL_PORT: '9350',
        INTERNAL_HOST: '10.0.0.4',
        TRUST_PROXY: '10.0.0.0/8',
      }),
    ).exposure;
    expect(custom).toMatchObject({
      allowedOrigins: ['https://a.example', 'https://b.example'],
      metricsToken: 'metrics-token-0123456789',
      internalPort: 9350,
      internalHost: '10.0.0.4',
      trustProxy: ['10.0.0.0/8'],
    });
  });

  it('refuses unsafe exposure settings', () => {
    expect(issueNames(testEnv({ INTERNAL_PORT: '7350' }))).toEqual(['INTERNAL_PORT']);
    expect(issueNames(testEnv({ METRICS_TOKEN: 'short' }))).toEqual(['METRICS_TOKEN']);
    expect(issueNames(testEnv({ METRICS_TOKEN: 'change-me-please-0123' }))).toEqual(['METRICS_TOKEN']);
    expect(issueNames(testEnv({ TRUST_PROXY: 'true' }))).toEqual(['TRUST_PROXY']);
    expect(issueNames(testEnv({ HELLO_TIMEOUT_MS: '100' }))).toEqual(['HELLO_TIMEOUT_MS']);
  });
});

describe('deploy/.env from pnpm setup:env --production', () => {
  it('boots the game server in production behind the edge proxy', () => {
    const example = parseEnv(readFileSync(new URL('../../../deploy/.env.example', import.meta.url), 'utf8'));
    const env = Object.fromEntries(
      Object.entries(example).map(([k, v]) => [
        k,
        v === 'change-me' ? randomBytes(32).toString('base64url') : v,
      ]),
    );
    const c = loadConfig(env);
    expect(c).toMatchObject({
      env: 'production',
      allowUnticketed: false,
      results: { apiUrl: 'http://api:7360' },
      link: {
        matchmakerUrl: 'http://matchmaker:7370',
        serverId: 'gs-1',
        publicUrl: 'wss://example.com/gs/ws',
        region: 'na',
        controlUrl: 'http://game-server:7350',
      },
      exposure: { allowedOrigins: ['https://example.com'], debug: false },
    });
  });
});

describe('deploy/game-server/.env.example', () => {
  it('boots a standalone game server once its secrets are filled in', () => {
    const example = parseEnv(
      readFileSync(new URL('../../../deploy/game-server/.env.example', import.meta.url), 'utf8'),
    );
    const env = Object.fromEntries(
      Object.entries(example).map(([k, v]) => [
        k,
        v === 'change-me' ? randomBytes(32).toString('base64url') : v,
      ]),
    );
    expect(loadConfig(env)).toMatchObject({
      env: 'production',
      allowUnticketed: false,
      results: { apiUrl: 'https://example.com/api' },
      link: {
        matchmakerUrl: 'https://example.com/mm',
        serverId: 'gs-eu-1',
        publicUrl: 'wss://gs-eu.example.com/ws',
        region: 'eu',
      },
      exposure: { allowedOrigins: ['https://example.com'], debug: false, trustProxy: 1 },
    });
  });
});
