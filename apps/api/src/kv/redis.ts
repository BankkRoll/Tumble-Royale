/**
 * Redis-backed {@link KV}. Uses a second connection for subscriptions because a
 * Redis connection in subscriber mode cannot issue regular commands.
 */
import { Redis } from 'ioredis';
import type { KV, MessageHandler, ScoredMember } from './types.ts';

/** ioredis implementation of {@link KV}. */
export class RedisKV implements KV {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<MessageHandler>>();

  /**
   * @param url - `redis://` connection string.
   * @param prefix - Key prefix so several environments can share one Redis.
   */
  constructor(url: string, prefix = 'tumble:') {
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

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.cmd.del(...keys);
  }

  async getDel(key: string): Promise<string | null> {
    return this.cmd.getdel(key);
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const n = await this.cmd.incr(key);
    if (n === 1 && ttlMs) await this.cmd.pexpire(key, ttlMs);
    return n;
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

  async publish(channel: string, message: string): Promise<void> {
    await this.cmd.publish(channel, message);
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) {
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
