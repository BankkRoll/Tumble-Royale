/**
 * F1 — Crown Climb (LEVELS.md §9 F1). A compact sprint up a pastel toy castle
 * to a crown floating over the highest tower, guarded by a spinning bar.
 * Respawns keep everyone in it to the last second. Gate → Courtyard (doors +
 * hammers) → Rampart Stairs (barrels, grab ledges) → Keep Wall (climb wall vs
 * elevators) → Turret Hop → Crown Deck.
 *
 * Transcription notes (design → shipped obstacle modules):
 * - The crown is a `crown` trigger (touching it wins) plus a floating
 *   `propSpawner` crown for the visual; the trigger cannot follow a schedule,
 *   so the overtime "crown lowers" beat is not representable.
 * - Barrels bounce down the stairs as a chain of per-tread `boulderLane`s
 *   (each drops in from the tread above); there is no polyline lane.
 * - The Keep Wall is five grabbable 2.4 m tiers rather than a `climbWall`:
 *   the shipped Tumbler controller can't climb the wall module's holds (tested),
 *   so the fast route is jump-catch-climb ledges; there is no slip band.
 * - `sweeperArm` has no inner radius or speed schedule, so the crown sweeper
 *   ramps linearly from 1.0 to 1.6 rad/s instead.
 * - Elevators are `movingPlatform`s ping-ponging between the court and the keep
 *   top (humans only — bots can't tell when a platform is down).
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
  sphere,
  v,
  type Obstacle,
  type Piece,
  type Trigger,
} from '../gumdrop-gauntlet/kit.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Rampart treads: [z0, z1, top]. */
const TREADS = [
  [40, 46, 1.5],
  [46, 52, 3.0],
  [52, 58, 5.2],
  [58, 64, 7.4],
] as const;
const COURT = 7.4;
/** Keep Wall climb tiers (including the keep top): 5 × 2.4 m. */
const CLIMB_TIERS = 5;
const CLIMB_RISE = 2.4;
const CLIMB_DEPTH = 1.4;
const KEEP_TOP = 19.4;
const KEEP_FACE = 76;
/** Turret tops and z centres (two parallel lines at x ±3.5). */
const TURRETS = [
  [21, 100],
  [22.5, 107.5],
  [24, 115],
  [25.5, 122.5],
  [27, 130],
] as const;
const TURRET_X = 3.5;
const TURRET_R = 3;
const DECK = { z: 145.5, top: 28.5, r: 11 };
const DAIS_TOP = 30;
const CROWN_Y = 33.1;

const DOOR_W = 3;
const DOOR_POST = 0.8;
const doorX = (c: number): number => (c - 1.5) * (DOOR_W + DOOR_POST);

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

const CP: Trigger[] = [
  {
    id: 'cp-1',
    kind: 'checkpoint',
    index: 1,
    position: v(0, COURT + 2, 66),
    size: v(16, 4, 2),
    respawn: [-5, -2.5, 0, 2.5, 5].flatMap((x) => [v(x, COURT + 0.1, 68), v(x, COURT + 0.1, 70)]),
  },
  checkpoint({ index: 2, top: KEEP_TOP, z: 92, width: 20, respawnXs: [-5, -2.5, 0, 2.5, 5], respawnAhead: 2 })
    .trigger,
  {
    id: 'cp-3',
    kind: 'checkpoint',
    index: 3,
    position: v(0, DECK.top + 2, 137),
    size: v(10, 4, 2),
    respawn: [-4, -2, 0, 2, 4].map((x) => v(x, DECK.top + 0.1, 139)),
  },
];

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const flag = (x: number, y: number, z: number, color: string): Piece[] =>
  deco(cyl(x, y + 2, z, 0.12, 4, { color: 'neutral' }), box(x + 0.9, y + 3.4, z, 1.6, 1, 0.08, { color }));

const tower = (x: number, z: number, h: number, r: number, color: string): Piece[] =>
  deco(
    cyl(x, h / 2 - 8, z, r, h, { color: 'neutral', bevel: 0.3 }),
    { shape: 'wedge', position: v(x, h - 8 + r * 0.9, z), size: v(r * 2.2, r * 1.8, r * 2.2), color },
    ...flag(x, h - 8 + r * 1.8, z, 'accent'),
  );

const gate: Piece[] = [
  floor(0, 0, -6, 6, 16, { color: 'safe', pattern: 'checker' }),
  box(0, 1.5, -6.5, 16, 3, 1, { color: 'neutral' }),
  ...mirrorX(box(8.25, 0.5, 0, 0.5, 1, 12, { color: 'neutral' })),
  ...deco(arch(0, 0, -5.5, 12, 8, 1.5, { color: 'secondary', pattern: 'stripes' })),
];

const courtyard: Piece[] = [
  floor(0, 0, 6, 40, 16, { color: 'primary' }),
  ...mirrorX(box(8.25, 2, 23, 0.5, 4, 34, { color: 'neutral' })),
  paint(0, 0, 21.5, 16, 1, { color: 'secondary', pattern: 'stripes' }),
  ...deco(...mirrorX(...[12, 24, 36].map((z) => box(8.25, 4.5, z, 0.9, 1, 0.9, { color: 'neutral' })))),
];

const rampart: Piece[] = [
  ...TREADS.map(([z0, z1, top], i) => {
    const bottom = -1;
    return box(0, (top + bottom) / 2, (z0 + z1) / 2, 16, top - bottom, z1 - z0, {
      color: 'secondary',
      grabbable: i >= 2,
      bevel: 0.2,
    });
  }),
  // Grab lips on the two tall risers.
  box(0, 5.2 - 0.15, 52 - 0.15, 16, 0.3, 0.3, { color: 'accent', grabbable: true, bevel: 0.05 }),
  box(0, 7.4 - 0.15, 58 - 0.15, 16, 0.3, 0.3, { color: 'accent', grabbable: true, bevel: 0.05 }),
  ...mirrorX(box(8.25, 4, 52, 0.5, 9, 24, { color: 'neutral' })),
];

/**
 * The Keep Wall climb: five 2.4 m grabbable tiers, 1.4 m deep, stepping up the
 * keep face — jump, catch the lip, climb, repeat. (`climbWall` holds proved
 * unclimbable with the shipped Tumbler controller, so the wall is built from
 * ledges the controller does climb; studs are decorative holds.)
 */
function climbFace(): Piece[] {
  const out: Piece[] = [];
  for (let i = 1; i < CLIMB_TIERS; i++) {
    const top = COURT + i * CLIMB_RISE;
    const z0 = KEEP_FACE - CLIMB_DEPTH * (CLIMB_TIERS - i);
    out.push(
      box(0, (COURT + top) / 2, z0 + CLIMB_DEPTH / 2, 6, top - COURT, CLIMB_DEPTH, {
        color: i % 2 ? 'secondary' : 'primary',
        grabbable: true,
        bevel: 0.1,
      }),
      box(0, top - 0.15, z0 + 0.15, 6, 0.3, 0.3, { color: 'accent', grabbable: true, bevel: 0.05 }),
      ...deco(
        ...[-2, 0, 2].map((x) =>
          sphere(x + (i % 2) * 0.7 - 0.35, top - 1.2, z0 - 0.05, 0.25, { color: 'danger' }),
        ),
      ),
    );
  }
  out.push(
    box(0, KEEP_TOP - 0.15, KEEP_FACE + 0.15, 6, 0.3, 0.3, { color: 'accent', grabbable: true, bevel: 0.05 }),
  );
  return out;
}

const keep: Piece[] = [
  floor(0, COURT, 64, KEEP_FACE, 16, { color: 'primary' }),
  box(0, 13.15, 86, 20, 12.5, 20, { color: 'neutral', bevel: 0.4, grabbable: true }),
  ...climbFace(),
  // Battlements along the keep's front edge (behind the climb wall's lip).
  ...deco(...[-9, -6, 6, 9].map((x) => box(x, KEEP_TOP + 0.6, 76.6, 1.2, 1.2, 1.2, { color: 'neutral' }))),
  ...flag(-9.5, KEEP_TOP, 95.5, 'danger'),
  ...flag(9.5, KEEP_TOP, 95.5, 'safe'),
];

const turrets: Piece[] = TURRETS.flatMap(([top, z]) =>
  [-TURRET_X, TURRET_X].map((x) =>
    pillar(x, top, z, TURRET_R, top - 10, {
      color: x < 0 ? 'primary' : 'secondary',
      grabbable: true,
    }),
  ),
);

const crownDeck: Piece[] = [
  pillar(0, DECK.top, DECK.z, DECK.r, 1, { color: 'safe', pattern: 'checker' }),
  pillar(0, DAIS_TOP, DECK.z, 2, 1.5, { color: 'accent', grabbable: true }),
  ...Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return box(11.3 * Math.cos(a), DECK.top + 0.75, DECK.z + 11.3 * Math.sin(a), 1.5, 1.5, 1.5, {
      color: 'neutral',
      rotation: { yaw: 90 - i * 30 },
    });
  }),
  ...deco(
    arch(0, DECK.top, DECK.z, 8, 9, 1, { color: 'accent' }),
    cyl(0, DECK.top - 8, DECK.z, 4, 16, { color: 'neutral', pattern: 'stripes' }),
  ),
];

const castleDecor: Piece[] = [
  ...tower(-18, 30, 30, 3.5, 'danger'),
  ...tower(18, 30, 30, 3.5, 'secondary'),
  ...tower(-20, 90, 40, 4, 'primary'),
  ...tower(20, 90, 40, 4, 'danger'),
  ...tower(-16, 150, 46, 3.5, 'secondary'),
  ...tower(16, 150, 46, 3.5, 'primary'),
  // The floating island under the castle.
  ...deco(
    cyl(0, -6, 70, 26, 10, { color: '#b9a3d6', bevel: 1 }),
    cyl(0, -14, 70, 18, 8, { color: '#a58fc4', bevel: 1 }),
    sphere(0, -20, 70, 10, { color: '#957fb6' }),
  ),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const BARREL_SPEED = 7;
const BARREL_DROP_TIME = 0.35;

/**
 * Barrels: one 2-lane `boulderLane` per tread (x ±4), each dropping in from the
 * tread above and phased by the cumulative roll time, so a barrel visibly
 * thumps down the stairs and rolls out across the courtyard.
 */
function barrels(): Obstacle[] {
  const legs = [
    { from: 64, to: 58, y: 7.4, drop: 1.2 },
    { from: 58, to: 52, y: 5.2, drop: 2.2 },
    { from: 52, to: 46, y: 3.0, drop: 2.2 },
    { from: 46, to: 40, y: 1.5, drop: 1.5 },
    { from: 40, to: 32, y: 0, drop: 1.5 },
  ];
  let t = 0;
  return legs.map((leg, i) => {
    const o: Obstacle = {
      id: `s2-barrel-${i + 1}`,
      type: 'boulderLane',
      position: v(0, leg.y, leg.from),
      rotation: { yaw: 180 },
      params: {
        lanes: 2,
        laneSpacing: 8,
        laneOrder: 'cycle',
        length: leg.from - leg.to,
        radius: 1.2,
        speed: BARREL_SPEED,
        spawnPeriod: 2,
        phase: Math.round(t * 100) / 100,
        dropHeight: leg.drop,
        dropTime: BARREL_DROP_TIME,
        knockSpeed: 9,
        knockLift: 5,
      },
    };
    t += (leg.from - leg.to) / BARREL_SPEED;
    return o;
  });
}

const LIFT = {
  points: [v(0, 0, 0), v(0, KEEP_TOP - COURT, 0)],
  size: v(4, 0.6, 4),
  speed: 3.4,
  mode: 'pingPong',
  pauseTime: 1.5,
  pauseAt: 'ends',
  easing: 'sine',
};

const obstacles: Obstacle[] = [
  { id: 's0-gate', type: 'startGate', position: v(0, 0, 4.5), params: { width: 16, height: 3 } },
  {
    id: 's1-door',
    type: 'doorGauntlet',
    position: v(0, 0, 16),
    params: {
      rows: 1,
      doorsPerRow: 4,
      fakePerRow: 2,
      doorWidth: DOOR_W,
      postWidth: DOOR_POST,
      doorHeight: 3.5,
      wallHeight: 5,
      doorThickness: 0.6,
    },
  },
  ...[27, 35].map((z, i): Obstacle => ({
    id: `s1-ham-${i + 1}`,
    type: 'pendulumHammer',
    position: v(0, 0, z),
    params: {
      pivotHeight: 10,
      armLength: 8,
      headRadius: 1.1,
      headLength: 2.4,
      amplitudeDeg: 60,
      period: 2.8,
      phase: i * 0.5,
      knockSpeed: 13,
    },
  })),
  ...barrels(),
  { id: 's3-lift-L', type: 'movingPlatform', position: v(-6.5, COURT + 0.05, 74), params: LIFT },
  // Half a cycle later: (2 × 12 m / 3.4 m/s + 2 × 1.5 s) / 2.
  {
    id: 's3-lift-R',
    type: 'movingPlatform',
    position: v(6.5, COURT + 0.05, 74),
    params: { ...LIFT, phase: 5.03 },
  },
  ...[
    [22.5, 111.25, 0],
    [25.5, 126.25, 0.5],
  ].map(([y, z, phase], i): Obstacle => ({
    id: `s4-ham-${i + 1}`,
    type: 'pendulumHammer',
    position: v(0, y!, z!),
    params: {
      pivotHeight: 9,
      armLength: 7.5,
      headRadius: 1,
      headLength: 2.4,
      amplitudeDeg: 55,
      period: 2.6,
      phase,
      knockSpeed: 12,
    },
  })),
  {
    id: 's5-sweep',
    type: 'sweeperArm',
    position: v(0, DECK.top, DECK.z),
    params: {
      armLength: 10.5,
      armCount: 1,
      armHeight: 0.5,
      armRadius: 0.32,
      postRadius: 2,
      postHeight: DAIS_TOP - DECK.top,
      baseSpeed: 1,
      // Design schedule 1.0 → 1.6 rad/s over two minutes: a linear ramp to the same peak.
      accel: 0.005,
      maxSpeed: 1.6,
      knockSpeed: 8,
    },
  },
  {
    id: 'crown',
    type: 'propSpawner',
    position: v(0, DAIS_TOP, DECK.z),
    params: {
      kind: 'crown',
      points: [v(0, CROWN_Y - DAIS_TOP, 0)],
      floating: true,
      bobHeight: 0.3,
      bobPeriod: 3,
      idBase: 1000,
    },
  },
  {
    id: 'cp-1-gate',
    type: 'checkpointGate',
    position: v(0, COURT, 66),
    params: { index: 1, width: 16, height: 5 },
  },
  {
    id: 'cp-2-gate',
    type: 'checkpointGate',
    position: v(0, KEEP_TOP, 92),
    params: { index: 2, width: 20, height: 5 },
  },
  {
    id: 'cp-3-gate',
    type: 'checkpointGate',
    position: v(0, DECK.top, 137),
    params: { index: 3, width: 10, height: 5 },
  },
];

// -----------------------------------------------------------------------------
// Bot navigation
// -----------------------------------------------------------------------------

const JUMP = { r: 1.5, action: 'jump' } as const;
const LINEUP = { r: 1.2 } as const;
/**
 * Climb-out waypoint, placed {@link CLIMB_LIFT} above a grabbable lip. The brain
 * only counts arrival within 2.2 m below a waypoint, so this fires for a bot
 * hanging on the lip (≈ 2.05 m below) but not for one still standing under it
 * (≈ 2.7 m); its jump press is what hauls the hanging bot up.
 */
const CLIMB = { r: 1, action: 'jump' } as const;
const CLIMB_LIFT = 1.2;

const nav = new NavBuilder();

let climbSeq = 1000;
/**
 * Climb-out chain at `pos` (ids from 1000 up). The first press often lands
 * mid-air, before the lip is caught, and a held jump only counts once, so the
 * chain presses three times ~0.3 s apart (two plain waypoints between presses
 * let the 14-tick jump hold release).
 *
 * @returns The chain's first waypoint id.
 */
function climb(pos: [number, number, number], next: number): number {
  const base = climbSeq;
  climbSeq += 10;
  for (let k = 0; k < 7; k++)
    nav.add(base + k, pos, k < 6 ? base + k + 1 : next, k % 3 === 0 ? CLIMB : { r: 1 });
  return base;
}
// Courtyard doors (see Gumdrop Gauntlet: slide along the row until a fake bursts).
nav.add(0, [0, 0, 3], 1, { r: 2 });
nav.add(
  1,
  [0, 0, 10],
  [1, 2, 0, 3].map((c) => 210 + c),
  { r: 3 },
);
for (let c = 0; c < 4; c++) {
  const dir = c <= 1 ? 1 : -1;
  nav.add(210 + c, [doorX(c), 0, 15], 220 + c, { r: 0.9 });
  nav.add(220 + c, [Math.max(-6.5, Math.min(6.5, doorX(c) + dir * 10)), 0, 21], 2, { r: 2 });
}
nav
  .add(2, [0, 0, 23], 3, { r: 2, action: 'waitForGap', timeAgainst: 's1-ham-1' })
  .add(3, [0, 0, 31], [40, 60], { r: 2, action: 'waitForGap', timeAgainst: 's1-ham-2' });

// Rampart Stairs on the barrel-free strips (x ±2): two jump-ups, two grab-climbs.
[-2, 2].forEach((x, s) => {
  const b = 40 + s * 20;
  nav.add(b, [x, 0, 37], b + 1, LINEUP);
  nav.add(b + 1, [x, 0, 39.6], b + 2, JUMP);
  nav.add(b + 2, [x, 1.5, 43.4], b + 3, LINEUP);
  nav.add(b + 3, [x, 1.5, 45.6], b + 4, JUMP);
  nav.add(b + 4, [x, 3, 48.5], b + 5, LINEUP);
  nav.add(b + 5, [x, 3, 51.4], climb([x, 5.2 + CLIMB_LIFT, 52.4], b + 7), JUMP);
  nav.add(b + 7, [x, 5.2, 54.5], b + 8, LINEUP);
  nav.add(b + 8, [x, 5.2, 57.4], climb([x, 7.4 + CLIMB_LIFT, 58.4], 8), JUMP);
});

/*
 * Keep. Bots take the climb tiers: jump at each riser, catch the lip, and the
 * CLIMB waypoint on the lip presses jump to haul up. The elevators are left to
 * humans: a bot can't tell whether the platform is down, and waiting under a
 * raised lift gets it squashed.
 */
nav.add(8, [0, COURT, 68], 80, { r: 2 });
// Per tier: a take-off at the riser, then the climb-out chain on its lip.
for (let i = 1; i <= CLIMB_TIERS; i++) {
  const face = KEEP_FACE - CLIMB_DEPTH * (CLIMB_TIERS - i);
  const top = COURT + i * CLIMB_RISE;
  nav.add(
    79 + i,
    [0, top - CLIMB_RISE, face - 0.2],
    climb([0, top + CLIMB_LIFT, face + 0.3], i < CLIMB_TIERS ? 80 + i : 12),
    JUMP,
  );
}

// Turret Hop along either line; wait out each hammer on the turret before it.
nav.add(12, [0, KEEP_TOP, 93.5], [120, 140], { r: 2 });
[-TURRET_X, TURRET_X].forEach((x, s) => {
  const b = 120 + s * 20;
  nav.add(b, [x, KEEP_TOP, 93.5], b + 1, LINEUP);
  nav.add(
    b + 1,
    [x, KEEP_TOP, 96.2],
    climb([x, TURRETS[0][0] + CLIMB_LIFT, TURRETS[0][1] - TURRET_R + 0.2], b + 2),
    JUMP,
  );
  TURRETS.forEach(([top, z], i) => {
    const n = b + 2 + i * 3;
    const hammer = i === 1 ? 's4-ham-1' : i === 3 ? 's4-ham-2' : null;
    nav.add(
      n,
      [x, top, z],
      n + 1,
      hammer ? { r: 1.5, action: 'waitForGap', timeAgainst: hammer } : { r: 1.5 },
    );
    const next = TURRETS[i + 1];
    if (next) {
      nav.add(
        n + 1,
        [x, top, z + TURRET_R - 0.1],
        climb([x, next[0] + CLIMB_LIFT, next[1] - TURRET_R + 0.2], n + 3),
        JUMP,
      );
    } else {
      nav.add(n + 1, [x, top, z + TURRET_R - 0.1], 19, JUMP);
    }
  });
});

// Crown Deck: hop the sweeper, onto the dais, jump for the crown.
nav
  .add(19, [0, DECK.top, 137.5], 20, { r: 2 })
  .add(20, [0, DECK.top, 141], 21, LINEUP)
  .add(21, [0, DECK.top, 143.6], 22, JUMP)
  .add(22, [0, DAIS_TOP, DECK.z], [], { r: 1 });

// -----------------------------------------------------------------------------
// Round
// -----------------------------------------------------------------------------

export default defineRound({
  id: 'crown-climb',
  name: 'Crown Climb',
  type: 'final',
  theme: 'castle',
  objective: 'Climb the castle. Grab the Crown to win!',
  tips: [
    'Jump at the Crown — it floats just out of standing reach.',
    'The elevators are slow but safe. The wall is fast.',
    "Everyone respawns. It's not over until someone grabs it.",
  ],
  players: { min: 1, max: 15, ideal: 8 },
  qualification: { mode: 'crownGrab' },
  duration: { seconds: 180, overtimeSeconds: 60 },
  killY: -10,
  bounds: { min: v(-35, -30, -15), max: v(35, 55, 170) },
  spawn: { origin: v(0, 0.1, -1), yaw: 0, cols: 4, spacing: 1.8 },
  geometry: [...gate, ...courtyard, ...rampart, ...keep, ...turrets, ...crownDeck, ...castleDecor],
  obstacles,
  triggers: [
    {
      id: 'cp-0',
      kind: 'checkpoint',
      index: 0,
      position: v(0, 2, 0),
      size: v(16, 4, 12),
      respawn: [-4.5, -1.5, 1.5, 4.5].map((x) => v(x, 0.1, 1)),
    },
    ...CP,
    { id: 'crown', kind: 'crown', position: v(0, CROWN_Y, DECK.z), size: v(1.4, 1.4, 1.4) },
  ],
  flyover: {
    path: [v(0, 6, -15), v(14, 10, 30), v(-14, 16, 70), v(12, 26, 110), v(0, 38, 130)],
    lookAt: [v(0, 2, 16), v(0, 3, 50), v(0, 13, 80), v(0, 24, 120), v(0, CROWN_Y, DECK.z)],
    duration: 7,
  },
  cameraMode: 'orbit',
  music: 'mus_final_crownfever',
  speedScaleByStage: [1.0, 1.0, 1.1, 1.15, 1.2],
  fallBehavior: 'respawnCheckpoint',
  botNav: nav.build(),
  variations: [
    { id: 'coronation', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'stormy-keep',
      weight: 2,
      weather: 'stormy',
      description: 'Wind across the turrets; lightning flashes.',
      addObstacles: [
        {
          id: 'w-turret',
          type: 'fanZone',
          position: v(-12, KEEP_TOP + 6, 115),
          rotation: { yaw: 90 },
          params: { width: 40, height: 14, length: 24, strength: 6, falloff: 0.4, onTime: 3, offTime: 2 },
        },
      ],
    },
    {
      id: 'crown-rush',
      weight: 2,
      weather: 'sunset',
      description: 'The crown sweeper starts fast and stays fast.',
      obstacleParams: { 's5-sweep': { baseSpeed: 1.4, maxSpeed: 1.8 } },
    },
    {
      id: 'twin-sweepers',
      weight: 1,
      weather: 'night',
      description: 'Two sweeper arms guard the crown.',
      obstacleParams: { 's5-sweep': { armCount: 2 } },
    },
  ],
  decorSeed: 9101,
  designNotes:
    'Final: compact climb, everyone respawns. Door lottery (4 doors, 2 fakes) + hammers → rampart jump-ups and grab ' +
    'ledges with barrels → climb wall vs elevators → ascending turrets under two hammers → crown deck with a sweeper ' +
    'around the dais; the crown floats 3.1 m above the dais (must jump). First attempts expected ~55–65 s. ' +
    'Approximations: no crown lowering in overtime, no slip band, linear sweeper ramp, moving-crown variation dropped.',
});
