/**
 * KV factory: Redis when configured, otherwise the in-process implementation.
 */
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/errors.ts';
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

/** Lifetime of a {@link withLock} lock between renewals. */
export const LOCK_TTL_MS = 5000;

/**
 * Runs `fn` while holding a short distributed lock, retrying briefly when contended.
 * Guards read-modify-write sequences on JSON blobs (parties) across API instances.
 *
 * The lock is renewed every third of its TTL while `fn` runs, so a slow
 * critical section (database latency, a GC pause) cannot outlive it and let
 * a second instance in; a crashed holder's lock still lapses after the TTL.
 * Only the holder releases it (compare-and-delete).
 *
 * @param kv - Store that hosts the lock key.
 * @param key - Lock name.
 * @param fn - Critical section.
 * @returns Whatever `fn` returns.
 * @throws {ApiError} 503 `busy` when the lock cannot be acquired within ~2 s.
 * @example
 * await withLock(ctx.kv, `party:${id}`, async () => save(update(await load(id))));
 */
export async function withLock<T>(kv: KV, key: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const lock = `lock:${key}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await kv.setNX(lock, token, LOCK_TTL_MS)) {
      const renew = setInterval(
        () => void kv.expireIfEquals(lock, token, LOCK_TTL_MS).catch(() => undefined),
        Math.floor(LOCK_TTL_MS / 3),
      );
      renew.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(renew);
        await kv.delIfEquals(lock, token);
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new ApiError(503, 'busy', 'Someone else is changing this right now; try again in a moment');
}
