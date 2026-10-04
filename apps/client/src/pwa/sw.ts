/**
 * The game's service worker, bundled to `sw.js` by the PWA build plugin
 * (`vite-pwa.ts`) with this build's file list and version baked in.
 *
 * Responsibilities:
 * - install: precache the app shell and every game asset, so a show against
 *   bots runs with no network at all;
 * - activate: delete older versions' caches; the very first install takes
 *   control at once, later versions wait until the player restarts (the page
 *   asks with `SKIP_WAITING`, never during a show);
 * - fetch: route by `swRules.ts`; anything not ours goes untouched to the network.
 */
import {
  CONFIG_CACHE,
  SHELL_TIMEOUT_MS,
  cacheableConfig,
  precacheName,
  preferNetworkPage,
  routeRequest,
  staleCaches,
  type RouteContext,
} from './swRules.ts';

declare const __SW_VERSION__: string;
declare const __SW_PRECACHE__: string[];

// COMPAT: the client tsconfig uses the DOM lib, which lacks the worker event types; these are the parts used here.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface MessageEventLike extends ExtendableEvent {
  readonly data: unknown;
}
interface WorkerScope {
  readonly registration: ServiceWorkerRegistration;
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', fn: (e: MessageEventLike) => void): void;
}

const sw = self as unknown as WorkerScope;
const VERSION = __SW_VERSION__;
const CACHE = precacheName(VERSION);
const base = new URL(sw.registration.scope).pathname;
const ctx: RouteContext = {
  origin: sw.location.origin,
  base,
  precached: new Set(__SW_PRECACHE__),
};
const abs = (rel: string): string => new URL(rel, sw.registration.scope).href;

sw.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // NOTE: `reload` skips the HTTP cache so a half-deployed CDN edge can't seed this version with old files.
      await cache.addAll(__SW_PRECACHE__.map((rel) => new Request(abs(rel), { cache: 'reload' })));
      // First install: nothing to disrupt, so take over now and make the very next offline launch work.
      if (!sw.registration.active) await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(staleCaches(keys, VERSION).map((k) => caches.delete(k)));
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (e) => {
  const data = e.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  const route = routeRequest(
    { url: req.url, method: req.method, mode: req.mode, authorized: req.headers.has('authorization') },
    ctx,
  );
  switch (route.kind) {
    case 'passthrough':
      return;
    case 'precache':
      e.respondWith(fromPrecache(req, route.key));
      return;
    case 'config':
      e.respondWith(config(req));
      return;
    case 'shell':
      e.respondWith(shell(req));
      return;
  }
});

async function fromPrecache(req: Request, key: string): Promise<Response> {
  const hit = await caches.match(abs(key), { cacheName: CACHE });
  return hit ?? fetch(req);
}

/** Network first so a changed endpoint applies at once; the last good copy only offline. */
async function config(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    if (cacheableConfig(res.status, res.headers.get('content-type'))) {
      const cache = await caches.open(CONFIG_CACHE);
      await cache.put(abs('config.json'), res.clone());
    }
    return res;
  } catch (err) {
    const hit = await caches.match(abs('config.json'), { cacheName: CONFIG_CACHE });
    if (hit) return hit;
    throw err;
  }
}

/**
 * Page loads: the network's page when it answers in time (a new deploy shows
 * at once), else this version's own precached `index.html`, which matches the
 * precached assets exactly.
 */
async function shell(req: Request): Promise<Response> {
  const cached = (): Promise<Response | undefined> => caches.match(abs('index.html'), { cacheName: CACHE });
  const network = fetch(req);
  // The timeout path may never await it; a late failure must not surface as an unhandled rejection.
  network.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SHELL_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first === 'timeout') {
      const hit = await cached();
      return hit ?? (await network);
    }
    if (preferNetworkPage(first.status, first.type)) return first;
    return (await cached()) ?? first;
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
