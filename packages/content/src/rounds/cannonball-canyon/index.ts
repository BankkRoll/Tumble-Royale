/**
 * R7 — Cannonball Canyon (race, beach).
 *
 * A tropical canyon run under constant incoming fire: parrot cannons lob foam
 * coconuts from the cliffs, giant beach balls thunder down sandstone lanes,
 * a rope bridge takes crossfire from both banks, a boulder bowl, rafts or
 * stepping rocks under a sniper, sea stacks vs a climbing cliff, and a
 * ripple-volley treasure gauntlet. Transcribed from docs/design/LEVELS.md §R7.
 *
 * Module mapping notes (the design predates the obstacle library):
 * - `cannon` fires lanes across its local X at a landing line `range` m down
 *   +Z. Design `aim: sweep/pattern` + `patternYaws/sweepDeg` become lanes
 *   (`pingpong` for sweeps, `sequence` for patterns) spaced to cover the same
 *   angles; `targetApex` becomes `flightTime`; `fireInterval` → `period`;
 *   phases become `startDelay`. `burst` has no equivalent.
 * - `boulderLane` rolls along local +Z from its origin on flat ground, so the
 *   canyon balls are yawed 180° (and pitched down the Boulder Bowl slope).
 * - `movingPlatform` is speed-based; raft periods are converted.
 * - `climbWall` holds are not climbable by the controller beyond a ledge, so
 *   the 6 m cliff is a 2.2 m climb wall + a 2.2 m grab ledge + a 1.6 m hop.
 */
import { defineRound, type RoundDefinitionInput } from '@tumble/shared';

type Piece = RoundDefinitionInput['geometry'][number];
type Obstacle = NonNullable<RoundDefinitionInput['obstacles']>[number];
type Waypoint = NonNullable<RoundDefinitionInput['botNav']>[number];
type Trigger = NonNullable<RoundDefinitionInput['triggers']>[number];
type Vec = { x: number; y: number; z: number };

// -----------------------------------------------------------------------------
// Piece helpers
// -----------------------------------------------------------------------------

const v = (x: number, y: number, z: number): Vec => ({ x, y, z });
const G = 24;

interface PieceOpts {
  color?: string;
  pattern?: Piece['pattern'];
  grab?: boolean;
  deco?: boolean;
  bevel?: number;
  rot?: { yaw?: number; pitch?: number; roll?: number };
}

function piece(shape: Piece['shape'], pos: Vec, size: Vec, o: PieceOpts = {}): Piece {
  return {
    shape,
    position: pos,
    size,
    color: o.color ?? 'primary',
    pattern: o.pattern ?? 'none',
    grabbable: o.grab ?? false,
    decorative: o.deco ?? false,
    bevel: o.bevel ?? 0.15,
    ...(o.rot ? { rotation: o.rot } : {}),
  };
}

const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, o?: PieceOpts): Piece =>
  piece('box', v(x, y, z), v(sx, sy, sz), o);
const cyl = (x: number, y: number, z: number, r: number, h: number, o?: PieceOpts): Piece =>
  piece('cylinder', v(x, y, z), v(r, h, r), o);
const ball = (x: number, y: number, z: number, r: number, o?: PieceOpts): Piece =>
  piece('sphere', v(x, y, z), v(r, r, r), o);
const decal = (
  x: number,
  top: number,
  z: number,
  sx: number,
  sz: number,
  color: string,
  pattern: Piece['pattern'],
): Piece => box(x, top + 0.01, z, sx, 0.02, sz, { color, pattern, deco: true, bevel: 0 });
const respawnRow = (top: number, z: number, xs = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5]): Vec[] =>
  xs.map((x) => v(x, top + 0.1, z));

/** Palm tree: leaning trunk and a crown of leaf blobs (decor). */
function palm(x: number, baseY: number, z: number, h: number, lean = 8): Piece[] {
  const out: Piece[] = [
    cyl(x, baseY + h / 2, z, 0.35, h, {
      color: '#b5895a',
      pattern: 'stripes',
      deco: true,
      rot: { roll: lean },
    }),
  ];
  const tx = x - Math.sin((lean * Math.PI) / 180) * h * 0.5;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    out.push(
      ball(tx + Math.cos(a) * 1.2, baseY + h + 0.2, z + Math.sin(a) * 1.2, 1.1, {
        color: 'accent',
        deco: true,
      }),
    );
  }
  out.push(
    ball(tx + 0.3, baseY + h - 0.4, z, 0.35, { color: '#7a4a2a', deco: true }),
    ball(tx - 0.3, baseY + h - 0.5, z + 0.2, 0.35, { color: '#7a4a2a', deco: true }),
  );
  return out;
}

/** Beach umbrella with a striped canopy (decor). */
const umbrella = (x: number, baseY: number, z: number, color: string): Piece[] => [
  cyl(x, baseY + 1.3, z, 0.07, 2.6, { color: 'neutral', deco: true }),
  cyl(x, baseY + 2.6, z, 1.6, 0.25, { color, pattern: 'stripes', deco: true }),
];

/** Rock pillar a cannon sits on: solid top at `topY`, foot sunk into the sea. */
const perch = (x: number, z: number, topY: number, r = 2): Piece[] => [
  cyl(x, (topY - 12) / 2, z, r, topY + 12, { color: 'secondary', pattern: 'stripes' }),
  ball(x + (x < 0 ? -0.8 : 0.8), topY + 0.35, z + 1.1, 0.35, { color: 'accent', deco: true }),
];

// -----------------------------------------------------------------------------
// Obstacle builders
// -----------------------------------------------------------------------------

interface ShotOpts {
  /** Shot direction: world yaw in degrees (90 ⇒ +X). */
  yaw: number;
  range: number;
  /** Landing ground relative to the cannon base (m). */
  landing: number;
  /** Apex above the cannon base (m); solved into a flight time. */
  apex: number;
  lanes: number;
  /** Total angular spread of the lanes (degrees), centred on the barrel. */
  spreadDeg: number;
  pattern: 'random' | 'sequence' | 'pingpong';
  period: number;
  /** First shot (s); design phase × period. */
  start: number;
  ballRadius: number;
  knock: number;
  telegraph?: number;
  roll?: number;
  seed?: number;
}

/** Cannon instance from design-style aim (apex, spread) solved onto the module's lanes. */
function cannon(id: string, pos: Vec, o: ShotOpts): Obstacle {
  const pivot = 1.6;
  const up = Math.max(0.2, o.apex - pivot);
  const down = Math.max(0.2, o.apex - (o.landing + o.ballRadius));
  const flight = Math.sqrt((2 * up) / G) + Math.sqrt((2 * down) / G);
  const half = ((o.spreadDeg / 2) * Math.PI) / 180;
  const spacing = o.lanes > 1 ? (2 * o.range * Math.tan(half)) / (o.lanes - 1) : 0;
  return {
    id,
    type: 'cannon',
    position: pos,
    rotation: { yaw: o.yaw },
    params: {
      pivotHeight: pivot,
      range: o.range,
      landingHeight: o.landing,
      laneCount: o.lanes,
      laneSpacing: Math.round(spacing * 100) / 100,
      flightTime: Math.round(flight * 100) / 100,
      rollTime: o.roll ?? 0.6,
      rollSpeed: 5,
      bounceHeight: 0.5,
      period: o.period,
      startDelay: o.start,
      pattern: o.pattern,
      seed: o.seed ?? 1,
      ballRadius: o.ballRadius,
      knockImpulse: o.knock,
      aimTime: Math.max(0.7, o.telegraph ?? 0.8),
    },
  };
}

/** Giant ball lane rolling toward −Z (or down a slope when `pitchDeg` is set) from `pos`. */
function ballLane(
  id: string,
  pos: Vec,
  o: {
    length: number;
    radius: number;
    speed: number;
    every: number;
    at: number;
    pitchDeg?: number;
    knock?: number;
    drop?: number;
  },
): Obstacle {
  return {
    id,
    type: 'boulderLane',
    position: pos,
    rotation: { yaw: 180, ...(o.pitchDeg ? { pitch: o.pitchDeg } : {}) },
    params: {
      lanes: 1,
      length: o.length,
      radius: o.radius,
      speed: o.speed,
      spawnPeriod: o.every,
      phase: o.at,
      dropHeight: o.drop ?? 1,
      dropTime: 0.4,
      knockSpeed: o.knock ?? 11,
      knockLift: 6,
    },
  };
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const geometry: Piece[] = [];
const add = (...p: Piece[]): void => {
  geometry.push(...p);
};

// §0 Beach Start (z −10 → 10)
add(box(0, -0.5, 0, 26, 1, 20, { color: 'primary', bevel: 0.3 }));
for (const [x, c] of [
  [-8, 'danger'],
  [-3, 'secondary'],
  [3, 'accent'],
  [8, 'safe'],
] as const) {
  add(decal(x, 0, -5, 2.4, 5, c, 'stripes'));
}
add(decal(0, 0, 8.5, 26, 3, 'safe', 'checker'));
add(
  box(-13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' }),
  box(13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' }),
);
// Tiki hut row behind the start.
for (const x of [-9, -3, 3, 9]) {
  add(box(x, 1.8, -12.5, 4, 3.6, 3, { color: '#c99a5b', deco: true }));
  add(piece('wedge', v(x, 4.4, -12.5), v(5, 1.8, 3.6), { color: 'accent', deco: true, rot: { yaw: 90 } }));
}
add(...palm(-14, 0, -6, 7), ...palm(14, 0, -4, 6.5, -8));

// §1 Shoreline Shuffle (z 10 → 60)
add(box(0, -0.5, 35, 30, 1, 50, { color: 'primary', bevel: 0.3 }));
add(box(-20, 3, 35, 10, 8, 50, { color: 'secondary', pattern: 'stripes', bevel: 0.5 }));
add(box(15.5, 0.5, 35, 1, 1, 50, { color: 'neutral' }));
for (const [x, z, c] of [
  [11, 18, 'danger'],
  [12, 33, 'safe'],
  [10.5, 48, 'secondary'],
] as const) {
  add(...umbrella(x, 0, z, c));
  add(decal(x - 1.6, 0, z, 1.4, 2.6, c, 'stripes'));
}
add(...palm(-16, 7, 14, 6), ...palm(-23, 7, 30, 7), ...palm(-17, 7, 45, 6), ...palm(-22, 7, 58, 7.5));

// §2 Lane Runner (z 60 → 140)
// The floor runs 0.4 m past each outer lane: hugging the canyon wall is a razor-thin line the balls just miss.
add(box(0, -0.5, 100, 24.8, 1, 80, { color: 'primary', bevel: 0.3 }));
// Ridges stop short of both ends so runners can line up in, and fan out of, any lane.
for (const x of [-6, 0, 6])
  add(piece('wedge', v(x, 0.45, 99), v(1.2, 0.9, 70), { color: 'secondary', pattern: 'stripes' }));
for (const s of [-1, 1]) {
  add(box(s * 13.4, 5, 72.5, 2, 10, 25, { color: 'secondary', pattern: 'stripes' }));
  add(box(s * 13.4, 5, 100, 2, 10, 24, { color: 'secondary', pattern: 'stripes' }));
  add(box(s * 13.4, 5, 128.5, 2, 10, 23, { color: 'secondary', pattern: 'stripes' }));
  add(
    box(s * 13.9, -0.5, 86.5, 3, 1, 3, { color: 'safe' }),
    box(s * 13.9, -0.5, 114.5, 3, 1, 5, { color: 'safe' }),
  );
  add(
    box(s * 15.9, 5, 86.5, 1, 10, 3, { color: 'secondary' }),
    box(s * 15.9, 5, 114.5, 1, 10, 5, { color: 'secondary' }),
  );
  // Cave mouth the balls tumble out of (decor; the bridge passes between).
  add(box(s * 8.5, 5, 141.5, 9, 10, 3, { color: 'secondary', pattern: 'stripes', deco: true }));
  // Canyon rim crowd on towels.
  for (const z of [70, 95, 125])
    add(decal(s * 13.4, 10, z, 1.8, 3, z === 95 ? 'danger' : 'accent', 'stripes'));
}
add(box(0, 8.5, 141.5, 8, 3, 3, { color: 'secondary', deco: true }));
for (const x of [-9, -3, 3, 9]) add(decal(x, 0, 59.2, 2.4, 1.2, 'danger', 'hazard'));

// §3 Coconut Crossfire (z 140 → 210)
add(box(0, -0.5, 170, 8, 1, 60, { color: 'primary', pattern: 'stripes' }));
add(
  box(2.5, 1, 155, 2, 2, 2, { color: 'secondary', bevel: 0.2 }),
  box(-2.5, 1, 170, 2, 2, 2, { color: 'secondary', bevel: 0.2 }),
  box(2.5, 1, 185, 2, 2, 2, { color: 'secondary', bevel: 0.2 }),
);
add(
  box(-4.1, 0.6, 170, 0.2, 1.2, 60, { color: 'neutral' }),
  box(4.1, 0.6, 170, 0.2, 1.2, 60, { color: 'neutral' }),
);
for (let z = 142; z <= 198; z += 4)
  add(
    cyl(-4.1, 0.75, z, 0.14, 1.5, { color: '#b5895a', deco: true }),
    cyl(4.1, 0.75, z, 0.14, 1.5, { color: '#b5895a', deco: true }),
  );
add(
  box(-21, 1, 172, 6, 4, 50, { color: 'secondary', pattern: 'stripes', bevel: 0.5 }),
  box(21, 1, 172, 6, 4, 50, { color: 'secondary', pattern: 'stripes', bevel: 0.5 }),
);
add(box(0, -0.5, 205, 22, 1, 10, { color: 'safe', bevel: 0.3 }));
add(decal(0, 0, 204, 22, 2, 'safe', 'checker'));
add(...palm(-22, 3, 158, 6), ...palm(21, 3, 188, 6, -8));
// Galleon wreck in the lagoon.
add(box(-12, -2.5, 178, 5, 3, 14, { color: '#8a5a3a', deco: true, rot: { yaw: 20, roll: 12 }, bevel: 0.6 }));
add(
  cyl(-12, 2, 178, 0.25, 9, { color: '#8a5a3a', deco: true, rot: { roll: 18 } }),
  box(-13, 4, 178, 0.1, 3.5, 4, { color: 'neutral', deco: true, rot: { roll: 18 } }),
);

// §4 Boulder Bowl (z 210 → 284)
const BOWL_SLOPE = 10 / 60;
const BOWL_DEG = (Math.atan(BOWL_SLOPE) * 180) / Math.PI;
const bowlY = (z: number): number => (z - 212) * BOWL_SLOPE;
add(box(0, -0.5, 211, 16, 1, 2, { color: 'primary' }));
add(piece('ramp', v(0, 5, 242), v(16, 10, 60), { color: 'primary' }));
for (const s of [-1, 1]) {
  for (const [z0, z1] of [
    [212, 227],
    [233, 247],
    [253, 272],
  ] as const) {
    const zc = (z0 + z1) / 2;
    add(
      box(s * 8.25, bowlY(zc) + 0.5, zc, 0.5, 1.6, (z1 - z0) / Math.cos(Math.atan(BOWL_SLOPE)), {
        color: 'secondary',
        rot: { pitch: -BOWL_DEG },
      }),
    );
  }
  add(
    box(s * 10, 2.75, 230, 4, 0.5, 6, { color: 'safe' }),
    box(s * 10, 6.08, 250, 4, 0.5, 6, { color: 'safe' }),
  );
  add(
    cyl(s * 11.4, 3.2, 230, 1.2, 0.2, { color: '#4fd1ff', deco: true }),
    cyl(s * 11.4, 6.5, 250, 1.2, 0.2, { color: '#4fd1ff', deco: true }),
  );
  // Giant clam the balls tumble out of (decor).
  add(ball(s * 5, 12.2, 275.5, 2.4, { color: 'accent', pattern: 'stripes', deco: true }));
}
add(
  box(0, bowlY(242) + 0.02, 242, 2, 0.04, 60.8, {
    color: 'safe',
    deco: true,
    bevel: 0,
    rot: { pitch: -BOWL_DEG },
  }),
);
add(box(0, 9.5, 278, 22, 1, 12, { color: 'safe', bevel: 0.3 }));
add(decal(0, 10, 276, 22, 2, 'safe', 'checker'));

// §5 Raft Run (z 284 → 350)
const ROCK_Z = [288.98, 295.56, 302.14, 308.72, 315.3, 321.88, 328.46, 335.04];
add(cyl(0, 9.5, 312, 5, 1, { color: 'secondary', grab: true }));
for (const z of ROCK_Z) add(cyl(-11, 9.25, z, 1.8, 1.5, { color: 'accent', pattern: 'dots' }));
add(box(0, 9.5, 345, 26, 1, 10, { color: 'safe', bevel: 0.3 }));
add(decal(0, 10, 345, 26, 2, 'safe', 'checker'));
add(...perch(21, 312, 10));
add(...palm(1, 10, 313, 5));

// §6 Sea Stacks (z 350 → 397)
add(box(0, 9.5, 351, 26, 1, 2, { color: 'primary' }));
add(cyl(-3, 9.5, 355, 3, 4, { color: 'secondary', grab: true }));
add(cyl(2, 10.25, 361, 3, 5.5, { color: 'secondary', grab: true }));
add(cyl(-2, 11, 367, 3, 7, { color: 'secondary', grab: true }));
add(cyl(2, 11.75, 373, 3, 8.5, { color: 'secondary', grab: true }));
for (const [x, top, z] of [
  [-3, 11.5, 355],
  [2, 13, 361],
  [-2, 14.5, 367],
  [2, 16, 373],
] as const) {
  add(cyl(x, top - 6, z, 2.6, 8, { color: 'neutral', pattern: 'stripes', deco: true }));
}
// Cliff route: a 2.2 m climb wall, a 2.2 m grab ledge, then a 1.6 m hop onto the cliff path.
add(box(10, 10.6, 354, 4, 3.2, 4, { color: 'primary', grab: true }));
add(box(10, 11.7, 358, 4, 5.4, 4, { color: 'primary', grab: true }));
add(box(10, 14.4 - 0.15, 356.1, 4, 0.3, 0.3, { color: 'accent', grab: true, bevel: 0.08 }));
add(box(10, 12.5, 368.5, 4, 7, 17, { color: 'primary' }));
add(box(0, 15.5, 387, 26, 1, 20, { color: 'safe', bevel: 0.3 }));
add(decal(0, 16, 381, 26, 2, 'safe', 'checker'));
add(...perch(-21, 365, 16));

// §7 Treasure Gauntlet (z 397 → 475)
add(box(0, 15.5, 423.5, 16, 1, 53, { color: 'primary', bevel: 0.3 }));
add(piece('ramp', v(0, 17, 456), v(16, 2, 12), { color: 'accent', pattern: 'chevron' }));
add(box(0, 17.5, 468.5, 22, 1, 13, { color: 'safe', pattern: 'checker', bevel: 0.3 }));
add(
  box(-10, 18, 423.5, 4, 4, 53, { color: 'secondary', pattern: 'stripes', bevel: 0.4 }),
  box(10, 18, 423.5, 4, 4, 53, { color: 'secondary', pattern: 'stripes', bevel: 0.4 }),
);
// Tunnel mouths in the berms where the crossing balls come out.
add(piece('arch', v(-8.05, 18.2, 418), v(0.2, 3.6, 3.6), { color: 'neutral', deco: true, rot: { yaw: 90 } }));
add(piece('arch', v(8.05, 18.2, 440), v(0.2, 3.6, 3.6), { color: 'neutral', deco: true, rot: { yaw: 90 } }));
add(
  box(0, 21, 474, 6, 6, 2, { color: 'accent', deco: true, bevel: 0.4 }),
  box(0, 24.4, 474.4, 6.2, 0.8, 2.4, { color: 'danger', deco: true, bevel: 0.3 }),
);
for (const x of [-2.4, 0, 2.4]) add(ball(x, 24.9, 473.6, 0.5, { color: 'accent', deco: true }));
add(
  box(-16, 20, 465, 6, 6, 20, { color: 'neutral', pattern: 'stripes', deco: true }),
  box(16, 20, 465, 6, 6, 20, { color: 'neutral', pattern: 'stripes', deco: true }),
);
for (const z of [405, 420, 435]) add(ball(-11, 20.3, z - 1.2, 0.4, { color: 'danger', deco: true }));
for (const z of [412.5, 427.5, 442.5]) add(ball(11, 20.3, z - 1.2, 0.4, { color: 'danger', deco: true }));
add(
  ...palm(-17, 15, 450, 7),
  ...palm(17, 15, 452, 7, -8),
  ...umbrella(-15, 23, 462, 'danger'),
  ...umbrella(15, 23, 470, 'safe'),
);
// Volcano puffing on the horizon and a kite overhead.
add(
  piece('ramp', v(-70, 12, 520), v(40, 30, 30), { color: '#c99a5b', deco: true, rot: { yaw: 180 } }),
  ball(-70, 30, 520, 6, { color: '#ffffff', deco: true }),
);
add(
  piece('wedge', v(18, 38, 300), v(3, 4, 0.2), {
    color: 'danger',
    pattern: 'stripes',
    deco: true,
    rot: { yaw: 30 },
  }),
);

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const S1 = {
  yaw: 90,
  range: 17,
  landing: -7,
  apex: 10,
  lanes: 5,
  spreadDeg: 56,
  pattern: 'pingpong',
  period: 3.0,
  ballRadius: 0.8,
  knock: 9,
  telegraph: 0.9,
  roll: 0.8,
} as const;
const S3 = {
  range: 19,
  landing: -3,
  apex: 4,
  lanes: 3,
  spreadDeg: 16,
  pattern: 'sequence',
  period: 2.4,
  ballRadius: 0.7,
  knock: 12,
  telegraph: 0.8,
  roll: 0.6,
} as const;
const S7 = {
  range: 11,
  landing: -4,
  apex: 5,
  lanes: 3,
  spreadDeg: 20,
  pattern: 'sequence',
  period: 3.0,
  ballRadius: 0.8,
  knock: 10,
  telegraph: 0.8,
  roll: 0.8,
} as const;
const BALL2 = { length: 79, radius: 2, speed: 8, every: 5, knock: 11 };

const obstacles: Obstacle[] = [
  {
    id: 's0-gate',
    type: 'startGate',
    position: v(0, 0, 7),
    params: { width: 26, height: 2.6, style: 'drop' },
  },

  cannon('s1-can-1', v(-17, 7, 22), { ...S1, start: 1, seed: 11 }),
  cannon('s1-can-2', v(-17, 7, 37), { ...S1, start: 2, seed: 12 }),
  cannon('s1-can-3', v(-17, 7, 52), { ...S1, start: 3, seed: 13 }),

  ballLane('s2-ball-1', v(-9, 0, 139), { ...BALL2, at: 0 }),
  ballLane('s2-ball-2', v(-3, 0, 139), { ...BALL2, at: 1.25 }),
  ballLane('s2-ball-3', v(3, 0, 139), { ...BALL2, at: 2.5 }),
  ballLane('s2-ball-4', v(9, 0, 139), { ...BALL2, at: 3.75 }),

  cannon('s3-can-L1', v(-19, 3, 150), { ...S3, yaw: 90, start: 1, seed: 31 }),
  cannon('s3-can-L2', v(-19, 3, 180), { ...S3, yaw: 90, start: 2.2, seed: 32 }),
  cannon('s3-can-R1', v(19, 3, 165), { ...S3, yaw: -90, start: 1.6, seed: 33 }),
  cannon('s3-can-R2', v(19, 3, 195), { ...S3, yaw: -90, start: 2.8, seed: 34 }),
  { id: 's3-cpgate', type: 'checkpointGate', position: v(0, 0, 204), params: { index: 1, width: 20.2 } },

  ballLane('s4-ball-L', v(-4.3, 10, 272), {
    length: 60 / Math.cos(Math.atan(BOWL_SLOPE)),
    radius: 3,
    speed: 9,
    every: 4.5,
    at: 0,
    pitchDeg: BOWL_DEG,
    knock: 14,
    drop: 3,
  }),
  ballLane('s4-ball-R', v(4.3, 10, 272), {
    length: 60 / Math.cos(Math.atan(BOWL_SLOPE)),
    radius: 3,
    speed: 9,
    every: 4.5,
    at: 2.25,
    pitchDeg: BOWL_DEG,
    knock: 14,
    drop: 3,
  }),
  { id: 's4-cpgate', type: 'checkpointGate', position: v(0, 10, 276), params: { index: 2, width: 20.2 } },

  {
    id: 's5-raft-A',
    type: 'movingPlatform',
    position: v(-2.5, 10, 287),
    params: {
      points: [v(0, 0, 0), v(0, 0, 18)],
      size: v(5, 0.8, 5),
      speed: 7,
      mode: 'pingPong',
      pauseTime: 1.2,
      pauseAt: 'ends',
      easing: 'cubic',
      phase: 0,
    },
  },
  {
    id: 's5-raft-B',
    type: 'movingPlatform',
    position: v(2.5, 10, 319),
    // Half a cycle behind raft A: (2·18.5/7 + 2.4) / 2.
    params: {
      points: [v(0, 0, 0), v(0, 0, 18.5)],
      size: v(5, 0.8, 5),
      speed: 7,
      mode: 'pingPong',
      pauseTime: 1.2,
      pauseAt: 'ends',
      easing: 'cubic',
      phase: 3.84,
    },
  },
  cannon('s5-sniper', v(20, 10, 312), {
    yaw: -90,
    range: 21,
    landing: 0,
    apex: 5,
    lanes: 5,
    spreadDeg: 40,
    pattern: 'pingpong',
    period: 2.0,
    start: 1,
    ballRadius: 0.7,
    knock: 12,
    telegraph: 0.8,
    roll: 0.3,
    seed: 51,
  }),
  { id: 's5-cpgate', type: 'checkpointGate', position: v(0, 10, 345), params: { index: 3, width: 24.2 } },

  {
    id: 's6-climb',
    type: 'climbWall',
    position: v(10, 10, 352),
    params: {
      width: 4,
      height: 2.2,
      thickness: 0.8,
      holdRows: 2,
      holdCols: 3,
      holdMargin: 0.5,
      topLip: true,
      seed: 7,
    },
  },
  cannon('s6-can', v(-20, 16, 365), {
    yaw: 90,
    range: 30,
    landing: 0,
    apex: 6,
    lanes: 4,
    spreadDeg: 24,
    pattern: 'pingpong',
    period: 2.2,
    start: 1,
    ballRadius: 0.7,
    knock: 11,
    telegraph: 0.8,
    roll: 0.4,
    seed: 61,
  }),
  { id: 's6-cpgate', type: 'checkpointGate', position: v(0, 16, 381), params: { index: 4, width: 24.2 } },

  cannon('s7-can-L1', v(-11, 20, 405), { ...S7, yaw: 90, start: 1, seed: 71 }),
  cannon('s7-can-L2', v(-11, 20, 420), { ...S7, yaw: 90, start: 1.5, seed: 72 }),
  cannon('s7-can-L3', v(-11, 20, 435), { ...S7, yaw: 90, start: 2.0, seed: 73 }),
  cannon('s7-can-R1', v(11, 20, 412.5), { ...S7, yaw: -90, start: 2.5, seed: 74 }),
  cannon('s7-can-R2', v(11, 20, 427.5), { ...S7, yaw: -90, start: 3.0, seed: 75 }),
  cannon('s7-can-R3', v(11, 20, 442.5), { ...S7, yaw: -90, start: 3.5, seed: 76 }),
  {
    id: 's7-roll-1',
    type: 'boulderLane',
    position: v(-8, 16, 418),
    rotation: { yaw: 90 },
    params: {
      lanes: 1,
      length: 16,
      radius: 1.5,
      speed: 6,
      spawnPeriod: 4,
      phase: 0,
      dropHeight: 0.3,
      dropTime: 0.3,
      knockSpeed: 11,
      knockLift: 6,
    },
  },
  {
    id: 's7-roll-2',
    type: 'boulderLane',
    position: v(8, 16, 440),
    rotation: { yaw: -90 },
    params: {
      lanes: 1,
      length: 16,
      radius: 1.5,
      speed: 6,
      spawnPeriod: 4,
      phase: 2,
      dropHeight: 0.3,
      dropTime: 0.3,
      knockSpeed: 11,
      knockLift: 6,
    },
  },
  { id: 's7-finish', type: 'finishLine', position: v(0, 18, 468), params: { width: 19.6, height: 6.5 } },
];

const CANNONS = obstacles.filter((o) => o.type === 'cannon');

// -----------------------------------------------------------------------------
// Triggers
// -----------------------------------------------------------------------------

const triggers: Trigger[] = [
  {
    id: 'cp-0',
    kind: 'checkpoint',
    index: 0,
    position: v(0, 2, 0),
    size: v(26, 4, 20),
    respawn: respawnRow(0, -1, [-6, -3.6, -1.2, 1.2, 3.6, 6]),
    respawnYaw: 0,
  },
  {
    id: 'cp-1',
    kind: 'checkpoint',
    index: 1,
    position: v(0, 2, 204),
    size: v(22, 4, 2),
    respawn: respawnRow(0, 207),
    respawnYaw: 0,
  },
  {
    id: 'cp-2',
    kind: 'checkpoint',
    index: 2,
    position: v(0, 12, 276),
    size: v(22, 4, 2),
    respawn: respawnRow(10, 279),
    respawnYaw: 0,
  },
  {
    id: 'cp-3',
    kind: 'checkpoint',
    index: 3,
    position: v(0, 12, 345),
    size: v(26, 4, 2),
    respawn: respawnRow(10, 347.5),
    respawnYaw: 0,
  },
  {
    id: 'cp-4',
    kind: 'checkpoint',
    index: 4,
    position: v(0, 18, 381),
    size: v(26, 4, 2),
    respawn: respawnRow(16, 384),
    respawnYaw: 0,
  },
  { id: 'finish', kind: 'finish', position: v(0, 20, 468), size: v(22, 4, 2) },
];

// -----------------------------------------------------------------------------
// Bot nav
// -----------------------------------------------------------------------------

const wp = (
  id: number,
  x: number,
  y: number,
  z: number,
  next: number[],
  o: Partial<Waypoint> = {},
): Waypoint => ({
  id,
  position: v(x, y, z),
  radius: 1.5,
  next,
  action: 'run',
  ...o,
});

/**
 * Three nodes across a checkpoint's respawn line. Bots re-pick the nearest node
 * after a respawn (nodes far behind their best rank count 4× further), so a
 * node within ~2.5 m of every respawn point keeps them on the safe approach.
 */
const cpNodes = (ids: [number, number, number], y: number, z: number, next: number[]): Waypoint[] =>
  [-5, 0, 5].map((x, k) => wp(ids[k]!, x, y, z, next, { radius: 2.6 }));

const WALL_X = [-11.75, 11.75];

/** Rim point of a round stack `r` m from its centre toward the next stack — where bots take off. */
function takeoff(from: [number, number], to: [number, number], r: number): [number, number] {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const l = Math.hypot(dx, dz);
  return [from[0] + (dx / l) * r, from[1] + (dz / l) * r];
}
const STACKS: [number, number][] = [
  [-3, 355],
  [2, 361],
  [-2, 367],
  [2, 373],
];
const t12 = takeoff(STACKS[0]!, STACKS[1]!, 2.4);
const t23 = takeoff(STACKS[1]!, STACKS[2]!, 2.4);
const t34 = takeoff(STACKS[2]!, STACKS[3]!, 2.4);

const botNav: Waypoint[] = [
  // §0–§1: sidestep the landing rings on the beach.
  ...cpNodes([8, 0, 9], 0, -0.5, [1]),
  wp(1, 3, 0, 35, [2], { radius: 4 }),
  wp(2, 0, 0, 54, [100, 101], { radius: 3 }),
  // §2 Lane Runner: bots cannot read ball timing, so they take the wall-hugging line the balls just miss.
  ...WALL_X.map((x, i) => wp(100 + i, x, 0, 59, [110 + i], { radius: 0.5 })),
  ...WALL_X.map((x, i) => wp(110 + i, x, 0, 98, [120 + i], { radius: 0.5 })),
  ...WALL_X.map((x, i) => wp(120 + i, x, 0, 136, [130], { radius: 0.5 })),
  wp(130, 0, 0, 139, [200], { radius: 1.5 }),
  // §3 Coconut Crossfire: wait out of each bank's landing zone.
  wp(200, 0, 0, 143.5, [201], { radius: 1, action: 'waitForGap', timeAgainst: 's3-can-L1' }),
  wp(201, 0, 0, 158, [202], { radius: 1, action: 'waitForGap', timeAgainst: 's3-can-R1' }),
  wp(202, 0, 0, 172.5, [203], { radius: 1, action: 'waitForGap', timeAgainst: 's3-can-L2' }),
  wp(203, 0, 0, 187.5, [205, 206, 207], { radius: 1, action: 'waitForGap', timeAgainst: 's3-can-R2' }),
  ...cpNodes([205, 206, 207], 0, 207.5, [300]),
  // §4 Boulder Bowl: the 2 m centre line.
  wp(300, 0, 0, 212.5, [301], { radius: 0.5 }),
  wp(301, 0, 5, 242, [302], { radius: 0.5 }),
  wp(302, 0, 10, 273.5, [303, 304, 305], { radius: 1.5 }),
  ...cpNodes([303, 304, 305], 10, 279.5, [410]),
  // §5 Stepping rocks (bots cannot time the rafts): take off from each rock's far rim.
  // Nodes sit just past each rim with a wide radius: bots jump from inside the rim without braking.
  wp(410, -10.6, 10, 284.6, [411], { radius: 1, action: 'jump' }),
  ...ROCK_Z.map((z, k) =>
    wp(411 + k, -11, 10, z + 2.0, k < ROCK_Z.length - 1 ? [412 + k] : [420, 421, 422], {
      radius: 1,
      action: 'jump',
    }),
  ),
  ...cpNodes([420, 421, 422], 10, 348, [500, 510]),
  // §6 Sea stacks (+1.5 hops) or the climb.
  wp(500, -3, 10, 351.2, [501], { radius: 0.6, action: 'jump' }),
  wp(501, t12[0], 11.5, t12[1], [502], { radius: 0.5, action: 'jump' }),
  wp(502, t23[0], 13, t23[1], [503], { radius: 0.5, action: 'jump' }),
  wp(503, t34[0], 14.5, t34[1], [504], { radius: 0.5, action: 'jump' }),
  wp(504, 2, 16, 375.4, [520, 521, 522], { radius: 0.6, action: 'jump' }),
  wp(510, 10, 10, 350.8, [511], { radius: 0.6, action: 'jump' }),
  wp(511, 10, 12.2, 354.6, [512], { radius: 0.6, action: 'jump' }),
  wp(512, 10, 14.4, 358.8, [513], { radius: 0.6, action: 'jump' }),
  wp(513, 10, 16, 372, [520, 521, 522], { radius: 1.5 }),
  ...cpNodes([520, 521, 522], 16, 384.5, [600]),
  // §7 Treasure Gauntlet: zig-zag the volleys, time the crossing balls.
  wp(600, 0, 16, 400, [601], { radius: 2 }),
  wp(601, 0, 16, 413.5, [602], { radius: 1.2, action: 'waitForGap', timeAgainst: 's7-roll-1' }),
  wp(602, 0, 16, 435.5, [603], { radius: 1.2, action: 'waitForGap', timeAgainst: 's7-roll-2' }),
  wp(603, 0, 16, 449, [604], { radius: 2 }),
  wp(604, 0, 18, 468, [], { radius: 4 }),
];

// -----------------------------------------------------------------------------
// Variations
// -----------------------------------------------------------------------------

const cannonParams = (
  f: (p: Record<string, number>) => Record<string, unknown>,
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(CANNONS.map((c) => [c.id, f(c.params as Record<string, number>)]));

const surf: Obstacle[] = [293.75, 306.25, 318.75, 331.25].map((z, k) => ({
  id: `w-surf-${k + 1}`,
  type: 'fanZone',
  position: v(-20, 12, z),
  rotation: { yaw: 90 },
  params: {
    width: 12.5,
    height: 6,
    length: 40,
    strength: 4,
    falloff: 0.3,
    onTime: 3,
    offTime: 2,
    spinUp: 0.8,
    phase: k * 0.5,
    telegraphLead: 0.8,
  },
}));

export default defineRound({
  id: 'cannonball-canyon',
  name: 'Cannonball Canyon',
  type: 'race',
  theme: 'beach',
  objective: 'Run the canyon! Dodge the coconut cannons.',
  tips: [
    'Red rings on the ground show where the next shot lands.',
    'Giant balls roll in lanes — hop the low ridges to change lanes.',
    'Hide behind crates on the bridge. They block one side only.',
  ],
  players: { min: 12, max: 60, ideal: 40 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 240, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-40, -15, -25), max: v(40, 50, 490) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 8, spacing: 1.4 },
  geometry,
  obstacles,
  triggers,
  flyover: {
    path: [
      v(22, 10, -10),
      v(0, 22, 60),
      v(-20, 12, 160),
      v(18, 20, 240),
      v(-24, 18, 310),
      v(16, 24, 370),
      v(0, 28, 490),
    ],
    lookAt: [
      v(0, 2, 30),
      v(0, 0, 100),
      v(0, 0, 172),
      v(0, 5, 245),
      v(0, 10, 312),
      v(0, 14, 368),
      v(0, 18, 440),
    ],
    duration: 8,
  },
  cameraMode: 'orbit',
  music: 'mus_beach_tikitumble',
  speedScaleByStage: [1.0, 1.08, 1.16, 1.24, 1.32],
  fallBehavior: 'respawnCheckpoint',
  botNav,
  variations: [
    { id: 'sunny-siege', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'broadside',
      weight: 2,
      weather: 'clear',
      description: 'Double the volley rate everywhere.',
      obstacleParams: cannonParams((p) => ({ period: Math.round(p.period! * 0.55 * 100) / 100 })),
    },
    {
      id: 'rogue-wave',
      weight: 2,
      weather: 'windy',
      description: 'Lagoon swell pushes rafts and rock-hoppers; canyon balls roll faster.',
      obstacleParams: {
        's5-raft-A': { speed: 9 },
        's5-raft-B': { speed: 9, phase: 3.17 },
        's2-ball-1': { speed: 9.5 },
        's2-ball-2': { speed: 9.5 },
        's2-ball-3': { speed: 9.5 },
        's2-ball-4': { speed: 9.5 },
      },
      addObstacles: surf,
    },
    {
      id: 'moonlit-cove',
      weight: 1,
      weather: 'night',
      description: 'Glowing coconuts: bigger balls, longer telegraphs.',
      obstacleParams: cannonParams((p) => ({
        ballRadius: Math.round(p.ballRadius! * 1.15 * 100) / 100,
        aimTime: 1.0,
      })),
    },
    {
      id: 'ball-pit',
      weight: 1,
      weather: 'sunset',
      description: 'Lane Runner balls swell to 5.2 m; fewer of them, but every lane change is forced.',
      obstacleParams: Object.fromEntries(
        ['s2-ball-1', 's2-ball-2', 's2-ball-3', 's2-ball-4'].map((id) => [
          id,
          { radius: 2.6, spawnPeriod: 6.5 },
        ]),
      ),
    },
  ],
  decorSeed: 1701,
  designNotes: [
    'Competent ≈ 100 s; first ≈ 90 s, 26th of 40 ≈ 135 s.',
    'Cannons: design sweep/pattern aim → lanes across the landing line (pingpong for sweeps, sequence for patterns), apex solved into flightTime, phase → startDelay. No burst (broadside halves the period instead).',
    'Lane Runner ridges stop 4 m short of each end so the outer lanes are not dead ends at the bridge. Boulder Bowl lanes at x ±4.3 (design ±4) widen the safe centre line to 2.6 m.',
    'Cliff route is a 2.2 m climbWall + 2.2 m grab ledge + 1.6 m hop (design: one 6 m climb wall; the controller only climbs via ledges).',
    'Bridge crates shelter visually; foam balls are kinematic and pass through them (no occlusion in the cannon module).',
    'Lighting: sun az 200° el 50° #fff2c4; fog warm turquoise 120/650.',
  ].join(' '),
});
