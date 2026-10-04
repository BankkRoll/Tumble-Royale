/**
 * Taking a cosmetic away from a player: the admin revoke and store refunds.
 *
 * Removing the inventory row is not enough on its own: saved loadouts still
 * name the item, and a loadout the player can no longer save would be stuck.
 * Every loadout that wears the item falls back to the default loadout's
 * choice for that slot, in the same transaction.
 */
import { and, eq } from 'drizzle-orm';
import type { LoadoutItems } from '../catalog.ts';
import type { AppContext } from '../context.ts';
import type { DbOrTx } from '../db/client.ts';
import { inventoryItems, loadouts } from '../db/schema.ts';

const LOADOUT_SINGLE_SLOTS = [
  'pattern',
  'face',
  'upper',
  'lower',
  'headwear',
  'back',
  'celebration',
  'victoryPose',
  'nameplate',
  'trail',
  'banner',
  'footsteps',
] as const;

/**
 * A loadout with every use of `cosmeticId` replaced by the default loadout's
 * choice for that slot (emotes are reset as a set, so none repeats).
 *
 * @param items - Saved loadout.
 * @param cosmeticId - Revoked item.
 * @param defaults - The default loadout.
 * @returns The new loadout, or null when it did not use the item.
 */
export function stripCosmetic(
  items: LoadoutItems,
  cosmeticId: string,
  defaults: LoadoutItems,
): LoadoutItems | null {
  let changed = false;
  const next: LoadoutItems = { ...items, emotes: [...items.emotes] as LoadoutItems['emotes'] };
  for (const slot of LOADOUT_SINGLE_SLOTS) {
    if (next[slot] === cosmeticId) {
      (next as unknown as Record<string, unknown>)[slot] = defaults[slot] ?? null;
      changed = true;
    }
  }
  if (next.emotes.includes(cosmeticId)) {
    next.emotes = [...defaults.emotes] as LoadoutItems['emotes'];
    changed = true;
  }
  return changed ? next : null;
}

/** Outcome of {@link revokeCosmetic}. */
export interface RevokedCosmetic {
  /** How the player had acquired it (`store`, `pass`, …). */
  source: string;
  /** Loadout slot indexes that wore it and now use the defaults. */
  loadouts: number[];
}

/**
 * Removes a cosmetic from a player's inventory and from every loadout that
 * wears it. Must run inside a transaction.
 *
 * @param tx - Open transaction.
 * @param ctx - Shared services (catalog defaults, clock).
 * @param userId - Owner.
 * @param cosmeticId - Item to take away.
 * @param onlySource - Remove it only while held from this source (`store`
 *   for refunds), so an item also earned another way is never taken.
 * @returns What was removed, or null when the player did not own it (from that source).
 */
export async function revokeCosmetic(
  tx: DbOrTx,
  ctx: AppContext,
  userId: string,
  cosmeticId: string,
  onlySource?: string,
): Promise<RevokedCosmetic | null> {
  const removed = await tx
    .delete(inventoryItems)
    .where(
      and(
        eq(inventoryItems.userId, userId),
        eq(inventoryItems.cosmeticId, cosmeticId),
        onlySource ? eq(inventoryItems.source, onlySource) : undefined,
      ),
    )
    .returning({ source: inventoryItems.source });
  if (removed.length === 0) return null;
  const defaults = ctx.catalog.defaultLoadout();
  const saved = await tx
    .select({ slotIndex: loadouts.slotIndex, items: loadouts.items })
    .from(loadouts)
    .where(eq(loadouts.userId, userId));
  const changed: number[] = [];
  for (const l of saved) {
    const next = stripCosmetic(l.items as LoadoutItems, cosmeticId, defaults);
    if (!next) continue;
    changed.push(l.slotIndex);
    await tx
      .update(loadouts)
      .set({ items: next, updatedAt: ctx.now() })
      .where(and(eq(loadouts.userId, userId), eq(loadouts.slotIndex, l.slotIndex)));
  }
  return { source: removed[0]!.source, loadouts: changed };
}
