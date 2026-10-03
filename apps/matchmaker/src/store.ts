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
  del(key: string): Promise<void>;
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
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp <= this.now()) {
      this.kv.delete(key);
      return null;
    }
    return e.v;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.kv.set(key, { v: value, exp: ttlMs ? this.now() + ttlMs : Number.POSITIVE_INFINITY });
  }

  async setNX(key: string, value: string, ttlMs: number): Promise<boolean> {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    if ((await this.get(key)) !== value) return false;
    this.kv.delete(key);
    return true;
  }

  async expireIfEquals(key: string, value: string, ttlMs: number): Promise<boolean> {
    if ((await this.get(key)) !== value) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async del(key: string): Promise<void> {
    this.kv.delete(key);
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

/** Redis-backed store. */
export class RedisStore implements MMStore {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(url: string, prefix = 'tumble:mm:') {
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

  async del(key: string): Promise<void> {
    await this.cmd.del(key);
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

  async publish(channel: string, message: string): Promise<void> {
    await this.cmd.publish(channel, message);
  }

  async subscribe(channel: string, handler: Handler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    const handlers = set;
    handlers.add(handler);
    return async () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
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
