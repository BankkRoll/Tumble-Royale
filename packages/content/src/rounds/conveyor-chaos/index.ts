/**
 * R2 — Conveyor Chaos (LEVELS.md §4 R2). A toy on the assembly line of the
 * world's silliest factory: every surface moves and the skill is reading which
 * way. Loading Bay → Intake Belts → The Punch Line → Flip Ramp → Crossbelts →
 * Gear Works → Press Hall → QC Scanners → Shipping Dock (~515 m).
 *
 * Transcription notes (design → shipped obstacle modules):
 * - `conveyorBelt` has no phase: "half a cycle apart" belts are the same
 *   `switch` belt yawed 180° (its forward is the other belt's backward).
 *   Uphill belts are pitched negative (positive pitch lowers local +Z).
 * - `punchWall` punches along local +Z with pistons along local X, so walls
 *   are yawed ±90° to punch across the corridor; panels are square faces.
 * - Sliding seam bumpers are flat-oval `bumperCar` carts; sliding lane
 *   bumpers on the dock orbit a 1 m circle.
 * - The maintenance catwalk is a timed `collapsingBridge` (no touch mode).
 * - Sliding QC lasers become full-length rotating `laserSweep` beams.
 * - The piston wave is `popupBlocks` `rows` yawed 180° so it rolls forward.
 */
import { defineRound } from '@tumble/shared';
import {
  NavBuilder,
  arch,
  box,
  checkpoint,
  cyl,
  deco,
  floor,
  mirrorX,
  paint,
  sphere,
  v,
  type Obstacle,
  type Piece,
} from '../gumdrop-gauntlet/kit.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DECK = 6;

/** Flip Ramp: z 134 → 184 rising 0 → 6. */
const FLIP_Z0 = 134;
const FLIP_Z1 = 184;
const FLIP_DEG = (Math.atan2(DECK, FLIP_Z1 - FLIP_Z0) * 180) / Math.PI;
const FLIP_LEN = Math.hypot(DECK, FLIP_Z1 - FLIP_Z0);
const flipY = (z: number): number => ((z - FLIP_Z0) / (FLIP_Z1 - FLIP_Z0)) * DECK;

/** Shipping Dock ramp: z 459 → 499 rising 6 → 10. */
const DOCK_Z0 = 459;
const DOCK_Z1 = 499;
const DOCK_TOP = 10;
const DOCK_DEG = (Math.atan2(DOCK_TOP - DECK, DOCK_Z1 - DOCK_Z0) * 180) / Math.PI;
const DOCK_LEN = Math.hypot(DOCK_TOP - DECK, DOCK_Z1 - DOCK_Z0);
const dockY = (z: number): number => DECK + ((z - DOCK_Z0) / (DOCK_Z1 - DOCK_Z0)) * (DOCK_TOP - DECK);

/** Gear Works discs. */
const GEAR_1 = { x: -3, z: 286, r: 6.5 };
const GEAR_2 = { x: 3, z: 299.6, r: 6.5 };
const GEAR_EXIT_Z = 308.1;

/** Crossbelt strips (z centres) and the static seams between them. */
const XBELTS = [209, 217, 225, 233] as const;
const SEAMS = [213, 221, 229] as const;

/** QC Scanner laser pivots. */
const LASERS = [
  { id: 's7-laser-1', z: 397, height: 0.6, speed: 72, dir: 1 },
  { id: 's7-laser-2', z: 415, height: 1.3, speed: 72, dir: -1 },
  { id: 's7-laser-3', z: 431, height: 0.6, speed: 86, dir: 1 },
] as const;

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

const CP = [
  checkpoint({ index: 1, top: 0, z: 124, width: 20, respawnAhead: 3 }),
  checkpoint({ index: 2, top: DECK, z: 240, width: 24, respawnAhead: 3 }),
  checkpoint({ index: 3, top: DECK, z: 385, width: 20, respawnAhead: 3 }),
  checkpoint({ index: 4, top: DECK, z: 457, width: 22, respawnAhead: 1 }),
];

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const crate = (x: number, y: number, z: number, s: number, color: string): Piece =>
  box(x, y, z, s, s, s, { color, pattern: 'stripes', bevel: 0.25, decorative: true });

const chimney = (x: number, z: number, h: number): Piece[] =>
  deco(
    cyl(x, h / 2 - 20, z, 3, h, { color: 'neutral', pattern: 'stripes' }),
    cyl(x, h - 19.5, z, 3.6, 1, { color: 'danger' }),
    sphere(x, h - 15, z, 3.2, { color: '#e9e4f2' }),
    sphere(x + 2, h - 11, z + 1, 2.4, { color: '#f3eefa' }),
  );

const loadingBay: Piece[] = [
  floor(0, 0, -10, 10, 26, { color: 'neutral' }),
  paint(0, 0, 8, 26, 2, { color: 'safe', pattern: 'checker' }),
  ...mirrorX(box(13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' })),
  box(0, 1.5, -10.5, 26, 3, 1, { color: 'neutral' }),
  // Giant crate stack behind the start.
  crate(-8, 3, -14, 6, 'secondary'),
  crate(-1.5, 3, -14.5, 6, 'accent'),
  crate(5, 3, -14, 6, 'primary'),
  crate(-4.5, 8.5, -14.5, 5, 'primary'),
  crate(2, 8.5, -14, 5, 'secondary'),
  crate(-1, 13, -14.5, 4, 'accent'),
];

const intakeBelts: Piece[] = [
  floor(0, 0, 10, 14, 26, { color: 'secondary' }),
  floor(0, 0, 54, 60, 26, { color: 'secondary' }),
  ...mirrorX(box(12.75, 0.5, 34, 0.5, 1, 40, { color: 'neutral' })),
  ...[-6, 0, 6].map((x) =>
    box(x, 0.15, 34, 0.3, 0.3, 40, { color: 'neutral', pattern: 'stripes', bevel: 0.08 }),
  ),
  // Overhead lane-sign gantry with arrow screens.
  ...deco(
    box(0, 6, 34, 26, 0.6, 1, { color: 'neutral' }),
    ...mirrorX(box(13, 3, 34, 0.6, 6, 0.6, { color: 'neutral' })),
    box(-9, 7.2, 34, 4, 1.6, 0.3, { color: 'safe', pattern: 'chevron' }),
    box(-3, 7.2, 34, 4, 1.6, 0.3, { color: 'danger', pattern: 'chevron', rotation: { yaw: 180 } }),
    box(3, 7.2, 34, 4, 1.6, 0.3, { color: 'safe', pattern: 'chevron' }),
    box(9, 7.2, 34, 4, 1.6, 0.3, { color: 'danger', pattern: 'chevron', rotation: { yaw: 180 } }),
  ),
];

const punchLine: Piece[] = [
  floor(0, 0, 60, 62, 12, { color: 'secondary' }),
  floor(0, 0, 90, 92, 8, { color: 'safe' }),
  paint(3.8, 0, 76, 0.4, 28, { color: 'danger', pattern: 'hazard' }),
  paint(-3.8, 0, 107, 0.4, 30, { color: 'danger', pattern: 'hazard' }),
  box(-5.7, 2.5, 76, 2, 5, 28, { color: 'neutral', bevel: 0.3 }),
  box(5.7, 2.5, 107, 2, 5, 30, { color: 'neutral', bevel: 0.3 }),
  floor(0, 0, 122, 134, 20, { color: 'safe' }),
  ...deco(
    box(-5.7, 5.4, 76, 2.4, 0.8, 28.4, { color: 'danger', pattern: 'hazard' }),
    box(5.7, 5.4, 107, 2.4, 0.8, 30.4, { color: 'danger', pattern: 'hazard' }),
  ),
];

/** Pitched box lying on the Flip Ramp slope: `lift` is its centre height above the belt surface. */
const onFlip = (x: number, w: number, h: number, lift: number, o: Parameters<typeof box>[6] = {}): Piece =>
  box(x, flipY(159) + lift, 159, w, h, FLIP_LEN + 0.4, { rotation: { pitch: -FLIP_DEG }, ...o });

const flipRamp: Piece[] = [
  onFlip(0, 1, 0.6, 0, { color: 'neutral', pattern: 'stripes' }),
  ...mirrorX(onFlip(7.75, 0.5, 2, 0.5, { color: 'neutral' })),
  floor(0, DECK, 184, 206, 20, { color: 'primary' }),
];

const crossbelts: Piece[] = [
  ...SEAMS.map((z) => floor(0, DECK, z - 1, z + 1, 20, { color: 'secondary' })),
  floor(0, DECK, 236, 256, 24, { color: 'safe' }),
  paint(-10, DECK, 222, 0.4, 28, { color: 'danger', pattern: 'hazard' }),
  paint(10, DECK, 222, 0.4, 28, { color: 'danger', pattern: 'hazard' }),
];

const gearWorks: Piece[] = [
  floor(0, DECK, 260.8, 266, 16, { color: 'primary' }),
  floor(0, DECK, 270.8, 278, 16, { color: 'primary' }),
  floor(0, DECK, GEAR_EXIT_Z, 321, 26, { color: 'safe' }),
  box(11.5, 5.5, 256.5, 1.5, 1, 1, { color: 'accent', pattern: 'hazard' }),
  box(11.5, 5.5, 308.5, 1.5, 1, 1, { color: 'accent' }),
  ...deco(
    cyl(GEAR_1.x, 1, GEAR_1.z, 1, 9, { color: 'neutral' }),
    cyl(GEAR_2.x, 1, GEAR_2.z, 1, 9, { color: 'neutral' }),
    // Giant background cog teeth.
    cyl(-24, 4, 292, 9, 2, { color: 'accent', rotation: { roll: 90 }, pattern: 'dots' }),
    cyl(24, 2, 300, 7, 2, { color: 'secondary', rotation: { roll: 90 }, pattern: 'dots' }),
  ),
];

const pressHall: Piece[] = [
  ...mirrorX(box(10.5, 8, 351, 1, 4, 60, { color: 'neutral' })),
  ...deco(
    box(0, 14, 351, 22, 1, 60, { color: 'neutral', pattern: 'stripes' }),
    ...mirrorX(box(10.5, 12, 351, 1, 4, 60, { color: 'neutral' })),
    ...[331, 343, 355, 367].map((z) => sphere(0, 12.8, z, 0.7, { color: 'accent' })),
  ),
  floor(0, DECK, 381, 395, 20, { color: 'safe' }),
];

const qcScanners: Piece[] = [
  ...mirrorX(box(6.5, 6.75, 425, 1, 1.5, 60, { color: 'neutral' })),
  ...deco(...LASERS.map((l) => arch(0, DECK, l.z, 15, 5, 1, { color: 'neutral', pattern: 'stripes' }))),
  ...deco(...mirrorX(box(6.5, 7.6, 410, 0.2, 0.8, 6, { color: 'safe', pattern: 'checker' }))),
];

/** Pitched box lying on the dock slope; `lift` is its centre height above the ramp surface. */
const onDock = (x: number, w: number, h: number, lift: number, o: Parameters<typeof box>[6] = {}): Piece =>
  box(x, dockY(479) + lift, 479, w, h, DOCK_LEN + 0.4, { rotation: { pitch: -DOCK_DEG }, ...o });

const shippingDock: Piece[] = [
  floor(0, DECK, 455, 459, 22, { color: 'safe' }),
  ...mirrorX(onDock(8.5, 4, 1, -0.5, { color: 'secondary' })),
  ...mirrorX(onDock(10.75, 0.5, 2, 0.5, { color: 'neutral' })),
  floor(0, DOCK_TOP, 499, 515, 24, { color: 'safe', pattern: 'checker' }),
  ...deco(...mirrorX(box(15, 13, 500, 6, 6, 30, { color: 'neutral', pattern: 'stripes' }))),
];

const factoryDecor: Piece[] = [
  ...chimney(-40, 60, 50),
  ...chimney(42, 180, 58),
  ...chimney(-44, 300, 54),
  ...chimney(40, 420, 60),
  crate(-20, -4, 40, 5, 'accent'),
  crate(22, -6, 120, 6, 'primary'),
  crate(-22, 0, 210, 5, 'secondary'),
  crate(24, 2, 330, 6, 'accent'),
  crate(-20, 3, 470, 5, 'primary'),
  // Overhead gantry crane rails carrying giant toys.
  ...deco(
    box(0, 22, 250, 2, 1.2, 420, { color: 'neutral', pattern: 'stripes' }),
    sphere(0, 18, 150, 3, { color: 'danger', pattern: 'dots' }),
    sphere(0, 18, 330, 3, { color: 'accent', pattern: 'dots' }),
  ),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const belt = (
  id: string,
  x: number,
  y: number,
  z: number,
  params: Record<string, unknown>,
  rotation?: Obstacle['rotation'],
): Obstacle => ({
  id,
  type: 'conveyorBelt',
  position: v(x, y, z),
  ...(rotation ? { rotation } : {}),
  params,
});

const PUNCH = {
  pistonCount: 7,
  pistonSpacing: 4,
  pistonSize: 3.4,
  pistonHeight: 1.7,
  reach: 5.5,
  punchTime: 0.15,
  holdTime: 0.5,
  retractTime: 0.8,
  period: 3,
  pattern: 'wave',
  waveStep: 0.35,
  telegraphLead: 0.6,
  wallHeight: 5,
  knockSpeed: 13,
  knockLift: 6,
};

const FLIP_BELT = {
  length: FLIP_LEN,
  width: 7,
  speed: 3,
  pattern: 'switch',
  switchPeriod: 5,
  switchRamp: 0.4,
  telegraphLead: 1,
  rails: false,
};

const XBELT = {
  length: 20,
  width: 6,
  speed: 3.5,
  pattern: 'switch',
  switchRamp: 0.4,
  telegraphLead: 1,
  rails: false,
};

const seamCart = (id: string, z: number, phaseSeed: number): Obstacle => ({
  id,
  type: 'bumperCar',
  position: v(0, DECK, z),
  params: {
    path: 'oval',
    radiusX: 6,
    radiusZ: 0.2,
    cars: 1,
    speed: 7.5,
    speedVariation: 0.3,
    variationPeriod: 3.2,
    carLength: 1.8,
    carWidth: 1.4,
    carHeight: 1.1,
    bumpImpulse: 9,
    seed: phaseSeed,
  },
});

const laneBumper = (id: string, x: number, z: number, angle: number): Obstacle => ({
  id,
  type: 'bumperPillar',
  position: v(x, dockY(z), z),
  params: {
    radius: 0.8,
    height: 2.2,
    bounceSpeed: 9,
    orbitRadius: 1,
    orbitSpeed: (2 * Math.PI) / 2.2,
    phase: angle,
  },
});

const obstacles: Obstacle[] = [
  { id: 's0-gate', type: 'startGate', position: v(0, 0, 7), params: { width: 26, height: 3 } },

  belt('s1-belt-a', -9, 0, 34, { length: 40, width: 6, speed: 3, rails: false }),
  belt('s1-belt-b', -3, 0, 34, { length: 40, width: 6, speed: 2.5, pattern: 'backward', rails: false }),
  belt('s1-belt-c', 3, 0, 34, { length: 40, width: 6, speed: 2, rails: false }),
  belt('s1-belt-d', 9, 0, 34, { length: 40, width: 6, speed: 3.5, pattern: 'backward', rails: false }),

  belt('s2-belt-1', 0, 0, 76, { length: 28, width: 8, speed: 2, rails: false }),
  belt('s2-belt-2', 0, 0, 107, { length: 30, width: 8, speed: 2, rails: false }),
  { id: 's2-punch-L', type: 'punchWall', position: v(-4.7, 0, 76), rotation: { yaw: 90 }, params: PUNCH },
  {
    id: 's2-punch-R',
    type: 'punchWall',
    position: v(4.7, 0, 107),
    rotation: { yaw: -90 },
    params: { ...PUNCH, pattern: 'alternate', period: 2.6 },
  },

  belt('s3-belt-L', -4, flipY(159), 159, FLIP_BELT, { pitch: -FLIP_DEG }),
  // Same belt turned around: its "forward" is downhill, so the two lanes always disagree.
  belt('s3-belt-R', 4, flipY(159), 159, FLIP_BELT, { yaw: 180, pitch: FLIP_DEG }),
  {
    id: 's3-bump-1',
    type: 'bumperPillar',
    position: v(-4, flipY(150), 150),
    params: { radius: 0.8, height: 2.2, bounceSpeed: 8 },
  },
  {
    id: 's3-bump-2',
    type: 'bumperPillar',
    position: v(4, flipY(168), 168),
    params: { radius: 0.8, height: 2.2, bounceSpeed: 8 },
  },

  belt('s4-xbelt-1', 0, DECK, XBELTS[0], { ...XBELT, switchPeriod: 3.5 }, { yaw: 90 }),
  belt('s4-xbelt-2', 0, DECK, XBELTS[1], { ...XBELT, switchPeriod: 3.5 }, { yaw: -90 }),
  belt('s4-xbelt-3', 0, DECK, XBELTS[2], { ...XBELT, switchPeriod: 2.9 }, { yaw: 90 }),
  belt('s4-xbelt-4', 0, DECK, XBELTS[3], { ...XBELT, switchPeriod: 2.9 }, { yaw: -90 }),
  seamCart('s4-bump-1', SEAMS[0], 1),
  seamCart('s4-bump-2', SEAMS[1], 2),
  seamCart('s4-bump-3', SEAMS[2], 3),

  {
    id: 's5-drum-1',
    type: 'rollingDrum',
    position: v(0, 4.1, 258.4),
    params: { length: 16, radius: 2.2, spinSpeed: 92, ridges: 10, ridgeHeight: 0.15 },
  },
  {
    id: 's5-drum-2',
    type: 'rollingDrum',
    position: v(0, 4.1, 268.4),
    params: { length: 16, radius: 2.2, spinSpeed: 115, ridges: 10, ridgeHeight: 0.15 },
  },
  {
    id: 's5-gear-1',
    type: 'spinningDisc',
    position: v(GEAR_1.x, DECK, GEAR_1.z),
    params: { radius: GEAR_1.r, thickness: 1, speed: 0.7, bumps: 6, bumpRadius: 0.6, bumpKnock: 3 },
  },
  {
    id: 's5-gear-2',
    type: 'spinningDisc',
    position: v(GEAR_2.x, DECK, GEAR_2.z),
    params: {
      radius: GEAR_2.r,
      thickness: 1,
      speed: -0.7,
      phase: 0.52,
      bumps: 6,
      bumpRadius: 0.6,
      bumpKnock: 3,
    },
  },
  {
    id: 's5-catwalk',
    type: 'collapsingBridge',
    position: v(11.5, DECK, 257),
    params: {
      segments: 17,
      segmentLength: 3,
      width: 1.5,
      thickness: 0.4,
      startDelay: 6,
      interval: 0.45,
      order: 'sequential',
      warnTime: 0.8,
      respawnDelay: 5,
      cycleGap: 3,
    },
  },

  {
    id: 's6-pistons',
    type: 'popupBlocks',
    position: v(0, DECK, 351),
    // Rows pattern advances toward local −Z each cycle; yawed 180° it rolls forward.
    rotation: { yaw: 180 },
    params: {
      cols: 5,
      rows: 15,
      cellSize: 4,
      gap: 0.12,
      blockHeight: 2,
      popHeight: 1.5,
      period: 1.6,
      warnTime: 0.4,
      riseTime: 0.2,
      holdTime: 0.6,
      fallTime: 0.4,
      pattern: 'rows',
      density: 0.34,
      launchImpulse: 8,
    },
  },

  belt('s7-belt', 0, DECK, 425, { length: 60, width: 12, speed: 3.5, rails: false }),
  ...LASERS.map((l): Obstacle => ({
    id: l.id,
    type: 'laserSweep',
    position: v(0, DECK, l.z),
    params: {
      mode: 'full',
      length: 6,
      height: l.height,
      radius: 0.18,
      speed: l.speed,
      direction: l.dir,
      knockImpulse: 5,
    },
  })),

  belt(
    's8-belt',
    0,
    dockY(479),
    479,
    {
      length: DOCK_LEN,
      width: 12,
      speed: 3.5,
      pattern: 'switch',
      switchPeriod: 3,
      switchRamp: 0.3,
      telegraphLead: 1,
      rails: true,
      railHeight: 0.6,
    },
    { pitch: -DOCK_DEG },
  ),
  laneBumper('s8-bump-L1', -8.5, 471, 0),
  laneBumper('s8-bump-L2', -8.5, 483, 2.07),
  laneBumper('s8-bump-L3', -8.5, 495, 4.15),
  laneBumper('s8-bump-R1', 8.5, 471, 3.14),
  laneBumper('s8-bump-R2', 8.5, 483, 5.21),
  laneBumper('s8-bump-R3', 8.5, 495, 1.0),
  { id: 's8-finish', type: 'finishLine', position: v(0, DOCK_TOP, 506), params: { width: 24, height: 6.5 } },

  ...CP.flatMap((c) => c.obstacles),
];

// -----------------------------------------------------------------------------
// Bot navigation
// -----------------------------------------------------------------------------

/** See Gumdrop Gauntlet: take-off 0.3 m past the lip, 1.5 m radius, after a straight line-up. */
const JUMP = { r: 1.5, action: 'jump' } as const;
const LINEUP = { r: 1.2 } as const;

const rimHop = (
  a: { x: number; z: number; r: number },
  b: { x: number; z: number },
): [number, number, number] => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz);
  return [a.x + (dx / l) * (a.r - 0.3), DECK, a.z + (dz / l) * (a.r - 0.3)];
};

const nav = new NavBuilder();
nav
  .add(0, [0, 0, 5], [10, 11], { r: 3 })
  .add(10, [-9, 0, 15], 12, { r: 2 })
  .add(11, [3, 0, 15], 13, { r: 2 })
  .add(12, [-9, 0, 55], 100, { r: 2 })
  .add(13, [3, 0, 55], 100, { r: 2 })
  // The Punch Line: hug the void-side strip, waiting out each panel wave.
  .add(100, [0, 0, 61], 101, { r: 2 })
  .add(101, [2.2, 0, 64], 102, { r: 1, action: 'waitForGap', timeAgainst: 's2-punch-L' })
  .add(102, [2.2, 0, 89], 103, { r: 1 })
  .add(103, [-2.2, 0, 93], 104, { r: 1, action: 'waitForGap', timeAgainst: 's2-punch-R' })
  .add(104, [-2.2, 0, 120], 105, { r: 1 })
  .add(105, [0, 0, 131], [200, 210], { r: 3 })
  // Flip Ramp: either lane (bots can't read the horn; they just push through).
  .add(200, [-4, 0, 135.5], 201, { r: 2 })
  .add(201, [-4, flipY(166), 166], 202, { r: 2 })
  .add(210, [4, 0, 135.5], 211, { r: 2 })
  .add(211, [4, flipY(166), 166], 202, { r: 2 })
  .add(202, [0, DECK, 190], 300, { r: 3 })
  // Crossbelts: straight across, timing the seam carts.
  .add(300, [0, DECK, 204], 301, { r: 2 })
  .add(301, [0, DECK, SEAMS[0] - 2], 302, { r: 1.5, action: 'waitForGap', timeAgainst: 's4-bump-1' })
  .add(302, [0, DECK, SEAMS[1] - 2], 303, { r: 1.5, action: 'waitForGap', timeAgainst: 's4-bump-2' })
  .add(303, [0, DECK, SEAMS[2] - 2], 304, { r: 1.5, action: 'waitForGap', timeAgainst: 's4-bump-3' })
  .add(304, [0, DECK, 244], [400, 410], { r: 3 })
  // Gear Works: sprint the drums, hop the gears; or gamble on the catwalk.
  .add(400, [0, DECK, 254.5], 401, { r: 1.5 })
  .add(401, [0, DECK, 263.4], 402, { r: 1.5 })
  .add(402, [GEAR_1.x, DECK, 275], 403, LINEUP)
  .add(403, [GEAR_1.x, DECK, 278.3], 404, JUMP)
  .add(404, [GEAR_1.x, DECK, GEAR_1.z], 405, { r: 2 })
  .add(405, rimHop(GEAR_1, GEAR_2), 406, JUMP)
  .add(406, [GEAR_2.x, DECK, GEAR_2.z], 407, { r: 2 })
  .add(407, [GEAR_2.x, DECK, GEAR_2.z + GEAR_2.r - 0.3], 408, JUMP)
  .add(408, [0, DECK, 314], 500, { r: 3 })
  .add(410, [11.5, DECK, 256.5], 411, { r: 0.6 })
  .add(411, [11.5, DECK, 308.5], 408, { r: 0.6 })
  // Press Hall: straight through the piston wave (stuck bots hop onto risen blocks).
  .add(500, [0, DECK, 320], 501, { r: 3 })
  .add(501, [0, DECK, 351], 502, { r: 4 })
  .add(502, [0, DECK, 383], 600, { r: 3 })
  // QC Scanners.
  .add(600, [0, DECK, 396], 601, { r: 2 })
  .add(601, [0, DECK, 425], 602, { r: 3 })
  .add(602, [0, DECK, 456], [700, 710, 711], { r: 2 })
  // Shipping Dock: the reversing belt, or a static side lane past the bumpers.
  .add(700, [0, DECK, 459], 701, { r: 2 })
  .add(701, [0, DOCK_TOP, 501], 800, { r: 3 })
  .add(710, [-8.5, DECK, 459.5], 712, { r: 1.2 })
  .add(712, [-8.5, DOCK_TOP, 500], 800, { r: 1.5 })
  .add(711, [8.5, DECK, 459.5], 713, { r: 1.2 })
  .add(713, [8.5, DOCK_TOP, 500], 800, { r: 1.5 })
  .add(800, [0, DOCK_TOP, 506], [], { r: 4 });

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

export default defineRound({
  id: 'conveyor-chaos',
  name: 'Conveyor Chaos',
  type: 'race',
  theme: 'factory',
  objective: 'Ride the belts to the finish! Read the arrows.',
  tips: [
    'Chevron lights show which way a belt runs — and flash before it flips.',
    'Punch walls light up before they fire. Stay on the far side.',
    'Pistons are platforms too: hop on top and ride the wave.',
  ],
  players: { min: 12, max: 60, ideal: 40 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 240, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-50, -25, -25), max: v(50, 60, 530) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 8, spacing: 1.4 },
  geometry: [
    ...loadingBay,
    ...intakeBelts,
    ...punchLine,
    ...flipRamp,
    ...crossbelts,
    ...gearWorks,
    ...pressHall,
    ...qcScanners,
    ...shippingDock,
    ...CP.flatMap((c) => c.geometry),
    ...factoryDecor,
  ],
  obstacles,
  triggers: [
    {
      id: 'cp-0',
      kind: 'checkpoint',
      index: 0,
      position: v(0, 2, 0),
      size: v(26, 4, 20),
      respawn: [-6, -3, 0, 3, 6].map((x) => v(x, 0.1, 2)),
    },
    ...CP.map((c) => c.trigger),
    { id: 'finish', kind: 'finish', position: v(0, DOCK_TOP + 2, 506), size: v(24, 4, 2) },
  ],
  flyover: {
    path: [
      v(-25, 18, -12),
      v(18, 14, 70),
      v(-20, 16, 150),
      v(22, 20, 225),
      v(-18, 22, 300),
      v(0, 26, 330),
      v(20, 18, 440),
      v(0, 20, 535),
    ],
    lookAt: [
      v(0, 0, 30),
      v(0, 1, 92),
      v(0, 4, 165),
      v(0, 6, 225),
      v(0, 6, 290),
      v(0, 6, 370),
      v(0, 6, 425),
      v(0, 10, 506),
    ],
    duration: 8,
  },
  cameraMode: 'orbit',
  music: 'mus_factory_clockwork',
  speedScaleByStage: [1.0, 1.1, 1.2, 1.3, 1.4],
  fallBehavior: 'respawnCheckpoint',
  botNav: nav.build(),
  variations: [
    { id: 'day-shift', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'overtime-shift',
      weight: 2,
      weather: 'clear',
      description: 'The intake belts also reverse.',
      obstacleParams: {
        's1-belt-a': { pattern: 'switch', switchPeriod: 4 },
        's1-belt-b': { pattern: 'switch', switchPeriod: 3.4 },
        's1-belt-c': { pattern: 'switch', switchPeriod: 4.6 },
        's1-belt-d': { pattern: 'switch', switchPeriod: 3.8 },
      },
    },
    {
      id: 'night-shift',
      weight: 1,
      weather: 'night',
      description: 'Lasers glow; laser 2 drops low and a high laser joins the scanners.',
      obstacleParams: { 's7-laser-2': { height: 0.6 } },
      addObstacles: [
        {
          id: 's7-laser-4',
          type: 'laserSweep',
          position: v(0, DECK, 406),
          params: { mode: 'full', length: 6, height: 1.3, radius: 0.18, speed: 69, knockImpulse: 5 },
        },
      ],
    },
    {
      id: 'heavy-load',
      weight: 2,
      weather: 'stormy',
      description: 'Punch walls on both sides of the first corridor — the safe strip moves to the centre.',
      addObstacles: [
        {
          id: 's2-punch-R2',
          type: 'punchWall',
          position: v(4.7, 0, 76),
          rotation: { yaw: -90 },
          params: { ...PUNCH, reach: 3, phase: 1.5 },
        },
      ],
    },
    {
      id: 'piston-checker',
      weight: 1,
      weather: 'clear',
      description: 'Pistons fire in a checker pattern.',
      obstacleParams: { 's6-pistons': { pattern: 'checker', period: 2.4, holdTime: 1.2 } },
    },
  ],
  decorSeed: 1201,
  designNotes:
    'Every surface moves. Lane choice (Intake) → telegraph reading (Punch Line) → reversing lanes (Flip Ramp) → ' +
    'lateral drift (Crossbelts) → treadmill drums + gear hops or the collapsing catwalk (Gear Works) → piston wave ' +
    '(Press Hall) → low/high lasers over a fast belt (QC) → reversing finish ramp vs bumper side lanes. ' +
    'Approximations: belts are phase-shifted by yawing 180°, seam bumpers are carts, QC lasers rotate instead of sliding, ' +
    'catwalk collapses on a timer, piston wave runs at ≈2.5 m/s (popupBlocks rows pattern).',
});
