/**
 * S2 — Tile Panic (LEVELS.md §5). Three floating layers of wafer tiles above
 * a chocolate lake; every grounded step cracks a tile. Corner candy-cane
 * towers carry sprinkle cannons from 30 s.
 *
 * Module mapping (the design predates `fallingTiles`):
 * - Layer masks (clipped square / disc / fat plus) → {@link tileField} blocks.
 * - `shakeTime` → `warnTime`; `triggerMode both` → touch cracking only.
 * - `timedSchedule` random drops and `shakeTimeSchedule` have no module
 *   equivalent. The lower layers "wake" instead: their rows ignore players
 *   until 15–35 s (L2) and 40–70 s (L3), outer rows first, so an early faller
 *   is not doomed, the safe middle shrinks, and the late game still escalates.
 * - Cannon `targetRange/targetApex/landingDelta`, `aim sweep` → `range`,
 *   `landingHeight`, `flightTime`, `laneCount × laneSpacing` + `pingpong`.
 */
import { defineRound } from '@tumble/shared';
import { hash01, overrideAll, polar, r3, roamGrid, tileField, v3, type ObstacleInput, type PieceInput } from './kit.ts';

const TILE = 2.8;
const GAP = 0.12;
const PITCH = TILE + GAP;
const L1_Y = 24;
const L2_Y = 12;
const L3_Y = 0;
/** 13 × 13 lattice: cells −6…6 on both axes. */
const EXTENT = 6 * PITCH + 0.01;

const inGrid = (x: number, z: number): boolean => Math.abs(x) <= EXTENT && Math.abs(z) <= EXTENT;
/** Top: every cell except the 3-cell corner triangles (|i|+|j| > 10). */
const maskL1 = (x: number, z: number): boolean => inGrid(x, z) && Math.abs(x / PITCH) + Math.abs(z / PITCH) <= 10.01;
/** Middle: a disc of radius 17. */
const maskL2 = (x: number, z: number): boolean => inGrid(x, z) && Math.hypot(x, z) <= 17;
/** Bottom: a fat plus, |x| ≤ 7.3 or |z| ≤ 7.3, clipped to radius 19. */
const maskL3 = (x: number, z: number): boolean =>
  inGrid(x, z) && (Math.abs(x) <= 7.3 || Math.abs(z) <= 7.3) && Math.hypot(x, z) <= 19;

const square = { shape: 'square' as const, tileSize: TILE, gap: GAP, thickness: 0.5, warnTime: 0.9, extent: EXTENT };
const layer1 = tileField({ ...square, idPrefix: 'layer-1', centre: v3(0, L1_Y, 0), include: maskL1, startTime: 0 });
/**
 * Lower layers "wake" row by row from the outside in: a row ignores players
 * until its time comes (L2 15 → 35 s, L3 40 → 70 s), so the safe middle
 * shrinks and the crowd is herded inward.
 */
const wake = (from: number, to: number) => ({ z }: { z: number }): number =>
  Math.round(from + (to - from) * (1 - Math.min(1, Math.abs(z) / EXTENT)));
const layer2 = tileField({ ...square, idPrefix: 'layer-2', centre: v3(0, L2_Y, 0), include: maskL2, startTime: wake(15, 35), mergeRows: false });
const layer3 = tileField({ ...square, idPrefix: 'layer-3', centre: v3(0, L3_Y, 0), include: maskL3, startTime: wake(40, 70), mergeRows: false });
/** `hex-mix` variation: the middle layer rebuilt from hexes (design circumradius 1.8 ⇒ 3.12 flat-to-flat). */
const layer2Hex = tileField({
  shape: 'hex',
  tileSize: 3.12,
  gap: 0.1,
  thickness: 0.5,
  warnTime: 0.9,
  extent: 18,
  idPrefix: 'layer-2h',
  centre: v3(0, L2_Y, 0),
  include: (x, z) => Math.hypot(x, z) <= 17,
  startTime: wake(15, 35),
  mergeRows: false,
});
const allTiles = [...layer1.instances, ...layer2.instances, ...layer3.instances];

// -----------------------------------------------------------------------------
// Sprinkle cannons (corner towers, live from 30 s)
// -----------------------------------------------------------------------------

const TOWER_TOP = 30;
const corners: [number, number, number][] = [
  [24, 24, -135],
  [-24, 24, 135],
  [-24, -24, 45],
  [24, -24, -45],
];
const cannons: ObstacleInput[] = corners.map(([x, z, yaw], i) => ({
  id: `can-${i + 1}`,
  type: 'cannon',
  position: v3(x, TOWER_TOP, z),
  rotation: { yaw },
  params: {
    pivotHeight: 1.6,
    barrelLength: 2.4,
    // 33.9 m to the centre; landing 22 m out puts the lane fan over L1's middle.
    range: 22,
    landingHeight: L1_Y - TOWER_TOP,
    laneCount: 5,
    // ±25° sweep at 22 m ⇒ ~20 m of lanes across the layer.
    laneSpacing: 5,
    flightTime: 1.6,
    rollTime: 1.0,
    rollSpeed: 6,
    bounceHeight: 0.6,
    period: 4,
    // activeFrom 30, phases 0 / 0.25 / 0.5 / 0.75 of the 4 s interval ⇒ one shot per second overall.
    startDelay: 30 + i,
    pattern: 'pingpong',
    seed: 2201 + i,
    ballRadius: 0.6,
    knockImpulse: 7,
    aimTime: 0.9,
  },
}));

// -----------------------------------------------------------------------------
// Set dressing
// -----------------------------------------------------------------------------

const decor: PieceInput[] = [
  // Chocolate lake and its swirl rings.
  { shape: 'cylinder', position: v3(0, -6, 0), size: v3(40, 0.4, 0), color: '#7b4a2e', decorative: true },
  { shape: 'torus', position: v3(0, -5.7, 0), size: v3(30, 0.35, 0), color: '#9a5f3c', decorative: true },
  { shape: 'torus', position: v3(0, -5.7, 0), size: v3(18, 0.3, 0), color: '#9a5f3c', decorative: true },
];
// Candy-cane corner towers (cannon mounts) with a cream collar under each cannon.
for (const [x, z] of corners) {
  decor.push(
    { shape: 'cylinder', position: v3(x, 14, z), size: v3(1.2, 32, 0), color: 'accent', pattern: 'stripes' },
    { shape: 'cylinder', position: v3(x, TOWER_TOP - 0.3, z), size: v3(1.7, 0.6, 0), color: 'neutral', bevel: 0.25 },
    { shape: 'torus', position: v3(x, TOWER_TOP - 0.6, z), size: v3(1.7, 0.25, 0), color: 'primary', decorative: true },
    { shape: 'cylinder', position: v3(x, -5.8, z), size: v3(2.4, 0.6, 0), color: 'neutral', decorative: true },
  );
}
// Marshmallow rocks in the lake.
for (let i = 0; i < 14; i++) {
  const p = polar(24 + hash01(2201, i) * 14, i * 25.7 + hash01(7, i) * 12, -5.6);
  const s = 1.2 + hash01(11, i) * 2.2;
  decor.push({ shape: 'sphere', position: r3(p), size: v3(s, s, s), color: i % 3 === 0 ? 'primary' : 'neutral', decorative: true });
}
// Cotton-candy clouds drifting through the gaps between layers.
for (let i = 0; i < 12; i++) {
  const y = i % 2 === 0 ? 18 : 6;
  const c = polar(36 + hash01(31, i) * 8, i * 30 + 15, y);
  for (let k = 0; k < 3; k++) {
    const s = 1.1 + hash01(i, k) * 1.1;
    decor.push({
      shape: 'sphere',
      position: r3(v3(c.x + (k - 1) * 1.8, c.y + hash01(k, i) * 0.8, c.z + (k - 1) * 0.6)),
      size: v3(s, s, s),
      color: k === 1 ? '#ffd9ef' : '#ffffff',
      decorative: true,
    });
  }
}
// Floating cupcake islands circling the arena (gumdrop domes on wafer bases).
for (let i = 0; i < 6; i++) {
  const p = polar(46, i * 60 + 30, 4 + (i % 3) * 8);
  decor.push(
    { shape: 'cylinder', position: r3(p), size: v3(4, 3, 0), color: 'secondary', pattern: 'stripes', decorative: true },
    { shape: 'sphere', position: r3(v3(p.x, p.y + 2.4, p.z)), size: v3(4.2, 4.2, 4.2), color: i % 2 ? 'primary' : 'accent', decorative: true },
    { shape: 'sphere', position: r3(v3(p.x, p.y + 6.6, p.z)), size: v3(0.9, 0.9, 0.9), color: 'danger', decorative: true },
  );
}

// -----------------------------------------------------------------------------
// Bot roaming grids (one per layer)
// -----------------------------------------------------------------------------

const navSpacing = 2 * PITCH;
const botNav = [
  ...roamGrid({ idBase: 100, y: L1_Y, spacing: navSpacing, extent: EXTENT, include: (x, z) => maskL1(x, z) && Math.hypot(x, z) < 16, seed: 1 }),
  ...roamGrid({ idBase: 200, y: L2_Y, spacing: navSpacing, extent: EXTENT, include: (x, z) => maskL2(x, z) && Math.hypot(x, z) < 14, seed: 2 }),
  ...roamGrid({ idBase: 300, y: L3_Y, spacing: navSpacing, extent: EXTENT, include: (x, z) => maskL3(x, z) && Math.hypot(x, z) < 16, seed: 3 }),
];

export default defineRound({
  id: 'tile-panic',
  name: 'Tile Panic',
  type: 'survival',
  theme: 'candy',
  objective: "Tiles crumble when touched. Don't fall!",
  tips: [
    'Keep moving — every tile you stand on is about to drop.',
    "Falling isn't the end: there are three layers. Use them.",
    "Jump to save tiles: airtime doesn't crack them.",
  ],
  players: { min: 10, max: 50, ideal: 32 },
  qualification: { mode: 'survive', ratio: 0.6 },
  duration: { seconds: 120, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v3(-35, -15, -35), max: v3(35, 45, 35) },
  spawn: { origin: v3(0, L1_Y + 0.1, 0), yaw: 0, cols: 8, spacing: 1.6 },
  geometry: decor,
  obstacles: [...allTiles, ...cannons],
  triggers: [],
  flyover: {
    path: [v3(0, 45, -40), v3(35, 30, 0), v3(0, 20, 40), v3(-30, 8, 0)],
    lookAt: [v3(0, 24, 0), v3(0, 18, 0), v3(0, 12, 0), v3(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_candy_sugarrush',
  speedScaleByStage: [1.0, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  botNav,
  variations: [
    { id: 'wafer-classic', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'hex-mix',
      weight: 2,
      weather: 'clear',
      description: 'Hex tiles on the middle layer.',
      removeObstacles: layer2.instances.map((i) => i.id),
      addObstacles: layer2Hex.instances,
    },
    {
      id: 'quick-crumble',
      weight: 2,
      weather: 'sunset',
      description: 'Faster cracking from the start.',
      obstacleParams: overrideAll(allTiles, { warnTime: 0.7 }),
    },
    {
      id: 'rebake',
      weight: 1,
      weather: 'clear',
      description: 'Tiles re-form on the bottom layer.',
      obstacleParams: overrideAll(layer3.instances, { respawnTime: 10 }),
    },
    {
      id: 'no-cannons',
      weight: 1,
      weather: 'night',
      description: 'Glowing night tiles; the sprinkle cannons are off.',
      removeObstacles: cannons.map((c) => c.id),
    },
  ],
  decorSeed: 2201,
  designNotes: [
    'Three square wafer layers (y 24 / 12 / 0, tile 2.8, pitch 2.92): L1 157 tiles (corner-clipped 13×13), L2 disc r 17, L3 fat plus.',
    'Touch cracking (warnTime 0.9). fallingTiles has no timed drops or shake schedule, so L2 rows wake 15–35 s and L3 rows 40–70 s, outside in;',
    'speedScaleByStage scales cannon timing only (the tile module ignores speedScale).',
    'Sprinkle cannons on the candy-cane towers from 30 s (one shot per second overall, knock 7, foam balls never crack tiles).',
    'Expected: 32 → 19 at ~80–100 s. Bots roam per-layer waypoint grids; a fallingTiles botSafeSpot (most intact neighbours) would make them far better.',
  ].join(' '),
});

/** Generated pieces, exported for the group-3 tests. */
export const tilePanicParts = { layer1, layer2, layer3, layer2Hex, cannons };
