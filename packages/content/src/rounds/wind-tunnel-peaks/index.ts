/**
 * R6 — Wind Tunnel Peaks (race, space).
 *
 * A vertical climb up floating peaks from a sunny sky, through the clouds,
 * into orbit: bounce pads and updrafts, a gusty gallery with an open edge,
 * thermal stairs, spinning radar dishes, a headwind ramp, low-gravity asteroid
 * hops and the pulsing Big Lift to the finish mesa.
 * Transcribed from docs/design/LEVELS.md §R6.
 *
 * Module mapping notes (the design predates the obstacle library):
 * - `fanZone` blows along local +Z from its face; updrafts are pitched up
 *   (and tilted 8° forward so riders drift onto the ledge). The design's
 *   `gravityFraction` becomes a strength: a column of length L and strength S
 *   tops out at L·S/24 m (gravity 24, rise scale 1, fall scale 2).
 * - Fan housings are solid discs at the face, sized max(width, height)/2, so
 *   updraft faces sit flush with the floor they lift from (they double as fan
 *   pads) and the Jetstream fan hangs above §6, blowing down the slope line.
 * - Low gravity: a constant upward push over walkable tops would un-ground
 *   players, so the low-G "zone" is six columns spanning only the gaps
 *   between asteroids (jumps through them are 1.6× longer and higher).
 * - `bouncePad` takes a launch velocity; `targetApex/targetRange` are solved here.
 * - `movingPlatform` is box-only and speed-based; periods are converted.
 * - The shuttle has no bot-readable timing, so a narrow catwalk was added as a
 *   slow-but-sure alternative (bots use it; humans pick).
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

/** Squashed floating-rock underside hanging below a platform top (decor). */
const rockUnder = (x: number, top: number, z: number, r: number): Piece[] => [
  ball(x, top - r * 0.75, z, r, { color: 'neutral', deco: true }),
  ball(x + r * 0.3, top - r * 1.25, z - r * 0.2, r * 0.6, { color: 'secondary', deco: true }),
];

// -----------------------------------------------------------------------------
// Obstacle builders
// -----------------------------------------------------------------------------

interface LiftOpts {
  width: number;
  /** Column extent along world Z (m). */
  depth: number;
  /** Height gained to the ledge the lift serves (m). */
  rise: number;
  onTime?: number;
  offTime?: number;
  /** Cycle offset (s). */
  phase?: number;
  telegraph?: number;
}

/**
 * Updraft column whose base face sits at (x, baseY, z). Riders top out ~2.5 m
 * above the ledge `rise` metres up and drift forward onto it.
 */
function updraft(id: string, x: number, baseY: number, z: number, o: LiftOpts): Obstacle {
  const length = o.rise + 1;
  const strength = Math.round(((G * (o.rise + 2.5)) / length) * 10) / 10;
  return {
    id,
    type: 'fanZone',
    position: v(x, baseY, z),
    rotation: { pitch: -82 },
    params: {
      width: o.width,
      height: o.depth,
      length,
      strength,
      falloff: 0,
      onTime: o.onTime ?? 1,
      offTime: o.offTime ?? 0,
      spinUp: 0.3,
      phase: o.phase ?? 0,
      telegraphLead: o.telegraph ?? 0.8,
      housingDepth: 0.6,
    },
  };
}

/**
 * Bounce pad whose launch is solved for an apex `apex` m above the pad top and
 * a landing `range` m ahead, `landDelta` m above the pad top.
 */
function pad(
  id: string,
  x: number,
  y: number,
  z: number,
  radius: number,
  apex: number,
  range: number,
  landDelta: number,
): Obstacle {
  const vy = Math.sqrt(2 * G * apex);
  const flight = vy / G + Math.sqrt((2 * (apex - landDelta)) / (2 * G));
  return {
    id,
    type: 'bouncePad',
    position: v(x, y, z),
    // NOTE: pads stay under the 0.35 m step height; a taller pad's bouncy rim launches runners backwards.
    params: {
      radius,
      height: 0.3,
      launch: { x: 0, y: Math.round(vy * 100) / 100, z: Math.round((range / flight) * 100) / 100 },
      cooldown: 0.35,
    },
  };
}

/** Side gust from the gallery's fan wall toward the open edge (+X). */
const gust = (id: string, z: number, phase: number, strength = 14): Obstacle => ({
  id,
  type: 'fanZone',
  position: v(-4.9, 8, z),
  rotation: { yaw: 90 },
  params: {
    width: 10,
    height: 4,
    length: 10,
    strength,
    falloff: 0.2,
    onTime: 2,
    offTime: 2,
    spinUp: 0.4,
    phase,
    telegraphLead: 0.8,
    housingDepth: 1.2,
  },
});

/** Low-gravity column over one asteroid gap (z0 → z1): lift without un-grounding walkers. */
const lowG = (id: string, z0: number, z1: number, width = 14): Obstacle => ({
  id,
  type: 'fanZone',
  // The fan sits below killY so its housing can never catch a falling Tumbler.
  position: v(0, -12, (z0 + z1) / 2),
  rotation: { pitch: -90 },
  params: {
    width,
    height: z1 - z0,
    length: 72,
    strength: 16,
    falloff: 0,
    onTime: 1,
    offTime: 0,
    spinUp: 0.1,
    phase: 0,
    telegraphLead: 0,
    housingDepth: 0.8,
  },
});

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const geometry: Piece[] = [];
const add = (...p: Piece[]): void => {
  geometry.push(...p);
};

/** Jetstream ramp surface height at z (z 263 → 313, y 30 → 48). */
const JET_SLOPE = 18 / 50;
const jetY = (z: number): number => 30 + JET_SLOPE * (z - 263);
const JET_DEG = (Math.atan(JET_SLOPE) * 180) / Math.PI;

// §0 Launch Pad
add(box(0, -0.5, 0, 26, 1, 20, { color: 'safe', bevel: 0.3 }));
add(decal(0, 0, 0, 12, 12, 'safe', 'checker'), decal(0, 0, 8.5, 26, 3, 'accent', 'chevron'));
add(
  box(-13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' }),
  box(13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' }),
);
// Rocket gantry behind the start.
add(
  box(-9, 9, -11.5, 1.2, 18, 1.2, { color: 'neutral', pattern: 'stripes', deco: true }),
  box(9, 9, -11.5, 1.2, 18, 1.2, { color: 'neutral', pattern: 'stripes', deco: true }),
);
for (const y of [5, 10, 15]) add(box(0, y, -11.5, 19, 0.6, 0.8, { color: 'secondary', deco: true }));
add(
  cyl(0, 11, -16, 2.6, 20, { color: 'neutral', pattern: 'stripes', deco: true }),
  ball(0, 21.5, -16, 2.6, { color: 'danger', deco: true }),
);
for (const x of [-2.6, 2.6])
  add(piece('wedge', v(x, 2.5, -16), v(1.6, 4, 2), { color: 'accent', deco: true }));
add(...rockUnder(0, -1, 0, 9));

// §1 Breezy Base (z 10 → 50)
add(box(0, -0.5, 20, 26, 1, 20, { color: 'primary', bevel: 0.3 }));
add(box(0, 2.5, 40, 26, 7, 20, { color: 'secondary', grab: true, bevel: 0.3 }));
add(
  box(11, 0.75, 28.5, 3, 1.5, 3, { color: 'accent' }),
  box(8, 1.5, 28.5, 3, 3, 3, { color: 'accent' }),
  box(5, 2.25, 28.5, 3, 4.5, 3, { color: 'accent' }),
);
add(cyl(-8, 0.02, 28.5, 1.6, 0.04, { color: 'safe', pattern: 'dots', deco: true }));
add(decal(0, 6, 31, 26, 1, 'danger', 'hazard'));
add(...rockUnder(0, -1, 30, 11));

// §2 Gust Gallery (z 50 → 110)
add(box(0, 5.5, 80, 10, 1, 60, { color: 'primary' }));
add(box(-5.5, 9, 80, 1, 8, 60, { color: 'neutral' }));
add(decal(4.8, 6, 80, 0.4, 60, 'danger', 'hazard'));
for (const z of [62, 74, 86, 98]) {
  // Wind-breaks stand off the fan wall: shelter is the 3 m slot upwind of each rock.
  add(box(-0.5, 7.25, z, 3, 2.5, 2.5, { color: 'secondary', bevel: 0.6 }));
  add(cyl(-5.4, 12.2, z + 6, 0.35, 0.5, { color: 'accent', deco: true, rot: { roll: 90 } }));
}
add(box(0, 5.5, 120, 16, 13, 20, { color: 'secondary', grab: true, bevel: 0.3 }));
add(decal(0, 12, 116, 16, 2, 'safe', 'checker'));
add(...rockUnder(0, 5, 80, 6), ...rockUnder(0, -1, 120, 9));

// §3 Thermal Stairs (z 130 → 187)
add(
  cyl(-6, 16, 138, 5, 4, { color: 'primary', grab: true }),
  cyl(-6, 22, 152, 5, 4, { color: 'primary', grab: true }),
);
add(
  box(-6, 24.5, 161, 6, 2, 4, { color: 'accent', grab: true }),
  box(-6, 25.6, 165, 6, 4.2, 4, { color: 'accent', grab: true }),
);
add(
  box(6, 16, 137, 6, 4, 6, { color: 'secondary', grab: true }),
  box(6, 22, 148, 6, 4, 8, { color: 'secondary', grab: true }),
);
add(
  box(6, 28, 159.5, 6, 4, 7, { color: 'secondary', grab: true }),
  box(6, 28, 165, 6, 4, 4, { color: 'secondary' }),
);
add(box(0, 26, 177, 20, 8, 20, { color: 'secondary', grab: true, bevel: 0.3 }));
add(decal(0, 30, 172, 20, 2, 'safe', 'checker'));
add(
  ...rockUnder(-6, 14, 138, 4),
  ...rockUnder(-6, 20, 152, 4),
  ...rockUnder(6, 14, 137, 3.5),
  ...rockUnder(6, 20, 148, 4),
);
add(...rockUnder(6, 26, 161, 4), ...rockUnder(0, 22, 177, 9));
// Cloud layer the climb punches through (y 22–28).
for (const [x, y, z, s] of [
  [-18, 23, 120, 9],
  [16, 25, 150, 11],
  [-20, 27, 190, 10],
  [20, 24, 230, 12],
  [-14, 26, 262, 8],
  [24, 28, 300, 10],
] as const) {
  add(
    box(x, y, z, s * 1.8, 1.2, s, { color: '#ffffff', deco: true, bevel: 0.6 }),
    box(x + s * 0.3, y + 0.8, z - s * 0.1, s, 1.2, s * 0.6, { color: '#ffffff', deco: true, bevel: 0.6 }),
  );
}

// §4 Satellite Spin (z 187 → 263)
add(box(0, 29.5, 253, 22, 1, 20, { color: 'safe', bevel: 0.3 }));
add(decal(0, 30, 248, 22, 2, 'safe', 'checker'));
add(
  cyl(0, 22, 196.2, 1, 16, { color: 'neutral', pattern: 'stripes', deco: true }),
  cyl(0, 22, 213, 1, 16, { color: 'neutral', pattern: 'stripes', deco: true }),
);
for (const z of [196.2, 213])
  add(piece('torus', v(0, 28.8, z), v(6.6, 0.5, 6.6), { color: 'accent', deco: true }));
// Maintenance catwalk beside the shuttle: narrow, slow, certain.
add(box(4.6, 29.7, 231.25, 2, 0.6, 23.5, { color: 'primary', pattern: 'stripes' }));
for (const z of [224, 232, 240]) add(cyl(4.6, 24, z, 0.25, 11, { color: 'neutral', deco: true }));
add(...rockUnder(0, 29, 253, 8));

// §5 Jetstream (z 263 → 325)
add(piece('ramp', v(0, 39, 288), v(12, 18, 50), { color: 'primary', pattern: 'chevron' }));
for (const [x, z] of [
  [3, 278],
  [-3, 290],
  [3, 302],
] as const) {
  add(box(x, jetY(z) + 0.85, z, 3, 2.5, 2, { color: 'secondary', bevel: 0.6 }));
}
const wallLen = 50 / Math.cos(Math.atan(JET_SLOPE));
for (const x of [-6.25, 6.25])
  add(box(x, jetY(288) + 1, 288, 0.5, 2.5, wallLen, { color: 'neutral', rot: { pitch: -JET_DEG } }));
for (const z of [270, 282, 294, 306]) {
  // Gust-light gantries: red/green beacon above the slope every 12 m.
  add(piece('arch', v(0, jetY(z) + 3.2, z), v(14, 6.4, 0.6), { color: 'neutral', deco: true }));
  add(ball(0, jetY(z) + 6.6, z, 0.5, { color: 'danger', deco: true }));
}
add(box(0, 47.5, 319, 20, 1, 12, { color: 'safe', bevel: 0.3 }));
add(decal(0, 48, 317, 20, 2, 'safe', 'checker'));
add(...rockUnder(0, 30, 288, 8), ...rockUnder(0, 47, 319, 6));

// §6 Asteroid Hop (z 325 → 400)
add(cyl(0, 47.5, 332, 3, 2, { color: 'secondary', grab: true, pattern: 'dots' }));
add(cyl(1.5, 49.5, 352, 3, 2, { color: 'secondary', grab: true, pattern: 'dots' }));
add(cyl(0, 50.5, 372, 3, 2, { color: 'secondary', grab: true, pattern: 'dots' }));
add(box(0, 51.5, 393, 22, 1, 28, { color: 'safe', bevel: 0.3 }));
add(decal(0, 52, 390, 20, 2, 'safe', 'checker'));
add(
  ...rockUnder(0, 46.5, 332, 2.6),
  ...rockUnder(1.5, 48.5, 352, 2.6),
  ...rockUnder(0, 49.5, 372, 2.6),
  ...rockUnder(0, 51, 393, 9),
);
{
  // Background asteroids tumbling slowly around the low-G zone.
  let s = 1601;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let k = 0; k < 12; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    add(
      ball(side * (12 + rnd() * 13), 40 + rnd() * 30, 325 + rnd() * 75, 1 + rnd() * 2, {
        color: k % 3 === 0 ? 'secondary' : 'neutral',
        deco: true,
      }),
    );
  }
}

// §7 The Big Lift (z 400 → 425)
add(box(0, 57.25, 416, 22, 13.5, 18, { color: 'secondary', grab: true, bevel: 0.3 }));
add(box(8, 53.9, 406.25, 2.5, 0.6, 1.5, { color: 'accent', grab: true }));
add(box(10.5, 56.1, 406.25, 2.5, 0.6, 1.5, { color: 'accent', grab: true }));
add(box(8, 58.3, 406.25, 2.5, 0.6, 1.5, { color: 'accent', grab: true }));
add(box(10.5, 60.5, 406.25, 2.5, 0.6, 1.5, { color: 'accent', grab: true }));
add(box(8, 62.7, 406.25, 2.5, 0.6, 1.5, { color: 'accent', grab: true }));
add(decal(0, 64, 412, 22, 2, 'safe', 'checker'));
add(
  cyl(0, 70, 422, 2, 12, { color: 'accent', pattern: 'stripes', deco: true }),
  ball(0, 76.5, 422, 2, { color: 'danger', deco: true }),
);
for (const x of [-2.2, 2.2])
  add(piece('wedge', v(x, 65.5, 422), v(1.4, 3, 2), { color: 'neutral', deco: true }));
add(...rockUnder(0, 50.5, 416, 10));
// Space-station crowd ring above the finish, ringed planet and moon on the horizon.
add(
  piece('torus', v(0, 86, 412), v(26, 1.6, 26), { color: 'neutral', deco: true }),
  piece('torus', v(0, 86, 412), v(26, 2.4, 26), {
    color: 'accent',
    pattern: 'stripes',
    deco: true,
    rot: { yaw: 15 },
  }),
);
add(
  ball(-70, 120, 300, 26, { color: 'secondary', deco: true }),
  piece('torus', v(-70, 120, 300), v(42, 2, 42), { color: 'accent', deco: true, rot: { roll: 18 } }),
);
add(ball(80, 90, 120, 9, { color: 'neutral', deco: true }));

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const GUSTS = ['s2-gust-1', 's2-gust-2', 's2-gust-3', 's2-gust-4'];
const LOWG_GAPS: [number, number][] = [
  [325, 329],
  [335, 339],
  [345, 349],
  [355, 359],
  [365, 369],
  [375, 379],
];

const obstacles: Obstacle[] = [
  { id: 's0-gate', type: 'startGate', position: v(0, 0, 7), params: { width: 26, height: 3, style: 'drop' } },

  pad('s1-pad', 0, 0, 24, 1.4, 8, 10, 5.6),
  updraft('s1-lift', -8, 0, 28.5, { width: 3, depth: 3, rise: 6 }),

  gust(GUSTS[0]!, 59, 0),
  gust(GUSTS[1]!, 71, 1),
  gust(GUSTS[2]!, 83, 2),
  gust(GUSTS[3]!, 95, 3),
  updraft('s2-lift-L', -3, 6, 108.5, { width: 3, depth: 3, rise: 6 }),
  updraft('s2-lift-R', 3, 6, 108.5, { width: 3, depth: 3, rise: 6 }),
  pad('s2-pad', 0, 6, 103, 1.2, 8, 10, 5.6),
  { id: 's2-cpgate', type: 'checkpointGate', position: v(0, 12, 116), params: { index: 1, width: 14.2 } },

  updraft('s3-lift-I', -6, 12, 131, { width: 4, depth: 3, rise: 6 }),
  pad('s3-pad-I', -6, 18, 140, 1.2, 7, 10, 5.6),
  updraft('s3-lift-R1', 6, 12, 131.5, {
    width: 4,
    depth: 3,
    rise: 6,
    onTime: 3,
    offTime: 1.5,
    phase: 0,
    telegraph: 1,
  }),
  updraft('s3-lift-R2', 6, 18, 141.5, {
    width: 4,
    depth: 3,
    rise: 6,
    onTime: 3,
    offTime: 1.5,
    phase: 1.5,
    telegraph: 1,
  }),
  updraft('s3-lift-R3', 6, 24, 153.5, {
    width: 4,
    depth: 3,
    rise: 6,
    onTime: 3,
    offTime: 1.5,
    phase: 3,
    telegraph: 1,
  }),
  { id: 's3-cpgate', type: 'checkpointGate', position: v(0, 30, 172), params: { index: 2, width: 18.2 } },

  {
    id: 's4-dish-1',
    type: 'spinningDisc',
    position: v(0, 30, 196.2),
    params: { radius: 7, thickness: 0.8, speed: 0.7, bumps: 3, bumpRadius: 0.8, bumpKnock: 6 },
  },
  {
    id: 's4-dish-2',
    type: 'spinningDisc',
    position: v(0, 30, 213),
    params: { radius: 7.5, thickness: 0.8, speed: -0.9, bumps: 0 },
  },
  {
    id: 's4-wind-2a',
    type: 'fanZone',
    position: v(-9.5, 32, 209.5),
    rotation: { yaw: 90 },
    params: {
      width: 7,
      height: 4,
      length: 19,
      strength: 8,
      falloff: 0.3,
      onTime: 2.5,
      offTime: 1.5,
      spinUp: 0.6,
      phase: 0,
      telegraphLead: 0.8,
    },
  },
  {
    id: 's4-wind-2b',
    type: 'fanZone',
    position: v(-9.5, 32, 216.5),
    rotation: { yaw: 90 },
    params: {
      width: 7,
      height: 4,
      length: 19,
      strength: 8,
      falloff: 0.3,
      onTime: 2.5,
      offTime: 1.5,
      spinUp: 0.6,
      phase: 0.6,
      telegraphLead: 0.8,
    },
  },
  {
    id: 's4-shuttle',
    type: 'movingPlatform',
    position: v(0, 30, 225),
    // Design period 5 s with 1 s holds ⇒ 26 m of travel in 3 s (13 m reach, near end 1.5 m from dish 2).
    params: {
      points: [v(0, 0, 0), v(0, 0, 13)],
      size: v(6, 0.8, 6),
      speed: 8.7,
      mode: 'pingPong',
      pauseTime: 1,
      pauseAt: 'ends',
      easing: 'sine',
    },
  },
  { id: 's4-cpgate', type: 'checkpointGate', position: v(0, 30, 248), params: { index: 3, width: 20.2 } },

  {
    // Hangs above §6 on the extended slope line and blows down the ramp, so its housing never blocks the path.
    id: 's5-jet',
    type: 'fanZone',
    position: v(0, jetY(345) + 2.98, 345),
    rotation: { yaw: 180, pitch: JET_DEG },
    params: {
      width: 12,
      height: 5,
      length: (345 - 262) / Math.cos(Math.atan(JET_SLOPE)),
      strength: 12,
      falloff: 0,
      onTime: 2.5,
      offTime: 2.0,
      spinUp: 0.4,
      phase: 0,
      telegraphLead: 1.0,
      housingDepth: 1.2,
    },
  },
  { id: 's5-cpgate', type: 'checkpointGate', position: v(0, 48, 317), params: { index: 4, width: 18.2 } },

  ...LOWG_GAPS.map(([z0, z1], k) => lowG(`s6-lowg-${k + 1}`, z0, z1)),
  {
    id: 's6-rock-2',
    type: 'movingPlatform',
    position: v(0, 49.5, 342),
    params: {
      points: [v(0, 0, -1), v(0, 0, 1)],
      size: v(6, 2, 6),
      speed: 1.4,
      mode: 'pingPong',
      pauseTime: 0.5,
      pauseAt: 'ends',
      easing: 'sine',
    },
  },
  {
    id: 's6-rock-4',
    type: 'movingPlatform',
    position: v(0, 51, 362),
    params: {
      points: [v(0, -1, 0), v(0, 1, 0)],
      size: v(6, 2, 6),
      speed: 1.55,
      mode: 'pingPong',
      pauseTime: 0.2,
      pauseAt: 'ends',
      easing: 'sine',
    },
  },
  { id: 's6-cpgate', type: 'checkpointGate', position: v(0, 52, 390), params: { index: 5, width: 18.2 } },

  updraft('s7-biglift', 0, 52, 404, { width: 6, depth: 6, rise: 12, onTime: 3, offTime: 1.5, telegraph: 1 }),
  { id: 's7-finish', type: 'finishLine', position: v(0, 64, 412), params: { width: 19.6, height: 6.5 } },
];

// The big lift needs a shorter, stronger column so a full ride fits inside one 3 s "on".
{
  const big = obstacles.find((o) => o.id === 's7-biglift')!;
  Object.assign(big.params as Record<string, unknown>, { length: 10, strength: 34.8 });
}

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
    position: v(0, 14, 116),
    size: v(16, 4, 2),
    respawn: respawnRow(12, 119, [-6, -3.6, -1.2, 1.2, 3.6, 6]),
    respawnYaw: 0,
  },
  {
    id: 'cp-2',
    kind: 'checkpoint',
    index: 2,
    position: v(0, 32, 172),
    size: v(20, 4, 2),
    respawn: respawnRow(30, 175),
    respawnYaw: 0,
  },
  {
    id: 'cp-3',
    kind: 'checkpoint',
    index: 3,
    position: v(0, 32, 248),
    size: v(22, 4, 2),
    respawn: respawnRow(30, 251),
    respawnYaw: 0,
  },
  {
    id: 'cp-4',
    kind: 'checkpoint',
    index: 4,
    position: v(0, 50, 317),
    size: v(20, 4, 2),
    respawn: respawnRow(48, 320),
    respawnYaw: 0,
  },
  {
    id: 'cp-5',
    kind: 'checkpoint',
    index: 5,
    position: v(0, 54, 390),
    size: v(20, 4, 2),
    respawn: respawnRow(52, 393),
    respawnYaw: 0,
  },
  { id: 'void-high', kind: 'void', position: v(0, 20, 305), size: v(60, 2, 230) },
  { id: 'finish', kind: 'finish', position: v(0, 66, 412), size: v(22, 4, 2) },
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
 * after a respawn (nodes far behind their best rank are 4× "further"), so a
 * node within ~2.5 m of every respawn point stops them skipping the jumps
 * between the checkpoint and where they fell.
 */
const cpNodes = (ids: [number, number, number], y: number, z: number, next: number[]): Waypoint[] =>
  [-5, 0, 5].map((x, k) => wp(ids[k]!, x, y, z, next, { radius: 2.6 }));

const botNav: Waypoint[] = [
  // §1: pad / updraft / steps.
  ...cpNodes([8, 0, 9], 0, -0.5, [1, 2, 3]),
  // Pad legs run straight over the pad centre at full speed: the bounce is vertical, the run-up carries you forward.
  wp(1, 0, 0, 19, [10], { radius: 0.6 }),
  // Lift legs aim at a hover point above the column so riders stay in the wind until they top out.
  wp(2, -8, 0, 26.2, [7], { radius: 1, action: 'jump' }),
  wp(7, -8, 6.8, 28.6, [10], { radius: 1.2 }),
  wp(3, 12, 0, 25.5, [4], { radius: 1, action: 'jump' }),
  wp(4, 11, 1.5, 28.5, [5], { radius: 1, action: 'jump' }),
  wp(5, 8, 3, 28.5, [6], { radius: 1, action: 'jump' }),
  wp(6, 5, 4.5, 28.5, [10], { radius: 1, action: 'jump' }),
  wp(10, 0, 6, 45, [100], { radius: 1.5 }),
  // §2 Gust Gallery: hug the fan wall; the rocks catch you when a gust hits.
  wp(100, -3.5, 6, 58, [101], { radius: 1.2 }),
  wp(101, -3.5, 6, 70, [102], { radius: 1.2 }),
  wp(102, -3.5, 6, 82, [103], { radius: 1.2 }),
  wp(103, -3.5, 6, 94, [104, 105, 106], { radius: 1.2 }),
  wp(104, -3, 6, 106.6, [107], { radius: 1, action: 'jump' }),
  wp(107, -3, 12.8, 108.6, [111, 110], { radius: 1.2 }),
  wp(105, 0, 6, 99.5, [110], { radius: 0.6 }),
  wp(106, 3, 6, 106.6, [108], { radius: 1, action: 'jump' }),
  wp(108, 3, 12.8, 108.6, [112, 110], { radius: 1.2 }),
  ...cpNodes([111, 110, 112], 12, 119.5, [200, 210]),
  // §3 Thermal Stairs: jumper route (left) or rider route (right).
  wp(200, -6, 12, 129.5, [202], { radius: 1 }),
  wp(202, -6, 18.8, 130.8, [201], { radius: 1.2 }),
  wp(201, -6, 18, 136.5, [203], { radius: 0.6 }),
  wp(203, -6, 24, 155.5, [204], { radius: 1, action: 'jump' }),
  wp(204, -6, 25.5, 161.5, [205], { radius: 1, action: 'jump' }),
  wp(205, -6, 27.7, 165.5, [206], { radius: 1, action: 'jump' }),
  wp(206, -5, 30, 170.5, [218, 217], { radius: 1.5 }),
  wp(210, 6, 12, 130.2, [214], { radius: 1 }),
  wp(214, 6, 18.8, 131.2, [211], { radius: 1.2 }),
  wp(211, 6, 18, 137.5, [215], { radius: 1.2 }),
  wp(215, 6, 24.8, 141.2, [212], { radius: 1.2 }),
  wp(212, 6, 24, 148.5, [216], { radius: 1.2 }),
  wp(216, 6, 30.8, 153.2, [213], { radius: 1.2 }),
  wp(213, 6, 30, 160, [219, 217], { radius: 1.5 }),
  ...cpNodes([218, 217, 219], 30, 175.5, [220]),
  // §4 Satellite Spin.
  wp(220, 0, 30, 186.4, [300], { radius: 0.5, action: 'jump' }),
  wp(300, 0, 30, 196.2, [301], { radius: 2 }),
  wp(301, 0, 30, 202.6, [302], { radius: 0.7, action: 'jump' }),
  wp(302, -1.5, 30, 213, [303], { radius: 2 }),
  wp(303, 4.5, 30, 218.6, [304], { radius: 0.8 }),
  wp(304, 4.6, 30, 226, [305], { radius: 0.8 }),
  wp(305, 4.6, 30, 240, [306, 307, 308], { radius: 0.8 }),
  ...cpNodes([307, 306, 308], 30, 251.5, [400]),
  // §5 Jetstream: rock to rock, sheltering on the uphill side.
  // Bots cannot read the gust light, so they grind up the rock-free centre line.
  wp(400, 0, 30, 265, [401], { radius: 2 }),
  wp(401, 0, jetY(288), 288, [404, 405, 406], { radius: 1.2 }),
  ...cpNodes([405, 404, 406], 48, 320.5, [500]),
  // §6 Asteroid Hop: every jump from the far edge, through the low-G gap.
  wp(500, 0, 48, 324.6, [501], { radius: 0.5, action: 'jump' }),
  wp(501, 0, 48.5, 334.6, [502], { radius: 0.5, action: 'jump' }),
  wp(502, 0.4, 49.5, 344, [503], { radius: 0.5, action: 'jump' }),
  wp(503, 1.2, 50.5, 354.6, [504], { radius: 0.5, action: 'jump' }),
  wp(504, 0.5, 51, 364.6, [505], { radius: 0.5, action: 'jump' }),
  wp(505, 0, 51.5, 374.6, [506, 507, 508], { radius: 0.5, action: 'jump' }),
  ...cpNodes([507, 506, 508], 52, 393.5, [600]),
  // §7 The Big Lift (the shelf ladder is left to humans: bots cannot chain side-on shelf grabs).
  wp(600, 0, 52, 403, [602], { radius: 1.2, action: 'jump' }),
  wp(602, 0, 64.8, 404.8, [601], { radius: 1.2 }),
  wp(601, 0, 64, 409.5, [700], { radius: 2 }),
  wp(700, 0, 64, 412, [], { radius: 4 }),
];

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

export default defineRound({
  id: 'wind-tunnel-peaks',
  name: 'Wind Tunnel Peaks',
  type: 'race',
  theme: 'space',
  objective: 'Ride the winds to the top of the sky!',
  tips: [
    'Glowing columns are updrafts. Jump in and drift onto the ledge.',
    'Hide behind rocks when the gust lights turn red.',
    'In the low-gravity gaps you jump much, much farther.',
  ],
  players: { min: 10, max: 50, ideal: 36 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 270, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-40, -15, -25), max: v(40, 100, 440) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 8, spacing: 1.4 },
  geometry,
  obstacles,
  triggers,
  flyover: {
    path: [
      v(0, 6, -18),
      v(16, 14, 80),
      v(-18, 26, 150),
      v(20, 38, 210),
      v(-16, 50, 290),
      v(18, 60, 360),
      v(0, 80, 430),
    ],
    lookAt: [
      v(0, 6, 30),
      v(0, 6, 80),
      v(0, 20, 150),
      v(0, 30, 205),
      v(0, 40, 290),
      v(0, 50, 360),
      v(0, 30, 250),
    ],
    duration: 9,
  },
  cameraMode: 'orbit',
  music: 'mus_space_orbitparty',
  speedScaleByStage: [1.0, 1.06, 1.12, 1.18, 1.24],
  fallBehavior: 'respawnCheckpoint',
  botNav,
  variations: [
    { id: 'clear-ascent', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'solar-storm',
      weight: 2,
      weather: 'stormy',
      description: 'Stronger winds everywhere.',
      obstacleParams: {
        ...Object.fromEntries(GUSTS.map((id) => [id, { strength: 17 }])),
        's5-jet': { strength: 14.5, onTime: 3.0 },
      },
    },
    {
      id: 'deep-space',
      weight: 1,
      weather: 'night',
      description: 'Starry from the start; low gravity reaches the Satellite Spin gaps too.',
      addObstacles: [
        lowG('s4-lowg-1', 187, 189.2, 16),
        lowG('s4-lowg-2', 203.2, 205.5, 16),
        lowG('s4-lowg-3', 220.5, 222, 16),
      ],
    },
    {
      id: 'dead-calm',
      weight: 1,
      weather: 'clear',
      description: 'All gust fans off; updrafts always on (beginner).',
      removeObstacles: [...GUSTS, 's5-jet'],
      obstacleParams: {
        's3-lift-R1': { offTime: 0 },
        's3-lift-R2': { offTime: 0 },
        's3-lift-R3': { offTime: 0 },
        's7-biglift': { offTime: 0 },
      },
    },
    {
      id: 'meteor-shower',
      weight: 2,
      weather: 'clear',
      description: 'Space rocks roll across Terrace 4 and Terrace 6.',
      addObstacles: [
        {
          id: 's4-meteor',
          type: 'boulderLane',
          position: v(-11, 30, 253),
          rotation: { yaw: 90 },
          params: {
            lanes: 1,
            length: 22,
            radius: 1.2,
            speed: 7,
            spawnPeriod: 3.5,
            phase: 0,
            dropHeight: 5,
            knockSpeed: 11,
          },
        },
        {
          id: 's6-meteor',
          type: 'boulderLane',
          position: v(11, 52, 395),
          rotation: { yaw: -90 },
          params: {
            lanes: 1,
            length: 22,
            radius: 1.2,
            speed: 7,
            spawnPeriod: 3.5,
            phase: 1.75,
            dropHeight: 5,
            knockSpeed: 11,
          },
        },
      ],
    },
  ],
  decorSeed: 1601,
  designNotes: [
    'Competent ≈ 105 s; pulsing lifts bunch the finish. Sky darkens with altitude (space theme altitude blend).',
    'Updrafts: fanZone pitched −82°, strength = 24·(rise+2.5)/(rise+1), falloff 0; housings double as fan pads flush with the floor.',
    'Big Lift: 10 m column at 34.8 m/s² tops out ~14.5 m above T6 in ~2 s (pulses 3 on / 1.5 off).',
    'Gust Gallery: fans set in the wall push +X at 14 m/s²; shelter = the slot between wall and rock (rocks moved off the wall, fans do not occlude).',
    'Jetstream: fan hung above §6 on the slope line (any fan at the ramp top would wall off Terrace 5).',
    'Low-G: six 16 m/s² columns over the asteroid gaps only (design: one zone, gravityFraction 0.4 — a push over walkable tops would un-ground players). Asteroid tops re-staged 48.5/49.5/50.5/51±1/51.5 (design 48/50/52/48–52/52) so +2 m hops stay inside the shipped jump envelope.',
    'A2/A4 are boxes (movingPlatform has no cylinder). Added a 1.4 m catwalk beside the shuttle (bots cannot time platforms).',
  ].join(' '),
});
