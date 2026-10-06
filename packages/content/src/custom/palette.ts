/**
 * What the round editor offers: the obstacle library filtered to the modules
 * a custom round may use, grouped for the palette, plus the level parts
 * (static piece presets) players build courses from.
 */
import type { StaticPiece } from '@tumble/shared';
import { getObstacleModule } from '@tumble/sim/obstacles';
import { z } from 'zod';
import type { CustomRoundType } from './limits.ts';

/** Obstacles that only work inside hand-made team, hold-item or final logic. */
export const EXCLUDED_OBSTACLES: ReadonlySet<string> = new Set([
  'paintGrid',
  'goalZone',
  'propSpawner',
  'throneFloor',
]);

/** Obstacles that hand out hunt points; allowed (and one required) only in hunt rounds. */
export const SCORING_OBSTACLES: ReadonlySet<string> = new Set(['cometField', 'sunbeamZones']);

/** Obstacles that run a logic round's puzzle; allowed (and one required) only in logic rounds. */
export const LOGIC_OBSTACLES: ReadonlySet<string> = new Set(['patternBoard', 'puzzleFloor']);

/**
 * Whether an obstacle type may be placed in a custom round of `type`.
 *
 * @param obstacleType - Obstacle module id.
 * @param type - The round's type.
 */
export function obstacleAllowed(obstacleType: string, type: CustomRoundType): boolean {
  if (EXCLUDED_OBSTACLES.has(obstacleType)) return false;
  if (SCORING_OBSTACLES.has(obstacleType)) return type === 'hunt';
  if (LOGIC_OBSTACLES.has(obstacleType)) return type === 'logic';
  return true;
}

/** Palette groups, in display order. Types not listed fall into "More". */
export const OBSTACLE_GROUPS: readonly { label: string; types: readonly string[] }[] = [
  {
    label: 'Floors',
    types: [
      'iceFloor',
      'stickyGoo',
      'conveyorBelt',
      'slideRamp',
      'fallingTiles',
      'collapsingBridge',
      'popupBlocks',
    ],
  },
  { label: 'Moving', types: ['movingPlatform', 'spinningDisc', 'tiltPlatform', 'seesaw', 'rollingDrum'] },
  {
    label: 'Hazards',
    types: [
      'spinwheel',
      'pendulumHammer',
      'sweeperArm',
      'bumperPillar',
      'punchWall',
      'doorGauntlet',
      'boulderLane',
      'laserSweep',
      'cannon',
      'bumperCar',
      'jumpRopeBeam',
      'fanZone',
      'risingSlime',
    ],
  },
  { label: 'Helpers', types: ['bouncePad', 'teleporterPair', 'climbWall', 'voidTrigger'] },
  { label: 'Course', types: ['startGate', 'checkpointGate', 'finishLine'] },
  { label: 'Hunt', types: ['cometField', 'sunbeamZones'] },
  { label: 'Logic', types: ['patternBoard', 'puzzleFloor'] },
];

const num = (p: Record<string, unknown>, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/**
 * Rough collider count an obstacle builds, from its (default-applied) params.
 * Grids and bridges build one collider per cell; everything else a handful.
 *
 * @param type - Obstacle module id.
 * @param params - Params with defaults applied.
 * @returns Estimated colliders (at least 1).
 */
export function obstacleColliderCost(type: string, params: Record<string, unknown>): number {
  const cells = (cols: string, rows: string, c: number, r: number) =>
    Math.max(1, num(params, cols, c)) * Math.max(1, num(params, rows, r));
  switch (type) {
    case 'fallingTiles':
      return cells('cols', 'rows', 8, 8);
    case 'popupBlocks':
      return cells('cols', 'rows', 6, 6);
    case 'patternBoard':
      return cells('cols', 'rows', 4, 4) + 4;
    case 'puzzleFloor':
      return cells('cols', 'rows', 5, 5) + 4;
    case 'collapsingBridge':
      return Math.max(1, num(params, 'segments', 8));
    case 'doorGauntlet':
      return cells('rows', 'doorsPerRow', 4, 5) * 2;
    case 'climbWall':
      return 2 + cells('holdRows', 'holdCols', 6, 4);
    case 'punchWall':
      return 2 + Math.max(1, num(params, 'pistonCount', 4));
    case 'spinwheel':
      return 1 + Math.max(1, num(params, 'armCount', 2)) * Math.max(1, num(params, 'tiers', 1));
    case 'boulderLane':
      return 2 + Math.max(1, num(params, 'lanes', 3)) * 3;
    case 'bumperCar':
      return Math.max(1, num(params, 'cars', 3));
    case 'cometField':
      return 8 + Math.max(1, num(params, 'slots', 24));
    case 'sunbeamZones':
      return Math.max(1, num(params, 'beams', 8));
    default:
      return 4;
  }
}

/** A level part: a named static piece preset for the editor palette. */
export interface LevelPart {
  id: string;
  label: string;
  /** Piece placed at the cursor (position is overwritten). */
  piece: Omit<StaticPiece, 'position'>;
}

const part = (
  id: string,
  label: string,
  shape: StaticPiece['shape'],
  size: { x: number; y: number; z: number },
  extra: Partial<Omit<StaticPiece, 'shape' | 'size' | 'position'>> = {},
): LevelPart => ({
  id,
  label,
  piece: {
    shape,
    size,
    surface: 'normal',
    color: 'primary',
    bevel: 0.3,
    grabbable: false,
    decorative: false,
    pattern: 'none',
    ...extra,
  },
});

/** Static piece presets, from the conventions in LEVELS.md §1.5. */
export const LEVEL_PARTS: readonly LevelPart[] = [
  part('floor', 'Floor 12×12', 'box', { x: 12, y: 1, z: 12 }),
  part('floor-long', 'Walkway 6×24', 'box', { x: 6, y: 1, z: 24 }, { color: 'secondary' }),
  part('beam', 'Beam 1.5×12', 'box', { x: 1.5, y: 0.8, z: 12 }, { color: 'accent' }),
  part('step', 'Step 4×1.2×3', 'box', { x: 4, y: 1.2, z: 3 }, { color: 'secondary' }),
  part('wall', 'Wall 8×3', 'box', { x: 8, y: 3, z: 0.8 }, { color: 'neutral', bevel: 0.15 }),
  part('ramp', 'Ramp 6×3×10', 'ramp', { x: 6, y: 3, z: 10 }, { color: 'secondary' }),
  part('wedge', 'Wedge 4×2×4', 'wedge', { x: 4, y: 2, z: 4 }, { color: 'accent' }),
  part('pillar', 'Round pad r3', 'cylinder', { x: 3, y: 1, z: 3 }, { color: 'safe' }),
  part('hex', 'Hex pad r2.5', 'hexPrism', { x: 2.5, y: 1, z: 2.5 }, { color: 'accent' }),
  part('ice', 'Ice slab 10×10', 'box', { x: 10, y: 1, z: 10 }, { surface: 'ice', color: 'safe' }),
  part('bouncy', 'Bouncy block 3×1×3', 'box', { x: 3, y: 1, z: 3 }, { surface: 'bouncy', color: 'interact' }),
  part('ledge', 'Grab ledge 6×2.2×2', 'box', { x: 6, y: 2.2, z: 2 }, { grabbable: true, color: 'interact' }),
  part('arch', 'Arch 8×5', 'arch', { x: 8, y: 5, z: 1.5 }, { color: 'accent', decorative: true }),
  part(
    'sphere',
    'Ball r1.5 (decor)',
    'sphere',
    { x: 1.5, y: 1.5, z: 1.5 },
    { decorative: true, color: 'accent' },
  ),
];

const jsonSchemas = new Map<string, unknown>();

/**
 * An obstacle's params as JSON Schema (input side: defaults listed, every
 * param optional), for tools that generate forms. Cached per type.
 *
 * @param type - Obstacle module id.
 * @returns The schema, or null for an unknown type.
 */
export function obstacleParamJsonSchema(type: string): unknown {
  const hit = jsonSchemas.get(type);
  if (hit !== undefined) return hit;
  const mod = getObstacleModule(type);
  if (!mod) return null;
  let json: unknown;
  try {
    json = z.toJSONSchema(mod.schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    json = {};
  }
  jsonSchemas.set(type, json);
  return json;
}
