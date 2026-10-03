import type { SfxDefs } from '../types.ts';
import { MOVEMENT_SFX } from './movement.ts';
import { OBSTACLE_SFX } from './obstacles.ts';
import { SHOW_SFX } from './show.ts';
import { UI_SFX } from './ui.ts';

export { RARITIES } from './ui.ts';
export type { Rarity } from './ui.ts';

/** The complete procedural sound bank, keyed by sound name. */
export const SFX_DEFS: SfxDefs = {
  ...MOVEMENT_SFX,
  ...OBSTACLE_SFX,
  ...SHOW_SFX,
  ...UI_SFX,
};

/** Every sound name in the bank, in definition order. */
export const SFX_NAMES: readonly string[] = Object.keys(SFX_DEFS);
