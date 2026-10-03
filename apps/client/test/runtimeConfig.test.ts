import { describe, expect, it, vi } from 'vitest';
import type { Endpoints } from '../src/devTools.ts';
import { loadRuntimeConfig, parseRuntimeConfig } from '../src/runtimeConfig.ts';

const ORIGIN = 'https://play.example.com';

const endpoints = (): Endpoints => ({
  api: 'https://built.example.com/api',
  matchmaker: 'https://built.example.com/mm',
  gameServer: null,
});

const respond = (body: string, init: { status?: number; type?: string } = {}) =>
  vi.fn(async () =>
    Promise.resolve(
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': init.type ?? 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;

describe('parseRuntimeConfig', () => {
  it('resolves relative paths against the page origin', () => {
    const { config, warnings } = parseRuntimeConfig(
      { apiUrl: '/api', matchmakerUrl: '/mm/', gameServerUrl: '/gs/ws' },
      ORIGIN,
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      apiUrl: 'https://play.example.com/api',
      matchmakerUrl: 'https://play.example.com/mm',
      gameServerUrl: 'wss://play.example.com/gs/ws',
    });
  });

  it('maps a relative WebSocket path to ws: on plain http', () => {
    expect(parseRuntimeConfig({ gameServerUrl: '/gs/ws' }, 'http://localhost:8080').config).toEqual({
      gameServerUrl: 'ws://localhost:8080/gs/ws',
    });
  });

  it('keeps absolute cross-origin URLs', () => {
    expect(
      parseRuntimeConfig(
        { apiUrl: 'https://api.example.net', gameServerUrl: 'wss://gs-1.example.net/ws' },
        ORIGIN,
      ).config,
    ).toEqual({ apiUrl: 'https://api.example.net', gameServerUrl: 'wss://gs-1.example.net/ws' });
  });

  it('skips each invalid field with a warning and keeps the valid ones', () => {
    const { config, warnings } = parseRuntimeConfig(
      {
        apiUrl: 'javascript:alert(1)',
        matchmakerUrl: 42,
        gameServerUrl: 'ftp://x',
        reportErrors: 'yes',
        sentryDsn: 'https://sentry.example.com/1',
      },
      ORIGIN,
    );
    expect(config).toEqual({});
    expect(warnings).toHaveLength(5);
  });

  it('rejects non-objects', () => {
    for (const raw of [null, [], 'x', 3]) {
      const r = parseRuntimeConfig(raw, ORIGIN);
      expect(r.config).toEqual({});
      expect(r.warnings).toHaveLength(1);
    }
  });

  it('accepts reportErrors and a DSN with a key', () => {
    expect(
      parseRuntimeConfig({ reportErrors: false, sentryDsn: 'https://k@sentry.example.com/7' }, ORIGIN).config,
    ).toEqual({ reportErrors: false, sentryDsn: 'https://k@sentry.example.com/7' });
  });
});

describe('loadRuntimeConfig', () => {
  it('applies endpoints from config.json', async () => {
    const target = endpoints();
    const cfg = await loadRuntimeConfig({
      fetch: respond(JSON.stringify({ apiUrl: '/api', gameServerUrl: '/gs/ws' })),
      origin: ORIGIN,
      endpoints: target,
    });
    expect(cfg.apiUrl).toBe('https://play.example.com/api');
    expect(target).toEqual({
      api: 'https://play.example.com/api',
      matchmaker: 'https://built.example.com/mm',
      gameServer: 'wss://play.example.com/gs/ws',
    });
  });

  it('keeps the defaults when the file is missing', async () => {
    const target = endpoints();
    expect(
      await loadRuntimeConfig({ fetch: respond('', { status: 404 }), origin: ORIGIN, endpoints: target }),
    ).toEqual({});
    expect(target).toEqual(endpoints());
  });

  it('ignores an SPA fallback page served for the path', async () => {
    const target = endpoints();
    await loadRuntimeConfig({
      fetch: respond('<!doctype html>', { type: 'text/html' }),
      origin: ORIGIN,
      endpoints: target,
    });
    expect(target).toEqual(endpoints());
  });

  it('survives invalid JSON and network errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = endpoints();
    await loadRuntimeConfig({ fetch: respond('{not json'), origin: ORIGIN, endpoints: target });
    const failing = vi.fn(() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
    await loadRuntimeConfig({ fetch: failing, origin: ORIGIN, endpoints: target });
    expect(target).toEqual(endpoints());
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
