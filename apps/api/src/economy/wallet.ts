/**
 * Wallet reads and cosmetic grants shared by the store, pass, challenges and
 * match rewards.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { inventoryItems, profiles } from '../db/schema.ts';
import type { Wallet } from './ledger.ts';

/** Current cached balances. */
export async function readWallet(db: DbOrTx, userId: string): Promise<Wallet> {
  const [w] = await db
    .select({ gumballs: profiles.gumballs, gems: profiles.gems, crownShards: profiles.crownShards })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return w ?? { gumballs: 0, gems: 0, crownShards: 0 };
}

/** Sources a refund or gift reversal may take back; an earned grant re-sources them. */
const REVERSIBLE_SOURCES = ['store', 'gift'];

/**
 * Grants a cosmetic (no-op when already owned).
 *
 * An item held only because it was bought in the store or gifted is
 * re-sourced to the earned source when it is granted again, so a later store
 * refund or gift reversal (which only take back `store` / `gift` copies)
 * never removes something the player earned.
 *
 * @param tx - Open transaction.
 * @param userId - Recipient.
 * @param cosmeticId - Item.
 * @param source - How it was obtained (`store`, `event`, `achievement`, …).
 * @returns True when the item was newly added.
 */
export async function grantCosmetic(
  tx: DbOrTx,
  userId: string,
  cosmeticId: string,
  source: string,
): Promise<boolean> {
  const rows = await tx
    .insert(inventoryItems)
    .values({ userId, cosmeticId, source })
    .onConflictDoNothing()
    .returning({ id: inventoryItems.id });
  if (rows.length > 0) return true;
  if (!REVERSIBLE_SOURCES.includes(source)) {
    await tx
      .update(inventoryItems)
      .set({ source })
      .where(
        and(
          eq(inventoryItems.userId, userId),
          eq(inventoryItems.cosmeticId, cosmeticId),
          inArray(inventoryItems.source, REVERSIBLE_SOURCES),
        ),
      );
  }
  return false;
}
