/**
 * Practice Island — the optional first-launch tutorial course (SPEC §14.1).
 * A compact candy island where Coach Boing teaches one verb per station, in
 * order: Move (arrow slalom) → Jump (three hops) → Dive (a gap only a
 * jump+dive clears) → Grab (grab the coach) → Ledge Climb (2.4 m lip) →
 * Bounce Pad (onto the high shelf) → Falling Tiles (they drop behind you) →
 * Checkpoint + fall demo (hop off the diving board, pop back) → through the
 * race arch to a short mini race against bots.
 *
 * Never part of a real show: the id is in `DEV_ROUND_IDS` and the round is
 * registered only through `rounds/tutorial.ts`. The client runner builds two
 * sims from it — the practice course (human + coach) and the mini race (spawn
 * moved to {@link RACE_SPAWN}) — and reads every station point from
 * `layout.ts`.
 *
 * Distances were measured with the real controller: flat running jump ≈ 4.2 m
 * centre to centre, jump+dive ≈ 6.6 m, bounce launch (0, 16, 5) peaks ≈ 5.5 m.
 */
import { defineRound } from '@tumble/shared';
import {
  NavBuilder,
  arch,
  box,
  cyl,
  deco,
  floor,
  mirrorX,
  paint,
  pillar,
  ramp,
  sphere,
  torus,
  v,
  type Obstacle,
  type Piece,
  type Trigger,
} from '../gumdrop-gauntlet/kit.ts';
import { COACH_PODIUM, FALL_BOARD, ISLAND as I, PRACTICE_SPAWN } from './layout.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEG = 180 / Math.PI;
/** Island slabs are 2 m thick so they read as chunky floating candy. */
const SLAB = 2;
const diveLandZ = I.jumpC.z1 + I.diveGap;

/** Arrow route through the Move slalom (posts sit opposite each bend). */
const MOVE_PATH: readonly [number, number][] = [
  [0, 6.5],
  [2.6, 11],
  [-2.6, 16],
  [2.6, 21],
  [0, 25.5],
];
const MOVE_POSTS: readonly [number, number][] = [
  [-1.7, 11],
  [1.7, 16],
  [-1.7, 21],
];

/** Mini race hurdles (z of each bar) and bumper spots. */
const HURDLES = [122.5, 128.5, 134.5] as const;
const BUMPERS: readonly [number, number][] = [
  [-3.5, 155],
  [3.5, 155],
  [0, 161],
  [-4.5, 166],
  [4.5, 166],
];

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const lollipop = (x: number, top: number, z: number, color: string): Piece[] =>
  deco(
    cyl(x, top + 3, z, 0.3, 6, { color: 'neutral', pattern: 'stripes' }),
    cyl(x, top + 6.8, z, 2, 0.6, { color, rotation: { pitch: 90 }, pattern: 'dots' }),
  );

const cupcake = (x: number, y: number, z: number, s: number): Piece[] =>
  deco(
    cyl(x, y, z, 3.2 * s, 3 * s, { color: 'secondary', pattern: 'stripes' }),
    sphere(x, y + 2.2 * s, z, 3.1 * s, { color: 'primary' }),
    sphere(x, y + 5.2 * s, z, 0.9 * s, { color: 'danger' }),
  );

const balloon = (x: number, y: number, z: number, color: string): Piece[] =>
  deco(sphere(x, y, z, 1.3, { color }), cyl(x, y - 2.8, z, 0.05, 3.6, { color: 'neutral' }));

/** Painted chevron strip from `a` to `b` on a floor at `top`. */
const arrow = (a: readonly [number, number], b: readonly [number, number], top: number): Piece => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return paint((a[0] + b[0]) / 2, top, (a[1] + b[1]) / 2, 1.1, Math.hypot(dx, dz) - 0.6, {
    color: 'accent',
    pattern: 'chevron',
    rotation: { yaw: Math.atan2(dx, dz) * DEG },
  });
};

/** Hazard stripe along a drop-off lip. */
const lip = (top: number, z: number, width: number): Piece =>
  paint(0, top, z, width, 0.5, { color: 'danger', pattern: 'hazard' });

const start: Piece[] = [
  floor(0, 0, I.plazaZ0, 6, 12, { color: 'safe', pattern: 'checker' }, SLAB),
  box(0, 1, I.plazaZ0 - 0.5, 12, 2, 1, { color: 'neutral' }),
  ...mirrorX(box(6.25, 0.5, 0, 0.5, 1, 12, { color: 'neutral' })),
  // Start arch at the plaza exit: runners pass under it, and it stays out of the spawn camera.
  ...deco(arch(0, 0, 5.5, 10, 6.5, 1, { color: 'primary', pattern: 'stripes' })),
  ...deco(...mirrorX(sphere(7.6, 1.6, -3.5, 1.5, { color: 'accent', pattern: 'dots' }))),
];

const moveSlalom: Piece[] = [
  floor(0, 0, 6, I.moveZ1, 10, { color: 'primary' }, SLAB),
  ...mirrorX(box(5.25, 0.4, 16, 0.5, 0.8, 20, { color: 'neutral' })),
  ...MOVE_PATH.slice(1).map((b, i) => arrow(MOVE_PATH[i]!, b, 0)),
  // Solid candy-cane posts the arrows weave around; the swirl tops sit well above head height.
  ...MOVE_POSTS.flatMap(([x, z]) => [
    cyl(x, 1.4, z, 0.4, 2.8, { color: 'neutral', pattern: 'stripes' }),
    ...deco(sphere(x, 3.1, z, 0.75, { color: 'danger', pattern: 'dots' })),
  ]),
];

const jumpHops: Piece[] = [
  lip(0, I.moveZ1 - 0.3, 10),
  floor(0, I.jumpA.top, I.jumpA.z0, I.jumpA.z1, 6, { color: 'secondary' }, SLAB),
  floor(0, I.jumpB.top, I.jumpB.z0, I.jumpB.z1, 6, { color: 'primary' }, SLAB + 0.8),
  floor(0, I.jumpC.top, I.jumpC.z0, I.jumpC.z1, 9, { color: 'secondary' }, SLAB + 0.8),
  lip(I.jumpA.top, I.jumpA.z1 - 0.3, 6),
  lip(I.jumpB.top, I.jumpB.z1 - 0.3, 6),
  ...deco(...mirrorX(torus(2.2, I.jumpB.top + 0.02, 37, 0.5, 0.08, { color: 'accent' }))),
];

const diveGap: Piece[] = [
  lip(I.jumpC.top, I.jumpC.z1 - 0.3, 9),
  paint(0, I.jumpC.top, I.jumpC.z1 - 1.6, 3, 1.6, { color: 'accent', pattern: 'chevron' }),
  // The "dive through the hoop" ring floats over the gap: pure decoration.
  ...deco(
    torus(0, I.jumpC.top + 2.3, I.jumpC.z1 + I.diveGap / 2, 2.3, 0.22, {
      color: 'accent',
      rotation: { pitch: 90 },
    }),
  ),
  ...deco(
    ...mirrorX(
      cyl(2.5, I.jumpC.top - 3, I.jumpC.z1 + I.diveGap / 2, 0.18, 8.2, {
        color: 'neutral',
        pattern: 'stripes',
      }),
    ),
  ),
];

const grabPlaza: Piece[] = [
  floor(0, I.grabTop, diveLandZ, I.grabZ1, 14, { color: 'primary' }, SLAB),
  ...deco(torus(0, I.grabTop + 0.03, 61, 2.6, 0.16, { color: 'accent' })),
  paint(0, I.grabTop, 61, 3.6, 3.6, { color: 'accent', pattern: 'dots' }),
  ...mirrorX(box(7.25, I.grabTop + 0.4, 60, 0.5, 0.8, 14, { color: 'neutral' })),
  // Squishy gumdrops to bump around while waiting for the coach.
  ...deco(
    sphere(-4.8, I.grabTop + 0.5, 57.5, 0.8, { color: 'danger' }),
    sphere(5, I.grabTop + 0.5, 64.5, 0.8, { color: 'accent' }),
  ),
];

const ledgeWall: Piece[] = [
  floor(0, I.ledgeTop, I.grabZ1, I.ledgeZ1, 12, { color: 'secondary', grabbable: true }, I.ledgeTop + 0.8),
  // Yellow lip trim marks the grabbable edge (LEVELS.md §1.5 grab lip).
  ...deco(box(0, I.ledgeTop - 0.12, I.grabZ1 - 0.05, 12.04, 0.24, 0.12, { color: 'accent', bevel: 0.05 })),
  ...deco(
    ...mirrorX(
      box(3.5, I.ledgeTop / 2, I.grabZ1 - 0.04, 0.3, I.ledgeTop - 0.4, 0.08, {
        color: 'accent',
        pattern: 'stripes',
        bevel: 0,
      }),
    ),
  ),
  ...deco(torus(0, I.ledgeTop + 0.03, I.padZ, 2, 0.18, { color: 'accent' })),
];

const bounceShelf: Piece[] = [
  floor(0, I.shelfTop, I.ledgeZ1, I.shelfZ1, 10, { color: 'primary' }, I.shelfTop - I.ledgeTop + 0.2),
  lip(I.shelfTop, I.shelfZ1 - 0.3, 10),
];

const checkpointTerrace: Piece[] = [
  floor(0, I.shelfTop, I.checkpointZ0, I.racePlazaZ0, 12, { color: 'secondary' }, SLAB),
  // Diving board for the fall demo: a striped plank over the void.
  floor(
    FALL_BOARD.x - 1.45,
    I.shelfTop,
    FALL_BOARD.z - 1.25,
    FALL_BOARD.z + 1.25,
    3.5,
    { color: 'accent', pattern: 'stripes' },
    0.5,
  ),
  paint(FALL_BOARD.x + 0.05, I.shelfTop, FALL_BOARD.z, 0.4, 2.5, {
    color: 'danger',
    pattern: 'hazard',
    rotation: { yaw: 0 },
  }),
  ...deco(cyl(FALL_BOARD.x - 1.5, I.shelfTop - 1.5, FALL_BOARD.z, 0.25, 3, { color: 'neutral' })),
  // Rail on the far side only: the diving board leaves the terrace on +X.
  box(-6.25, I.shelfTop + 0.4, 99, 0.5, 0.8, 9, { color: 'neutral' }),
  ...deco(arch(0, I.shelfTop, I.raceGateZ, 11, 6.5, 1.2, { color: 'accent', pattern: 'stripes' })),
  ...deco(...mirrorX(sphere(5.6, I.shelfTop + 6.9, I.raceGateZ, 0.8, { color: 'danger' }))),
];

const racePlaza: Piece[] = [
  floor(0, I.shelfTop, I.racePlazaZ0, I.raceTrackZ0, 14, { color: 'safe', pattern: 'checker' }, SLAB),
  ...mirrorX(box(7.25, I.shelfTop + 0.5, 113, 0.5, 1, 10, { color: 'neutral' })),
];

const raceTrack: Piece[] = [
  floor(0, I.shelfTop, I.raceTrackZ0, I.rampZ0, 12, { color: 'primary' }, SLAB),
  ...HURDLES.map((z) =>
    box(0, I.shelfTop + 0.275, z, 12, 0.55, 0.5, { color: 'danger', pattern: 'stripes', bevel: 0.12 }),
  ),
  ramp(
    0,
    (I.shelfTop + I.raceLowTop) / 2,
    (I.rampZ0 + I.rampZ1) / 2,
    12,
    I.shelfTop - I.raceLowTop,
    I.rampZ1 - I.rampZ0,
    {
      rotation: { yaw: 180 },
      color: 'secondary',
      pattern: 'chevron',
    },
  ),
  floor(0, I.raceLowTop, I.rampZ1, I.gapZ0, 14, { color: 'primary' }, SLAB),
  lip(I.raceLowTop, I.gapZ0 - 0.3, 14),
  floor(0, I.raceLowTop, I.gapZ1, I.endZ, 12, { color: 'safe' }, SLAB),
  paint(0, I.raceLowTop, I.finishZ, 12, 2, { color: 'safe', pattern: 'checker' }),
  pillar(COACH_PODIUM.x, COACH_PODIUM.y, COACH_PODIUM.z, 1.5, 3, { color: 'accent', pattern: 'dots' }),
  ...deco(...mirrorX(box(9.5, I.raceLowTop + 2, 179, 3, 4, 10, { color: 'neutral', pattern: 'stripes' }))),
];

const skyDecor: Piece[] = [
  ...lollipop(-11.5, 0, 10, 'accent'),
  ...lollipop(11.5, 0, 22, 'danger'),
  ...lollipop(-10, 0.8, 42, 'danger'),
  ...lollipop(10, 2.6, 72, 'accent'),
  ...lollipop(-9.5, I.shelfTop, 100, 'accent'),
  ...lollipop(-10, I.shelfTop, 126, 'danger'),
  ...lollipop(10, I.shelfTop, 130, 'accent'),
  ...lollipop(-11, I.raceLowTop, 176, 'accent'),
  ...cupcake(-26, -8, 20, 1.4),
  ...cupcake(27, -10, 70, 1.8),
  ...cupcake(-28, -6, 120, 1.5),
  ...cupcake(26, -9, 168, 1.6),
  ...balloon(-14, 10, 14, 'danger'),
  ...balloon(15, 12, 50, 'accent'),
  ...balloon(-15, 16, 86, 'primary'),
  ...balloon(14, 20, 118, 'safe'),
  ...balloon(-16, 18, 158, 'accent'),
  ...balloon(15, 15, 192, 'danger'),
];

// -----------------------------------------------------------------------------
// Checkpoints (respawn points sit on solid ground past each trigger)
// -----------------------------------------------------------------------------

const cp = (
  index: number,
  top: number,
  z: number,
  width: number,
  respawnZ: number,
  xs: number[],
): Trigger => ({
  id: `cp-${index}`,
  kind: 'checkpoint',
  index,
  position: v(0, top + 2, z),
  size: v(width, 4, 3),
  respawn: xs.map((x) => v(x, top + 0.1, respawnZ)),
  respawnYaw: 0,
});

const SPREAD = [-1.5, 0, 1.5];
const triggers: Trigger[] = [
  {
    id: 'cp-0',
    kind: 'checkpoint',
    index: 0,
    position: v(0, 2, 0),
    size: v(12, 4, 12),
    respawn: [-2.5, -0.8, 0.8, 2.5].map((x) => v(x, 0.1, 2)),
  },
  cp(1, 0, 26, 10, 26.4, SPREAD),
  cp(2, I.jumpC.top, 43, 9, 44.2, SPREAD),
  cp(3, I.grabTop, diveLandZ + 1.6, 14, diveLandZ + 3.2, [-3, -1, 1, 3]),
  cp(4, I.ledgeTop, 68.6, 12, 69.6, [-2.5, -1, 1, 2.5]),
  cp(5, I.shelfTop, 77, 10, 78.6, SPREAD),
  {
    ...cp(6, I.shelfTop, I.checkpointGateZ, 12, I.checkpointGateZ + 2.5, [-2, -0.7, 0.7, 2]),
    size: v(12, 4, 2),
  },
  cp(7, I.raceLowTop, I.rampZ1 + 2, 14, I.rampZ1 + 3.5, [-3, -1, 1, 3]),
  { id: 'finish', kind: 'finish', position: v(0, I.raceLowTop + 2, I.finishZ), size: v(12, 4, 2) },
];

const CP_PAINT: Piece[] = [
  paint(0, 0, 26, 10, 1.4, { color: 'safe', pattern: 'checker' }),
  paint(0, I.jumpC.top, 43, 9, 1.4, { color: 'safe', pattern: 'checker' }),
  paint(0, I.grabTop, diveLandZ + 1.6, 14, 1.4, { color: 'safe', pattern: 'checker' }),
  paint(0, I.ledgeTop, 68.6, 12, 1.4, { color: 'safe', pattern: 'checker' }),
  paint(0, I.shelfTop, 77, 10, 1.4, { color: 'safe', pattern: 'checker' }),
  paint(0, I.shelfTop, I.checkpointGateZ, 12, 2, { color: 'safe', pattern: 'checker' }),
  paint(0, I.raceLowTop, I.rampZ1 + 2, 14, 1.4, { color: 'safe', pattern: 'checker' }),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const obstacles: Obstacle[] = [
  {
    id: 's6-pad',
    type: 'bouncePad',
    // Sunk so only 0.2 m shows: under the 0.35 m step-up, so running onto it never snags the rim.
    position: v(0, I.ledgeTop - 0.2, I.padZ),
    params: { radius: 1.4, height: 0.4, launch: v(0, 16, 5) },
  },
  {
    id: 's7-tiles',
    type: 'fallingTiles',
    position: v(0, I.shelfTop, I.tilesZ),
    params: {
      shape: 'square',
      cols: 3,
      rows: 4,
      tileSize: 2.6,
      gap: 0.12,
      thickness: 0.5,
      warnTime: 0.6,
      respawnTime: 3.5,
    },
  },
  {
    id: 's8-gate',
    type: 'checkpointGate',
    position: v(0, I.shelfTop, I.checkpointGateZ),
    // Index 0 keeps the arch label a plain "CHECKPOINT": the island has one visible gate, and the trigger (cp-6) does the work.
    params: { index: 0, width: 12, height: 5, respawnDistance: 2.5 },
  },
  {
    id: 'r0-gate',
    type: 'startGate',
    position: v(0, I.shelfTop, I.startGateZ),
    params: { width: 14, height: 3, openDuration: 0.4 },
  },
  ...BUMPERS.map(([x, z], i): Obstacle => ({
    id: `r2-bump-${i + 1}`,
    type: 'bumperPillar',
    position: v(x, I.raceLowTop, z),
    params: {
      radius: 0.9,
      height: 2.4,
      bounceSpeed: 7,
      ...(i === 2 ? { orbitRadius: 1.2, orbitSpeed: 1.6 } : {}),
    },
  })),
  {
    id: 'r3-finish',
    type: 'finishLine',
    position: v(0, I.raceLowTop, I.finishZ),
    params: { width: 12, height: 6 },
  },
];

// -----------------------------------------------------------------------------
// Bot navigation (ids grouped by hundreds per station; see layout.ts navFrom)
// -----------------------------------------------------------------------------

/** Take-off waypoints sit just past the lip; bots leave ~1 m early and fly ≈ 4 m. */
const JUMP = { r: 1.2, action: 'jump' } as const;
const LINEUP = { r: 1.2 } as const;
/** Climb-out press above the lip (see Crown Climb): fires only for a bot hanging on it. */
const CLIMB = { r: 1, action: 'jump' } as const;

const nav = new NavBuilder();
nav.add(0, [0, 0, 2], 100, { r: 3 });
MOVE_PATH.slice(1).forEach(([x, z], i) =>
  nav.add(100 + i, [x, 0, z], i < MOVE_PATH.length - 2 ? 101 + i : 200, { r: 1.4 }),
);
nav
  .add(200, [0, 0, 26.6], 201, LINEUP)
  .add(201, [0, 0, I.moveZ1 + 0.2], 202, JUMP)
  .add(202, [0, 0, 31.2], 203, LINEUP)
  .add(203, [0, 0, I.jumpA.z1 + 0.2], 204, { r: 1, action: 'jump' })
  .add(204, [0, I.jumpB.top, 37], 205, LINEUP)
  .add(205, [0, I.jumpB.top, I.jumpB.z1 + 0.2], 206, { r: 1, action: 'jump' })
  .add(206, [0, I.jumpC.top, 43.5], 300, { r: 1.5 });
nav
  .add(300, [0, I.jumpC.top, 45], 301, LINEUP)
  .add(301, [0, I.jumpC.top, I.jumpC.z1 + 0.2], 302, { r: 1, action: 'jumpDive' })
  .add(302, [0, I.grabTop, diveLandZ + 4], 400, { r: 2 });
nav
  .add(400, [0, I.grabTop, 61], 410, { r: 2 })
  .add(410, [0, I.grabTop, 64], 411, LINEUP)
  .add(411, [0, I.grabTop, I.grabZ1 - 0.3], 420, { r: 1.5, action: 'jump' });
for (let k = 0; k < 7; k++)
  nav.add(
    420 + k,
    [0, I.ledgeTop + 1.2, I.grabZ1 + 0.3],
    k < 6 ? 421 + k : 500,
    k % 3 === 0 ? CLIMB : { r: 1 },
  );
nav
  .add(500, [0, I.ledgeTop, 69.8], 501, LINEUP)
  .add(501, [0, I.ledgeTop, I.padZ], 502, { r: 0.8 })
  .add(502, [0, I.shelfTop, 79], 600, { r: 2.5 });
nav
  .add(600, [0, I.shelfTop, 81.5], 601, LINEUP)
  .add(601, [0, I.shelfTop, I.tilesZ], 602, { r: 2 })
  .add(602, [0, I.shelfTop, 96], 700, { r: 2 });
nav.add(700, [0, I.shelfTop, 100], 701, { r: 2 }).add(701, [0, I.shelfTop, 105], 800, { r: 2 });
nav.add(800, [0, I.shelfTop, 112], 801, { r: 3 }).add(801, [0, I.shelfTop, 119.5], 802, LINEUP);
HURDLES.forEach((z, i) => {
  nav.add(802 + 2 * i, [0, I.shelfTop, z - 1.3], 803 + 2 * i, { r: 1.3, action: 'jump' });
  nav.add(803 + 2 * i, [0, I.shelfTop, z + 3], i < HURDLES.length - 1 ? 804 + 2 * i : 810, LINEUP);
});
nav
  .add(810, [0, (I.shelfTop + I.raceLowTop) / 2, (I.rampZ0 + I.rampZ1) / 2], 811, { r: 2 })
  .add(811, [0, I.raceLowTop, 151.5], [812, 813], { r: 2 })
  .add(812, [-2.6, I.raceLowTop, 161], 814, { r: 1.5 })
  .add(813, [2.6, I.raceLowTop, 161], 814, { r: 1.5 })
  .add(814, [0, I.raceLowTop, 169.4], 815, LINEUP)
  .add(815, [0, I.raceLowTop, I.gapZ0 + 0.2], 816, JUMP)
  .add(816, [0, I.raceLowTop, 179], 817, { r: 2 })
  .add(817, [0, I.raceLowTop, I.finishZ], [], { r: 4 });

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

export default defineRound({
  id: 'practice-island',
  name: 'Practice Island',
  type: 'race',
  theme: 'candy',
  objective: 'Learn the moves with Coach Boing, then win the mini race!',
  tips: [
    'Jump, then dive at the top of the jump to fly furthest.',
    'Fall off? You pop back at your last checkpoint.',
    'Hold Grab near a ledge to hang on, then Jump to climb.',
  ],
  players: { min: 1, max: 8, ideal: 8 },
  qualification: { mode: 'finish', ratio: 1 },
  duration: { seconds: 900, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-40, -15, -20), max: v(40, 36, 205) },
  spawn: { ...PRACTICE_SPAWN },
  geometry: [
    ...start,
    ...moveSlalom,
    ...jumpHops,
    ...diveGap,
    ...grabPlaza,
    ...ledgeWall,
    ...bounceShelf,
    ...checkpointTerrace,
    ...racePlaza,
    ...raceTrack,
    ...CP_PAINT,
    ...skyDecor,
  ],
  obstacles,
  triggers,
  flyover: {
    path: [v(20, 16, -14), v(-16, 12, 30), v(16, 16, 66), v(-14, 18, 100), v(14, 16, 150), v(0, 14, 200)],
    lookAt: [v(0, 0, 8), v(0, 0.5, 45), v(0, 3, 75), v(0, 6, 100), v(0, 4, 150), v(0, 2, I.finishZ)],
    duration: 8,
  },
  cameraMode: 'orbit',
  music: 'mus_lobby_tumbletown',
  speedScaleByStage: [1, 1, 1, 1, 1],
  fallBehavior: 'respawnCheckpoint',
  botNav: nav.build(),
  variations: [{ id: 'classic', weight: 1, weather: 'clear', description: 'As authored.' }],
  decorSeed: 4242,
  designNotes:
    'Tutorial course, never in shows. One verb per station with a rest pad and checkpoint after each. Required ' +
    'gaps stay ≤ 2.4 m except the dive gap (5 m, 0.6 m drop: jump alone ≈ 0.6 m short, jump+dive clears by ≈ 1 m). ' +
    'Ledge 2.4 m (grabbable). Pad shelf +3.6 m, unreachable without the pad. Mini race ≈ 70 m: hurdles, ramp, ' +
    'bumpers, one 2 m hop.',
});
