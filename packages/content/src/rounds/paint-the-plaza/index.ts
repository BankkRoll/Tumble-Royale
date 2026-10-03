/**
 * T3 — Paint the Plaza (LEVELS.md §6). Four teams paint a neon night plaza;
 * score = painted value at the buzzer (raised stages count double), rotating
 * rinse arms wash stripes back to neutral and paint buckets grant a few
 * seconds of super-roller.
 *
 * 4-fold symmetric: team 0's corner (−X, −Z) and the stage on the −Z axis are
 * authored once and rotated by 90° steps; team k sits 90°·k clockwise from
 * team 0 seen from above (0 = (−x,−z), 1 = (+x,−z), 2 = (+x,+z), 3 = (−x,+z)).
 *
 * The paint grid uses 25 × 25 cells of 2 m centred on the plaza, so each 6 m
 * stage covers exactly 3 × 3 cells (the 48 m floor then leaves a half cell
 * under each wall: those edge cells are blocked).
 */
import { defineRound } from '@tumble/shared';
import {
  crestBoard,
  crowdStand,
  radial,
  rotPiece,
  rotPoint,
  team,
  teamBanner,
  v,
  wrapDeg,
} from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];
type Trigger = NonNullable<Def['triggers']>[number];

const TEAMS = [0, 1, 2, 3];
/** Yaw-sense rotation carrying team 0's corner (−x, −z) onto team k's (−90° per team: −x,−z → +x,−z → …). */
const teamRot = (k: number): number => wrapDeg(-90 * k);

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

/** The stage on the −Z axis with its two ramps (rotated ×4). */
const stage: Piece[] = [
  { shape: 'box', position: v(0, 0.75, -18), size: v(6, 1.5, 6), color: 'neutral', bevel: 0.2 },
  // Inner ramp rises toward the stage (−Z), outer ramp rises toward it from the wall side (+Z).
  {
    shape: 'ramp',
    position: v(0, 0.75, -13),
    size: v(3, 1.5, 4),
    rotation: { yaw: 180 },
    color: 'neutral',
    pattern: 'chevron',
  },
  {
    shape: 'ramp',
    position: v(0, 0.75, -22.5),
    size: v(3, 1.5, 3),
    rotation: { yaw: 0 },
    color: 'neutral',
    pattern: 'chevron',
  },
  // Neon "×2" posts flanking the stage (decor).
  {
    shape: 'cylinder',
    position: v(-3.4, 2.4, -20.8),
    size: v(0.18, 1.8, 0),
    color: 'secondary',
    decorative: true,
  },
  {
    shape: 'cylinder',
    position: v(3.4, 2.4, -20.8),
    size: v(0.18, 1.8, 0),
    color: 'secondary',
    decorative: true,
  },
  {
    shape: 'torus',
    position: v(0, 3.5, -20.8),
    size: v(1.2, 0.12, 0),
    rotation: { pitch: 90 },
    color: 'accent',
    decorative: true,
  },
];

/** Team 0's corner: pre-painted spawn pad, banners and crest boards. */
function corner(t: number): Piece[] {
  return [
    {
      shape: 'box',
      position: v(-21, 0.01, -21),
      size: v(6, 0.02, 6),
      color: team(t),
      pattern: 'checker',
      decorative: true,
    },
    ...teamBanner(t, v(-23.4, 0, -18.2), 45, 6),
    ...teamBanner(t, v(-18.2, 0, -23.4), 45, 6),
    ...crestBoard(t, v(-25.6, 4.2, -25.6), 45, 3.4),
  ];
}

/** Neon city dressing outside the walls: billboards, speaker stacks, ring signs, rooftop crowd. */
function city(): Piece[] {
  const out: Piece[] = [];
  const side: Piece[] = [
    // Billboard on a rooftop island beyond the −Z wall.
    { shape: 'box', position: v(0, -2, -36), size: v(30, 4, 12), color: 'primary', decorative: true },
    {
      shape: 'box',
      position: v(0, 6.5, -38),
      size: v(16, 7, 0.6),
      color: 'neutral',
      decorative: true,
      pattern: 'checker',
    },
    {
      shape: 'box',
      position: v(0, 6.5, -37.6),
      size: v(15, 6, 0.2),
      color: 'secondary',
      decorative: true,
      pattern: 'stripes',
    },
    { shape: 'cylinder', position: v(-6, 1.5, -38), size: v(0.3, 3, 0), color: 'neutral', decorative: true },
    { shape: 'cylinder', position: v(6, 1.5, -38), size: v(0.3, 3, 0), color: 'neutral', decorative: true },
    // Speaker stacks.
    {
      shape: 'box',
      position: v(-12, 2, -33),
      size: v(3, 4, 3),
      color: 'neutral',
      decorative: true,
      pattern: 'dots',
    },
    {
      shape: 'cylinder',
      position: v(-12, 2.6, -31.4),
      size: v(1.1, 0.3, 0),
      rotation: { pitch: 90 },
      color: 'accent',
      decorative: true,
    },
    {
      shape: 'box',
      position: v(12, 2, -33),
      size: v(3, 4, 3),
      color: 'neutral',
      decorative: true,
      pattern: 'dots',
    },
    {
      shape: 'cylinder',
      position: v(12, 2.6, -31.4),
      size: v(1.1, 0.3, 0),
      rotation: { pitch: 90 },
      color: 'accent',
      decorative: true,
    },
    // Glowing ring sign.
    {
      shape: 'torus',
      position: v(0, 13, -38),
      size: v(2.6, 0.25, 0),
      rotation: { pitch: 90 },
      color: 'accent',
      decorative: true,
    },
  ];
  out.push(...radial(side, 4));
  for (let k = 0; k < 4; k++) {
    const roof = rotPoint(v(0, -1.5, -44), 90 * k + 45);
    out.push({
      shape: 'hexPrism',
      position: v(roof.x, -1.5, roof.z),
      size: v(8, 3, 0),
      color: 'primary',
      decorative: true,
    });
    out.push(
      ...crowdStand(
        rotPoint(v(0, 0, -42), 90 * k + 45),
        wrapDeg(90 * k + 45),
        10,
        3,
        ['#ff3df2', '#00e5ff', '#2bffb8', '#ffd23f', '#cfd3ff'],
        k,
      ),
    );
  }
  // Drones with spotlights hovering over the plaza.
  for (let k = 0; k < 6; k++) {
    const p = rotPoint(v(0, 16 + (k % 2) * 3, 20), k * 60 + 30);
    out.push(
      { shape: 'sphere', position: p, size: v(0.6, 0, 0), color: 'neutral', decorative: true },
      {
        shape: 'torus',
        position: v(p.x, p.y + 0.3, p.z),
        size: v(0.9, 0.08, 0),
        color: 'accent',
        decorative: true,
      },
    );
  }
  return out;
}

const geometry: Piece[] = [
  // p.1 plaza floor (the paint grid draws on top of it).
  {
    shape: 'box',
    position: v(0, -0.5, 0),
    size: v(48, 1, 48),
    color: '#211a4f',
    pattern: 'none',
    bevel: 0.3,
  },
  ...radial(stage, 4),
  // p.4 fountain base (rinse hub).
  { shape: 'cylinder', position: v(0, 0.3, 0), size: v(3, 0.6, 0), color: 'accent' },
  // p.5 / p.6 edge walls with neon trim.
  ...radial([{ shape: 'box', position: v(0, 1, -24.5), size: v(50, 2, 1), color: 'neutral' }], 4),
  ...radial(
    [
      {
        shape: 'box',
        position: v(0, 2.05, -24.5),
        size: v(50, 0.1, 0.4),
        color: 'secondary',
        decorative: true,
      },
    ],
    4,
  ),
  ...TEAMS.flatMap((k) => corner(k).map((p) => rotPiece(p, teamRot(k)))),
  ...city(),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const stageRect = (x: number, z: number) => ({ x, z, sizeX: 6, sizeZ: 6, height: 1.5, mult: 2 });
const ramps = TEAMS.flatMap((k) => {
  const inner = rotPoint(v(0, 0, -13), 90 * k);
  const outer = rotPoint(v(0, 0, -22.5), 90 * k);
  const across = k % 2 === 0;
  return [
    { x: inner.x, z: inner.z, sizeX: across ? 3 : 4, sizeZ: across ? 4 : 3 },
    { x: outer.x, z: outer.z, sizeX: across ? 3 : 3, sizeZ: across ? 3 : 3 },
  ];
});

const paintParams = {
  cols: 25,
  rows: 25,
  cellSize: 2,
  teams: 4,
  stages: [stageRect(0, -18), stageRect(18, 0), stageRect(0, 18), stageRect(-18, 0)],
  blocked: [
    ...ramps,
    // Fountain base.
    { x: 0, z: 0, sizeX: 5, sizeZ: 5 },
    // Half cells under the edge walls.
    { x: 24, z: 0, sizeX: 1, sizeZ: 50 },
    { x: -24, z: 0, sizeX: 1, sizeZ: 50 },
    { x: 0, z: 24, sizeX: 50, sizeZ: 1 },
    { x: 0, z: -24, sizeX: 50, sizeZ: 1 },
  ],
  prepaint: TEAMS.map((k) => {
    const c = rotPoint(v(-21, 0, -21), teamRot(k));
    return { x: c.x, z: c.z, sizeX: 6, sizeZ: 6, team: k };
  }),
  rinseArms: 2,
  rinseLength: 16,
  rinseHubRadius: 3,
  rinseHeight: 3.5,
  rinseWidth: 1.2,
  rinseSpeed: 0.45,
  rinseSchedule: [{ t: 60, speed: 0.7 }],
  // Buckets at r 6 on the diagonals: equidistant from every corner.
  buckets: [45, 135, 225, 315].map((a) => {
    const p = rotPoint(v(0, 0, 6), a);
    return { x: p.x, z: p.z };
  }),
  bucketDuration: 6,
  bucketRespawn: 12,
};

const obstacles: Obstacle[] = [
  { id: 'paint', type: 'paintGrid', position: v(0, 0, 0), params: paintParams },
  ...[
    [-9, -9],
    [9, -9],
    [9, 9],
    [-9, 9],
  ].map(([x, z], i): Obstacle => ({
    id: `bump-${i + 1}`,
    type: 'bumperPillar',
    position: v(x!, 0, z!),
    params: { radius: 1, height: 2.4, bounceSpeed: 8 },
  })),
];

// -----------------------------------------------------------------------------
// Triggers: one respawn checkpoint per corner (index = team)
// -----------------------------------------------------------------------------

const triggers: Trigger[] = TEAMS.map((k) => {
  const c = rotPoint(v(-21, 1, -21), teamRot(k));
  return {
    id: `cp-t${k}`,
    kind: 'checkpoint' as const,
    position: c,
    size: v(6, 3, 6),
    index: k,
    respawn: [
      [-1.4, -1.4],
      [1.4, -1.4],
      [-1.4, 1.4],
      [1.4, 1.4],
    ].map(([dx, dz]) => v(c.x + dx!, 0.1, c.z + dz!)),
    respawnYaw: wrapDeg(45 + teamRot(k)),
  };
});

export default defineRound({
  id: 'paint-the-plaza',
  name: 'Paint the Plaza',
  type: 'team',
  theme: 'neon',
  objective: 'Paint the most floor in your team colour!',
  tips: [
    'Diving splashes a big blob of paint.',
    'Grab a paint bucket for a few seconds of super-roller.',
    'Stages count double. Rinse arms wash paint away!',
  ],
  players: { min: 8, max: 100, ideal: 60 },
  qualification: { mode: 'teamScore', teams: 4, teamsEliminated: 1, ratio: 0.75 },
  duration: { seconds: 90, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-40, -15, -40), max: v(40, 25, 40) },
  spawn: {
    origin: v(0, 0, 0),
    yaw: 45,
    cols: 8,
    spacing: 1.3,
    teamOrigins: TEAMS.map((k) => {
      const p = rotPoint(v(-19, 0.1, -19), teamRot(k));
      return v(p.x, 0.1, p.z);
    }),
  },
  geometry,
  obstacles,
  triggers,
  flyover: {
    path: [v(0, 50, -10), v(10, 48, 0), v(0, 46, 10), v(-10, 44, 0), v(0, 30, -30)],
    lookAt: [v(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_neon_arcadeheart',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'respawnCheckpoint',
  botNav: [
    { id: 0, position: v(0, 0, 0), radius: 4, next: [] },
    ...TEAMS.map((k) => ({
      id: 100 + k,
      position: rotPoint(v(0, 1.5, -18), 90 * k),
      radius: 2.5,
      next: [] as number[],
    })),
    ...TEAMS.map((k) => ({
      id: 200 + k,
      position: rotPoint(v(-12, 0, -12), 90 * k),
      radius: 3,
      next: [] as number[],
    })),
  ],
  variations: [
    { id: 'neon-night', weight: 4, weather: 'night', description: 'As authored.' },
    {
      id: 'triple-rinse',
      weight: 1,
      weather: 'night',
      description: 'Three rinse arms.',
      obstacleParams: { paint: { rinseArms: 3 } },
    },
    {
      id: 'bucket-bonanza',
      weight: 2,
      weather: 'night',
      description: 'Eight buckets.',
      obstacleParams: {
        paint: {
          buckets: [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
            const p = rotPoint(v(0, 0, a % 90 === 0 ? 10 : 6), a);
            return { x: p.x, z: p.z };
          }),
        },
      },
    },
    {
      id: 'rinse-rush',
      weight: 2,
      weather: 'night',
      description: 'The rinse spins up early and hard.',
      obstacleParams: { paint: { rinseSpeed: 0.6, rinseSchedule: [{ t: 40, speed: 1.0 }] } },
    },
  ],
  decorSeed: 3301,
  designNotes:
    'paintGrid owns painting, dive splashes (3 × 3), buckets (touch pickup ⇒ 6 s three-wide swath, back 12 s later) and the ' +
    'rinse (pure f(t), harmless at 3.5 m, washes a 1.2 m strip). Team points are a live level read by the team rules ' +
    '(stage cells ×2). No paint zone trigger (it would award zone points). Respawn = own corner pad (checkpoint index = team). ' +
    'Deviations: 25 × 25 cell grid so stages align with cells; buckets are touch pickups inside paintGrid instead of carried ' +
    'propSpawner buckets; slick-paint (per-team ice) needs per-player surfaces, replaced by rinse-rush; last-place ties use ' +
    'the team rules tie-break (earlier score) rather than stage cells.',
});
