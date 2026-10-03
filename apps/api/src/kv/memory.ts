/**
 * In-process {@link KV} used when `REDIS_URL` is unset. Single-node only: state
 * vanishes on restart and is not shared between processes.
 */
import type { KV, MessageHandler, ScoredMember } from './types.ts';

interface Entry {
  value: string;
  expiresAt: number;
}

/** Map-backed KV with lazy TTL expiry and synchronous pub/sub fan-out. */
export class MemoryKV implements KV {
  private readonly values = new Map<string, Entry>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly channels = new Map<string, Set<MessageHandler>>();

  /** @param now - Clock in ms; injectable so tests can advance time. */
  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): Entry | undefined {
    const e = this.values.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.values.set(key, { value, expiresAt: ttlMs ? this.now() + ttlMs : Number.POSITIVE_INFINITY });
  }

  async setNX(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.values.delete(k);
      this.zsets.delete(k);
    }
  }

  async getDel(key: string): Promise<string | null> {
    const v = this.live(key)?.value ?? null;
    this.values.delete(key);
    return v;
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const e = this.live(key);
    const next = (e ? Number(e.value) : 0) + 1;
    this.values.set(key, {
      value: String(next),
      expiresAt: e ? e.expiresAt : ttlMs ? this.now() + ttlMs : Number.POSITIVE_INFINITY,
    });
    return next;
  }

  private zset(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    return z;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    this.zset(key).set(member, score);
  }

  async zincrby(key: string, delta: number, member: string): Promise<number> {
    const z = this.zset(key);
    const next = (z.get(member) ?? 0) + delta;
    z.set(member, next);
    return next;
  }

  async zrem(key: string, member: string): Promise<void> {
    this.zsets.get(key)?.delete(member);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return this.zsets.get(key)?.get(member) ?? null;
  }

  // Redis orders equal scores lexicographically; ZREVRANGE reverses that too.
  private sorted(key: string): ScoredMember[] {
    const z = this.zsets.get(key);
    if (!z) return [];
    return [...z.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0));
  }

  async zrevrank(key: string, member: string): Promise<number | null> {
    const i = this.sorted(key).findIndex((m) => m.member === member);
    return i < 0 ? null : i;
  }

  async zrevrange(key: string, start: number, stop: number): Promise<ScoredMember[]> {
    const all = this.sorted(key);
    const end = stop < 0 ? all.length + stop : stop;
    return all.slice(start, end + 1);
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async publish(channel: string, message: string): Promise<void> {
    for (const h of [...(this.channels.get(channel) ?? [])]) h(message);
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.values.clear();
    this.zsets.clear();
    this.channels.clear();
  }
}
