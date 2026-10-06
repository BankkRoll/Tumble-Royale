/**
 * Transaction-scoped advisory locks, for "check, then insert" sequences that
 * no unique constraint can guard (a pair in either order, an open report).
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client.ts';

/**
 * Holds a Postgres advisory lock named by `parts` until the transaction ends.
 * Concurrent transactions locking the same name queue behind each other, so
 * whatever they read after the lock includes the earlier one's writes.
 *
 * NOTE: the name is hashed to 32 bits, so unrelated names can collide; that
 * only makes two unrelated transactions wait for each other, never wrong.
 *
 * @param tx - Open transaction (outside one the lock is released at once).
 * @param parts - Lock name, joined with `:`; put a domain prefix first.
 * @example
 * await lockXact(tx, 'friend-pair', ...[a, b].sort());
 */
export async function lockXact(tx: DbOrTx, ...parts: string[]): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${parts.join(':')}))`);
}
