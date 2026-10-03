import { MAX_PLAYERS } from '@tumble/shared';
import type { VfxBudget } from './types.ts';

/**
 * VFX capacity presets per quality tier.
 *
 * Responsibilities:
 * - The default budget and per-tier presets.
 * - Merging partial overrides.
 */

/** Quality tiers that map onto a {@link VfxBudget}. */
export type VfxQualityTier = 'low' | 'medium' | 'high' | 'ultra';

/** Budget used when none is given (the `high` tier). */
export const DEFAULT_VFX_BUDGET: Readonly<VfxBudget> = Object.freeze({
  particles: 4096,
  confetti: 1500,
  trails: 12,
  shadows: MAX_PLAYERS,
});

const TIERS: Readonly<Record<VfxQualityTier, Readonly<VfxBudget>>> = {
  low: { particles: 1024, confetti: 400, trails: 4, shadows: MAX_PLAYERS },
  medium: { particles: 2048, confetti: 800, trails: 8, shadows: MAX_PLAYERS },
  high: DEFAULT_VFX_BUDGET,
  ultra: { particles: 8192, confetti: 3000, trails: 20, shadows: MAX_PLAYERS },
};

/**
 * Budget preset for a quality tier. Shadows never drop below a full `MAX_PLAYERS`
 * lobby, because every character must always have one.
 *
 * @param tier - Quality tier.
 * @returns A fresh budget object.
 * @example
 * const vfx = createVfxSystem({ budget: vfxBudgetForTier('medium') });
 */
export function vfxBudgetForTier(tier: VfxQualityTier): VfxBudget {
  return { ...TIERS[tier] };
}

/**
 * Fills missing fields from `base`.
 *
 * @param base - Fallback values.
 * @param partial - Overrides.
 * @returns A fresh, complete budget.
 */
export function mergeBudget(base: Readonly<VfxBudget>, partial: Partial<VfxBudget> | undefined): VfxBudget {
  return {
    particles: Math.max(16, Math.floor(partial?.particles ?? base.particles)),
    confetti: Math.max(16, Math.floor(partial?.confetti ?? base.confetti)),
    trails: Math.max(0, Math.floor(partial?.trails ?? base.trails)),
    shadows: Math.max(1, Math.floor(partial?.shadows ?? base.shadows)),
  };
}

/** Hard allocation ceiling: pools are sized once, so later budget raises up to this never reallocate. */
export const MAX_VFX_BUDGET: Readonly<VfxBudget> = TIERS.ultra;
