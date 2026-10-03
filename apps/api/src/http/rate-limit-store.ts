/**
 * `@fastify/rate-limit` store on the shared {@link KV}, so every API instance
 * counts against the same window: with per-process counters a client behind a
 * load balancer gets `max × instances`.
 *
 * Fixed windows: the counter key carries the window index, so it needs only
 * an atomic increment with a TTL on creation (`KV.incr`), and the remaining
 * time is known without asking the store.
 */
import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import type { KV } from '../kv/types.ts';

type ChildOptions = Parameters<FastifyRateLimitStore['child']>[0];

/** Route identity for per-route buckets (the plugin passes `routeInfo` at runtime). */
function routeKey(o: ChildOptions): string {
  const info = (o as unknown as { routeInfo?: { method: string; url: string } }).routeInfo;
  return info ? `${info.method}${info.url}` : `${String(o.method)}${o.url}`;
}

/**
 * Builds a store class bound to a KV (the plugin instantiates it itself).
 *
 * @param kv - Shared KV (Redis in production).
 * @param now - Clock in ms.
 * @param prefix - Key namespace.
 * @example
 * await app.register(rateLimit, { store: kvRateLimitStore(ctx.kv, Date.now), skipOnError: true });
 */
export function kvRateLimitStore(kv: KV, now: () => number, prefix = 'rl:'): FastifyRateLimitStoreCtor {
  class KvStore implements FastifyRateLimitStore {
    constructor(
      _options?: unknown,
      private readonly ns = prefix,
    ) {}

    incr(
      key: string,
      cb: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      const t = now();
      const window = Math.floor(t / timeWindow);
      const ttl = (window + 1) * timeWindow - t;
      // The extra second keeps the counter alive across clock skew between instances.
      kv.incr(`${this.ns}${key}:${window}`, ttl + 1000).then(
        (current) => cb(null, { current, ttl }),
        (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
      );
    }

    child(routeOptions: ChildOptions): FastifyRateLimitStore {
      return new KvStore(undefined, `${this.ns}${routeKey(routeOptions)}:`);
    }
  }
  return KvStore;
}
