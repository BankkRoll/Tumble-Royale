/**
 * ApiClient session lifecycle against a fake `/auth/*`: a launch never mints a
 * guest over a linked account, transient failures keep the session, a refused
 * session without a device token is marked expired, and a refresh follows
 * another tab's rotation and never overwrites a session switched meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/game/api.ts';

const store = new Map<string, string>();
const fakeWindow = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  addEventListener: () => undefined,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};

const KEY = 'tumble.v1.auth';

/** An unsigned JWT-shaped token with `exp` seconds from now. */
function jwt(sub: string, expInSec: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + expInSec })}.x`;
}

function stored(): Record<string, unknown> | null {
  const raw = store.get(KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** A client already probed online, holding `tokens`. */
function clientWith(tokens: { accessToken: string; refreshToken: string; deviceToken: string }) {
  store.set(KEY, JSON.stringify(tokens));
  const api = new ApiClient('https://api.test');
  api.online = true;
  return api;
}

let calls: { url: string; body: unknown }[] = [];
function serve(handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url, body });
      return handler(url, body);
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('window', fakeWindow);
  store.clear();
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resume', () => {
  const linked = { accessToken: jwt('u1', -10), refreshToken: 'r1-xxxxxxxxxxxxxxxxxxxx', deviceToken: '' };

  it('keeps a linked session through a server error, a rate limit or a network failure', async () => {
    for (const failure of [
      () => new Response('down', { status: 503 }),
      () => new Response('slow down', { status: 429 }),
      () => Promise.reject(new TypeError('offline')),
    ]) {
      store.clear();
      calls = [];
      serve(failure);
      const api = clientWith(linked);
      expect(await api.resume('Pal')).toBe(false);
      expect(api.expired).toBe(false);
      expect(stored()).toMatchObject({ refreshToken: 'r1-xxxxxxxxxxxxxxxxxxxx' });
      expect(calls.some((c) => c.url.endsWith('/auth/guest'))).toBe(false);
    }
  });

  it('marks a refused linked session expired instead of minting a guest over it', async () => {
    serve(() => Response.json({ error: 'refresh_reused' }, { status: 401 }));
    const api = clientWith(linked);
    const expired = vi.fn();
    api.onExpired(expired);
    expect(await api.resume('Pal')).toBe(false);
    expect(expired).toHaveBeenCalledOnce();
    expect(api.expired).toBe(true);
    expect(api.signedIn).toBe(true);
    expect(stored()).toMatchObject({ expired: true });
    expect(calls.some((c) => c.url.endsWith('/auth/guest'))).toBe(false);
    // Later launches do not retry or replace it either.
    calls = [];
    expect(await api.resume('Pal')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await api.accessToken()).toBeNull();
  });

  it('falls back to the device sign-in only when the server refused and a device token exists', async () => {
    serve((url) =>
      url.endsWith('/auth/refresh')
        ? Response.json({ error: 'invalid_refresh' }, { status: 401 })
        : Response.json({
            accessToken: jwt('u1', 900),
            refreshToken: 'r2-xxxxxxxxxxxxxxxxxxxx',
            deviceToken: 'd1',
          }),
    );
    const api = clientWith({ ...linked, deviceToken: 'd1' });
    expect(await api.resume('Pal')).toBe(true);
    const guest = calls.find((c) => c.url.endsWith('/auth/guest'));
    expect(guest?.body).toMatchObject({ deviceToken: 'd1' });
  });
});

describe('refresh across tabs', () => {
  it('adopts the session another tab already rotated instead of presenting a stale token', async () => {
    serve(() => new Response('should not be called', { status: 500 }));
    const api = clientWith({
      accessToken: jwt('u1', -10),
      refreshToken: 'old-xxxxxxxxxxxxxxxxxxx',
      deviceToken: 'd',
    });
    // Another tab rotates and stores the result.
    const fresh = { accessToken: jwt('u1', 900), refreshToken: 'new-xxxxxxxxxxxxxxxxxxx', deviceToken: 'd' };
    store.set(KEY, JSON.stringify(fresh));
    expect(await api.accessToken()).toBe(fresh.accessToken);
    expect(calls).toHaveLength(0);
  });

  it('never writes an old session over one the device switched to while the refresh was out', async () => {
    let release: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((r) => (release = r)));
    const api = clientWith({
      accessToken: jwt('u1', -10),
      refreshToken: 'a-xxxxxxxxxxxxxxxxxxxxx',
      deviceToken: 'd',
    });
    const pending = api.accessToken();
    await new Promise((r) => setTimeout(r, 0));
    api.adoptSession({ accessToken: jwt('u2', 900), refreshToken: 'b-xxxxxxxxxxxxxxxxxxxxx' }, false);
    release(Response.json({ accessToken: jwt('u1', 900), refreshToken: 'c-xxxxxxxxxxxxxxxxxxxxx' }));
    await pending;
    expect(api.currentUserId()).toBe('u2');
    expect(stored()).toMatchObject({ refreshToken: 'b-xxxxxxxxxxxxxxxxxxxxx' });
  });
});
