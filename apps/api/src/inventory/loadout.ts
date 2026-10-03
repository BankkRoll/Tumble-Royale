/**
 * Loadout shape and ownership validation.
 *
 * A saved loadout is content's `CosmeticLoadout` (free body colours as hex,
 * item ids per slot) plus `banner` and `footsteps`. Content validates ids and
 * slots; the API adds ownership, which content cannot know.
 */
import { validateLoadout as validateContentLoadout } from '@tumble/content/cosmetics';
import { z } from 'zod';
import type { CatalogCosmetic, CosmeticSlot, LoadoutItems } from '../catalog.ts';
import { ApiError, badRequest } from '../http/errors.ts';

/** Number of loadout slots per player. */
export const LOADOUT_COUNT = 6;

const Id = z.string().min(3).max(64);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Validated loadout body. */
export const LoadoutItemsSchema = z.object({
  colors: z.tuple([Hex, Hex, Hex]),
  pattern: Id,
  face: Id,
  upper: Id.nullable(),
  lower: Id.nullable(),
  headwear: Id.nullable(),
  back: Id.nullable(),
  emotes: z.tuple([Id, Id, Id, Id]),
  celebration: Id,
  victoryPose: Id,
  nameplate: Id,
  trail: Id.nullable(),
  banner: Id.nullable().default(null),
  footsteps: Id.nullable().default(null),
}) satisfies z.ZodType<LoadoutItems, unknown>;

/**
 * Checks ids exist, sit in the right slot and are owned.
 *
 * @param items - Requested loadout.
 * @param catalog - Cosmetics by id.
 * @param owned - Ids the player owns.
 * @throws {ApiError} 400 `invalid_loadout` (unknown id / wrong slot / duplicate emote), 403 `not_owned`.
 */
export function validateLoadout(
  items: LoadoutItems,
  catalog: ReadonlyMap<string, CatalogCosmetic>,
  owned: ReadonlySet<string>,
): void {
  const { banner, footsteps, ...core } = items;
  const issues = validateContentLoadout(core).map((i) => ({ field: i.field as string, message: i.message }));
  const extra: [string, string | null, CosmeticSlot][] = [
    ['banner', banner, 'banner'],
    ['footsteps', footsteps, 'footsteps'],
  ];
  for (const [field, id, slot] of extra) {
    if (id === null) continue;
    const item = catalog.get(id);
    if (!item) issues.push({ field, message: `unknown cosmetic "${id}"` });
    else if (item.slot !== slot) issues.push({ field, message: `"${id}" is a ${item.slot}, not a ${slot}` });
  }
  if (issues.length) throw badRequest('invalid_loadout', issues.map((i) => i.message).join('; '), { issues });

  const refs = [core.pattern, core.face, core.upper, core.lower, core.headwear, core.back, ...core.emotes, core.celebration, core.victoryPose, core.nameplate, core.trail, banner, footsteps];
  const notOwned = [...new Set(refs.filter((id): id is string => id !== null && !owned.has(id)))];
  if (notOwned.length) {
    throw new ApiError(403, 'not_owned', `You do not own: ${notOwned.join(', ')}`, { items: notOwned });
  }
}
