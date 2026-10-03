import { z } from 'zod';

/** Highest account level. Beyond it, XP keeps accruing for the season pass only. */
export const MAX_LEVEL = 100;

/** One row of the level table. */
export const LevelRowSchema = z.object({
  level: z.number().int().min(1),
  /** XP needed to go from this level to the next (0 at the cap). */
  xpToNext: z.number().int().min(0),
  /** Total XP needed to reach this level from zero. */
  totalXp: z.number().int().min(0),
});

/** The full level curve. */
export const LevelTableSchema = z
  .array(LevelRowSchema)
  .length(MAX_LEVEL)
  .refine((rows) => rows.every((r, i) => r.level === i + 1), 'levels must be 1..MAX_LEVEL in order')
  .refine((rows) => rows.every((r, i) => i === 0 || r.totalXp === rows[i - 1]!.totalXp + rows[i - 1]!.xpToNext), 'totals must accumulate');

/** A row of the level table. */
export type LevelRow = z.output<typeof LevelRowSchema>;

/**
 * XP to advance from `level` to `level + 1`. Early levels come fast (a level
 * per show or two) and the curve flattens so later levels take ~6–8 shows.
 */
function xpToNext(level: number): number {
  if (level >= MAX_LEVEL) return 0;
  const raw = 400 + 90 * Math.pow(level - 1, 0.85);
  return Math.round(raw / 10) * 10;
}

function buildTable(): LevelRow[] {
  const rows: LevelRow[] = [];
  let total = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const next = xpToNext(level);
    rows.push({ level, xpToNext: next, totalXp: total });
    total += next;
  }
  return rows;
}

/** The validated level table, index 0 = level 1. */
export const LEVEL_TABLE: readonly LevelRow[] = LevelTableSchema.parse(buildTable());

/**
 * Account level for a lifetime XP total.
 *
 * @param totalXp - Lifetime XP.
 * @returns Level, XP into it and XP needed for the next one.
 * @example
 * levelForXp(0); // { level: 1, intoLevel: 0, toNext: 400 }
 */
export function levelForXp(totalXp: number): { level: number; intoLevel: number; toNext: number } {
  const xp = Math.max(0, Math.floor(totalXp));
  let lo = 0;
  let hi = LEVEL_TABLE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((LEVEL_TABLE[mid] as LevelRow).totalXp <= xp) lo = mid;
    else hi = mid - 1;
  }
  const row = LEVEL_TABLE[lo] as LevelRow;
  return { level: row.level, intoLevel: xp - row.totalXp, toNext: row.xpToNext };
}

/**
 * Lifetime XP at which `level` is reached.
 *
 * @param level - 1..MAX_LEVEL (clamped).
 */
export function xpForLevel(level: number): number {
  const i = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level))) - 1;
  return (LEVEL_TABLE[i] as LevelRow).totalXp;
}
