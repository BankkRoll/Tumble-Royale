/**
 * KV factory: Redis when configured, otherwise the in-process implementation.
 */
import { randomUUID } from 'node:crypto';
import { MemoryKV } from './memory.ts';
import { RedisKV } from './redis.ts';
import type { KV } from './types.ts';

export type { KV, ScoredMember, MessageHandler } from './types.ts';
export { MemoryKV } from './memory.ts';

/**
 * Creates the KV store for this process.
 *
 * @param redisUrl - Redis URL, or undefined for the in-memory adapter.
 * @param now - Clock (ms) for the in-memory adapter's TTLs.
 */
export function createKV(redisUrl: string | undefined, now?: () => number): KV {
  return redisUrl ? new RedisKV(redisUrl) : new MemoryKV(now);
}

/**
 * Runs `fn` while holding a short distributed lock, retrying briefly when contended.
 * Guards read-modify-write sequences on JSON blobs (parties) across API instances.
 *
 * @param kv - Store that hosts the lock key.
 * @param key - Lock name.
 * @param fn - Critical section.
 * @returns Whatever `fn` returns.
 * @throws When the lock cannot be acquired within ~2 s.
 */
export async function withLock<T>(kv: KV, key: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await kv.setNX(`lock:${key}`, token, 5000)) {
      try {
        return await fn();
      } finally {
        if ((await kv.get(`lock:${key}`)) === token) await kv.del(`lock:${key}`);
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`lock ${key} busy`);
}
