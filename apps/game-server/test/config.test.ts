import { describe, expect, it } from 'vitest';
import { EnvConfigError } from '@tumble/shared/env';
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

describe('game server config', () => {
  it('has working defaults for everything but secrets', () => {
    const c = loadConfig(testEnv());
    expect(c).toMatchObject({
      env: 'test',
      port: 7350,
      fillWaitMs: 25_000,
      startAtHumans: 40,
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
    expect(loadConfig(testEnv()).capacity).toEqual({ roomCapacity: 40, maxRooms: 10, serverCapacity: 400 });
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
});
