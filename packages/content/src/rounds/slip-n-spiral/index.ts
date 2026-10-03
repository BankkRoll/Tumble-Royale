/**
 * R4 — Slip 'n' Spiral (LEVELS.md §4 R4). A bobsled run carved into a
 * snow-globe mountain: start at the summit, slide 2.5 turns down an ice tube
 * while giant snowballs chase you, then shoot out onto a glacier slide and a
 * final skating rink. Summit Start → Powder Run → Penguin Slalom → Crack
 * Bridges + The Chute → The Spiral → Glacier Slide → Icicle Hall → Rink Finale.
 *
 * Transcription notes (design → shipped obstacle modules):
 * - The spiral is generated from the design formula (see `spiral.ts`); its
 *   snowball is a chain of per-segment `boulderLane`s (balls only roll straight).
 * - `collapsingBridge` is timed only (no touch trigger, no ice surface): the
 *   Crack Bridges crack in a chasing wave (near end first), staggered
 *   so at any moment at least one bridge is whole.
 * - `fanZone` has a solid housing behind its face, so the spiral gusts blow
 *   across the lane from the outer wall instead of straight up the tube.
 * - Moving penguins orbit (bumperPillar has no linear slide).
 * - The rink boards are 14 box segments (no partial torus), leaving the entry
 *   and exit open.
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
  pillar,
  ramp,
  sphere,
  v,
  type Obstacle,
  type Piece,
  type Trigger,
} from '../gumdrop-gauntlet/kit.ts';
import {
  SPIRAL_CENTRE,
  SPIRAL_VERTICES,
  segmentPoint,
  spiralGeometry,
  spiralSegment,
  spiralSnowballs,
  spiralVertex,
} from './spiral.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SUMMIT = 80;
const SLALOM = 72;
/** Powder Run: z 10 → 70, 80 → 72. */
const powderY = (z: number): number => SUMMIT - ((z - 10) / 60) * (SUMMIT - SLALOM);
const POWDER_DEG = (Math.atan2(SUMMIT - SLALOM, 60) * 180) / Math.PI;

/** Glacier Slide: deck top from (z 256, y 22) to (z 315, y 6). */
const SLIDE = { z0: 256, y0: 22, z1: 315, y1: 6 };
const SLIDE_LEN = Math.hypot(SLIDE.z1 - SLIDE.z0, SLIDE.y0 - SLIDE.y1);
const SLIDE_DEG = (Math.atan2(SLIDE.y0 - SLIDE.y1, SLIDE.z1 - SLIDE.z0) * 180) / Math.PI;

const HALL = 6;
const RINK = { z: 392, r: 18 };
const FINISH_TOP = 7.2;

const PENGUINS = [
  [-6, 78],
  [2, 82],
  [8, 90],
  [-2, 94],
  [6, 112],
  [-6, 120],
  [3, 122],
  [9, 118],
] as const;

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

const CP_FLAT = [
  checkpoint({ index: 1, top: SLALOM, z: 128, width: 24, respawnAhead: 2 }),
  checkpoint({ index: 2, top: SLALOM, z: 174, width: 22, respawnAhead: 2 }),
];
const CP_RUNOUT = checkpoint({ index: 5, top: HALL, z: 320, width: 20, respawnAhead: 3 });

/**
 * Checkpoint across the spiral lane at vertex `k`: a thin trigger across the
 * lane and respawn points 2–4 m down the next segment, facing travel.
 */
function spiralCheckpoint(index: number, k: number): Trigger {
  const p = spiralVertex(k);
  const s = spiralSegment(k);
  const respawn = [0.15, 0.3].flatMap((t) => [-1.5, 0, 1.5].map((lat) => segmentPoint(k, t, lat)));
  return {
    id: `cp-${index}`,
    kind: 'checkpoint',
    index,
    position: v(p.x, p.y + 2, p.z),
    size: v(8, 4, 2),
    rotation: { yaw: Math.round(s.travelYaw) },
    respawn: respawn.map((q) =>
      v(Math.round(q.x * 100) / 100, Math.round((q.y + 0.1) * 100) / 100, Math.round(q.z * 100) / 100),
    ),
    respawnYaw: Math.round(s.travelYaw),
  };
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const pine = (x: number, y: number, z: number, s: number): Piece[] =>
  deco(
    cyl(x, y + 1 * s, z, 0.5 * s, 2 * s, { color: '#8a6a52' }),
    { shape: 'wedge', position: v(x, y + 4 * s, z), size: v(4 * s, 4 * s, 4 * s), color: '#4f9e86' },
    {
      shape: 'wedge',
      position: v(x, y + 6.5 * s, z),
      size: v(3 * s, 3 * s, 3 * s),
      color: '#5fb39a',
      rotation: { yaw: 90 },
    },
  );

const floe = (x: number, y: number, z: number, s: number): Piece[] =>
  deco(cyl(x, y, z, 6 * s, 2 * s, { color: '#f4fbff', bevel: 0.5 }), ...pine(x, y + s, z, s));

const summitStart: Piece[] = [
  floor(0, SUMMIT, -10, 10, 26, { color: 'safe', pattern: 'checker' }),
  ...mirrorX(box(13.25, SUMMIT + 0.5, 0, 0.5, 1, 20, { color: 'neutral' })),
  box(0, SUMMIT + 1.5, -10.5, 26, 3, 1, { color: 'neutral' }),
  ...deco(
    sphere(0, SUMMIT + 2, -13, 6, { color: '#f4fbff' }),
    sphere(-9, SUMMIT + 1, -12, 4.5, { color: '#f4fbff' }),
  ),
];

const powderRun: Piece[] = [
  ramp(0, 78.67, 20, 22, 2.67, 20, { rotation: { yaw: 180 }, color: 'primary' }),
  ramp(0, 76, 40, 22, 2.67, 20, { rotation: { yaw: 180 }, surface: 'ice', color: 'secondary' }),
  ramp(0, 73.33, 60, 22, 2.67, 20, { rotation: { yaw: 180 }, color: 'primary' }),
  ...mirrorX(
    box(11.25, powderY(40) + 0.5, 40, 0.5, 2, 60.6, { rotation: { pitch: POWDER_DEG }, color: 'neutral' }),
  ),
  // Snow-cannon holes the snowballs roll out of.
  ...deco(
    box(-11.6, powderY(25) + 1, 25, 0.6, 2.4, 2.4, { color: 'danger', pattern: 'hazard' }),
    box(11.6, powderY(45) + 1, 45, 0.6, 2.4, 2.4, { color: 'danger', pattern: 'hazard' }),
    box(-11.6, powderY(60) + 1, 60, 0.6, 2.4, 2.4, { color: 'danger', pattern: 'hazard' }),
  ),
];

const penguinSlalom: Piece[] = [
  box(0, SLALOM - 0.5, 100.5, 24, 1, 61, { surface: 'ice', color: 'secondary', bevel: 0.3 }),
  box(-5, SLALOM + 0.1, 84, 5, 0.2, 5, { color: 'primary', pattern: 'dots' }),
  box(6, SLALOM + 0.1, 100, 5, 0.2, 5, { color: 'primary', pattern: 'dots' }),
  box(-3, SLALOM + 0.1, 116, 5, 0.2, 5, { color: 'primary', pattern: 'dots' }),
  ...mirrorX(paint(11.8, SLALOM, 100.5, 0.4, 61, { color: 'danger', pattern: 'hazard' })),
];

const crackBridges: Piece[] = [
  floor(0, SLALOM, 171, 177, 22, { color: 'safe' }),
  ramp(0, 71, 186.25, 7, 2, 18.5, {
    rotation: { yaw: 180 },
    surface: 'ice',
    color: 'secondary',
    pattern: 'chevron',
  }),
  box(4, SLALOM, 180, 8.5, 2, 0.5, { rotation: { yaw: -35 }, color: 'neutral', pattern: 'stripes' }),
  box(-4, SLALOM, 180, 8.5, 2, 0.5, { rotation: { yaw: 35 }, color: 'neutral', pattern: 'stripes' }),
  ...mirrorX(box(3.75, 71 + 1.25, 186.25, 0.5, 2.5, 18.7, { rotation: { pitch: 6.17 }, color: 'neutral' })),
  ...deco(
    arch(0, 70, 195, 9, 6, 2, { color: 'accent', pattern: 'stripes' }),
    // Ice-crystal arches over the chute.
    arch(0, 71.4, 182, 10, 7, 0.6, { color: '#cfefff' }),
    arch(0, 70.6, 189, 10, 7, 0.6, { color: '#cfefff' }),
  ),
];

const spiralDecor: Piece[] = [
  cyl(SPIRAL_CENTRE.x, 46, SPIRAL_CENTRE.z, 12, 52, { color: 'neutral', bevel: 0.5 }),
  ...deco(
    sphere(SPIRAL_CENTRE.x, 76, SPIRAL_CENTRE.z, 13, { color: '#f4fbff' }),
    // Warm carved windows in the mountain core.
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i * 60 + 15) * (Math.PI / 180);
      return box(12 * Math.cos(a), 30 + (i % 3) * 12, SPIRAL_CENTRE.z + 12 * Math.sin(a), 1.6, 2.4, 1.6, {
        color: '#ffcf7a',
        rotation: { yaw: 90 - i * 60 - 15 },
      });
    }),
  ),
];

const glacierSlide: Piece[] = [
  box(0, 21.5, 253.5, 12, 1, 5, { color: 'safe' }),
  // Catch walls round the exit pad: riders arrive sliding sideways off turn 3.
  box(-6.25, 22.75, 252.5, 0.5, 1.5, 9, { color: 'neutral' }),
  box(6.25, 22.75, 255, 0.5, 1.5, 4, { color: 'neutral' }),
  floor(0, HALL, 315, 330, 20, { color: 'safe' }),
];

const icicleHall: Piece[] = [
  box(0, HALL - 0.5, 350, 18, 1, 40, { surface: 'ice', color: 'secondary', bevel: 0.3 }),
  ...mirrorX(box(9.5, HALL + 3, 350, 1, 8, 40, { color: '#cfefff' })),
  box(0, HALL + 7.5, 350, 20, 1, 40, { color: 'neutral', pattern: 'stripes' }),
  // Icicle fringe under the roof edge.
  ...deco(
    ...[332, 340, 348, 356, 364].flatMap((z) =>
      mirrorX({
        shape: 'wedge',
        position: v(8.2, HALL + 6.3, z),
        size: v(0.8, 1.4, 0.8),
        rotation: { roll: 180 },
        color: '#e8f8ff',
      }),
    ),
  ),
];

/** 16 board segments around the rink, minus the two covering the entry (−Z) and exit (+Z). */
const rinkBoards: Piece[] = Array.from({ length: 16 }, (_, i) => (i + 0.5) * 22.5)
  .filter((deg) => Math.abs(deg - 90) > 15 && Math.abs(deg - 270) > 15)
  .map((deg) => {
    const a = (deg * Math.PI) / 180;
    return box(18.3 * Math.sin(a), HALL + 0.6, RINK.z + 18.3 * Math.cos(a), 0.4, 1, 7.2, {
      rotation: { yaw: deg + 90 },
      color: 'neutral',
      pattern: 'stripes',
    });
  });

const rinkFinale: Piece[] = [
  box(0, HALL - 0.5, 372, 18, 1, 4, { surface: 'ice', color: 'primary' }),
  pillar(0, HALL, RINK.z, RINK.r, 1, { surface: 'ice', color: 'primary' }),
  box(0, FINISH_TOP - 0.6, 417.5, 24, 1.2, 15, { color: 'safe', pattern: 'checker', grabbable: true }),
  ...rinkBoards,
  ...deco(...mirrorX(box(18, 10, 412, 6, 8, 20, { color: 'neutral', pattern: 'stripes' }))),
  ...deco(...mirrorX(sphere(13, 12, 418, 1.4, { color: 'accent' }))),
];

const frostyDecor: Piece[] = [
  ...floe(-40, 60, 40, 1.2),
  ...floe(42, 64, 110, 1.4),
  ...floe(-48, 40, 230, 1.6),
  ...floe(50, 30, 260, 1.3),
  ...floe(-34, 0, 350, 1.2),
  ...floe(36, -2, 400, 1.5),
  // Frozen waterfall off the summit.
  ...deco(box(30, 50, 20, 6, 50, 2, { color: '#d6f1ff', bevel: 0.6 })),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const snowball = (
  id: string,
  x: number,
  z: number,
  dir: 1 | -1,
  params: Record<string, unknown>,
): Obstacle => ({
  id,
  type: 'boulderLane',
  position: v(x, powderY(z), z),
  rotation: { yaw: dir * 90 },
  params: {
    lanes: 1,
    length: 24,
    radius: 1,
    speed: 6,
    spawnPeriod: 3,
    dropHeight: 0,
    dropTime: 0.05,
    knockSpeed: 8,
    knockLift: 4,
    ...params,
  },
});

const penguin = (id: string, x: number, z: number, params: Record<string, unknown> = {}): Obstacle => ({
  id,
  type: 'bumperPillar',
  position: v(x, SLALOM, z),
  params: { radius: 0.9, height: 1.8, bounceSpeed: 9, ...params },
});

/** Icicle pendulum swinging across the spiral lane at vertex `k`. */
function icicle(id: string, k: number, phase: number): Obstacle {
  const p = spiralVertex(k);
  // Swing plane across the lane: local Z along the lane tangent.
  const tangentYaw = Math.round((Math.atan2(-Math.sin(p.phi), Math.cos(p.phi)) * 180) / Math.PI + 90);
  return {
    id,
    type: 'pendulumHammer',
    position: v(Math.round(p.x * 100) / 100, p.y, Math.round(p.z * 100) / 100),
    rotation: { yaw: tangentYaw },
    params: {
      pivotHeight: 9,
      armLength: 7.5,
      headRadius: 1,
      headLength: 2.4,
      amplitudeDeg: 40,
      period: 2.4,
      phase,
      knockSpeed: 11,
      knockLift: 5,
    },
  };
}

/** Crosswind gust from the outer wall across spiral segment `k`. */
function gust(id: string, k: number, phase: number): Obstacle {
  const s = spiralSegment(k);
  const a = spiralVertex(k);
  // Outer side: the lateral side farther from the axis.
  const p1 = segmentPoint(k, 0.5, 4.3);
  const p2 = segmentPoint(k, 0.5, -4.3);
  const d = (q: { x: number; z: number }): number => Math.hypot(q.x - SPIRAL_CENTRE.x, q.z - SPIRAL_CENTRE.z);
  const outer = d(p1) > d(p2) ? p1 : p2;
  const inward = Math.atan2(s.mid.x - outer.x, s.mid.z - outer.z) * (180 / Math.PI);
  return {
    id,
    type: 'fanZone',
    position: v(
      Math.round(outer.x * 100) / 100,
      Math.round((a.y + s.mid.y) * 50) / 100 + 0.6,
      Math.round(outer.z * 100) / 100,
    ),
    rotation: { yaw: Math.round(inward) },
    params: {
      width: Math.round(s.length),
      height: 4,
      length: 9,
      strength: 16,
      falloff: 0.3,
      onTime: 2.5,
      offTime: 2.5,
      phase,
      telegraphLead: 0.8,
      housingDepth: 1,
    },
  };
}

const obstacles: Obstacle[] = [
  { id: 's0-gate', type: 'startGate', position: v(0, SUMMIT, 7), params: { width: 26, height: 3 } },

  snowball('s1-snow-1', -12, 25, 1, {}),
  snowball('s1-snow-2', 12, 45, -1, { phase: 1.5 }),
  snowball('s1-snow-3', -12, 60, 1, { speed: 7, spawnPeriod: 2.6, phase: 0.65 }),

  ...PENGUINS.slice(0, 4).map(([x, z], i) => penguin(`s2-peng-${i + 1}`, x, z)),
  penguin('s2-peng-5', -8, 104, { orbitRadius: 2, orbitSpeed: (2 * Math.PI) / 3.5 }),
  penguin('s2-peng-6', 1, 108, { orbitRadius: 2, orbitSpeed: (2 * Math.PI) / 3.5, phase: Math.PI }),
  ...PENGUINS.slice(4).map(([x, z], i) => penguin(`s2-peng-${i + 7}`, x, z, { bounceSpeed: 10 })),

  ...[-7, 0, 7].map((x, i): Obstacle => ({
    id: `s3-crack-${'LCR'[i]}`,
    type: 'collapsingBridge',
    position: v(x, SLALOM, 131),
    params: {
      segments: 10,
      segmentLength: 4,
      width: 4,
      thickness: 0.6,
      startDelay: 4 + i * 7,
      interval: 0.5,
      order: 'sequential',
      warnTime: 1,
      respawnDelay: 2,
      cycleGap: 12,
      seed: 41 + i,
    },
  })),

  ...spiralSnowballs(),
  {
    id: 's4-peng-1',
    type: 'bumperPillar',
    position: v(8.77, 62, 230.18),
    params: { radius: 0.8, height: 1.8, bounceSpeed: 9 },
  },
  {
    id: 's4-peng-2',
    type: 'bumperPillar',
    position: v(-11.23, 58.8, 234.46),
    params: { radius: 0.8, height: 1.8, bounceSpeed: 9 },
  },
  {
    id: 's4-peng-3',
    type: 'bumperPillar',
    position: v(-20.2, 55.6, 215),
    params: { radius: 0.8, height: 1.8, bounceSpeed: 9 },
  },
  icicle('s4-icicle-1', 11, 0),
  icicle('s4-icicle-2', 15, 0.33),
  icicle('s4-icicle-3', 19, 0.66),
  gust('s4-gust-1', 17, 0),
  gust('s4-gust-2', 20, 2.5),

  {
    id: 's5-slide',
    type: 'slideRamp',
    position: v(0, (SLIDE.y0 + SLIDE.y1) / 2, (SLIDE.z0 + SLIDE.z1) / 2),
    params: {
      length: Math.round(SLIDE_LEN * 100) / 100,
      width: 12,
      angle: Math.round(SLIDE_DEG * 100) / 100,
      rails: true,
    },
  },

  ...[
    [338, 0],
    [350, 0.5],
    [362, 0.25],
  ].map(([z, phase], i): Obstacle => ({
    id: `s6-icicle-${i + 1}`,
    type: 'pendulumHammer',
    position: v(0, HALL, z!),
    params: {
      pivotHeight: 7,
      armLength: 5.5,
      headRadius: 1.1,
      headLength: 2.6,
      amplitudeDeg: 60,
      period: 2.6,
      phase,
      knockSpeed: 11,
      knockLift: 5,
      // Hung from the hall roof.
      supports: false,
    },
  })),

  {
    id: 's7-sweep',
    type: 'sweeperArm',
    position: v(0, HALL, RINK.z),
    params: {
      armLength: 16.5,
      armCount: 3,
      armHeight: 0.5,
      armRadius: 0.3,
      baseSpeed: 0.9,
      accel: 0,
      postRadius: 1.5,
      postHeight: 3,
      knockSpeed: 7,
      // Low lift: the rink boards are only 1 m tall.
      knockLift: 3,
    },
  },
  {
    id: 's7-finish',
    type: 'finishLine',
    position: v(0, FINISH_TOP, 418),
    params: { width: 24, height: 6.5 },
  },

  ...CP_FLAT.flatMap((c) => c.obstacles),
  ...CP_RUNOUT.obstacles,
];

// -----------------------------------------------------------------------------
// Bot navigation
// -----------------------------------------------------------------------------

const nav = new NavBuilder();
nav
  .add(0, [0, SUMMIT, 5], 1, { r: 3 })
  .add(1, [0, powderY(30), 30], 2, { r: 3, action: 'waitForGap', timeAgainst: 's1-snow-1' })
  .add(2, [0, powderY(50), 50], 3, { r: 3, action: 'waitForGap', timeAgainst: 's1-snow-3' })
  .add(3, [0, SLALOM, 72], 4, { r: 3 })
  .add(4, [-2, SLALOM, 86], 5, { r: 2.5 })
  .add(5, [3, SLALOM, 100], 6, { r: 2.5 })
  .add(6, [-1, SLALOM, 113], 7, { r: 2.5 })
  .add(7, [0, SLALOM, 129], [100, 101, 102], { r: 3 })
  .add(100, [-7, SLALOM, 132], 110, { r: 1.5 })
  .add(101, [0, SLALOM, 132], 110, { r: 1.5 })
  .add(102, [7, SLALOM, 132], 110, { r: 1.5 })
  .add(110, [0, SLALOM, 175], 111, { r: 3 })
  .add(111, [0, 70, 195], 400, { r: 2 });

// The Spiral: vertex by vertex. Icicles sweep the whole lane width, so bots just commit (no safe gap to wait for).
for (let k = 0; k < SPIRAL_VERTICES; k++) {
  const p = spiralVertex(k);
  nav.add(400 + k, [p.x, p.y, p.z], k < SPIRAL_VERTICES - 1 ? 401 + k : 500, { r: 2.5 });
}
nav
  .add(500, [0, 22, 254], 501, { r: 2 })
  .add(501, [0, HALL, 318], 600, { r: 3 })
  .add(600, [4.5, HALL, 333], 601, { r: 1.5 })
  .add(601, [4.5, HALL, 368], 700, { r: 1.5 })
  .add(700, [0, HALL, 376], 701, { r: 3 })
  // Swing round the sweeper post, then line up on the finish step.
  .add(701, [-5, HALL, RINK.z], 704, { r: 2 })
  .add(704, [-1, HALL, 405], 702, { r: 1.2 })
  .add(702, [0, HALL, 409.6], 703, { r: 1.5, action: 'jump' })
  .add(703, [0, FINISH_TOP, 418], [], { r: 4 });

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

/** Turn-2 lane segments that become `slide` on the aurora night (geometry overrides aren't in the schema). */
const auroraSlides: Obstacle[] = Array.from({ length: 12 }, (_, i) => {
  const s = spiralSegment(12 + i);
  return {
    id: `aurora-slide-${12 + i}`,
    type: 'iceFloor',
    position: v(
      Math.round(s.mid.x * 100) / 100,
      Math.round((s.mid.y + 0.06) * 100) / 100,
      Math.round(s.mid.z * 100) / 100,
    ),
    rotation: { yaw: Math.round(s.travelYaw * 10) / 10, pitch: Math.round(s.slopeDeg * 100) / 100 },
    params: {
      shape: 'box',
      sizeX: 6.8,
      sizeZ: Math.round(s.slopeLength * 100) / 100,
      thickness: 0.1,
      surface: 'slide',
    },
  };
});

export default defineRound({
  id: 'slip-n-spiral',
  name: "Slip 'n' Spiral",
  type: 'race',
  theme: 'frosty',
  objective: 'Slide down the frozen spiral to the finish!',
  tips: [
    'Ice keeps your momentum — start turning early.',
    'Snowballs chase you down the spiral. Duck into the side pockets!',
    'Snow islands give grip. Use them to steer on the rink.',
  ],
  players: { min: 12, max: 60, ideal: 40 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 240, overtimeSeconds: 0 },
  killY: -4,
  bounds: { min: v(-60, -10, -25), max: v(60, 110, 440) },
  spawn: { origin: v(0, SUMMIT + 0.1, 0), yaw: 0, cols: 8, spacing: 1.4 },
  geometry: [
    ...summitStart,
    ...powderRun,
    ...penguinSlalom,
    ...crackBridges,
    ...spiralGeometry(),
    ...spiralDecor,
    ...glacierSlide,
    ...icicleHall,
    ...rinkFinale,
    ...CP_FLAT.flatMap((c) => c.geometry),
    ...CP_RUNOUT.geometry,
    ...frostyDecor,
  ],
  obstacles,
  triggers: [
    {
      id: 'cp-0',
      kind: 'checkpoint',
      index: 0,
      position: v(0, SUMMIT + 2, 0),
      size: v(26, 4, 20),
      respawn: [-6, -3, 0, 3, 6].map((x) => v(x, SUMMIT + 0.1, 2)),
    },
    ...CP_FLAT.map((c) => c.trigger),
    spiralCheckpoint(3, 12),
    spiralCheckpoint(4, 24),
    CP_RUNOUT.trigger,
    { id: 'void-crevasse', kind: 'void', position: v(0, 60, 151), size: v(40, 2, 44) },
    // Catches anyone knocked over a tube wall long before killY (nothing walkable below y 22 here).
    { id: 'void-spiral', kind: 'void', position: v(0, 15, 212.5), size: v(90, 2, 85) },
    { id: 'finish', kind: 'finish', position: v(0, FINISH_TOP + 2, 418), size: v(24, 4, 2) },
  ],
  flyover: {
    path: [
      v(0, 95, -20),
      v(25, 85, 120),
      v(45, 75, 215),
      v(0, 70, 280),
      v(-50, 50, 215),
      v(20, 30, 300),
      v(0, 22, 440),
    ],
    lookAt: [
      v(0, 80, 10),
      v(0, 72, 150),
      v(0, 60, 215),
      v(0, 45, 215),
      v(0, 35, 215),
      v(0, 10, 300),
      v(0, 7, 400),
    ],
    duration: 10,
  },
  cameraMode: 'orbit',
  music: 'mus_frosty_snowglobe',
  speedScaleByStage: [1.0, 1.08, 1.16, 1.24, 1.32],
  fallBehavior: 'respawnCheckpoint',
  botNav: nav.build(),
  variations: [
    { id: 'fresh-powder', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'blizzard',
      weight: 2,
      weather: 'snow',
      description: 'Falling snow and stronger spiral gusts.',
      obstacleParams: { 's4-gust-1': { strength: 22 }, 's4-gust-2': { strength: 22 } },
    },
    {
      id: 'avalanche',
      weight: 2,
      weather: 'clear',
      description: 'Bigger, more frequent snowballs.',
      obstacleParams: {
        ...Object.fromEntries(spiralSnowballs().map((o) => [o.id, { radius: 1.9, spawnPeriod: 4.5 }])),
        's1-snow-1': { spawnPeriod: 2.25 },
        's1-snow-2': { spawnPeriod: 2.25 },
        's1-snow-3': { spawnPeriod: 1.95 },
      },
    },
    {
      id: 'aurora-night',
      weight: 1,
      weather: 'night',
      description: 'Aurora sky; turn 2 of the spiral turns to slide.',
      addObstacles: auroraSlides,
    },
    {
      id: 'penguin-parade',
      weight: 1,
      weather: 'snow',
      description: 'Extra waddling penguins patrol the slalom and the spiral pockets stay busy.',
      addObstacles: [
        penguin('s2-peng-11', -4, 90, { orbitRadius: 2.5, orbitSpeed: 1.6 }),
        penguin('s2-peng-12', 5, 96, { orbitRadius: 2.5, orbitSpeed: -1.6 }),
        penguin('s2-peng-13', 0, 115, { orbitRadius: 3, orbitSpeed: 1.2 }),
      ],
    },
  ],
  decorSeed: 1401,
  designNotes:
    'Summit to rink. Ice basics (Powder Run) → ice steering (Penguin Slalom) → crack bridges + the Chute chokepoint → ' +
    '2.5-turn conical ice tube with a chasing snowball, icicles and gusts → glacier slide → icicle hall → sweeper rink. ' +
    'Approximations: timed (not touch) crack bridges with normal surface; gusts blow across the tube; snowball is a ' +
    'chain of segment lanes (continuous at stage 1, small hand-off pauses at higher stages); the thin-ice variation ' +
    'became penguin-parade (no geometry overrides).',
});
