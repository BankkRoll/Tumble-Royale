/**
 * Redis-backed {@link KV}. Uses a second connection for subscriptions because a
 * Redis connection in subscriber mode cannot issue regular commands.
 */
import { Redis } from 'ioredis';
import type { KV, MessageHandler, ScoredMember } from './types.ts';

const INCR_WITH_TTL = `local n = redis.call('incr', KEYS[1]) if redis.call('pttl', KEYS[1]) < 0 then redis.call('pexpire', KEYS[1], ARGV[1]) end return n`;
// Compare-and-delete / compare-and-expire in one server-side step: a GET then
// a DEL from Node could delete a lock another instance took in between.
const DEL_IF_EQUALS = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXPIRE_IF_EQUALS = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

/** ioredis implementation of {@link KV}. */
export class RedisKV implements KV {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  /** SUBSCRIBE commands not acknowledged yet, so concurrent subscribers to one channel all wait for it. */
  private readonly subscribing = new Map<string, Promise<unknown>>();

  /**
   * @param url - `redis://` connection string.
   * @param prefix - Namespace for keys and pub/sub channels, so several
   *   environments can share one Redis without reading each other's state or
   *   receiving each other's events.
   */
  constructor(
    url: string,
    private readonly prefix = 'tumble:',
  ) {
    this.cmd = new Redis(url, { keyPrefix: prefix, lazyConnect: false, maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { lazyConnect: false });
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
    return Number(await this.cmd.eval(DEL_IF_EQUALS, 1, key, value)) === 1;
  }

  async expireIfEquals(key: string, value: string, ttlMs: number): Promise<boolean> {
    return Number(await this.cmd.eval(EXPIRE_IF_EQUALS, 1, key, value, String(ttlMs))) === 1;
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.cmd.del(...keys);
  }

  async getDel(key: string): Promise<string | null> {
    return this.cmd.getdel(key);
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    if (!ttlMs) return this.cmd.incr(key);
    // One step: a failure between INCR and PEXPIRE would leave a counter that never
    // expires, which for a rate-limit bucket means a client blocked for good.
    return Number(await this.cmd.eval(INCR_WITH_TTL, 1, key, String(ttlMs)));
  }

  /** Round trip to Redis (health checks); rejects when it does not answer. */
  async ping(): Promise<void> {
    await this.cmd.ping();
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.cmd.zadd(key, score, member);
  }

  async zincrby(key: string, delta: number, member: string): Promise<number> {
    return Number(await this.cmd.zincrby(key, delta, member));
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.cmd.zrem(key, member);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const s = await this.cmd.zscore(key, member);
    return s === null ? null : Number(s);
  }

  async zrevrank(key: string, member: string): Promise<number | null> {
    return this.cmd.zrevrank(key, member);
  }

  async zrevrange(key: string, start: number, stop: number): Promise<ScoredMember[]> {
    const flat = await this.cmd.zrevrange(key, start, stop, 'WITHSCORES');
    const out: ScoredMember[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: flat[i]!, score: Number(flat[i + 1]) });
    return out;
  }

  async zcard(key: string): Promise<number> {
    return this.cmd.zcard(key);
  }

  // NOTE: ioredis applies keyPrefix to keys only, never to pub/sub channels; they are prefixed here.
  async publish(channel: string, message: string): Promise<void> {
    await this.cmd.publish(this.prefix + channel, message);
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    const name = this.prefix + channel;
    let set = this.handlers.get(name);
    if (!set) {
      const created = new Set<MessageHandler>();
      set = created;
      this.handlers.set(name, created);
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
