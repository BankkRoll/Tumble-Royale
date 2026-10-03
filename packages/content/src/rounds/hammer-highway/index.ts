/**
 * R5 — Hammer Highway (race, castle).
 *
 * A jester's obstacle parade through a toy castle floating over a moat:
 * moat bridges, battering rams, a crumbling causeway, a three-lane hammer
 * hall, a barrel ramp / grab-ledge rampart, the 3 m Highway and the royal
 * hammers guarding the throne. Transcribed from docs/design/LEVELS.md §R5.
 *
 * Module mapping notes (the design predates the obstacle library):
 * - `pendulumHammer` swings in its local X–Y plane, so `swingAxis: 'x'` rams
 *   are the same module yawed 90°. `knockImpulse` → `knockSpeed`. Every hammer
 *   uses `supports: false`; this file builds castle gantries that stay clear
 *   of neighbouring lanes (the module's own posts would land on them).
 * - `collapsingBridge` has no touch mode and no `dropFraction`; the causeway
 *   uses seeded `random` order with a short interval so ~30 % of stones are
 *   down at once, and the Highway tail uses a timed `sequential` crumble.
 * - `bumperPillar` cannot slide on an axis; the royal guards orbit instead.
 * - `boulderLane` rolls along local +Z on flat ground, so the barrel lanes are
 *   yawed 180° and pitched down the rampart slope.
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

/** 1 m thick floor slab whose walking surface is at `top`. */
const slab = (x: number, top: number, z: number, sx: number, sz: number, o?: PieceOpts): Piece =>
  box(x, top - 0.5, z, sx, 1, sz, { bevel: 0.3, ...o });

const cyl = (x: number, y: number, z: number, r: number, h: number, o?: PieceOpts): Piece =>
  piece('cylinder', v(x, y, z), v(r, h, r), o);

/** Thin decorative strip lying on a surface (checkpoint pads, hazard edges). */
const decal = (x: number, top: number, z: number, sx: number, sz: number, color: string, pattern: Piece['pattern']): Piece =>
  box(x, top + 0.01, z, sx, 0.02, sz, { color, pattern, deco: true, bevel: 0 });

/** Six respawn points across the width, `z` past the trigger, standing on `top`. */
const respawnRow = (top: number, z: number, xs = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5]): Vec[] => xs.map((x) => v(x, top + 0.1, z));

/** Castle tower: round shaft from `baseY` to `topY`, crenellated cap ring. */
function tower(x: number, z: number, baseY: number, topY: number, r: number, color = 'neutral'): Piece[] {
  const h = topY - baseY;
  const out: Piece[] = [cyl(x, baseY + h / 2, z, r, h, { color, deco: true }), cyl(x, topY + 0.3, z, r + 0.35, 0.6, { color: 'secondary', deco: true })];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    out.push(box(x + Math.cos(a) * r, topY + 1, z + Math.sin(a) * r, 0.7, 0.8, 0.7, { color: 'secondary', deco: true }));
  }
  // Pennant pole + flag in accent (non-team heraldry).
  out.push(cyl(x, topY + 2.6, z, 0.08, 3.2, { color: 'neutral', deco: true }));
  out.push(piece('wedge', v(x + 0.55, topY + 3.6, z), v(0.08, 0.9, 1.1), { color: 'accent', deco: true, rot: { roll: 90 } }));
  return out;
}

/** Gantry beam spanning two towers, centred over a hammer pivot. */
const beam = (z: number, y: number, span: number, depth = 1.2): Piece =>
  box(0, y, z, span, 0.8, depth, { color: 'secondary', pattern: 'stripes', deco: true, bevel: 0.25 });

// -----------------------------------------------------------------------------
// Hammers
// -----------------------------------------------------------------------------

interface HammerSpec {
  pivotHeight: number;
  armLength: number;
  headRadius: number;
  headLength: number;
  amplitudeDeg: number;
  period: number;
  phase: number;
  knockSpeed: number;
}

/**
 * Pendulum hammer at `pos`. `along` swings it along the course (battering
 * ram, design `swingAxis: 'x'`) by yawing the module's X–Y swing plane.
 */
function hammer(id: string, pos: Vec, h: HammerSpec, along = false): Obstacle {
  return {
    id,
    type: 'pendulumHammer',
    position: pos,
    ...(along ? { rotation: { yaw: 90 } } : {}),
    // Rams shove along the walkway (|knock| < the 9 m/s stun threshold): you lose ground, not the bridge.
    params: { ...h, supports: false, ...(along ? { knockSpeed: 8.5, knockLift: 2.5, stun: false } : { knockLift: 7, stun: true }) },
  };
}

const MOAT_HAMMER: Omit<HammerSpec, 'phase'> = {
  pivotHeight: 10,
  armLength: 8,
  headRadius: 1.1,
  headLength: 2.4,
  amplitudeDeg: 60,
  period: 3.0,
  knockSpeed: 12,
};

const RAM: Omit<HammerSpec, 'phase'> = {
  pivotHeight: 9.5,
  armLength: 7,
  headRadius: 1.0,
  headLength: 3.0,
  amplitudeDeg: 55,
  period: 3.2,
  knockSpeed: 10,
};

const GIANT: Omit<HammerSpec, 'phase'> = {
  pivotHeight: 14,
  armLength: 12,
  headRadius: 1.6,
  headLength: 4,
  amplitudeDeg: 50,
  period: 4.0,
  knockSpeed: 14,
};

const HALL_SIDE: Omit<HammerSpec, 'phase'> = {
  pivotHeight: 8.9,
  armLength: 7.4,
  headRadius: 1.0,
  headLength: 2.4,
  amplitudeDeg: 45,
  period: 2.4,
  // Design 12-ish; the hall walls had to move outside the swing arc, so side
  // lanes lose their wall-side safety. A softer knock compensates.
  knockSpeed: 11,
};

const HALL_RAM: Omit<HammerSpec, 'phase'> = {
  pivotHeight: 8.9,
  armLength: 6.5,
  headRadius: 1.0,
  headLength: 3.0,
  amplitudeDeg: 65,
  period: 3.6,
  knockSpeed: 11,
};

const HIGHWAY: Omit<HammerSpec, 'phase'> = { ...MOAT_HAMMER, knockSpeed: 13 };

const ROYAL: Omit<HammerSpec, 'phase'> = {
  pivotHeight: 16,
  armLength: 13,
  headRadius: 2.0,
  headLength: 6,
  amplitudeDeg: 55,
  period: 4.0,
  knockSpeed: 15,
};

/**
 * Crumbling causeway: 5 m anchor stones (static) alternate with 3 m crumbling
 * stones (8 per causeway) that shake, drop and pop back in a seeded random
 * order. Holes never merge, so a hole is always a 3 m hop or a short wait.
 */
const CAUSE_START = 129;
const CAUSE_PITCH = 8;
const CRUMBLE_LEN = 3;
const causeway = (id: string, x: number, seed: number, startDelay: number): Obstacle => ({
  id,
  type: 'collapsingBridge',
  // Segment k spans z 134 + 8k … 137 + 8k: a gap of 5 between 3 m stones leaves room for the anchors.
  position: v(x, 0, CAUSE_START + 5 - (CAUSE_PITCH - CRUMBLE_LEN) / 2),
  params: {
    segments: 8,
    segmentLength: CAUSE_PITCH,
    width: 4,
    thickness: 0.8,
    gap: CAUSE_PITCH - CRUMBLE_LEN,
    order: 'random',
    seed,
    startDelay,
    interval: 1.0,
    warnTime: 0.8,
    fallTime: 0.5,
    respawn: true,
    respawnDelay: 1.5,
    riseTime: 0.6,
    cycleGap: 1.0,
  },
});

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const geometry: Piece[] = [];
const add = (...p: Piece[]): void => {
  geometry.push(...p);
};

// Moat under the floating island (visual only; killY handles falls).
add(box(0, -8, 245, 140, 0.2, 560, { color: '#5fb8ff', deco: true, bevel: 0 }));
for (let k = 0; k < 14; k++) {
  // Rubber ducks bobbing in the moat.
  const x = (k % 2 === 0 ? -1 : 1) * (14 + ((k * 7) % 11));
  const z = 20 + k * 33;
  add(piece('sphere', v(x, -7.3, z), v(0.7, 0.7, 0.7), { color: 'accent', deco: true }));
  add(piece('sphere', v(x, -6.4, z + 0.4), v(0.42, 0.42, 0.42), { color: 'accent', deco: true }));
}

// §0 Gate Plaza (z −10 → 10)
add(slab(0, 0, 0, 26, 20, { color: 'neutral' }));
add(decal(0, 0, 8.5, 26, 3, 'safe', 'checker'));
add(box(-13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' }), box(13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' }));
add(box(0, 4, -10.75, 30, 8, 1.5, { color: 'neutral', bevel: 0.3 }));
add(piece('arch', v(0, 3.75, -10), v(9, 7.5, 2), { color: 'secondary', deco: true }));
for (let k = -3; k <= 3; k++) add(box(k * 1.1, 4.2, -9.85, 0.18, 6.4, 0.18, { color: 'neutral', deco: true, bevel: 0.05 }));
add(...tower(-15, -10.5, -10, 12, 2.6), ...tower(15, -10.5, -10, 12, 2.6));

// §1 Moat Bridges (z 10 → 64)
for (const x of [-8, 0, 8]) {
  add(slab(x, 0, 31, 4, 42));
  add(decal(x - 1.9, 0, 31, 0.2, 14, 'danger', 'hazard'), decal(x + 1.9, 0, 31, 0.2, 14, 'danger', 'hazard'));
}
add(slab(0, 0, 58, 26, 12, { color: 'safe' }));
// One castle gantry carries all three moat hammers (staggered ±2.4 m so heads never clip).
add(...tower(-19, 31, -10, 13, 2.2), ...tower(19, 31, -10, 13, 2.2));
add(box(0, 10.7, 31, 40, 0.8, 6.6, { color: 'secondary', pattern: 'stripes', deco: true, bevel: 0.3 }));

// §2 Ram Run (z 64 → 129)
add(slab(0, 0, 92, 6, 56));
add(decal(-2.9, 0, 92, 0.2, 56, 'danger', 'hazard'), decal(2.9, 0, 92, 0.2, 56, 'danger', 'hazard'));
add(slab(0, 0, 124.5, 20, 9, { color: 'safe' }));
add(decal(0, 0, 124, 20, 2, 'safe', 'checker'));
for (const z of [74, 88, 102]) {
  add(cyl(-4.6, 0.25, z, 0.5, 20.5, { color: 'neutral', deco: true }), cyl(4.6, 0.25, z, 0.5, 20.5, { color: 'neutral', deco: true }));
  add(beam(z, 10.1, 10, 1));
}

// §3 Crumbling Causeway (z 129 → 209)
add(slab(0, 0, 203, 24, 12, { color: 'safe' }));
add(decal(0, 0, 202, 24, 2, 'safe', 'checker'));
for (const z of [150, 176]) add(piece('arch', v(0, 3, z), v(34, 26, 2), { color: 'neutral', pattern: 'stripes', deco: true }));
for (const x of [-5, 5]) {
  for (let j = 0; j <= 8; j++) {
    const z0 = CAUSE_START + j * CAUSE_PITCH;
    const len = j === 8 ? 4 : 5;
    add(box(x, -0.4, z0 + len / 2, 4, 0.8, len, { color: 'secondary', bevel: 0.25 }));
    // Anchor piers rising out of the moat: these stones never fall.
    add(cyl(x, -4.5, z0 + len / 2, 0.7, 7.4, { color: 'neutral', deco: true }));
  }
}

// §4 Hammer Hall (z 209 → 287)
add(slab(0, 0, 210, 18, 2, { color: 'secondary' }));
for (const x of [-7, 0, 7]) add(slab(x, 0, 245, 4, 68));
add(slab(0, 0, 233, 18, 2, { color: 'secondary', pattern: 'stripes' }));
add(slab(0, 0, 257, 18, 2, { color: 'secondary', pattern: 'stripes' }));
add(slab(0, 0, 283, 20, 8, { color: 'safe' }));
for (const x of [-4.9, -2.1, 2.1, 4.9]) {
  add(decal(x, 0, 222, 0.2, 21, 'danger', 'hazard'), decal(x, 0, 245, 0.2, 22, 'danger', 'hazard'), decal(x, 0, 268.5, 0.2, 21, 'danger', 'hazard'));
}
// Hall walls stand outside the side hammers' arc (±13.8 m) so heads never clip.
for (const x of [-15.5, 15.5]) {
  add(box(x, 0, 248, 1, 20, 82, { color: 'neutral', bevel: 0.3 }));
  for (const z of [215, 233, 251, 269]) {
    add(box(x - Math.sign(x) * 0.55, 6.5, z, 0.1, 5, 2.4, { color: 'accent', pattern: 'stripes', deco: true, bevel: 0.05 }));
  }
}
for (const z of [221, 245, 269]) add(box(0, 9.5, z, 32, 0.8, 1.2, { color: 'secondary', pattern: 'stripes', deco: true, bevel: 0.25 }));

// §5 Rampart Climb (z 287 → 341)
add(piece('ramp', v(-3, 4, 306), v(12, 8, 38), { color: 'primary', pattern: 'chevron' }));
add(box(7, 0.6, 291, 6, 3.2, 8, { color: 'secondary', grab: true }));
add(box(7, 1.7, 299, 6, 5.4, 8, { color: 'secondary', grab: true }));
add(box(7, 2.8, 307, 6, 7.6, 8, { color: 'secondary', grab: true }));
add(box(7, 3.5, 318, 6, 9, 14, { color: 'secondary' }));
for (const [y, z] of [
  [2.2, 287],
  [4.4, 295],
  [6.6, 303],
] as const) {
  add(box(7, y - 0.15, z - 0.1, 6, 0.3, 0.3, { color: 'accent', grab: true, bevel: 0.08 }));
}
add(box(0, 7.5, 333, 22, 1, 16, { color: 'safe', bevel: 0.3 }));
add(decal(0, 8, 333, 22, 2, 'safe', 'checker'));
add(box(3.5, 4.5, 306, 1, 9, 38, { color: 'neutral' }));
for (const x of [-10.5, 10.5]) for (const z of [326, 329.5, 333, 336.5, 340]) add(box(x, 9, z, 1, 2, 1.2, { color: 'neutral' }));
// Low parapet on the open left edge of the barrel ramp.
add(box(-9.2, 4.5, 306, 0.4, 1.2, 38.9, { color: 'neutral', rot: { pitch: -11.9 } }));
// Barrel stack the lanes roll out of, and hay bales where they burst.
for (const [x, z] of [
  [-8, 327],
  [-4, 327],
  [-2, 327.6],
] as const) {
  add(cyl(x, 8.9, z, 0.8, 1.8, { color: 'secondary', pattern: 'stripes', deco: true }));
}
for (const x of [-6, 0]) add(box(x, 0.6, 285.4, 2.6, 1.2, 1.2, { color: 'accent', pattern: 'stripes', deco: true }));

// §6 The Highway (z 341 → 432)
add(box(0, 7.5, 353.5, 3, 1, 25, { color: 'primary' }));
add(cyl(0, 7.5, 370, 4, 1, { color: 'safe', grab: true }));
add(box(0, 7.5, 386, 3, 1, 24, { color: 'primary' }));
add(cyl(0, 7.5, 402, 4, 1, { color: 'safe', grab: true }));
add(cyl(0, -3, 370, 3.6, 20, { color: 'neutral' }), cyl(0, -3, 402, 3.6, 20, { color: 'neutral' }));
add(decal(-1.45, 8, 353.5, 0.1, 25, 'danger', 'hazard'), decal(1.45, 8, 353.5, 0.1, 25, 'danger', 'hazard'));
add(decal(-1.45, 8, 386, 0.1, 24, 'danger', 'hazard'), decal(1.45, 8, 386, 0.1, 24, 'danger', 'hazard'));
add(box(0, 7.5, 426, 24, 1, 12, { color: 'safe', bevel: 0.3 }));
add(decal(0, 8, 424, 24, 2, 'safe', 'checker'));
for (const z of [348, 358, 381, 391]) {
  add(cyl(-11, 3.5, z, 0.9, 31, { color: 'neutral', deco: true }), cyl(11, 3.5, z, 0.9, 31, { color: 'neutral', deco: true }));
  add(beam(z, 18.8, 24, 1));
}
// Rest-tower pennants: the flyover frames them as the Highway's breathing spots.
add(cyl(-3.2, 10.5, 370, 0.08, 5, { color: 'neutral', deco: true }), cyl(3.2, 10.5, 402, 0.08, 5, { color: 'neutral', deco: true }));
add(piece('wedge', v(-2.7, 12.4, 370), v(0.08, 1, 1.2), { color: 'accent', deco: true, rot: { roll: 90 } }));
add(piece('wedge', v(3.7, 12.4, 402), v(0.08, 1, 1.2), { color: 'accent', deco: true, rot: { roll: 90 } }));

// §7 Throne Run (z 432 → 492)
add(box(0, 7.5, 451, 24, 1, 38, { color: 'primary', pattern: 'checker', bevel: 0.3 }));
add(piece('ramp', v(0, 9, 476), v(16, 2, 12), { color: 'accent', pattern: 'chevron' }));
add(box(0, 9.5, 487, 22, 1, 10, { color: 'safe', pattern: 'checker', bevel: 0.3 }));
add(box(0, 13, 491.5, 4, 6, 1, { color: 'accent', deco: true }));
add(box(0, 10.6, 490.6, 3, 1.2, 1.6, { color: 'danger', deco: true }));
add(piece('sphere', v(0, 16.4, 491.5), v(1.1, 1.1, 1.1), { color: 'accent', deco: true }));
add(box(-16, 11, 460, 6, 6, 40, { color: 'neutral', pattern: 'stripes', deco: true }));
add(box(16, 11, 460, 6, 6, 40, { color: 'neutral', pattern: 'stripes', deco: true }));
for (const z of [444, 458]) {
  add(...tower(-20, z, -12, 25, 1.6), ...tower(20, z, -12, 25, 1.6));
  add(box(0, 24.8, z, 42, 1, 1.4, { color: 'secondary', pattern: 'stripes', deco: true, bevel: 0.3 }));
}
add(...tower(-12.5, 492, -12, 18, 2.4), ...tower(12.5, 492, -12, 18, 2.4));

// Floating-island dressing: corner keeps, a waterfall and cardboard clouds on sticks.
add(...tower(-26, 60, -12, 16, 3), ...tower(26, 140, -12, 18, 3), ...tower(-26, 250, -12, 14, 3), ...tower(27, 340, -12, 20, 3));
add(box(-34, -2, 300, 4, 14, 10, { color: '#bfe9ff', pattern: 'stripes', deco: true, bevel: 0.5 }));
for (const [x, y, z] of [
  [-33, 26, 90],
  [34, 30, 210],
  [-30, 34, 380],
  [33, 28, 470],
] as const) {
  add(piece('sphere', v(x, y, z), v(4, 4, 4), { color: 'neutral', deco: true }));
  add(piece('sphere', v(x + 4, y - 0.8, z + 1), v(3, 3, 3), { color: 'neutral', deco: true }));
  add(cyl(x, y - 9, z, 0.25, 14, { color: 'secondary', deco: true }));
}

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const obstacles: Obstacle[] = [
  { id: 's0-gate', type: 'startGate', position: v(0, 0, 7), params: { width: 26, height: 3, style: 'drop' } },

  hammer('s1-ham-L', v(-8, 0, 28.6), { ...MOAT_HAMMER, phase: 0 }),
  hammer('s1-ham-C', v(0, 0, 31), { ...MOAT_HAMMER, phase: 0.33 }),
  hammer('s1-ham-R', v(8, 0, 33.4), { ...MOAT_HAMMER, phase: 0.66 }),

  hammer('s2-ram-1', v(0, 0, 74), { ...RAM, phase: 0 }, true),
  hammer('s2-ram-2', v(0, 0, 88), { ...RAM, phase: 0.35 }, true),
  hammer('s2-ram-3', v(0, 0, 102), { ...RAM, phase: 0.7 }, true),
  { id: 's2-cpgate', type: 'checkpointGate', position: v(0, 0, 124), params: { index: 1, width: 18.2 } },

  causeway('s3-cause-L', -5, 51, 3),
  causeway('s3-cause-R', 5, 52, 11),
  hammer('s3-giant-1', v(0, 0, 150), { ...GIANT, phase: 0 }),
  hammer('s3-giant-2', v(0, 0, 176), { ...GIANT, phase: 0.5 }),
  { id: 's3-cpgate', type: 'checkpointGate', position: v(0, 0, 202), params: { index: 2, width: 22.2 } },

  hammer('s4-hamL-1', v(-7, 0, 221), { ...HALL_SIDE, phase: 0 }),
  hammer('s4-hamL-2', v(-7, 0, 245), { ...HALL_SIDE, phase: 0.33 }),
  hammer('s4-hamL-3', v(-7, 0, 269), { ...HALL_SIDE, phase: 0.66 }),
  hammer('s4-ramC-1', v(0, 0, 221), { ...HALL_RAM, phase: 0.5 }, true),
  hammer('s4-ramC-2', v(0, 0, 245), { ...HALL_RAM, phase: 0.83 }, true),
  hammer('s4-ramC-3', v(0, 0, 269), { ...HALL_RAM, phase: 0.16 }, true),
  hammer('s4-hamR-1', v(7, 0, 221), { ...HALL_SIDE, phase: 0.16 }),
  hammer('s4-hamR-2', v(7, 0, 245), { ...HALL_SIDE, phase: 0.5 }),
  hammer('s4-hamR-3', v(7, 0, 269), { ...HALL_SIDE, phase: 0.83 }),

  // Barrel lanes: start at the ramp top (z 325, y 8) and roll 38.8 m down the 11.9° slope.
  {
    id: 's5-barrel-L',
    type: 'boulderLane',
    position: v(-6, 8, 325),
    rotation: { yaw: 180, pitch: 11.9 },
    params: { lanes: 1, length: 38.8, radius: 1.2, speed: 8, spawnPeriod: 3.5, phase: 0, dropHeight: 2.5, dropTime: 0.4, knockSpeed: 9, knockLift: 3 },
  },
  {
    id: 's5-barrel-C',
    type: 'boulderLane',
    position: v(0, 8, 325),
    rotation: { yaw: 180, pitch: 11.9 },
    params: { lanes: 1, length: 38.8, radius: 1.2, speed: 8, spawnPeriod: 3.5, phase: 1.75, dropHeight: 2.5, dropTime: 0.4, knockSpeed: 9, knockLift: 3 },
  },
  { id: 's5-cpgate', type: 'checkpointGate', position: v(0, 8, 333), params: { index: 3, width: 20.2 } },

  hammer('s6-ham-1', v(0, 8, 348), { ...HIGHWAY, phase: 0 }),
  hammer('s6-ham-2', v(0, 8, 358), { ...HIGHWAY, phase: 0.5 }),
  hammer('s6-ham-3', v(0, 8, 381), { ...HIGHWAY, phase: 0.25 }),
  hammer('s6-ham-4', v(0, 8, 391), { ...HIGHWAY, phase: 0.75 }),
  {
    id: 's6-tail',
    type: 'collapsingBridge',
    position: v(0, 8, 406),
    params: {
      segments: 7,
      segmentLength: 2,
      width: 3,
      thickness: 0.6,
      gap: 0.06,
      order: 'sequential',
      seed: 61,
      startDelay: 20,
      interval: 0.45,
      warnTime: 0.6,
      fallTime: 0.6,
      respawn: true,
      respawnDelay: 2.4,
      riseTime: 0.6,
      cycleGap: 2.5,
    },
  },
  { id: 's6-cpgate', type: 'checkpointGate', position: v(0, 8, 424), params: { index: 4, width: 22.2 } },

  hammer('s7-royal-1', v(0, 8, 444), { ...ROYAL, phase: 0 }),
  hammer('s7-royal-2', v(0, 8, 458), { ...ROYAL, phase: 0.5 }),
  {
    id: 's7-guard-L',
    type: 'bumperPillar',
    position: v(-8, 8, 451),
    params: { radius: 1.0, height: 2.4, bounceSpeed: 8.5, bounceLift: 2.5, orbitRadius: 3, orbitSpeed: 2.09, phase: 0 },
  },
  {
    id: 's7-guard-R',
    type: 'bumperPillar',
    position: v(8, 8, 451),
    params: { radius: 1.0, height: 2.4, bounceSpeed: 8.5, bounceLift: 2.5, orbitRadius: 3, orbitSpeed: 2.09, phase: Math.PI },
  },
  { id: 's7-finish', type: 'finishLine', position: v(0, 10, 486), params: { width: 19.6, height: 6.5 } },
];

// -----------------------------------------------------------------------------
// Triggers
// -----------------------------------------------------------------------------

const triggers: Trigger[] = [
  { id: 'cp-0', kind: 'checkpoint', index: 0, position: v(0, 2, 0), size: v(26, 4, 20), respawn: respawnRow(0, -1, [-6, -3.6, -1.2, 1.2, 3.6, 6]), respawnYaw: 0 },
  { id: 'cp-1', kind: 'checkpoint', index: 1, position: v(0, 2, 124), size: v(20, 4, 2), respawn: respawnRow(0, 126.5), respawnYaw: 0 },
  { id: 'cp-2', kind: 'checkpoint', index: 2, position: v(0, 2, 202), size: v(24, 4, 2), respawn: respawnRow(0, 205), respawnYaw: 0 },
  { id: 'cp-3', kind: 'checkpoint', index: 3, position: v(0, 10, 333), size: v(22, 4, 2), respawn: respawnRow(8, 336), respawnYaw: 0 },
  { id: 'cp-4', kind: 'checkpoint', index: 4, position: v(0, 10, 424), size: v(24, 4, 2), respawn: respawnRow(8, 427), respawnYaw: 0 },
  { id: 'finish', kind: 'finish', position: v(0, 12, 486), size: v(22, 4, 2) },
];

// -----------------------------------------------------------------------------
// Bot nav
// -----------------------------------------------------------------------------

const wp = (id: number, x: number, y: number, z: number, next: number[], o: Partial<Waypoint> = {}): Waypoint => ({
  id,
  position: v(x, y, z),
  radius: 1.5,
  next,
  action: 'run',
  ...o,
});

const LANES = [-7, 0, 7] as const;
const HALL_IDS = [
  ['s4-hamL-1', 's4-hamL-2', 's4-hamL-3'],
  ['s4-ramC-1', 's4-ramC-2', 's4-ramC-3'],
  ['s4-hamR-1', 's4-hamR-2', 's4-hamR-3'],
] as const;

/**
 * Nodes across a checkpoint's respawn line. Bots re-pick the nearest node
 * after a respawn (nodes far behind their best rank count 4× further), so a
 * node within ~2.5 m of every respawn point stops them skipping the safe
 * approach between the checkpoint and where they fell.
 */
const cpNode = (id: number, x: number, y: number, z: number, next: number[]): Waypoint => wp(id, x, y, z, next, { radius: 2.6 });

const botNav: Waypoint[] = [
  // §0–§1: pick the least crowded bridge, time its hammer.
  cpNode(14, -5, 0, -0.5, [11, 12]),
  cpNode(0, 0, 0, -0.5, [11, 12, 13]),
  cpNode(15, 5, 0, -0.5, [12, 13]),
  wp(11, -8, 0, 9, [1], { radius: 1.2 }),
  wp(12, 0, 0, 9, [2], { radius: 1.2 }),
  wp(13, 8, 0, 9, [3], { radius: 1.2 }),
  wp(1, -8, 0, 21, [4], { radius: 1, action: 'waitForGap', timeAgainst: 's1-ham-L' }),
  wp(2, 0, 0, 24, [5], { radius: 1, action: 'waitForGap', timeAgainst: 's1-ham-C' }),
  wp(3, 8, 0, 26, [6], { radius: 1, action: 'waitForGap', timeAgainst: 's1-ham-R' }),
  wp(4, -8, 0, 53.5, [7], { radius: 1.2 }),
  wp(5, 0, 0, 53.5, [7], { radius: 1.2 }),
  wp(6, 8, 0, 53.5, [7], { radius: 1.2 }),
  wp(7, 0, 0, 60, [100], { radius: 2 }),
  // §2 Ram Run: chase each ram as it swings away.
  wp(100, 0, 0, 66, [101], { radius: 0.8, action: 'waitForGap', timeAgainst: 's2-ram-1' }),
  wp(101, 0, 0, 81, [102], { radius: 0.8, action: 'waitForGap', timeAgainst: 's2-ram-2' }),
  wp(102, 0, 0, 95, [103, 104, 105], { radius: 0.8, action: 'waitForGap', timeAgainst: 's2-ram-3' }),
  cpNode(104, -5, 0, 126.8, [200]),
  cpNode(103, 0, 0, 126.8, [200, 201]),
  cpNode(105, 5, 0, 126.8, [201]),
  // §3 Causeway: outer strips dodge the giant hammers; hop anchor to anchor over the crumbling stones.
  wp(200, -6.2, 0, 130.5, [220], { radius: 1 }),
  wp(201, 6.2, 0, 130.5, [240], { radius: 1 }),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => wp(220 + k, -6.2, 0, 133.4 + 8 * k, [k < 7 ? 221 + k : 206], { radius: 0.7, action: 'jump' })),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => wp(240 + k, 6.2, 0, 133.4 + 8 * k, [k < 7 ? 241 + k : 207], { radius: 0.7, action: 'jump' })),
  wp(206, -5.5, 0, 199, [208, 211], { radius: 1.2 }),
  wp(207, 5.5, 0, 199, [208, 212], { radius: 1.2 }),
  cpNode(211, -5, 0, 205.5, [290, 291]),
  cpNode(208, 0, 0, 205.5, [290, 291, 292]),
  cpNode(212, 5, 0, 205.5, [291, 292]),
  // §4 Hammer Hall: line up on the entry sill, per-lane timing, lane swaps on the cross-bridges.
  ...LANES.map((x, i) => wp(290 + i, x, 0, 210, [300 + i], { radius: 1 })),
  ...LANES.map((x, i) => wp(300 + i, x, 0, 213.5, [310 + i], { radius: 1, action: 'waitForGap', timeAgainst: HALL_IDS[i]![0] })),
  ...LANES.map((x, i) => wp(310 + i, x, 0, 233, LANES.map((_, j) => 320 + j).filter((_, j) => Math.abs(j - i) <= 1), { radius: 1 })),
  ...LANES.map((x, j) => wp(320 + j, x, 0, 233.5, [330 + j], { radius: 1 })),
  ...LANES.map((x, j) => wp(330 + j, x, 0, 237.5, [340 + j], { radius: 1, action: 'waitForGap', timeAgainst: HALL_IDS[j]![1] })),
  ...LANES.map((x, j) => wp(340 + j, x, 0, 257, LANES.map((_, k) => 350 + k).filter((_, k) => Math.abs(k - j) <= 1), { radius: 1 })),
  ...LANES.map((x, k) => wp(350 + k, x, 0, 257.5, [360 + k], { radius: 1 })),
  ...LANES.map((x, k) => wp(360 + k, x, 0, 261.5, [370 + k], { radius: 1, action: 'waitForGap', timeAgainst: HALL_IDS[k]![2] })),
  ...LANES.map((x, k) => wp(370 + k, x, 0, 281, [380], { radius: 1.2 })),
  wp(380, 0, 0, 284, [400, 410], { radius: 2.5 }),
  // §5 Rampart: barrel ramp (dodge strips) or the grab-ledge ladder.
  wp(400, -8.1, 0, 288.5, [401], { radius: 0.7 }),
  wp(401, -8.1, 4.2, 307, [402], { radius: 0.7 }),
  wp(402, -8.1, 8, 325.5, [420, 421], { radius: 1 }),
  wp(410, 7, 0, 285.6, [411], { radius: 1, action: 'jump' }),
  wp(411, 7, 2.2, 293.6, [412], { radius: 1, action: 'jump' }),
  wp(412, 7, 4.4, 301.6, [413], { radius: 1, action: 'jump' }),
  wp(413, 7, 6.6, 309.6, [414], { radius: 1, action: 'jump' }),
  wp(414, 7, 8, 321, [420, 422], { radius: 1.5 }),
  cpNode(421, -5, 8, 336.5, [500]),
  cpNode(420, 0, 8, 336.5, [500]),
  cpNode(422, 5, 8, 336.5, [500]),
  // §6 The Highway: hug the centre line, rest on the towers.
  wp(500, 0, 8, 342.5, [501], { radius: 0.8, action: 'waitForGap', timeAgainst: 's6-ham-1' }),
  wp(501, 0, 8, 353, [502], { radius: 0.8, action: 'waitForGap', timeAgainst: 's6-ham-2' }),
  wp(502, 0, 8, 370, [503], { radius: 2 }),
  wp(503, 0, 8, 375.5, [504], { radius: 0.8, action: 'waitForGap', timeAgainst: 's6-ham-3' }),
  wp(504, 0, 8, 386, [505], { radius: 0.8, action: 'waitForGap', timeAgainst: 's6-ham-4' }),
  wp(505, 0, 8, 402, [506], { radius: 2 }),
  wp(506, 0, 8, 421.5, [507, 508, 509], { radius: 1.5 }),
  cpNode(507, -5, 8, 427.5, [600]),
  cpNode(508, 0, 8, 427.5, [600]),
  cpNode(509, 5, 8, 427.5, [600]),
  // §7 Throne Run: time the royal hammers, or brave the guards on the flanks.
  wp(600, 0, 8, 435, [601, 602, 603], { radius: 3 }),
  wp(601, 0, 8, 438.5, [604], { radius: 1, action: 'waitForGap', timeAgainst: 's7-royal-1' }),
  wp(604, 0, 8, 452, [610], { radius: 1, action: 'waitForGap', timeAgainst: 's7-royal-2' }),
  wp(602, -8, 8, 442, [605], { radius: 1.5, action: 'waitForGap', timeAgainst: 's7-guard-L' }),
  wp(603, 8, 8, 442, [606], { radius: 1.5, action: 'waitForGap', timeAgainst: 's7-guard-R' }),
  wp(605, -8, 8, 466, [610], { radius: 1.5 }),
  wp(606, 8, 8, 466, [610], { radius: 1.5 }),
  wp(610, 0, 8, 469, [611], { radius: 3 }),
  wp(611, 0, 10, 486, [], { radius: 4 }),
];

// -----------------------------------------------------------------------------
// Variations
// -----------------------------------------------------------------------------

/** Crosswind fans along the Highway's left flank (storm-siege). Split into 15 m fans so housings stay small. */
const crosswind: Obstacle[] = [345, 360, 375, 390, 405, 420].map((z, k) => ({
  id: `w-crosswind-${k + 1}`,
  type: 'fanZone',
  position: v(-14, 12, z),
  rotation: { yaw: 90 },
  params: { width: 15, height: 8, length: 26, strength: 3.5, falloff: 0.3, onTime: 2.6, offTime: 1.8, spinUp: 0.6, phase: k * 0.35, telegraphLead: 0.8 },
}));

const lockStep: Record<string, Record<string, unknown>> = {};
for (const id of HALL_IDS.flat()) lockStep[id] = { phase: 0 };
for (const id of ['s6-ham-1', 's6-ham-2', 's6-ham-3', 's6-ham-4']) lockStep[id] = { phase: 0, period: 3.4 };

export default defineRound({
  id: 'hammer-highway',
  name: 'Hammer Highway',
  type: 'race',
  theme: 'castle',
  objective: 'Dodge the hammers and cross to the throne!',
  tips: [
    'Hammers swing on a beat — count it before you cross.',
    'Shaking stones are about to fall. Wait, or leap.',
    'The ladder ledges skip the barrel ramp, if you can climb.',
  ],
  players: { min: 12, max: 60, ideal: 40 },
  qualification: { mode: 'finish', ratio: 0.6 },
  duration: { seconds: 270, overtimeSeconds: 0 },
  killY: -12,
  bounds: { min: v(-40, -20, -25), max: v(40, 50, 500) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 8, spacing: 1.4 },
  geometry,
  obstacles,
  triggers,
  flyover: {
    path: [v(0, 14, -22), v(18, 10, 92), v(-24, 20, 165), v(0, 26, 230), v(20, 18, 305), v(-14, 14, 360), v(0, 24, 510)],
    lookAt: [v(0, 4, 20), v(0, 2, 92), v(0, 2, 165), v(0, 0, 250), v(0, 5, 310), v(0, 9, 386), v(0, 10, 470)],
    duration: 9,
  },
  cameraMode: 'orbit',
  music: 'mus_castle_jestercourt',
  speedScaleByStage: [1.0, 1.1, 1.2, 1.3, 1.4],
  fallBehavior: 'respawnCheckpoint',
  botNav,
  variations: [
    { id: 'royal-procession', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'storm-siege',
      weight: 2,
      weather: 'stormy',
      description: 'Wind and lightning; Highway hammers get gusts.',
      addObstacles: crosswind,
    },
    {
      id: 'jesters-joke',
      weight: 2,
      weather: 'clear',
      description: 'Hammers in phase lock-step: whole rows open and close together.',
      obstacleParams: lockStep,
    },
    {
      id: 'crumbling-keep',
      weight: 1,
      weather: 'sunset',
      description: 'More stones drop on the causeway; the Highway tail crumbles faster.',
      obstacleParams: {
        's3-cause-L': { interval: 0.85, respawnDelay: 1.7 },
        's3-cause-R': { interval: 0.85, respawnDelay: 1.7 },
        's6-tail': { warnTime: 0.45, interval: 0.4 },
      },
    },
    {
      id: 'night-watch',
      weight: 1,
      weather: 'night',
      description: 'Torch-lit; hammers have glowing heads; rams faster.',
      obstacleParams: { 's2-ram-1': { period: 2.8 }, 's2-ram-2': { period: 2.8 }, 's2-ram-3': { period: 2.8 } },
    },
  ],
  decorSeed: 1501,
  designNotes: [
    'Competent ≈ 105 s; Highway is the main sorter (30–40 % fall there once). Ratio 0.6 (harder cut).',
    'Moat hammers staggered z 28.6/31/33.4 (design: all z 31) so neighbouring heads never clip; one shared gantry.',
    'Hall walls moved to x ±14.5 (design ±9.5) because side-hammer heads sweep to x ±13.8; side knock softened to 11.',
    'Causeway: 5 m static anchor stones alternate with 3 m crumbling stones (collapsingBridge, random order, ~20 % down at once); holes never merge (design: 17 random 4 m stones, dropFraction 0.3, never-adjacent — not expressible in collapsingBridge).',
    'Highway tail: timed sequential crumble (design touch mode, not supported by collapsingBridge).',
    'Royal guards orbit r 3 at 2.09 rad/s (design: z-slide ±6, not supported by bumperPillar).',
    'Lighting: sun az 120° el 48° #fff1d6; fog lilac 110/620.',
  ].join(' '),
});
