import { describe, expect, it } from 'vitest';
import {
  CONFIG_CACHE,
  cacheableConfig,
  isShellPath,
  precacheName,
  preferNetworkPage,
  routeRequest,
  shouldPrecache,
  staleCaches,
  type RouteContext,
} from '../src/pwa/swRules.ts';

const ctx: RouteContext = {
  origin: 'https://play.example.com',
  base: '/',
  precached: new Set(['index.html', 'assets/index-abc123.js', 'assets/rapier-x.js', 'news/season.jpg']),
};
const get = (path: string, mode = 'cors', extra: Partial<{ method: string; authorized: boolean }> = {}) =>
  routeRequest({ url: `https://play.example.com${path}`, method: 'GET', mode, ...extra }, ctx);

describe('routeRequest', () => {
  it('serves precached build files from the cache', () => {
    expect(get('/assets/index-abc123.js', 'no-cors')).toEqual({
      kind: 'precache',
      key: 'assets/index-abc123.js',
    });
    expect(get('/news/season.jpg')).toEqual({ kind: 'precache', key: 'news/season.jpg' });
  });

  it('never touches the account API, matchmaker or game server, on any path', () => {
    for (const p of ['/api/me', '/api/auth/discord/callback?code=1', '/mm/queue', '/gs/ws', '/mm/stats'])
      expect(get(p).kind).toBe('passthrough');
    // A self-hosted layout can put the API anywhere; unknown paths are never ours.
    expect(get('/backend/v1/profile').kind).toBe('passthrough');
  });

  it('never caches non-GET or authorized requests, even for precached paths', () => {
    expect(get('/assets/index-abc123.js', 'cors', { method: 'POST' }).kind).toBe('passthrough');
    expect(get('/assets/index-abc123.js', 'cors', { authorized: true }).kind).toBe('passthrough');
    expect(get('/config.json', 'cors', { method: 'HEAD' }).kind).toBe('passthrough');
  });

  it('treats config.json as network-first, never as a precached file', () => {
    expect(get('/config.json')).toEqual({ kind: 'config' });
    expect(get('/config.json?x=1')).toEqual({ kind: 'config' });
  });

  it('routes the SPA page routes to the shell and leaves other navigations alone', () => {
    for (const p of [
      '/',
      '/index.html',
      '/join/ABCD',
      '/join/ABCD/',
      '/auth/email?token=x',
      '/auth/discord',
      '/store',
    ])
      expect(get(p, 'navigate').kind, p).toBe('shell');
    // OAuth starts and returns on the API are top-level navigations too; they must reach the server.
    // The admin console is its own page; the worker must never answer it with the game.
    for (const p of [
      '/api/auth/google',
      '/level.html',
      '/join/a/b',
      '/storefront',
      '/config.json',
      '/admin',
      '/admin.html',
      '/editor',
      '/status',
      '/status/',
      '/status.html',
      '/status?ref=banner',
    ])
      expect(get(p, 'navigate').kind, p).toBe('passthrough');
  });

  it('leaves the status page and its data to the network, even when files share its path', () => {
    const withStatus: RouteContext = {
      ...ctx,
      // Even a stale precache that somehow holds the page must not answer it.
      precached: new Set([...ctx.precached, 'status.html', 'assets/status-Ab12Cd.js']),
    };
    const at = (path: string, mode = 'cors') =>
      routeRequest({ url: `https://play.example.com${path}`, method: 'GET', mode }, withStatus).kind;
    expect(at('/status', 'navigate')).toBe('passthrough');
    expect(at('/status.html', 'navigate')).toBe('passthrough');
    expect(at('/status.html')).toBe('passthrough');
    expect(at('/assets/status-Ab12Cd.js', 'no-cors')).toBe('passthrough');
    for (const p of [
      '/api/status/summary',
      '/api/status/history',
      '/api/status/feed.atom',
      '/api/status/feed.json',
    ])
      expect(at(p), p).toBe('passthrough');
    expect(shouldPrecache('status.html')).toBe(false);
    expect(shouldPrecache('assets/status-Ab12Cd.js')).toBe(false);
  });

  it('ignores other origins and paths outside the scope', () => {
    expect(
      routeRequest(
        { url: 'https://cdn.example.com/assets/index-abc123.js', method: 'GET', mode: 'cors' },
        ctx,
      ).kind,
    ).toBe('passthrough');
    const sub: RouteContext = { ...ctx, base: '/game/' };
    expect(
      routeRequest({ url: 'https://play.example.com/index.html', method: 'GET', mode: 'navigate' }, sub).kind,
    ).toBe('passthrough');
    expect(
      routeRequest({ url: 'https://play.example.com/game/join/XY', method: 'GET', mode: 'navigate' }, sub)
        .kind,
    ).toBe('shell');
    expect(
      routeRequest(
        { url: 'https://play.example.com/game/assets/rapier-x.js', method: 'GET', mode: 'cors' },
        sub,
      ),
    ).toEqual({ kind: 'precache', key: 'assets/rapier-x.js' });
  });

  it('does not serve query-string variants of precached files from the cache', () => {
    expect(get('/assets/index-abc123.js?v=2').kind).toBe('passthrough');
  });

  it('passes through malformed URLs and paths', () => {
    expect(routeRequest({ url: 'not a url', method: 'GET', mode: 'cors' }, ctx).kind).toBe('passthrough');
    expect(get('/%E0%A4%A').kind).toBe('passthrough');
  });
});

describe('isShellPath', () => {
  it('matches only the client-routed pages', () => {
    expect(isShellPath('')).toBe(true);
    expect(isShellPath('auth')).toBe(true);
    expect(isShellPath('join/')).toBe(false);
    expect(isShellPath('stores')).toBe(false);
  });
});

describe('shouldPrecache', () => {
  it('keeps the game and drops maps, host files, dev pages and the worker', () => {
    expect(shouldPrecache('index.html')).toBe(true);
    expect(shouldPrecache('assets/rapier-DLPg5AQS.js')).toBe(true);
    expect(shouldPrecache('assets/meta-IQ9rXU7n.css')).toBe(true);
    expect(shouldPrecache('icons/icon-192.png')).toBe(true);
    expect(shouldPrecache('manifest.webmanifest')).toBe(true);
    expect(shouldPrecache('news/rounds/egg-heist.jpg')).toBe(true);
    for (const f of [
      'assets/index.js.map',
      'sw.js',
      'config.json',
      '_redirects',
      'level.html',
      'admin.html',
      'assets/admin-Dkd5BaaA.js',
      'assets/admin-C9yXQ9rg.css',
      'editor.html',
      'assets/editor-Bq3xZ1aa.js',
      'assets/editor-Kp9wQ2bb.css',
      '.well-known/x',
    ])
      expect(shouldPrecache(f), f).toBe(false);
  });
});

describe('cache housekeeping', () => {
  it('deletes only this worker’s older precaches', () => {
    const keys = [
      precacheName('old1'),
      precacheName('new'),
      CONFIG_CACHE,
      'other-app-cache',
      precacheName('old2'),
    ];
    expect(staleCaches(keys, 'new')).toEqual([precacheName('old1'), precacheName('old2')]);
  });

  it('stores config.json only from a real JSON 200', () => {
    expect(cacheableConfig(200, 'application/json; charset=utf-8')).toBe(true);
    expect(cacheableConfig(200, 'text/html')).toBe(false);
    expect(cacheableConfig(404, 'application/json')).toBe(false);
    expect(cacheableConfig(200, null)).toBe(false);
  });

  it('prefers the network page unless the server is down or lacks the SPA rewrite', () => {
    expect(preferNetworkPage(200, 'basic')).toBe(true);
    expect(preferNetworkPage(0, 'opaqueredirect')).toBe(true);
    expect(preferNetworkPage(302, 'basic')).toBe(true);
    expect(preferNetworkPage(404, 'basic')).toBe(false);
    expect(preferNetworkPage(502, 'basic')).toBe(false);
  });
});
