/**
 * F2 — Last Tumbler Standing (LEVELS.md §9). Three floating discs of ice
 * hexes in a snow-globe sky; finalists carve each other's footing while snow
 * cannons follow the survivors down. Last one up wins.
 *
 * Module mapping:
 * - Disc masks → {@link tileField} hex rows (design circumradius 1.5 ⇒ module
 *   flat-to-flat `tileSize` 2.6); `shakeTime` → `warnTime`.
 * - `glareRatio` (ice hexes), `timedSchedule` random drops and
 *   `shakeTimeSchedule` have no `fallingTiles` equivalent. Instead the lower
 *   layers wake row by row from the outside in (L2 30–80 s, L3 90–200 s; L3's
 *   centre row never does — sudden death there is cannons and shoving), the
 *   cannons follow the survivors down, and the hard cap (highest survivor wins
 *   at 240 s) guarantees the show never stalls.
 * - `landingDeltaSchedule` (cannons retarget lower layers at 120 / 170 s) →
 *   each pylon carries three cannons, one per layer, live from 45–60 / 120 /
 *   170 s. Lower cannons sit between layers so their arcs never pass through
 *   the layer above.
 */
import { defineRound } from '@tumble/shared';
import { hash01, overrideAll, polar, r3, roamGrid, tileField, v3, type ObstacleInput, type PieceInput } from '../tile-panic/kit.ts';

/** Design circumradius 1.5 m ⇒ flat-to-flat 2.6 m. */
const HEX = 2.6;
/**
 * `wake`: [outer, centre] seconds at which a layer's rows start reacting to
 * players. The top layer cracks from the gun; the lower ones wake outside-in,
 * standing in for the design's escalating timed drops (90–235 s).
 */
const LAYERS = [
  { id: 'layer-1', y: 20, radius: 16, wake: [0, 0] },
  { id: 'layer-2', y: 10, radius: 14, wake: [30, 80] },
  { id: 'layer-3', y: 0, radius: 12, wake: [90, 200] },
] as const;
/** Match time from which the very last row (L3's centre line) would crumble: the hard cap. */
const LAST_ROW_WAKE = 240;

const fields = LAYERS.map((l) =>
  tileField({
    idPrefix: l.id,
    shape: 'hex',
    tileSize: HEX,
    gap: 0.08,
    thickness: 0.5,
    warnTime: 1.0,
    startTime: ({ z, row }) =>
      // NOTE: if the last row crumbled, everyone on it would drop in the same tick and the
      // final would crown nobody (lastStanding has no height tiebreak for simultaneous falls).
      l.id === 'layer-3' && row === 0
        ? LAST_ROW_WAKE
        : Math.round(l.wake[0] + (l.wake[1] - l.wake[0]) * (1 - Math.min(1, Math.abs(z) / l.radius))),
    mergeRows: false,
    centre: v3(0, l.y, 0),
    extent: l.radius + 1,
    include: (x, z) => Math.hypot(x, z) <= l.radius,
  }),
);
const allTiles = fields.flatMap((f) => f.instances);

// -----------------------------------------------------------------------------
// Snow cannons: two pylons, one cannon per layer on each
// -----------------------------------------------------------------------------

const PYLON_Z = 24;
interface Perch {
  suffix: string;
  baseY: number;
  targetY: number;
  /** Seconds the north / south cannon goes live. */
  live: [number, number];
  flightTime: number;
  /** Lane spacing keeping the 7-lane fan inside the target disc. */
  laneSpacing: number;
}
const perches: Perch[] = [
  { suffix: '', baseY: 34, targetY: 20, live: [45, 60], flightTime: 1.8, laneSpacing: 4.4 },
  { suffix: 'b', baseY: 14, targetY: 10, live: [120, 121.75], flightTime: 1.2, laneSpacing: 3.9 },
  { suffix: 'c', baseY: 4, targetY: 0, live: [170, 171.75], flightTime: 1.2, laneSpacing: 3.3 },
];
const cannons: ObstacleInput[] = [];
for (const perch of perches) {
  [1, -1].forEach((side, k) => {
    const z = side * (perch.suffix === '' ? PYLON_Z : PYLON_Z - 1);
    cannons.push({
      id: `snow-can-${k + 1}${perch.suffix}`,
      type: 'cannon',
      position: v3(0, perch.baseY, z),
      rotation: { yaw: side > 0 ? 180 : 0 },
      params: {
        pivotHeight: 1.6,
        barrelLength: 2.4,
        range: Math.abs(z),
        landingHeight: perch.targetY - perch.baseY,
        // ±35° sweep (design sweepDeg 70) at the centre line.
        laneCount: 7,
        laneSpacing: perch.laneSpacing,
        flightTime: perch.flightTime,
        rollTime: 1.0,
        rollSpeed: 6,
        bounceHeight: 0.6,
        period: 3.5,
        startDelay: perch.live[k] as number,
        pattern: 'pingpong',
        seed: 9201 + k,
        ballRadius: 0.6,
        knockImpulse: 7,
        aimTime: 1.0,
      },
    });
  });
}

// -----------------------------------------------------------------------------
// Set dressing
// -----------------------------------------------------------------------------

const geometry: PieceInput[] = [];
for (const side of [1, -1]) {
  geometry.push(
    // Striped cannon pylon (collides; out of reach) and perches for the lower cannons.
    { shape: 'cylinder', position: v3(0, 14, side * PYLON_Z), size: v3(1.5, 40, 0), color: 'neutral', pattern: 'stripes' },
    { shape: 'cylinder', position: v3(0, 33.7, side * PYLON_Z), size: v3(1.9, 0.6, 0), color: 'secondary', bevel: 0.25 },
    { shape: 'cylinder', position: v3(0, 13.7, side * (PYLON_Z - 1)), size: v3(1.8, 0.6, 0), color: 'secondary', bevel: 0.25 },
    { shape: 'cylinder', position: v3(0, 3.7, side * (PYLON_Z - 1)), size: v3(1.8, 0.6, 0), color: 'secondary', bevel: 0.25 },
    { shape: 'sphere', position: v3(0, 38.6, side * PYLON_Z), size: v3(1.2, 1.2, 1.2), color: 'accent', decorative: true },
  );
}
// Snowfield far below (the snow-globe floor) with drifts.
geometry.push({ shape: 'cylinder', position: v3(0, -16, 0), size: v3(60, 1, 0), color: '#e8f6ff', decorative: true });
for (let i = 0; i < 16; i++) {
  const p = polar(14 + hash01(9201, i) * 34, i * 22.5 + hash01(3, i) * 10, -15.5);
  const s = 2 + hash01(4, i) * 4;
  geometry.push({ shape: 'sphere', position: r3(p), size: v3(s, s, s), color: '#ffffff', decorative: true });
}
// Ice-crystal spires ringing the arena.
for (let i = 0; i < 10; i++) {
  const p = polar(34 + hash01(17, i) * 8, i * 36 + 18, 2 + hash01(19, i) * 10);
  const h = 8 + hash01(23, i) * 14;
  geometry.push({
    shape: 'hexPrism',
    position: r3(p),
    size: v3(1.2 + hash01(29, i), h, 0),
    rotation: { yaw: i * 17, pitch: 0, roll: (hash01(31, i) - 0.5) * 20 },
    color: i % 2 ? 'secondary' : 'accent',
    decorative: true,
  });
}

// -----------------------------------------------------------------------------
// Bot roaming grids
// -----------------------------------------------------------------------------

const navSpacing = 2 * (HEX + 0.08);
const botNav = LAYERS.flatMap((l, k) =>
  roamGrid({ idBase: 100 * (k + 1), y: l.y, spacing: navSpacing, extent: l.radius, include: (x, z) => Math.hypot(x, z) <= l.radius - 2.5, seed: 9201 + k }),
);

export default defineRound({
  id: 'last-tumbler-standing',
  name: 'Last Tumbler Standing',
  type: 'final',
  theme: 'frosty',
  objective: 'Ice cracks under you. Be the last one up!',
  tips: [
    'Ice hexes crack when you stand on them — keep moving.',
    'Break the ice around your rivals to cut them off.',
    'Three layers. A fall is only the end on the bottom one.',
  ],
  players: { min: 1, max: 15, ideal: 8 },
  qualification: { mode: 'lastStanding' },
  duration: { seconds: 240, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v3(-30, -15, -30), max: v3(30, 40, 30) },
  spawn: { origin: v3(0, 20.1, 0), yaw: 0, cols: 4, spacing: 3.0 },
  geometry,
  obstacles: [...allTiles, ...cannons],
  triggers: [],
  flyover: {
    path: [v3(0, 40, -30), v3(28, 25, 0), v3(0, 12, 28), v3(-20, 4, 0)],
    lookAt: [v3(0, 20, 0), v3(0, 15, 0), v3(0, 10, 0), v3(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_final_crownfever',
  speedScaleByStage: [1.0, 1.0, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  botNav,
  variations: [
    { id: 'glacier', weight: 4, weather: 'snow', description: 'As authored (light snowfall).' },
    {
      id: 'black-ice',
      weight: 2,
      weather: 'night',
      description: 'Aurora night; brittle black ice cracks faster (0.8 s).',
      obstacleParams: overrideAll(allTiles, { warnTime: 0.8 }),
    },
    {
      id: 'thaw',
      weight: 1,
      weather: 'clear',
      description: 'Faster cracks from the start.',
      obstacleParams: overrideAll(allTiles, { warnTime: 0.7 }),
    },
    {
      id: 'blizzard-cannons',
      weight: 1,
      weather: 'snow',
      description: 'Cannons from 30 s, firing twice as often.',
      obstacleParams: Object.fromEntries(
        cannons.map((c) => {
          const start = Number((c.params as Record<string, unknown>).startDelay);
          return [c.id, { period: 1.75, startDelay: start < 100 ? 30 + (c.id.includes('-2') ? 0.875 : 0) : start }];
        }),
      ),
    },
  ],
  decorSeed: 9201,
  designNotes: [
    'Hex discs r 16 / 14 / 12 at y 20 / 10 / 0 (hex 2.6 flat-to-flat, touch crack 1.0 s, no respawn); L2 rows wake 30–80 s, L3 rows 90–200 s (the centre row stays solid to the cap).',
    'Snow cannons: layer-1 cannons live at 45 / 60 s, layer-2 cannons at 120 s, layer-3 cannons at 170 s (design landingDeltaSchedule).',
    'Missing in fallingTiles: glare-ice hexes (black-ice reinterpreted as faster cracking), timed random drops and the shake schedule —',
    'without them the bots usually finish it well before the cap; at 240 s the highest survivor wins.',
  ].join(' '),
});
