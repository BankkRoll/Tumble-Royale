/**
 * @tumble/render/vfx — GPU-cheap cartoon effects for Tumble Royale.
 *
 * Responsibilities:
 * - `createVfxSystem`: confetti, dust, speed lines, stun stars, slime splashes,
 *   fireworks, qualify sparkles, elimination balloons, crown shine, bounce
 *   rings, wind streaks, tile cracks, team smoke, teleports, sparkles, pops,
 *   blob shadows and trail ribbons in ≈ 7 draw calls + 1 per visible trail.
 * - Sim-event → effect mapping (`handleSimEvent`).
 * - Quality-tier budgets and the lists a lab page needs to enumerate effects.
 */
export * from './types.ts';
export { createVfxSystem } from './vfxSystem.ts';
export { VFX_KINDS } from './recipes.ts';
export { TRAIL_STYLES } from './trails.ts';
export { DEFAULT_VFX_BUDGET, vfxBudgetForTier, type VfxQualityTier } from './budget.ts';
