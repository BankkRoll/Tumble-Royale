/**
 * R3 — Tilt Town (LEVELS.md §4 R3). A sunset boardwalk town built on scales,
 * teacups and seesaws over a glittering bay. Nothing is static; the crowd itself
 * is the hazard. Pier Plaza → Wobble Warm-up → Seesaw Strait → Teeter Bridges
 * → Tilt Tables → Scale Stairs → Wobble Grid & The Plank → Grand Seesaw.
 *
 * Transcription notes (design → shipped obstacle modules):
 * - `tiltPlatform` / `seesaw` stiffness, damping and mass are physical
 *   (N·m/rad, kg; a Tumbler weighs 1 kg), so the design's unitless 1–8
 *   stiffness values were re-derived per piece size: single riders tip a plate
 *   a few degrees, a crowd pins it at its limit.
 * - `seesaw` planks lie along local X, so every seesaw is yawed 90° to rock
 *   along the course. Its origin is the ground under the fulcrum: the plank top
 *   sits `pivotHeight + thickness` above it.
 * - Tilt plates and planks are not grabbable in the shipped modules, so the
 *   design's grab-climbs onto raised ends were made jumpable instead: Strait
 *   seesaws tilt 11° (ends ±1.5 m), The Plank 10°, the Grand Seesaw 5°, and the
 *   Scale Stairs rise 1.0 m per step on 10° plates (summit 6.0 instead of 7.2).
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
  pillar,
  sphere,
  v,
  type Obstacle,
  type Piece,
} from '../gumdrop-gauntlet/kit.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Walking height of the upper town (summit deck onward). */
const UPPER = 6;
const LANES = [-7, 0, 7] as const;
const SAW_ROWS = [68, 94, 120] as const;

/** Right route of the Teeter Bridges: zig-zag 6 × 6 plates. */
const PLATES = [
  [4, 141],
  [9, 149],
  [4, 157],
  [9, 165],
  [4, 173],
  [9, 181],
  [4, 189],
] as const;
const BEAM_Z = [146, 166, 186] as const;
const STOOL_Z = [156, 176] as const;
const BRIDGE_LANDING = 194.4;

/** Second tilt table: 1.5 m gaps either side (design 2 m) so a crowd-tipped table never strands bots. */
const TABLE_2_Z = 243.5;

/** Scale Stairs: five 8 × 8 steps per side, +1 m each. */
const STEP_Z = [270.5, 280, 289.5, 299, 308.5] as const;
const stepTop = (k: number): number => k + 1;

const GRID_X = [-7.5, 0, 7.5] as const;
const GRID_Z = [331, 338.5, 346, 353.5] as const;

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

const CP = [
  checkpoint({ index: 1, top: 0, z: 132, width: 24, respawnAhead: 2.5 }),
  checkpoint({ index: 2, top: 0, z: 199, width: 26, respawnAhead: 2.5 }),
  checkpoint({ index: 3, top: UPPER, z: 318, width: 24, respawnAhead: 2.5 }),
  checkpoint({
    index: 4,
    top: UPPER,
    z: 384,
    width: 24,
    respawnAhead: 2.5,
    respawnXs: [-3, -1.5, 0, 1.5, 3],
  }),
];

// -----------------------------------------------------------------------------
// Obstacle helpers
// -----------------------------------------------------------------------------

interface TiltOpts {
  maxTiltDeg: number;
  stiffness: number;
  damping: number;
  mass: number;
  axes?: 'both' | 'x' | 'z';
  thickness?: number;
  pivotDepth?: number;
  columnHeight?: number;
}

/** Tilt plate addressed by its walking top. */
function tilt(
  id: string,
  x: number,
  top: number,
  z: number,
  sizeX: number,
  sizeZ: number,
  o: TiltOpts,
): Obstacle {
  const thickness = o.thickness ?? 0.8;
  return {
    id,
    type: 'tiltPlatform',
    position: v(x, top - thickness / 2, z),
    params: {
      sizeX,
      sizeZ,
      thickness,
      maxTiltDeg: o.maxTiltDeg,
      axes: o.axes ?? 'both',
      stiffness: o.stiffness,
      damping: o.damping,
      mass: o.mass,
      pivotDepth: o.pivotDepth ?? 0,
      columnHeight: o.columnHeight ?? 8,
    },
  };
}

interface SawOpts {
  length: number;
  width: number;
  thickness: number;
  pivotHeight: number;
  maxTiltDeg: number;
  stiffness: number;
  damping: number;
  mass: number;
}

/** Seesaw addressed by its level plank top, rocking along the course (yaw 90). */
function seesaw(id: string, x: number, top: number, z: number, o: SawOpts): Obstacle {
  return {
    id,
    type: 'seesaw',
    position: v(x, top - o.pivotHeight - o.thickness, z),
    rotation: { yaw: 90 },
    params: { ...o },
  };
}

const STRAIT_SAW: SawOpts = {
  length: 16,
  width: 4,
  thickness: 0.8,
  pivotHeight: 1.5,
  maxTiltDeg: 9,
  stiffness: 260,
  damping: 100,
  mass: 30,
};
const SMALL_TILT: TiltOpts = { maxTiltDeg: 12, stiffness: 800, damping: 260, mass: 40 };
const PLATE: TiltOpts = { maxTiltDeg: 12, stiffness: 700, damping: 230, mass: 35 };
/** The grid sits under hammers: stiffer plates so a knock-back isn't also a slide-off. */
const GRID_PLATE: TiltOpts = { maxTiltDeg: 10, stiffness: 900, damping: 300, mass: 35 };

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const lantern = (x: number, y: number, z: number, color: string): Piece[] =>
  deco(sphere(x, y, z, 1.2, { color }), cyl(x, y + 2.5, z, 0.05, 3, { color: 'neutral' }));

const beachHut = (x: number, z: number, color: string): Piece[] =>
  deco(
    box(x, -2, z, 6, 4, 6, { color, pattern: 'stripes', bevel: 0.3 }),
    { shape: 'wedge', position: v(x, 1.25, z), size: v(7, 2.5, 7), color: 'neutral', rotation: { yaw: 90 } },
    box(x, -6, z, 8, 4, 8, { color: 'neutral', bevel: 0.5 }),
  );

const pierPlaza: Piece[] = [
  floor(0, 0, -10, 10, 26, { color: 'primary', pattern: 'stripes' }),
  ...mirrorX(box(13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' })),
  box(0, 1.5, -10.5, 26, 3, 1, { color: 'neutral' }),
  ...deco(
    ...mirrorX(cyl(12, -6, -8, 0.6, 12, { color: 'neutral' }), cyl(12, -6, 8, 0.6, 12, { color: 'neutral' })),
  ),
];

const wobbleWarmUp: Piece[] = [
  floor(0, 0, 26, 32, 22, { color: 'secondary', grabbable: true }),
  floor(0, 0, 46, 56, 24, { color: 'safe', grabbable: true }),
  ...deco(
    ...mirrorX(
      cyl(11, -6, 18, 0.6, 12, { color: 'neutral' }),
      cyl(11, -6, 39, 0.6, 12, { color: 'neutral' }),
    ),
  ),
];

const seesawStrait: Piece[] = [
  floor(0, 0, 56, 59, 24, { color: 'safe', grabbable: true }),
  floor(0, 0, 78, 84, 24, { color: 'secondary', grabbable: true }),
  floor(0, 0, 104, 110, 24, { color: 'secondary', grabbable: true }),
  floor(0, 0, 129, 137, 24, { color: 'safe', grabbable: true }),
  ...deco(
    ...SAW_ROWS.flatMap((z) =>
      mirrorX(box(3.5, -0.5, z, 1, 1, 16, { color: 'neutral', pattern: 'stripes' })),
    ),
  ),
  // String lights between the lane posts.
  ...deco(
    ...SAW_ROWS.flatMap((z) => [-3.5, 3.5].map((x) => box(x, 3.5, z, 0.08, 0.08, 16, { color: 'accent' }))),
  ),
  ...SAW_ROWS.flatMap((z) => lantern(-3.5, 2.5, z, 'accent').concat(lantern(3.5, 2.5, z, 'danger'))),
];

const teeterBridges: Piece[] = [
  ...STOOL_Z.map((z) => pillar(-6, 0, z, 2, 1, { color: 'safe', grabbable: true })),
  floor(0, 0, BRIDGE_LANDING, 207.5, 26, { color: 'safe', grabbable: true }),
];

const tiltTables: Piece[] = [
  floor(0, 0, TABLE_2_Z + 10.5, 265, 24, { color: 'safe', grabbable: true }),
  ...deco(
    cyl(0, -7.5, 221, 2.5, 9, { color: 'neutral', pattern: 'stripes' }),
    cyl(0, -7.5, TABLE_2_Z, 2, 9, { color: 'neutral', pattern: 'stripes' }),
  ),
];

const scaleStairs: Piece[] = [
  floor(0, UPPER, 314, 326, 24, { color: 'safe', grabbable: true }),
  ...deco(
    ...STEP_Z.flatMap((z, k) =>
      mirrorX(cyl(5, stepTop(k) - 5, z, 0.8, 8, { color: 'neutral', pattern: 'stripes' })),
    ),
  ),
  // Scale beams joining each pair of steps (the town's namesake balances).
  ...deco(...STEP_Z.map((z, k) => box(0, stepTop(k) - 1.5, z, 10, 0.3, 0.3, { color: 'accent' }))),
];

const wobbleGrid: Piece[] = [
  floor(0, UPPER, 380, 392, 24, { color: 'safe', grabbable: true }),
  ...deco(
    arch(0, UPPER, 338.5, 26, 14, 1.2, { color: 'neutral', pattern: 'stripes' }),
    arch(0, UPPER, 353.5, 26, 14, 1.2, { color: 'neutral', pattern: 'stripes' }),
  ),
];

const grandSeesaw: Piece[] = [
  floor(0, UPPER, 426, 440, 26, { color: 'safe', pattern: 'checker', grabbable: true }),
  ...deco(...mirrorX(box(15, UPPER + 3, 430, 4, 6, 20, { color: 'neutral', pattern: 'stripes' }))),
  ...[-14, 14].flatMap((x, i) =>
    [397, 407, 417, 427, 437, 442].flatMap((z, k) =>
      lantern(x, UPPER + 8 + ((k + i) % 3) * 2.5, z, k % 2 ? 'accent' : 'danger'),
    ),
  ),
];

const bayDecor: Piece[] = [
  // The bay: a glittering water plane far below.
  ...deco(box(0, -16, 215, 150, 0.5, 470, { color: '#4fb6c9', bevel: 0 })),
  ...beachHut(-26, 40, 'primary'),
  ...beachHut(27, 110, 'secondary'),
  ...beachHut(-28, 190, 'accent'),
  ...beachHut(26, 280, 'primary'),
  ...beachHut(-26, 360, 'secondary'),
  // Ferris wheel (static ring) and lighthouse behind the finish.
  ...deco(
    {
      shape: 'torus',
      position: v(-60, 18, 250),
      size: v(16, 0.8, 16),
      rotation: { pitch: 90, yaw: 90 },
      color: 'accent',
    },
    cyl(-60, 0, 250, 1, 36, { color: 'neutral' }),
    cyl(0, 10, 470, 3, 40, { color: 'neutral', pattern: 'stripes' }),
    sphere(0, 31, 470, 3.2, { color: 'accent' }),
  ),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const obstacles: Obstacle[] = [
  { id: 's0-gate', type: 'startGate', position: v(0, 0, 7), params: { width: 26, height: 3 } },

  tilt('s1-tilt-big', 0, 0, 18, 20, 12, { maxTiltDeg: 8, stiffness: 4000, damping: 1200, mass: 150 }),
  tilt('s1-tilt-a', -7, 0, 39, 6, 10, SMALL_TILT),
  tilt('s1-tilt-b', 0, 0, 39, 6, 10, SMALL_TILT),
  tilt('s1-tilt-c', 7, 0, 39, 6, 10, SMALL_TILT),

  ...SAW_ROWS.flatMap((z, row) =>
    LANES.map((x, l) =>
      seesaw(
        `s2-saw-${row + 1}${'LCR'[l]}`,
        x,
        0,
        z,
        // Row 3 is looser: more dramatic swings right before the checkpoint.
        row === 2 ? { ...STRAIT_SAW, stiffness: 200, damping: 80 } : STRAIT_SAW,
      ),
    ),
  ),

  ...BEAM_Z.map((z, i) =>
    tilt(`s3-roll-${i + 1}`, -6, 0, z, 4, 14, {
      maxTiltDeg: i === 2 ? 16 : 14,
      axes: 'z',
      stiffness: 400,
      damping: 130,
      mass: 25,
    }),
  ),
  ...PLATES.map(([x, z], i) => tilt(`s3-plate-${i + 1}`, x, 0, z, 6, 6, PLATE)),

  tilt('s4-table-1', 0, 0, 221, 24, 24, {
    maxTiltDeg: 10,
    stiffness: 12000,
    damping: 3500,
    mass: 300,
    thickness: 1,
  }),
  tilt('s4-table-2', 0, 0, TABLE_2_Z, 18, 18, {
    maxTiltDeg: 12,
    stiffness: 8000,
    damping: 2400,
    mass: 200,
    thickness: 1,
  }),
  {
    id: 's4-bump-1',
    type: 'bumperPillar',
    position: v(0, 0, 260),
    params: { radius: 1, height: 2.4, bounceSpeed: 8 },
  },

  ...STEP_Z.flatMap((z, k) =>
    [-5, 5].map((x) =>
      tilt(`s5-step-${k + 1}${x < 0 ? 'L' : 'R'}`, x, stepTop(k), z, 8, 8, {
        maxTiltDeg: 10,
        stiffness: 1200,
        damping: 400,
        mass: 60,
        columnHeight: 6 + stepTop(k),
      }),
    ),
  ),

  ...GRID_Z.flatMap((z, r) =>
    GRID_X.map((x, c) =>
      tilt(`s6-grid-r${r + 1}c${c + 1}`, x, UPPER, z, 6, 6, { ...GRID_PLATE, columnHeight: 14 }),
    ),
  ),
  ...[338.5, 353.5].map((z, i): Obstacle => ({
    id: `s6-ham-${i + 1}`,
    type: 'pendulumHammer',
    position: v(0, UPPER, z),
    params: {
      pivotHeight: 10,
      armLength: 8,
      headRadius: 1.3,
      headLength: 3,
      amplitudeDeg: 55,
      period: 2.8,
      phase: i * 0.5,
      knockSpeed: 10,
      knockLift: 4,
      // The decorative gantry arches carry these; module posts would clip the outer grid column.
      supports: false,
    },
  })),
  seesaw('s6-plank', 0, UPPER, 369, {
    length: 20,
    width: 6,
    thickness: 0.8,
    pivotHeight: 2,
    maxTiltDeg: 8,
    stiffness: 260,
    damping: 100,
    mass: 40,
  }),

  seesaw('s7-grand', 0, UPPER, 409, {
    length: 30,
    width: 12,
    thickness: 1,
    pivotHeight: 2.5,
    maxTiltDeg: 5,
    stiffness: 900,
    damping: 330,
    mass: 100,
  }),
  { id: 's7-finish', type: 'finishLine', position: v(0, UPPER, 432), params: { width: 26, height: 6.5 } },

  ...CP.flatMap((c) => c.obstacles),
];

// -----------------------------------------------------------------------------
// Bot navigation
// -----------------------------------------------------------------------------

/** See Gumdrop Gauntlet: take-off 0.3 m past the lip, 1.5 m radius, after a straight line-up. */
const JUMP = { r: 1.5, action: 'jump' } as const;
const LINEUP = { r: 1.2 } as const;

const nav = new NavBuilder();

/**
 * Line-up + take-off pair for a jump across the lip at `edgeZ` (travel +Z).
 * Ids `id` (line-up) and `id + 1` (take-off); the take-off leads to `next`.
 */
function hopZ(id: number, x: number, y: number, edgeZ: number, next: number | number[]): void {
  nav.add(id, [x, y, edgeZ - 2.5], id + 1, LINEUP);
  nav.add(id + 1, [x, y, edgeZ + 0.3], next, JUMP);
}

// §1 Wobble Warm-up.
nav.add(0, [0, 0, 5], 1, { r: 3 });
hopZ(1, 0, 0, 10, 3);
nav.add(3, [0, 0, 18], 4, { r: 3 });
hopZ(4, 0, 0, 24, 6);
nav.add(6, [0, 0, 28.5], [10, 20, 30], { r: 2 });
LANES.forEach((x, l) => {
  const b = 10 + l * 10;
  hopZ(b, x, 0, 32, b + 2);
  nav.add(b + 2, [x, 0, 39], b + 3, { r: 1.5 });
  hopZ(b + 3, x, 0, 44, 50);
});
nav.add(50, [0, 0, 51], [100, 130, 160], { r: 3 });

// §2 Seesaw Strait: pick a lane each row; pads between rows let lanes swap.
const padAfterRow = [81, 107, 133] as const;
LANES.forEach((x, l) => {
  SAW_ROWS.forEach((z, row) => {
    const b = 100 + l * 30 + row * 10;
    const onward = row < 2 ? [100 + row * 10 + 10, 130 + row * 10 + 10, 160 + row * 10 + 10] : [200];
    hopZ(b, x, 0, z - 8 - 1, b + 2);
    nav.add(b + 2, [x, 0, z], b + 3, { r: 1.5 });
    hopZ(b + 3, x, 0, z + 8, b + 5);
    nav.add(b + 5, [x * 0.5, 0, padAfterRow[row]!], onward, { r: 2 });
  });
});

// §3 Teeter Bridges: rolling beams + stools (left) or the zig-zag plates (right).
nav.add(200, [0, 0, 134.5], [210, 240], { r: 3 });
hopZ(210, -6, 0, 137, 212);
nav.add(212, [-6, 0, BEAM_Z[0]], 213, { r: 1.2 });
hopZ(213, -6, 0, 153, 215);
nav.add(215, [-6, 0, STOOL_Z[0] + 2.3], 216, JUMP);
nav.add(216, [-6, 0, BEAM_Z[1]], 217, { r: 1.2 });
hopZ(217, -6, 0, 173, 219);
nav.add(219, [-6, 0, STOOL_Z[1] + 2.3], 220, JUMP);
nav.add(220, [-6, 0, BEAM_Z[2]], 221, { r: 1.2 });
hopZ(221, -6, 0, 193, 290);

/** Take-off point 0.3 m past where the centre-to-centre line leaves square plate `a` (half-size 3). */
function squareHop(a: readonly [number, number], b: readonly [number, number]): [number, number, number] {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = 3 / Math.max(Math.abs(dx), Math.abs(dz));
  const l = Math.hypot(dx, dz);
  return [a[0] + dx * t + (dx / l) * 0.3, 0, a[1] + dz * t + (dz / l) * 0.3];
}
hopZ(240, PLATES[0][0], 0, 137, 242);
PLATES.forEach((p, i) => {
  const b = 242 + i * 2;
  nav.add(b, [p[0], 0, p[1]], b + 1, { r: 1.2 });
  const next = PLATES[i + 1];
  nav.add(b + 1, next ? squareHop(p, next) : [p[0], 0, p[1] + 3.3], next ? b + 2 : 290, JUMP);
});

// §4 Tilt Tables.
nav.add(290, [0, 0, 201], 291, { r: 3 });
hopZ(291, 0, 0, 207.5, 293);
nav.add(293, [0, 0, 221], 294, { r: 4 });
hopZ(294, 0, 0, 233, 296);
nav.add(296, [0, 0, TABLE_2_Z], 297, { r: 3 });
hopZ(297, 0, 0, TABLE_2_Z + 9, 299);
nav.add(299, [0, 0, 260.5], [400, 420], { r: 3 });

// §5 Scale Stairs: two staircases.
[-5, 5].forEach((x, s) => {
  const b = 400 + s * 20;
  hopZ(b, x, 0, 265, b + 2);
  STEP_Z.forEach((z, k) => {
    const n = b + 2 + k * 3;
    nav.add(n, [x, stepTop(k), z], n + 1, { r: 1.5 });
    hopZ(n + 1, x, stepTop(k), z + 4, k < 4 ? n + 3 : 450);
  });
});

// §6 Wobble Grid (centre column waits out the hammers) and The Plank.
nav.add(450, [0, UPPER, 320], [500, 520, 540], { r: 3 });
GRID_X.forEach((x, c) => {
  const b = 500 + c * 20;
  hopZ(b, x, UPPER, 326, b + 2);
  GRID_Z.forEach((z, r) => {
    const n = b + 2 + r * 3;
    const hammer = c === 1 && (r === 0 || r === 2) ? `s6-ham-${r === 0 ? 1 : 2}` : null;
    nav.add(
      n,
      [x, UPPER, z],
      n + 1,
      hammer ? { r: 1.5, action: 'waitForGap', timeAgainst: hammer } : { r: 1.5 },
    );
    if (r < 3) nav.add(n + 1, [x, UPPER, z + 3.3], n + 3, JUMP);
    // The Plank is only 6 m wide: side columns hop onto the centre plate of the last row first.
    else if (c === 1) nav.add(n + 1, [0, UPPER, z + 3.3], 561, JUMP);
    else nav.add(n + 1, [x - Math.sign(x) * 3.3, UPPER, z], 531, JUMP);
  });
});
nav.add(561, [0, UPPER, 369], 562, { r: 2 });
hopZ(562, 0, UPPER, 379, 564);
nav.add(564, [0, UPPER, 386], 600, { r: 3 });

// §7 Grand Seesaw.
hopZ(600, 0, UPPER, 392, 602);
nav.add(602, [0, UPPER, 409], 603, { r: 4 });
hopZ(603, 0, UPPER, 424, 605);
nav.add(605, [0, UPPER, 432], [], { r: 4 });

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

export default defineRound({
  id: 'tilt-town',
  name: 'Tilt Town',
  type: 'race',
  theme: 'sunset',
  objective: 'Cross the wobbly town! Balance is everything.',
  tips: [
    "Platforms tip toward the crowd. Go where others aren't.",
    'A seesaw end that rises can be waited out — or out-jumped.',
    'Stay near the middle of a tilting plate; edges tip hardest.',
  ],
  players: { min: 10, max: 50, ideal: 36 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 270, overtimeSeconds: 0 },
  killY: -14,
  bounds: { min: v(-80, -25, -25), max: v(80, 45, 480) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 8, spacing: 1.4 },
  geometry: [
    ...pierPlaza,
    ...wobbleWarmUp,
    ...seesawStrait,
    ...teeterBridges,
    ...tiltTables,
    ...scaleStairs,
    ...wobbleGrid,
    ...grandSeesaw,
    ...CP.flatMap((c) => c.geometry),
    ...bayDecor,
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
    { id: 'finish', kind: 'finish', position: v(0, UPPER + 2, 432), size: v(26, 4, 2) },
  ],
  flyover: {
    path: [
      v(20, 12, -15),
      v(-22, 14, 70),
      v(20, 16, 160),
      v(0, 30, 205),
      v(-20, 16, 285),
      v(18, 20, 350),
      v(0, 16, 455),
    ],
    lookAt: [
      v(0, 0, 20),
      v(0, 0, 94),
      v(0, 0, 170),
      v(0, 0, 232),
      v(0, 3, 300),
      v(0, UPPER, 365),
      v(0, UPPER, 410),
    ],
    duration: 8,
  },
  cameraMode: 'orbit',
  music: 'mus_sunset_boardwalk',
  speedScaleByStage: [1.0, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'respawnCheckpoint',
  botNav: nav.build(),
  variations: [
    { id: 'golden-hour', weight: 4, weather: 'sunset', description: 'As authored.' },
    {
      id: 'sea-breeze',
      weight: 2,
      weather: 'windy',
      description: 'A gusty crosswind over the Strait and the Plank.',
      addObstacles: [
        {
          id: 'w-gust-1',
          type: 'fanZone',
          position: v(-14, 3, 94),
          rotation: { yaw: 90 },
          params: { width: 76, height: 10, length: 28, strength: 6, falloff: 0.5, onTime: 2.5, offTime: 1.5 },
        },
        {
          id: 'w-gust-2',
          type: 'fanZone',
          position: v(-14, UPPER + 3, 369),
          rotation: { yaw: 90 },
          params: { width: 22, height: 10, length: 28, strength: 5, falloff: 0.5, onTime: 2.5, offTime: 1.5 },
        },
      ],
    },
    {
      id: 'loose-hinges',
      weight: 2,
      weather: 'sunset',
      description: 'Everything tips further and settles slower.',
      obstacleParams: {
        ...Object.fromEntries(
          SAW_ROWS.flatMap((_, r) =>
            LANES.map((_x, l) => [`s2-saw-${r + 1}${'LCR'[l]}`, { stiffness: 180, damping: 80 }]),
          ),
        ),
        's6-plank': { stiffness: 180, damping: 80 },
        's7-grand': { stiffness: 630, damping: 260 },
        's4-table-1': { maxTiltDeg: 13, stiffness: 9000 },
        's4-table-2': { maxTiltDeg: 15, stiffness: 6000 },
      },
    },
    {
      id: 'lantern-night',
      weight: 1,
      weather: 'night',
      description: 'Lanterns light the edges; the hammers get a third partner.',
      addObstacles: [
        {
          id: 's6-ham-3',
          type: 'pendulumHammer',
          position: v(0, UPPER, 346),
          params: {
            pivotHeight: 10,
            armLength: 8,
            headRadius: 1.3,
            headLength: 3,
            amplitudeDeg: 55,
            period: 2.8,
            phase: 0.25,
            supports: false,
          },
        },
      ],
    },
    {
      id: 'stiff-town',
      weight: 1,
      weather: 'clear',
      description: 'Beginner-friendly: every tilt halved.',
      obstacleParams: Object.fromEntries(
        [
          ['s1-tilt-big', 4],
          ['s1-tilt-a', 6],
          ['s1-tilt-b', 6],
          ['s1-tilt-c', 6],
          ['s3-roll-1', 7],
          ['s3-roll-2', 7],
          ['s3-roll-3', 8],
          ...PLATES.map((_, i) => [`s3-plate-${i + 1}`, 6] as const),
          ['s4-table-1', 5],
          ['s4-table-2', 6],
          ...STEP_Z.flatMap((_, k) => ['L', 'R'].map((s) => [`s5-step-${k + 1}${s}`, 5] as const)),
          ...GRID_Z.flatMap((_, r) => GRID_X.map((_x, c) => [`s6-grid-r${r + 1}c${c + 1}`, 5] as const)),
        ].map(([id, deg]) => [id, { maxTiltDeg: deg }]),
      ),
    },
  ],
  decorSeed: 1301,
  designNotes:
    'The crowd is the hazard: every walkable piece after the plaza is a dynamic tilt plate or seesaw (replicated). ' +
    'Gentle warm-up → three-lane seesaw rows → rolling beams vs zig-zag plates → two crowd-weighted tables → scale ' +
    'stairs → tilt grid under two hammers → The Plank → Grand Seesaw finale. Approximations: physical stiffness/mass ' +
    're-derived; grab-climbs replaced by jumpable tilt limits (planks are not grabbable); stairs rise 1.0 m.',
});
