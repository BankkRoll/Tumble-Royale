/**
 * Short-lived markers for deleted accounts. Access tokens are verified without
 * a database read, so a token minted just before `DELETE /me` would otherwise
 * keep working until it expires.
 */
import { ACCESS_TOKEN_TTL_SEC } from '../auth/tokens.ts';
import type { KV } from '../kv/index.ts';

const key = (userId: string) => `erased:${userId}`;

/**
 * Marks an account as deleted for as long as any of its tokens could be valid.
 *
 * @param kv - Shared KV (so every API instance sees it).
 * @param userId - Deleted account.
 */
export async function markErased(kv: KV, userId: string): Promise<void> {
  await kv.set(key(userId), '1', (ACCESS_TOKEN_TTL_SEC + 60) * 1000);
}

/**
 * True when the account was deleted recently enough that tokens minted for it
 * may still be unexpired.
 */
export async function isErased(kv: KV, userId: string): Promise<boolean> {
  return (await kv.get(key(userId))) !== null;
}
