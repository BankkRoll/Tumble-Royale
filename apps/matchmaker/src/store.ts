/**
 * Storage for queue entries, game servers, custom lobbies and pub/sub.
 * Redis when `REDIS_URL` is set (several matchmaker instances share state and
 * one holds the tick lock at a time); an in-process map otherwise.
 */
import { Redis } from 'ioredis';

/** Pub/sub handler. */
export type Handler = (message: string) => void;

/** Minimal KV + hash + pub/sub contract. TTLs in milliseconds. */
export interface MMStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
  /**
   * Deletes `key` only while it still holds `value`: releases a lock this
   * caller owns, never one another holder took after it expired.
   *
   * @returns True when the key was deleted.
   */
  delIfEquals(key: string, value: string): Promise<boolean>;
  /**
   * Resets the TTL of `key` only while it still holds `value` (lock renewal).
   *
   * @returns True when the caller still owns the key.
   */
  expireIfEquals(key: string, value: string, ttlMs: number): Promise<boolean>;
  /**
   * Increments a fixed-window counter, starting the window (TTL `windowMs`)
   * on the first hit.
   *
   * @returns The count after this hit and the milliseconds left in the window.
   */
  hitWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  del(key: string): Promise<void>;
  /**
   * Resets the TTL of an existing key.
   *
   * @returns False when the key does not exist.
   */
  expire(key: string, ttlMs: number): Promise<boolean>;
  hset(hash: string, field: string, value: string): Promise<void>;
  /**
   * Removes one hash field.
   *
   * @returns True when this call removed it. Of two concurrent callers exactly
   *   one sees true, so it doubles as an atomic claim.
   */
  hdel(hash: string, field: string): Promise<boolean>;
  hgetall(hash: string): Promise<Record<string, string>>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: Handler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** In-process store (single instance, dev and tests). */
export class MemoryStore implements MMStore {
  private readonly kv = new Map<string, { v: string; exp: number }>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly channels = new Map<string, Set<Handler>>();

  /** @param now - Clock in ms, injectable for TTL tests. */
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  // NOTE: the conditional operations below read and write without an await in
  // between. An await would let a concurrent caller interleave, and two
  // setNX calls could then both take the same lock (Redis runs them atomically).
  private read(key: string): string | null {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp <= this.now()) {
      this.kv.delete(key);
      return null;
    }
    return e.v;
  }

  private write(key: string, value: string, ttlMs?: number): void {
    this.kv.set(key, { v: value, exp: ttlMs ? this.now() + ttlMs : Number.POSITIVE_INFINITY });
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.write(key, value, ttlMs);
  }

  async setNX(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.read(key) !== null) return false;
    this.write(key, value, ttlMs);
    return true;
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    if (this.read(key) !== value) return false;
    this.kv.delete(key);
    return true;
  }

  async expireIfEquals(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.read(key) !== value) return false;
    this.write(key, value, ttlMs);
    return true;
  }

  async hitWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const now = this.now();
    const e = this.kv.get(key);
    if (!e || e.exp <= now) {
      this.kv.set(key, { v: '1', exp: now + windowMs });
      return { count: 1, ttlMs: windowMs };
    }
    e.v = String(Number(e.v) + 1);
    return { count: Number(e.v), ttlMs: e.exp - now };
  }

  async del(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    const v = this.read(key);
    if (v === null) return false;
    this.write(key, v, ttlMs);
    return true;
  }

  async hset(hash: string, field: string, value: string): Promise<void> {
    let h = this.hashes.get(hash);
    if (!h) {
      h = new Map();
      this.hashes.set(hash, h);
    }
    h.set(field, value);
  }

  async hdel(hash: string, field: string): Promise<boolean> {
    return this.hashes.get(hash)?.delete(field) ?? false;
  }

  async hgetall(hash: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(hash) ?? []);
  }

  async publish(channel: string, message: string): Promise<void> {
    for (const h of [...(this.channels.get(channel) ?? [])]) h(message);
  }

  async subscribe(channel: string, handler: Handler): Promise<() => Promise<void>> {
    const set = this.channels.get(channel) ?? new Set<Handler>();
    this.channels.set(channel, set);
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.kv.clear();
    this.hashes.clear();
    this.channels.clear();
  }
}

// Compare-and-delete / compare-and-expire must run as one server-side step: a
// GET followed by a DEL from Node could delete a lock another instance took in between.
const DEL_IF_EQUALS = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXPIRE_IF_EQUALS = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

// INCR and PEXPIRE in one step: a crash between them would leave a counter
// without a TTL that blocks the key forever.
const HIT_WINDOW = `local n = redis.call('incr', KEYS[1]) local t = redis.call('pttl', KEYS[1]) if t < 0 then redis.call('pexpire', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end return {n, t}`;

/** Redis-backed store. */
export class RedisStore implements MMStore {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<Handler>>();
  /** SUBSCRIBE commands not acknowledged yet, so concurrent subscribers to one channel all wait for it. */
  private readonly subscribing = new Map<string, Promise<unknown>>();

  /**
   * @param url - `redis://` connection string.
   * @param prefix - Namespace for keys and pub/sub channels, so environments
   *   sharing one Redis neither read each other's state nor receive each
   *   other's events.
   */
  constructor(
    url: string,
    private readonly prefix = 'tumble:mm:',
  ) {
    this.cmd = new Redis(url, { keyPrefix: prefix, maxRetriesPerRequest: 3 });
    this.sub = new Redis(url);
    this.sub.on('message', (channel: string, message: string) => {
      for (const h of [...(this.handlers.get(channel) ?? [])]) h(message);
    });
  }

  async get(key: string): Promise<string | null> {
    return this.cmd.get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs) await this.cmd.set(key, value, 'PX', ttlMs);
    else await this.cmd.set(key, value);
  }

  async setNX(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.cmd.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    return (await this.cmd.eval(DEL_IF_EQUALS, 1, key, value)) === 1;
  }

  async expireIfEquals(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.cmd.eval(EXPIRE_IF_EQUALS, 1, key, value, String(ttlMs))) === 1;
  }

  async hitWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const [count, ttl] = (await this.cmd.eval(HIT_WINDOW, 1, key, String(windowMs))) as [number, number];
    return { count, ttlMs: ttl > 0 ? ttl : windowMs };
  }

  async del(key: string): Promise<void> {
    await this.cmd.del(key);
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    return (await this.cmd.pexpire(key, ttlMs)) === 1;
  }

  async hset(hash: string, field: string, value: string): Promise<void> {
    await this.cmd.hset(hash, field, value);
  }

  async hdel(hash: string, field: string): Promise<boolean> {
    return (await this.cmd.hdel(hash, field)) > 0;
  }

  async hgetall(hash: string): Promise<Record<string, string>> {
    return this.cmd.hgetall(hash);
  }

  // NOTE: ioredis applies keyPrefix to keys only, never to pub/sub channels; they are prefixed here.
  async publish(channel: string, message: string): Promise<void> {
    await this.cmd.publish(this.prefix + channel, message);
  }

  async subscribe(channel: string, handler: Handler): Promise<() => Promise<void>> {
    const name = this.prefix + channel;
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
      const created = set;
      const pending = this.sub
        .subscribe(name)
        .catch((err: unknown) => {
          // Not subscribed after all: the next caller must try again rather than wait on a dead entry.
          if (this.handlers.get(name) === created) this.handlers.delete(name);
          throw err;
        })
        .finally(() => this.subscribing.delete(name));
      this.subscribing.set(name, pending);
    }
    const handlers = set;
    handlers.add(handler);
    await this.subscribing.get(name);
    return async () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.handlers.get(name) === handlers) {
        this.handlers.delete(name);
        await this.sub.unsubscribe(name);
      }
    };
  }

  async close(): Promise<void> {
    this.cmd.disconnect();
    this.sub.disconnect();
  }
}

/** Creates the store for this process. */
export function createStore(redisUrl: string | undefined, now?: () => number): MMStore {
  return redisUrl ? new RedisStore(redisUrl) : new MemoryStore(now);
}
