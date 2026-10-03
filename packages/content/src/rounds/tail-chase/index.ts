/**
 * H1 — Tail Chase (LEVELS.md §7). Half the lobby starts with a tail; grab a
 * holder to steal theirs. Whoever holds a tail at the buzzer qualifies.
 *
 * A 60 × 60 m jungle ruin: a three-tier ziggurat with a spinning summit, four
 * corner towers with stair blocks and escape bounce pads, a conveyor loop
 * around the edge and rolling logs on the diagonals. Symmetric by sign
 * mirroring in X and Z.
 */
import { defineRound } from '@tumble/shared';
import { crowdStand, rotPoint, v } from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];
type Trigger = NonNullable<Def['triggers']>[number];

const GRAVITY = 24;
const SIGNS = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
] as const;

/** Bounce-pad launch for a target apex and range landing `landingDelta` relative to the pad. */
function padLaunch(apex: number, range: number, landingDelta: number): { x: number; y: number; z: number } {
  const vy = Math.sqrt(2 * GRAVITY * apex);
  const flight = vy / GRAVITY + Math.sqrt((2 * (apex - landingDelta)) / GRAVITY);
  return { x: 0, y: Math.round(vy * 100) / 100, z: Math.round((range / flight) * 100) / 100 };
}

/** Tower at (sx·22, sz·22) with its three stair blocks (exact table for (+22, +22), mirrored by sign). */
function tower(sx: number, sz: number): Piece[] {
  const m = (x: number, y: number, z: number) => v(sx * x, y, sz * z);
  return [
    { shape: 'box', position: m(22, 4, 22), size: v(6, 8, 6), color: 'neutral', grabbable: true, bevel: 0.3 },
    // +1.5 / +1.8 jumps, then +2.2 / +2.5 grabs.
    { shape: 'box', position: m(17.5, 0.75, 22), size: v(3, 1.5, 3), color: 'accent', grabbable: true },
    { shape: 'box', position: m(17.5, 1.65, 18.5), size: v(3, 3.3, 3), color: 'accent', grabbable: true },
    { shape: 'box', position: m(21, 2.75, 17.5), size: v(3, 5.5, 3), color: 'accent', grabbable: true },
    // Banana-leaf canopy posts and leaves over the tower (decor, clear of the pad's arc).
    {
      shape: 'cylinder',
      position: m(24.6, 10, 24.6),
      size: v(0.25, 4, 0),
      color: '#b8956a',
      decorative: true,
    },
    {
      shape: 'sphere',
      position: m(24.6, 12.4, 24.6),
      size: v(2.2, 0, 0),
      color: 'primary',
      decorative: true,
    },
    { shape: 'sphere', position: m(25.6, 11.6, 23), size: v(1.4, 0, 0), color: 'primary', decorative: true },
    // Monkey statue on the tower corner.
    { shape: 'sphere', position: m(19.6, 8.7, 24.4), size: v(0.7, 0, 0), color: '#b8956a', decorative: true },
    { shape: 'sphere', position: m(19.6, 9.6, 24.4), size: v(0.5, 0, 0), color: '#b8956a', decorative: true },
  ];
}

function decor(): Piece[] {
  const out: Piece[] = [];
  // Overgrown ruin islands, vines and a toucan crowd beyond the rails.
  for (let k = 0; k < 8; k++) {
    const p = rotPoint(v(0, 0, 44), k * 45 + 22.5);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, -2, p.z),
        size: v(4.5, 4, 0),
        color: '#b8956a',
        decorative: true,
      },
      {
        shape: 'cylinder',
        position: v(p.x, 4, p.z),
        size: v(0.5, 8, 0),
        color: '#b8956a',
        decorative: true,
        pattern: 'stripes',
      },
      { shape: 'sphere', position: v(p.x, 9, p.z), size: v(3, 0, 0), color: 'primary', decorative: true },
    );
    if (k % 2 === 0)
      out.push(
        ...crowdStand(
          rotPoint(v(0, 0, 38), k * 45),
          k * 45 + 180,
          8,
          2,
          ['#ff5a1a', '#ffd23f', '#3ce6e0', '#9d6cff'],
          k,
        ),
      );
  }
  // Worn stone paths from the respawn pads to the ziggurat, and moss bands on the towers.
  for (let k = 0; k < 4; k++) {
    out.push({
      shape: 'box',
      position: rotPoint(v(0, 0.01, 15.5), k * 90),
      size: k % 2 ? v(5, 0.02, 2.6) : v(2.6, 0.02, 5),
      color: 'secondary',
      pattern: 'checker',
      decorative: true,
    });
  }
  for (const [sx, sz] of SIGNS) {
    out.push({
      shape: 'box',
      position: v(sx * 22, 6.6, sz * 22),
      size: v(6.3, 0.7, 6.3),
      color: 'primary',
      decorative: true,
      bevel: 0.25,
    });
  }
  // Carved steps decor on the ziggurat faces.
  for (let k = 0; k < 4; k++) {
    const p = rotPoint(v(0, 3.2, 6.1), k * 90 + 45);
    out.push({ shape: 'sphere', position: p, size: v(0.5, 0, 0), color: 'accent', decorative: true });
  }
  return out;
}

const geometry: Piece[] = [
  // r.1 ground (the conveyor loop runs just outside it).
  { shape: 'box', position: v(0, -0.5, 0), size: v(56, 1, 56), color: 'primary', bevel: 0.3 },
  // r.2 – r.4 ziggurat tiers (tops 1.5 / 3.0 / 4.5).
  { shape: 'box', position: v(0, 0.75, 0), size: v(18, 1.5, 18), color: 'secondary', bevel: 0.25 },
  {
    shape: 'box',
    position: v(0, 1.5, 0),
    size: v(12, 3, 12),
    color: 'secondary',
    bevel: 0.25,
    pattern: 'stripes',
  },
  { shape: 'box', position: v(0, 2.25, 0), size: v(6, 4.5, 6), color: 'accent', bevel: 0.2 },
  // r.5 tier-1 ramps rising toward the ziggurat from each side.
  {
    shape: 'ramp',
    position: v(0, 0.75, 11),
    size: v(4, 1.5, 4),
    rotation: { yaw: 180 },
    color: 'secondary',
    pattern: 'chevron',
  },
  {
    shape: 'ramp',
    position: v(0, 0.75, -11),
    size: v(4, 1.5, 4),
    rotation: { yaw: 0 },
    color: 'secondary',
    pattern: 'chevron',
  },
  {
    shape: 'ramp',
    position: v(11, 0.75, 0),
    size: v(4, 1.5, 4),
    rotation: { yaw: -90 },
    color: 'secondary',
    pattern: 'chevron',
  },
  {
    shape: 'ramp',
    position: v(-11, 0.75, 0),
    size: v(4, 1.5, 4),
    rotation: { yaw: 90 },
    color: 'secondary',
    pattern: 'chevron',
  },
  // r.6 / r.7 corner towers and stairs.
  ...SIGNS.flatMap(([sx, sz]) => tower(sx, sz)),
  // r.8 outer rails beyond the conveyor loop.
  { shape: 'box', position: v(0, 0.5, 30.25), size: v(61, 1, 0.5), color: 'neutral' },
  { shape: 'box', position: v(0, 0.5, -30.25), size: v(61, 1, 0.5), color: 'neutral' },
  { shape: 'box', position: v(30.25, 0.5, 0), size: v(0.5, 1, 61), color: 'neutral' },
  { shape: 'box', position: v(-30.25, 0.5, 0), size: v(0.5, 1, 61), color: 'neutral' },
  // r.9 respawn pad paint on the mid-edge pads.
  ...[v(22, 0.01, 0), v(-22, 0.01, 0), v(0, 0.01, 22), v(0, 0.01, -22)].map((p): Piece => ({
    shape: 'cylinder',
    position: p,
    size: v(4, 0.02, 0),
    color: 'safe',
    pattern: 'checker',
    decorative: true,
  })),
  ...decor(),
];

const loop = (
  id: string,
  pos: { x: number; y: number; z: number },
  yaw: number,
  length: number,
): Obstacle => ({
  id,
  type: 'conveyorBelt',
  position: pos,
  rotation: { yaw },
  params: { length, width: 2, speed: 5, pattern: 'forward', rails: false },
});

// Tower pads aim down the diagonal at tier 2 (top 3.0): ~24 m out, 5 m below the 8 m tower top.
const TOWER_PAD = padLaunch(6, 24, -5);

const obstacles: Obstacle[] = [
  // Loop runs N → +x, E → −z, S → −x, W → +z.
  loop('loop-N', v(0, 0, 29), 90, 60),
  loop('loop-E', v(29, 0, 0), 180, 56),
  loop('loop-S', v(0, 0, -29), 270, 60),
  loop('loop-W', v(-29, 0, 0), 0, 56),
  ...SIGNS.map(([sx, sz], i): Obstacle => ({
    id: `pad-T${i + 1}`,
    type: 'bouncePad',
    position: v(sx * 22, 8, sz * 22),
    rotation: { yaw: (Math.atan2(-sx, -sz) * 180) / Math.PI },
    params: { radius: 1.2, launch: TOWER_PAD, cooldown: 0.4 },
  })),
  // Summit merry-go-round, flush with the summit top.
  {
    id: 'disc',
    type: 'spinningDisc',
    position: v(0, 4.5, 0),
    params: { radius: 3, thickness: 0.5, speed: 1.2 },
  },
  // Trip logs across the tower–ziggurat diagonals.
  ...SIGNS.map(([sx, sz], i): Obstacle => ({
    id: `log-${i + 1}`,
    type: 'rollingDrum',
    position: v(sx * 13, 0.6, sz * 13),
    rotation: { yaw: sx * sz > 0 ? 45 : -45 },
    params: { length: 6, radius: 0.6, spinSpeed: 143, ridges: 6, ridgeHeight: 0.12 },
  })),
];

const pad = (id: string, x: number, z: number, yaw: number): Trigger => ({
  id,
  kind: 'checkpoint',
  position: v(x, 1, z),
  size: v(8, 3, 8),
  index: 0,
  respawn: [
    [-1.5, -1.5],
    [1.5, -1.5],
    [-1.5, 1.5],
    [1.5, 1.5],
  ].map(([dx, dz]) => v(x + dx!, 0.1, z + dz!)),
  respawnYaw: yaw,
});

export default defineRound({
  id: 'tail-chase',
  name: 'Tail Chase',
  type: 'hunt',
  theme: 'jungle',
  objective: 'Hold a tail when time runs out!',
  tips: [
    'Grab a tail from behind to steal it.',
    "Just stole one? You're safe for a moment. Run!",
    'Bounce pads on the towers are great escape routes.',
  ],
  players: { min: 8, max: 100, ideal: 75 },
  qualification: { mode: 'holdItem', ratio: 0.5 },
  duration: { seconds: 90, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-45, -15, -45), max: v(45, 30, 45) },
  spawn: { origin: v(0, 0.1, -20), yaw: 0, cols: 10, spacing: 1.4 },
  geometry,
  obstacles,
  triggers: [
    pad('cp-c0', 22, 0, -90),
    pad('cp-c1', -22, 0, 90),
    pad('cp-c2', 0, 22, 180),
    pad('cp-c3', 0, -22, 0),
  ],
  flyover: {
    path: [v(-40, 20, -40), v(40, 26, -40), v(40, 18, 40), v(0, 14, 20)],
    lookAt: [v(0, 3, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_jungle_bongobounce',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'respawnCheckpoint',
  // Hints for hunt bots: their flee anchor is the centroid (the ziggurat), plus escape features.
  botNav: [
    { id: 0, position: v(0, 4.5, 0), radius: 2.5, next: [] },
    { id: 1, position: v(0, 3, 7.5), radius: 2, next: [] },
    { id: 2, position: v(0, 3, -7.5), radius: 2, next: [] },
    ...SIGNS.map(([sx, sz], i) => ({
      id: 10 + i,
      position: v(sx * 22, 8, sz * 22),
      radius: 2,
      next: [] as number[],
    })),
    ...SIGNS.map(([sx, sz], i) => ({
      id: 20 + i,
      position: v(sx * 13, 0, sz * 13),
      radius: 2.5,
      next: [] as number[],
    })),
  ],
  variations: [
    { id: 'ruins-classic', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'fast-loop',
      weight: 1,
      weather: 'sunset',
      description: 'Conveyor loop at 8 m/s and a faster summit spinner.',
      obstacleParams: {
        'loop-N': { speed: 8 },
        'loop-E': { speed: 8 },
        'loop-S': { speed: 8 },
        'loop-W': { speed: 8 },
        disc: { speed: 2 },
      },
    },
    {
      id: 'jungle-night',
      weight: 1,
      weather: 'night',
      description: 'Glowing tails and fireflies under the canopy.',
    },
    {
      id: 'log-jam',
      weight: 1,
      weather: 'clear',
      description: 'Faster rolling logs on every diagonal.',
      obstacleParams: {
        'log-1': { spinSpeed: 230 },
        'log-2': { spinSpeed: 230 },
        'log-3': { spinSpeed: 230 },
        'log-4': { spinSpeed: 230 },
      },
    },
  ],
  decorSeed: 4101,
  designNotes:
    'holdItem rules: ceil(N × 0.5) tails dealt at start; grabbing a holder steals (1 s steal cooldown in the rules). ' +
    'Tower pads solved for gravity 24: apex 6, ~24 m toward the centre, landing on tier 2. Respawn = first mid-edge pad touched ' +
    '(else the spawn grid). Deviations: back-hemisphere steal check, 1.5 s immunity flash, hunter 1.05× speed and ' +
    '"falling drops your tail" are not in the hold-item rules; few-tails (ratio 0.4) needs a playlist override, replaced by log-jam.',
});
