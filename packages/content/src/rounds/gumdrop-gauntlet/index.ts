/**
 * R1 — Gumdrop Gauntlet (LEVELS.md §4 R1). The signature opener: a candy
 * obstacle parade that teaches every core verb in the first 40 s, then gets
 * loud. Eight sections over ~520 m: Sugar Steps → Door Dash → Windmill
 * Bridges → Hammer Plaza → Bumper Field + Sky Skip → Gumball Hill → Twirl
 * Isles → Twin Twirlers & Finish Ramp.
 *
 * Transcription notes (design → shipped obstacle modules):
 * - `spinwheel` spins about a vertical axis (no upright windmill exists), so
 *   the three bridge wheels sweep hip-height blades across the 8 m bridge.
 * - `bumperPillar` cannot slide on an axis; sliding bumpers orbit a small
 *   circle instead (radius ≈ the design amplitude / 2).
 * - `boulderLane` rolls straight along local +Z, so the gumball lanes are
 *   pitched to the hill's slope and laid out with `lanes`/`laneSpacing`.
 * - `bouncePad` takes a launch velocity; values were tuned against the real
 *   controller to land the Sky Skip on the wafer shelves.
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
  same,
  sphere,
  torus,
  v,
  type Obstacle,
  type Piece,
} from './kit.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Gumball Hill: z 322 → 382 rising 0 → 10. */
const HILL_Z0 = 322;
const HILL_Z1 = 382;
const HILL_RISE = 10;
const HILL_DEG = (Math.atan2(HILL_RISE, HILL_Z1 - HILL_Z0) * 180) / Math.PI;
const hillY = (z: number): number => ((z - HILL_Z0) / (HILL_Z1 - HILL_Z0)) * HILL_RISE;

/** Door rows (z) of the Door Dash and their fake-door counts (4 → 3 → 2). */
const DOOR_ROWS = [
  { id: 's2-door-1', z: 68, fakes: 4 },
  { id: 's2-door-2', z: 84, fakes: 3 },
  { id: 's2-door-3', z: 100, fakes: 2 },
] as const;
const DOOR_W = 4;
const DOOR_POST = 0.85;
const doorX = (c: number): number => (c - 2.5) * (DOOR_W + DOOR_POST);

/** Gumdrop stepping stones (left route of the Windmill Bridges). */
const STONE_X = -11;
const STONE_R = 2;
const stoneZ = (k: number): number => 128.6 + 6.2 * k;

/** Twirl Isles discs. */
const DISCS = [
  { id: 's7-disc-1', x: 0, z: 411.4, r: 7, speed: 0.6, bumps: 0 },
  { id: 's7-disc-2', x: 5, z: 425.45, r: 6, speed: -0.7, bumps: 3 },
  { id: 's7-disc-3', x: -2, z: 437.45, r: 6, speed: 0.9, bumps: 4 },
] as const;
type Disc = (typeof DISCS)[number];

/** Sky Skip pads sit near the outer edge: the pad rim adds an inward kick, so launches drift onto the shelves. */
const PAD_X = 12.2;
const PAD_Z = 293.5;

const HAMMER_Z = [200, 212, 224, 236, 248] as const;
const HAMMERS = HAMMER_Z.map((_, i) => `s4-ham-${i + 1}`);

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

const CP = [
  checkpoint({ index: 1, top: 0, z: 109, width: 30, respawnAhead: 2 }),
  checkpoint({ index: 2, top: 0, z: 184, width: 24 }),
  checkpoint({ index: 3, top: 0, z: 264, width: 28 }),
  // Respawn just behind the disc take-off so bots re-pick the jump node, not the disc beyond it.
  checkpoint({
    index: 4,
    top: HILL_RISE,
    z: 396,
    width: 28,
    respawnAhead: 4,
    respawnXs: [-1.5, -0.5, 0.5, 1.5],
  }),
  checkpoint({ index: 5, top: HILL_RISE, z: 452, width: 24 }),
];

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const lollipop = (x: number, z: number, color: string): Piece[] =>
  deco(
    cyl(x, 4, z, 0.35, 8, { color: 'neutral', pattern: 'stripes' }),
    cyl(x, 9, z, 2.6, 0.7, { color, rotation: { pitch: 90 }, pattern: 'dots' }),
  );

const cupcake = (x: number, y: number, z: number, s: number): Piece[] =>
  deco(
    cyl(x, y, z, 3.2 * s, 3 * s, { color: 'secondary', pattern: 'stripes' }),
    sphere(x, y + 2.2 * s, z, 3.1 * s, { color: 'primary' }),
    sphere(x, y + 5.2 * s, z, 0.9 * s, { color: 'danger' }),
  );

const balloon = (x: number, y: number, z: number, color: string): Piece[] =>
  deco(sphere(x, y, z, 1.4, { color }), cyl(x, y - 3, z, 0.05, 4, { color: 'neutral' }));

const start: Piece[] = [
  floor(0, 0, -10, 10, 26, { color: 'safe', pattern: 'checker' }),
  box(0, 1.5, -10.5, 26, 3, 1, { color: 'neutral' }),
  ...mirrorX(box(13.25, 0.5, 0, 0.5, 1, 20, { color: 'neutral' })),
  ...deco(...mirrorX(sphere(16, 3, -4, 3, { color: 'accent', pattern: 'dots' }))),
  ...deco(arch(0, 0, -9.5, 18, 8, 1.2, { color: 'primary', pattern: 'stripes' })),
];

const sugarSteps: Piece[] = [
  floor(0, 0, 10, 30, 24, { color: 'primary' }),
  box(0, 0.3, 26, 24, 0.6, 4, { color: 'secondary', pattern: 'stripes' }),
  box(0, 0.1, 33, 24, 2.2, 10, { color: 'primary', bevel: 0.3 }),
  box(0, 0.1, 45.25, 24, 2.2, 9.5, { color: 'secondary', bevel: 0.3 }),
  paint(0, 1.2, 37.7, 24, 0.6, { color: 'danger', pattern: 'hazard' }),
  paint(0, 1.2, 40.8, 24, 0.6, { color: 'danger', pattern: 'hazard' }),
  ...lollipop(15, 18, 'accent'),
  ...lollipop(-15, 18, 'danger'),
  ...lollipop(15, 30, 'danger'),
  ...lollipop(-15, 30, 'accent'),
  ...lollipop(15, 44, 'accent'),
  ...lollipop(-15, 44, 'danger'),
];

const doorDash: Piece[] = [
  ramp(0, 0.6, 53, 30, 1.2, 6, { rotation: { yaw: 180 }, color: 'primary', pattern: 'chevron' }),
  floor(0, 0, 56, 112, 30, { color: 'primary' }),
  ...mirrorX(box(15.25, 2.5, 84, 0.5, 5, 56, { color: 'neutral' })),
  paint(0, 0, 76, 30, 1, { color: 'secondary', pattern: 'stripes' }),
  paint(0, 0, 92, 30, 1, { color: 'secondary', pattern: 'stripes' }),
  // Crowd stands at the Door Dash entry (design: "crowd stands at §2 entry").
  ...deco(...mirrorX(box(20, 3, 62, 6, 6, 14, { color: 'neutral', pattern: 'stripes' }))),
  ...deco(
    ...mirrorX(
      sphere(15.25, 5.6, 58, 0.8, { color: 'accent' }),
      sphere(15.25, 5.6, 110, 0.8, { color: 'accent' }),
    ),
  ),
];

const windmillBridges: Piece[] = [
  floor(0, 0, 112, 120, 30, { color: 'secondary' }),
  floor(0, 0, 120, 124, 24, { color: 'secondary' }),
  box(12.6, 0.5, 118.5, 0.5, 1, 7.1, { rotation: { yaw: -45 }, color: 'neutral' }),
  box(-12.6, 0.5, 118.5, 0.5, 1, 7.1, { rotation: { yaw: 45 }, color: 'neutral' }),
  floor(0, 0, 124, 170, 8, { color: 'primary' }),
  ...mirrorX(paint(3.8, 0, 147, 0.4, 46, { color: 'danger', pattern: 'hazard' })),
  ...Array.from({ length: 7 }, (_, k) =>
    pillar(STONE_X, 0, stoneZ(k), STONE_R, 1.5, { color: 'accent', pattern: 'dots' }),
  ),
  box(9, -0.25, 147, 1.2, 0.5, 46, { color: 'secondary', pattern: 'stripes' }),
  floor(0, 0, 170, 190, 24, { color: 'safe' }),
  // Candy-cane frames over each wheel (decorative, high enough to never touch play).
  ...deco(
    arch(0, 0, 133, 14, 7, 1, { color: 'danger', pattern: 'stripes' }),
    arch(0, 0, 147, 14, 7, 1, { color: 'accent', pattern: 'stripes' }),
    arch(0, 0, 161, 14, 7, 1, { color: 'danger', pattern: 'stripes' }),
  ),
  // Chocolate waterfall under the bridges.
  ...deco(
    box(0, -9, 150, 40, 0.5, 60, { color: '#7a4a2e' }),
    box(-26, -2, 150, 8, 14, 20, { color: '#8b5a3c', bevel: 0.6 }),
  ),
];

const hammerPlaza: Piece[] = [
  floor(0, 0, 190, 262, 14, { color: 'primary' }),
  ...mirrorX(paint(6.8, 0, 226, 0.4, 72, { color: 'danger', pattern: 'hazard' })),
  ...mirrorX(paint(4.3, 0, 226, 0.15, 72, { color: 'safe' })),
  paint(0, 0, 230, 14, 4, { color: 'secondary' }),
  // Bunting between the hammer gantries.
  ...deco(
    ...HAMMER_Z.slice(0, 4).map((z) =>
      box(0, 12.4, z + 6, 22, 0.15, 0.15, { color: 'accent', pattern: 'stripes', rotation: { roll: 0 } }),
    ),
  ),
];

const bumperField: Piece[] = [
  floor(0, 0, 262, 322, 28, { color: 'secondary' }),
  // Low rails until the shelves take over: bumpers knock, the void shouldn't finish the job.
  ...mirrorX(box(14.25, 0.4, 280, 0.5, 0.8, 36, { color: 'neutral' })),
  ...mirrorX(box(11, 2.5, 325, 6, 7, 54, { color: 'neutral', pattern: 'stripes', bevel: 0.3 })),
  ...mirrorX(paint(11, 6, 325, 6, 54, { color: 'accent', pattern: 'dots' })),
  ...deco(...mirrorX(torus(PAD_X, 0.05, PAD_Z, 2.0, 0.2, { color: 'accent' }))),
];

const gumballHill: Piece[] = [
  ramp(0, HILL_RISE / 2, (HILL_Z0 + HILL_Z1) / 2, 28, HILL_RISE, HILL_Z1 - HILL_Z0, { color: 'primary' }),
  ...mirrorX(
    box(2.5, hillY(352) + 0.04, 352, 0.2, 0.05, 60.8, {
      rotation: { pitch: -HILL_DEG },
      decorative: true,
      color: 'secondary',
      bevel: 0,
    }),
  ),
  floor(0, HILL_RISE, HILL_Z1, 402, 28, { color: 'safe' }),
  ...deco(
    ...[-11, -5, 0, 5, 11].map((x) => box(x, 16, 381, 2.5, 3, 3, { color: 'accent', pattern: 'dots' })),
    box(0, 18, 381, 28, 1, 3, { color: 'neutral', pattern: 'stripes' }),
    ...mirrorX(cyl(14.5, 8.5, 381, 0.5, 19, { color: 'neutral' })),
  ),
];

const twirlIsles: Piece[] = [
  box(-10, 9.75, 425, 1.2, 0.5, 46, { color: 'secondary', pattern: 'stripes' }),
  paint(0, HILL_RISE, 401.7, 28, 0.6, { color: 'danger', pattern: 'hazard' }),
  ...deco(...DISCS.map((d) => cyl(d.x, 4, d.z, 1.2, 11, { color: 'neutral', pattern: 'stripes' }))),
  // Gantry for the beam hammer (the module's own posts would clip disc 2).
  ...deco(arch(-10, HILL_RISE, 425, 10, 10.6, 1, { color: 'neutral', pattern: 'stripes' })),
];

const finishStretch: Piece[] = [
  floor(0, HILL_RISE, 445.45, 490, 24, { color: 'primary' }),
  ...deco(torus(0, HILL_RISE + 0.02, 477, 9, 0.15, { color: 'danger' })),
  ramp(0, 11.5, 501, 20, 3, 22, { color: 'secondary', pattern: 'chevron' }),
  floor(0, 13, 512, 524, 24, { color: 'safe', pattern: 'checker' }),
  ...deco(...mirrorX(box(16, 15, 510, 6, 6, 30, { color: 'neutral', pattern: 'stripes' }))),
  ...deco(...mirrorX(sphere(12, 20, 516, 1.2, { color: 'accent' }))),
];

const skyDecor: Piece[] = [
  ...cupcake(-38, -6, 60, 1.4),
  ...cupcake(36, -10, 140, 1.8),
  ...cupcake(-36, -4, 230, 1.2),
  ...cupcake(38, 0, 330, 1.5),
  ...cupcake(-38, 4, 440, 1.6),
  ...balloon(-20, 14, 30, 'danger'),
  ...balloon(22, 18, 96, 'accent'),
  ...balloon(-24, 20, 200, 'primary'),
  ...balloon(20, 24, 290, 'safe'),
  ...balloon(-22, 30, 380, 'accent'),
  ...balloon(18, 32, 470, 'danger'),
];

const CP_GEOMETRY = CP.flatMap((c) => c.geometry);

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const bump = (id: string, x: number, y: number, z: number, params: Record<string, unknown>): Obstacle => ({
  id,
  type: 'bumperPillar',
  position: v(x, y, z),
  params: { radius: 0.9, height: 2.4, bounceSpeed: 9, ...params },
});

/** Sliding bumper approximation: orbit a 1.5 m circle at the design's 3 s period. */
const ORBIT = { orbitRadius: 1.5, orbitSpeed: (2 * Math.PI) / 3 };

const obstacles: Obstacle[] = [
  {
    id: 's0-gate',
    type: 'startGate',
    position: v(0, 0, 7),
    params: { width: 26, height: 3, openDuration: 0.4 },
  },

  ...DOOR_ROWS.map((r): Obstacle => ({
    id: r.id,
    type: 'doorGauntlet',
    position: v(0, 0, r.z),
    params: {
      rows: 1,
      doorsPerRow: 6,
      fakePerRow: r.fakes,
      doorWidth: DOOR_W,
      postWidth: DOOR_POST,
      doorHeight: 3.5,
      wallHeight: 5,
      doorThickness: 0.6,
      solidKnock: 4,
    },
  })),
  bump('s2-bump-1', -6, 0, 92, { bounceSpeed: 8 }),
  bump('s2-bump-2', 6, 0, 92, { bounceSpeed: 8 }),

  ...[
    { id: 's3-spin-1', z: 133, speed: 1.0, phase: 0 },
    { id: 's3-spin-2', z: 147, speed: -1.2, phase: 0.7 },
    { id: 's3-spin-3', z: 161, speed: 1.4, phase: 1.4 },
  ].map((w): Obstacle => ({
    id: w.id,
    type: 'spinwheel',
    position: v(0, 0, w.z),
    params: {
      armLength: 5,
      armCount: 3,
      armHeight: 0.7,
      armThickness: 0.5,
      speed: w.speed,
      phase: w.phase,
      hubRadius: 0.8,
      hubHeight: 2.4,
      knockSpeed: 8,
      knockLift: 3,
    },
  })),
  bump('s3-bump-1', 9, 0, 147, {
    radius: 0.8,
    height: 2.2,
    bounceSpeed: 10,
    orbitRadius: 1.6,
    orbitSpeed: (2 * Math.PI) / 2.6,
  }),

  ...HAMMER_Z.map((z, i): Obstacle => ({
    id: HAMMERS[i]!,
    type: 'pendulumHammer',
    position: v(0, 0, z),
    params: {
      pivotHeight: 11,
      armLength: 9,
      headRadius: 1.3,
      headLength: 3.2,
      amplitudeDeg: 65,
      period: 3,
      phase: i * 0.2,
      knockSpeed: 14,
    },
  })),

  bump('s5-bump-1', -8, 0, 272, {}),
  bump('s5-bump-2', 0, 0, 272, {}),
  bump('s5-bump-3', 8, 0, 272, {}),
  bump('s5-bump-4', -4, 0, 280, { ...ORBIT, phase: 0 }),
  bump('s5-bump-5', 4, 0, 280, { ...ORBIT, phase: Math.PI }),
  bump('s5-bump-6', -8, 0, 290, {}),
  bump('s5-bump-7', 0, 0, 290, {}),
  bump('s5-bump-8', 8, 0, 290, {}),
  bump('s5-bump-9', -4, 0, 298, { ...ORBIT, phase: Math.PI / 2 }),
  bump('s5-bump-10', 4, 0, 298, { ...ORBIT, phase: (3 * Math.PI) / 2 }),
  bump('s5-bump-11', -5, 0, 308, { radius: 1.5, height: 3, bounceSpeed: 11 }),
  bump('s5-bump-12', 5, 0, 308, { radius: 1.5, height: 3, bounceSpeed: 11 }),
  ...[-PAD_X, PAD_X].map((x): Obstacle => ({
    id: x < 0 ? 's5-pad-L' : 's5-pad-R',
    type: 'bouncePad',
    position: v(x, 0, PAD_Z),
    params: { radius: 1.4, launch: v(0, 10, 14) },
  })),

  {
    id: 's6-ball-c',
    type: 'boulderLane',
    position: v(0, hillY(381), 381),
    rotation: { yaw: 180, pitch: HILL_DEG },
    params: {
      lanes: 3,
      laneSpacing: 5,
      laneOrder: 'cycle',
      length: 59.8,
      radius: 1.4,
      speed: 7,
      spawnPeriod: 1.5,
      dropHeight: 3,
      knockSpeed: 10,
      knockLift: 5,
    },
  },
  {
    id: 's6-ball-out',
    type: 'boulderLane',
    position: v(0, hillY(381), 381),
    rotation: { yaw: 180, pitch: HILL_DEG },
    params: {
      lanes: 2,
      laneSpacing: 22,
      laneOrder: 'cycle',
      length: 28.4,
      radius: 1.4,
      speed: 7,
      spawnPeriod: 2.25,
      phase: 0.7,
      dropHeight: 3,
      knockSpeed: 10,
      knockLift: 5,
    },
  },

  ...DISCS.map((d): Obstacle => ({
    id: d.id,
    type: 'spinningDisc',
    position: v(d.x, HILL_RISE, d.z),
    params: { radius: d.r, thickness: 1, speed: d.speed, bumps: d.bumps, bumpRadius: 0.7, bumpKnock: 3 },
  })),
  {
    id: 's7-ham-1',
    type: 'pendulumHammer',
    position: v(-10, HILL_RISE, 425),
    params: {
      pivotHeight: 9,
      armLength: 7,
      headRadius: 1.3,
      headLength: 2.6,
      amplitudeDeg: 50,
      period: 2.6,
      phase: 0.5,
      knockSpeed: 12,
      supports: false,
    },
  },

  {
    id: 's8-sweep-1',
    type: 'sweeperArm',
    position: v(0, HILL_RISE, 477),
    params: {
      armLength: 9,
      armCount: 2,
      armHeight: 0.5,
      armRadius: 0.3,
      baseSpeed: 1.3,
      accel: 0,
      postRadius: 1,
      postHeight: 2.5,
      knockSpeed: 8,
    },
  },
  { id: 's8-finish', type: 'finishLine', position: v(0, 13, 516), params: { width: 24, height: 6 } },

  ...CP.flatMap((c) => c.obstacles),
];

// -----------------------------------------------------------------------------
// Bot navigation
// -----------------------------------------------------------------------------

/**
 * Jump legs. The brain checks arrival at 10 Hz and eases off inside 1.2 m of
 * its target, so a take-off waypoint sits 0.3 m past the lip with a 1.5 m
 * radius, preceded by a line-up waypoint ~2.5 m before the lip so the approach
 * is straight. Bots then leave 0.5–1.2 m before the lip at full speed and fly
 * ≈ 3.9 m: every bot-route gap is ≤ 2.4 m.
 */
const JUMP = { r: 1.5, action: 'jump' } as const;
const LINEUP = { r: 1.2 } as const;

const nav = new NavBuilder();
nav
  .add(0, [0, 0, 4], 9, { r: 3 })
  .add(9, [0, 0, 21], 10, LINEUP)
  .add(10, [0, 0, 24.3], 11, JUMP)
  .add(11, [0, 0.6, 28.3], 12, JUMP)
  .add(12, [0, 1.2, 38.3], 13, JUMP)
  .add(13, [0, 1.2, 46], 100, { r: 3 });

/*
 * Door Dash. Bots cannot see which doors are fake (the layout is seeded per
 * show), so each bot walks up to a door and then aims at a point far along
 * the row behind it. Against a solid door that shallow aim slides it along the
 * row face; every door it rubs is touched, so the first fake one bursts and
 * the same aim carries it through — which is how the crowd looks doing it.
 * Sweeps run toward the row's longer side so each covers about four doors.
 */
DOOR_ROWS.forEach((row, i) => {
  const fan = 100 + i * 20;
  const front = (c: number): number => fan + 1 + c;
  const sweep = (c: number): number => fan + 11 + c;
  const onward = i < DOOR_ROWS.length - 1 ? 100 + (i + 1) * 20 : 160;
  nav.add(fan, [0, 0, row.z - 7], [2, 3, 1, 4, 0, 5].map(front), { r: 5 });
  for (let c = 0; c < 6; c++) {
    const dir = c <= 2 ? 1 : -1;
    const sx = Math.max(-12.5, Math.min(12.5, doorX(c) + dir * 16));
    nav.add(front(c), [doorX(c), 0, row.z - 1], sweep(c), { r: 0.9 });
    nav.add(sweep(c), [sx, 0, row.z + 6], onward, { r: 2 });
  }
});
nav.add(160, [0, 0, 112], [200, 210, 220], { r: 4 });

// Windmill Bridges: main (left of the hubs), gumdrop stones, candy-cane beam.
nav
  .add(200, [-2.2, 0, 125], 201, { r: 1.2, action: 'waitForGap', timeAgainst: 's3-spin-1' })
  .add(201, [-2.2, 0, 140], 202, { r: 1.2, action: 'waitForGap', timeAgainst: 's3-spin-2' })
  .add(202, [-2.2, 0, 154], 203, { r: 1.2, action: 'waitForGap', timeAgainst: 's3-spin-3' })
  .add(203, [0, 0, 173], 300, { r: 3 })
  .add(210, [STONE_X, 0, 121.5], 211, LINEUP)
  .add(211, [STONE_X, 0, 124.3], 230, JUMP);
// Gumdrop stones: land, line up on the stone's centre, hop from its far lip.
for (let k = 0; k < 7; k++) {
  nav.add(230 + 2 * k, [STONE_X, 0, stoneZ(k)], 231 + 2 * k, LINEUP);
  nav.add(231 + 2 * k, [STONE_X, 0, stoneZ(k) + STONE_R + 0.3], k < 6 ? 232 + 2 * k : 218, JUMP);
}
nav
  .add(218, [-9, 0, 173], 300, { r: 2 })
  .add(220, [9, 0, 123], 221, { r: 0.6 })
  .add(221, [9, 0, 141], 222, { r: 0.6, action: 'waitForGap', timeAgainst: 's3-bump-1' })
  .add(222, [9, 0, 153], 223, { r: 0.6 })
  .add(223, [9, 0, 172], 300, { r: 2 });

// Hammer Plaza: ride the wave down the middle, or the edge lanes.
nav.add(300, [0, 0, 188], [301, 310, 311], { r: 3 });
HAMMER_Z.forEach((z, i) => {
  nav.add(301 + i, [0, 0, z - 4], i < 4 ? 302 + i : 306, {
    r: 1.5,
    action: 'waitForGap',
    timeAgainst: HAMMERS[i]!,
  });
});
nav
  .add(306, [0, 0, 258], 400, { r: 3 })
  .add(310, [-5.6, 0, 194], 312, { r: 0.8 })
  .add(312, [-5.6, 0, 254], 306, { r: 0.8 })
  .add(311, [5.6, 0, 194], 313, { r: 0.8 })
  .add(313, [5.6, 0, 254], 306, { r: 0.8 });

// Bumper Field + Sky Skip.
nav
  .add(400, [0, 0, 267], [401, 410, 411], { r: 4 })
  .add(401, [0, 0, 276], 402, { r: 3 })
  .add(402, [-2, 0, 285], 403, { r: 2.5, action: 'waitForGap', timeAgainst: 's5-bump-4' })
  .add(403, [2, 0, 294], 404, { r: 2.5, action: 'waitForGap', timeAgainst: 's5-bump-10' })
  .add(404, [0, 0, 303], 405, { r: 2.5 })
  .add(405, [0, 0, 318], 500, { r: 3 })
  .add(410, [-PAD_X, 0, PAD_Z - 9], 412, { r: 1.2 })
  .add(412, [-PAD_X, 0, PAD_Z - 1.9], 414, { r: 1 })
  .add(414, [-11, 6, 304], 416, { r: 2 })
  .add(416, [-11, 6, 349], 503, { r: 1.5 })
  .add(411, [PAD_X, 0, PAD_Z - 9], 413, { r: 1.2 })
  .add(413, [PAD_X, 0, PAD_Z - 1.9], 415, { r: 1 })
  .add(415, [11, 6, 304], 417, { r: 2 })
  .add(417, [11, 6, 349], 503, { r: 1.5 });

// Gumball Hill: climb in the strips between the ball lanes.
nav
  .add(500, [0, 0, 323], [501, 505], { r: 3 })
  .add(501, [-2.5, hillY(337), 337], 502, { r: 0.8 })
  .add(502, [-2.5, hillY(352), 352], 503, { r: 0.8 })
  .add(505, [2.5, hillY(337), 337], 506, { r: 0.8 })
  .add(506, [2.5, hillY(352), 352], 503, { r: 0.8 })
  .add(503, [2.5, hillY(367), 367], 504, { r: 0.8 })
  .add(504, [0, HILL_RISE, 386], 600, { r: 3 });

// Twirl Isles: disc hops, or the licorice beam under the hammer.
const [d1, d2, d3] = DISCS;
/**
 * Take-off waypoint 0.3 m inside disc `a`'s rim toward disc `b`. The disc centre
 * is the line-up; the spin drifts riders, so bots leave early onto 1.9 m gaps.
 */
const rimHop = (a: Disc, b: Disc): [number, number, number] => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz);
  return [a.x + (dx / l) * (a.r - 0.3), HILL_RISE, a.z + (dz / l) * (a.r - 0.3)];
};
nav
  .add(600, [0, HILL_RISE, 396], [599, 610], { r: 3 })
  .add(599, [0, HILL_RISE, 399.5], 601, LINEUP)
  .add(601, [0, HILL_RISE, 402.3], 602, JUMP)
  .add(602, [d1.x, HILL_RISE, d1.z], 603, { r: 2 })
  .add(603, rimHop(d1, d2), 604, JUMP)
  .add(604, [d2.x, HILL_RISE, d2.z], 605, { r: 2 })
  .add(605, rimHop(d2, d3), 606, JUMP)
  .add(606, [d3.x, HILL_RISE, d3.z], 607, { r: 2 })
  .add(607, [d3.x, HILL_RISE, d3.z + d3.r - 0.3], 608, JUMP)
  .add(608, [0, HILL_RISE, 455], 700, { r: 3 })
  .add(610, [-10, HILL_RISE, 402], 611, { r: 0.6 })
  .add(611, [-10, HILL_RISE, 419], 612, { r: 0.6, action: 'waitForGap', timeAgainst: 's7-ham-1' })
  .add(612, [-10, HILL_RISE, 431], 613, { r: 0.6 })
  .add(613, [-10, HILL_RISE, 450], 608, { r: 1.5 });

// Twin Twirlers (the brain auto-hops the bar) and the finish ramp.
nav
  .add(700, [-4.5, HILL_RISE, 466], 701, { r: 2 })
  .add(701, [-4.5, HILL_RISE, 488], 702, { r: 2 })
  .add(702, [0, HILL_RISE, 491], 703, { r: 3 })
  .add(703, [0, 13, 516], [], { r: 4 });

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

export default defineRound({
  id: 'gumdrop-gauntlet',
  name: 'Gumdrop Gauntlet',
  type: 'race',
  theme: 'candy',
  objective: 'Reach the finish! Doors may be fakes.',
  tips: [
    "Watch which doors burst open — follow the crowd's trail.",
    'Hug the edge lanes to dodge the hammers… if you dare.',
    'Hit a bounce pad to skip the bumper field entirely.',
  ],
  players: { min: 12, max: 100, ideal: 100 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 240, overtimeSeconds: 0 },
  killY: -12,
  bounds: { min: v(-45, -20, -25), max: v(45, 45, 540) },
  spawn: { origin: v(0, 0.1, -2), yaw: 0, cols: 10, spacing: 1.4 },
  geometry: [
    ...start,
    ...sugarSteps,
    ...doorDash,
    ...windmillBridges,
    ...hammerPlaza,
    ...bumperField,
    ...gumballHill,
    ...twirlIsles,
    ...finishStretch,
    ...CP_GEOMETRY,
    ...skyDecor,
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
    { id: 'finish', kind: 'finish', position: v(0, 15, 516), size: v(24, 4, 2) },
  ],
  flyover: {
    path: [
      v(30, 25, -15),
      v(20, 16, 75),
      v(-18, 18, 140),
      v(16, 20, 222),
      v(-22, 22, 315),
      v(20, 28, 420),
      v(0, 22, 545),
    ],
    lookAt: [
      v(0, 0, 10),
      v(0, 2, 84),
      v(0, 4, 147),
      v(0, 2, 226),
      v(0, 6, 345),
      v(0, 10, 430),
      v(0, 13, 516),
    ],
    duration: 9,
  },
  cameraMode: 'orbit',
  music: 'mus_candy_sugarrush',
  speedScaleByStage: [1.0, 1.08, 1.15, 1.22, 1.3],
  fallBehavior: 'respawnCheckpoint',
  botNav: nav.build(),
  variations: [
    { id: 'classic', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'sugar-rush',
      weight: 2,
      weather: 'sunset',
      description: 'Stingier doors, faster hammers.',
      obstacleParams: {
        's2-door-1': { fakePerRow: 3 },
        's2-door-2': { fakePerRow: 2 },
        's2-door-3': { fakePerRow: 1 },
        ...same(HAMMERS, { period: 2.6 }),
      },
    },
    {
      id: 'gumball-storm',
      weight: 2,
      weather: 'windy',
      description: 'Five centre lanes, quicker balls — the safe strips disappear and dodging becomes timing.',
      obstacleParams: { 's6-ball-c': { lanes: 5, laneSpacing: 2.5, spawnPeriod: 0.9, speed: 8 } },
    },
    {
      id: 'night-fair',
      weight: 1,
      weather: 'night',
      description: 'Carnival lights; the windmill wheels spin faster.',
      obstacleParams: {
        's3-spin-1': { speed: 1.15 },
        's3-spin-2': { speed: -1.38 },
        's3-spin-3': { speed: 1.61 },
      },
    },
    {
      id: 'sticky-bridge',
      weight: 1,
      weather: 'clear',
      description: 'Goo on the main bridge makes the side routes worth it.',
      obstacleParams: { 's3-bump-1': { orbitSpeed: Math.PI } },
      addObstacles: [
        {
          id: 's3-goo-1',
          type: 'stickyGoo',
          position: v(0, 0, 140),
          params: { shape: 'box', sizeX: 8, sizeZ: 8 },
        },
        {
          id: 's3-goo-2',
          type: 'stickyGoo',
          position: v(0, 0, 154),
          params: { shape: 'box', sizeX: 8, sizeZ: 8 },
        },
      ],
    },
    {
      id: 'hammer-sync',
      weight: 1,
      weather: 'clear',
      description: 'All hammers in phase — a single wall you pass in one window.',
      obstacleParams: same(HAMMERS, { phase: 0, period: 3.4 }),
    },
  ],
  decorSeed: 1101,
  designNotes:
    'Opener. Teach (Sugar Steps) → chokepoint (Door Dash 4/3/2 fakes) → timing (Windmill Bridges, 3 routes) → rhythm ' +
    '(Hammer Plaza wave, 2.7 m edge lanes) → reward (Sky Skip pads onto the wafer shelves) → pressure (Gumball Hill) → ' +
    'twist (Twirl Isles) → final hop (Twin Twirlers). Competent ≈ 95 s. Approximations: horizontal spinwheels stand in ' +
    'for upright windmills; sliding bumpers orbit; door halfRule/noRepeatRows are not supported by doorGauntlet.',
});
