/**
 * The collection log for one player: content's catalogue-wide log (sources,
 * completion by slot and rarity) over the player's inventory, plus when each
 * owned item was acquired. Read only.
 */
import { eq } from 'drizzle-orm';
import type { Catalog } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import { inventoryItems } from '../db/schema.ts';

/** Filters accepted by `GET /collection`. */
export interface CollectionQuery {
  slot?: Catalog['cosmetics'][number]['slot'];
  rarity?: Catalog['cosmetics'][number]['rarity'];
  owned?: boolean;
}

/**
 * Builds a player's collection log.
 *
 * @param db - Database or transaction.
 * @param catalog - Cosmetics and the collection read model.
 * @param userId - Player.
 * @param filter - Narrows the entries; totals always cover the whole catalogue.
 */
export async function collectionView(db: DbOrTx, catalog: Catalog, userId: string, filter: CollectionQuery) {
  const rows = await db
    .select({ id: inventoryItems.cosmeticId, acquiredAt: inventoryItems.acquiredAt })
    .from(inventoryItems)
    .where(eq(inventoryItems.userId, userId));
  const acquired = new Map(rows.map((r) => [r.id, r.acquiredAt]));
  // Every account owns `default` items, including ones added after it was created.
  const defaults = new Set(catalog.cosmetics.filter((c) => c.source === 'default').map((c) => c.id));
  const log = catalog.collection((id) => acquired.has(id) || defaults.has(id), filter);
  return {
    owned: log.owned,
    total: log.total,
    percent: log.percent,
    bySlot: log.bySlot,
    byRarity: log.byRarity,
    entries: log.entries.map((e) => ({ ...e, acquiredAt: acquired.get(e.id)?.toISOString() ?? null })),
  };
}
