/**
 * Discovers every obstacle set. Any `set-*.ts` file in the sim and render
 * obstacle folders is picked up automatically, so new sets appear in the
 * gallery without touching this page.
 *
 * Sets are imported lazily and independently: a set that is mid-development
 * and fails to load is reported instead of taking the whole gallery down.
 */
import type { ObstacleModule, ObstacleType } from '@tumble/sim';
import type { ObstacleVisualFactory } from '../../../../packages/render/src/obstacles/types.ts';

/** One obstacle type as the gallery knows it. */
export interface GalleryObstacleDef {
  type: ObstacleType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous modules; params flow through each module's own schema.
  module: ObstacleModule<any>;
  visual?: ObstacleVisualFactory;
  /** Which set file provided the sim module (for labels). */
  source: string;
}

/** Result of {@link discoverObstacles}. */
export interface Discovery {
  defs: GalleryObstacleDef[];
  /** Set files that failed to import, with the reason. */
  failures: { file: string; error: string }[];
}

const simSets = import.meta.glob('../../../../packages/sim/src/obstacles/set-*.ts');
const visualSets = import.meta.glob('../../../../packages/render/src/obstacles/set-*.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see GalleryObstacleDef.module.
function isModule(v: unknown): v is ObstacleModule<any> {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<ObstacleModule>;
  return typeof m.type === 'string' && typeof m.create === 'function' && typeof m.schema === 'object';
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function loadAll(
  loaders: Record<string, () => Promise<unknown>>,
  failures: Discovery['failures'],
): Promise<[string, Record<string, unknown>][]> {
  const entries = Object.entries(loaders).sort(([a], [b]) => a.localeCompare(b));
  const results = await Promise.allSettled(entries.map(([, load]) => load()));
  const out: [string, Record<string, unknown>][] = [];
  results.forEach((r, i) => {
    const file = fileName(entries[i]![0]);
    if (r.status === 'fulfilled') out.push([file, r.value as Record<string, unknown>]);
    else failures.push({ file, error: String((r.reason as Error)?.message ?? r.reason) });
  });
  return out;
}

/**
 * Collects all sim modules (from exported arrays of modules) and pairs them
 * with visual factories (from exported type → factory maps).
 *
 * @returns Definitions in set order, plus any sets that failed to load.
 */
export async function discoverObstacles(): Promise<Discovery> {
  const failures: Discovery['failures'] = [];
  const [sims, visuals] = await Promise.all([loadAll(simSets, failures), loadAll(visualSets, failures)]);
  const defs = new Map<string, GalleryObstacleDef>();
  for (const [file, mod] of sims) {
    for (const value of Object.values(mod)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (isModule(item) && !defs.has(item.type)) defs.set(item.type, { type: item.type, module: item, source: file.replace(/\.ts$/, '') });
      }
    }
  }
  for (const [, mod] of visuals) {
    for (const value of Object.values(mod)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      for (const [type, factory] of Object.entries(value as Record<string, unknown>)) {
        const def = defs.get(type);
        if (def && typeof factory === 'function' && !def.visual) def.visual = factory as ObstacleVisualFactory;
      }
    }
  }
  return { defs: [...defs.values()], failures };
}
