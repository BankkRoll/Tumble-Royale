/**
 * H3 — Sunbeam Squabble. Pools of late-afternoon sunshine drift across a
 * boardwalk plaza. Stand in a sunbeam to soak up points; a beam's sunshine is
 * shared between everyone inside it, so crowds score slowly and a well-timed
 * shove pays. The first Tumblers to bank ten points qualify.
 *
 * Layout: a 46 m square plaza with low rails, a slow low sweeper arm turning
 * around a lighthouse post in the middle (hop it or be swept out of your
 * beam) and four ice-cream kiosks to dodge around. Beams drift on their own
 * paths across the whole plaza; one beam per nine entrants (a duel shares a
 * single beam). Falls respawn on the plaza.
 */
import { defineRound } from '@tumble/shared';
import { crowdStand, rotPoint, v } from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];

const HALF = 23;
const KIOSK_AT = 14.5;
const KIOSKS = [45, 135, 225, 315].map((deg) => rotPoint(v(0, 0, KIOSK_AT), deg));

function kiosk(at: { x: number; z: number }, i: number): Piece[] {
  const stripe = i % 2 === 0 ? 'accent' : 'secondary';
  return [
    { shape: 'box', position: v(at.x, 0.9, at.z), size: v(2.6, 1.8, 2.6), color: 'neutral', bevel: 0.25 },
    // Striped awning and a giant cone on top (decor, above head height).
    {
      shape: 'box',
      position: v(at.x, 2.15, at.z),
      size: v(3.4, 0.5, 3.4),
      color: stripe,
      pattern: 'stripes',
      decorative: true,
    },
    {
      shape: 'cylinder',
      position: v(at.x, 3.2, at.z),
      size: v(0.55, 1.6, 0),
      color: '#e8b46a',
      pattern: 'checker',
      decorative: true,
    },
    {
      shape: 'sphere',
      position: v(at.x, 4.2, at.z),
      size: v(0.75, 0, 0),
      color: '#ff8fab',
      decorative: true,
    },
  ];
}

function decor(): Piece[] {
  const out: Piece[] = [];
  // Lamp posts along the rails and pennant poles at the corners.
  for (let k = 0; k < 4; k++) {
    for (const along of [-14, 0, 14]) {
      const p = rotPoint(v(along, 0, HALF + 1.2), k * 90);
      out.push(
        {
          shape: 'cylinder',
          position: v(p.x, 1.8, p.z),
          size: v(0.14, 3.6, 0),
          color: 'neutral',
          decorative: true,
        },
        {
          shape: 'sphere',
          position: v(p.x, 3.75, p.z),
          size: v(0.35, 0, 0),
          color: 'accent',
          decorative: true,
        },
      );
    }
    const c = rotPoint(v(HALF + 1.2, 0, HALF + 1.2), k * 90);
    out.push(
      {
        shape: 'cylinder',
        position: v(c.x, 3, c.z),
        size: v(0.18, 6, 0),
        color: 'neutral',
        decorative: true,
      },
      {
        shape: 'wedge',
        position: v(c.x, 5.4, c.z),
        size: v(0.2, 1.2, 1.8),
        rotation: { yaw: k * 90 + 45 },
        color: 'secondary',
        decorative: true,
      },
    );
  }
  // Pier pilings under the plaza and calm sea beyond.
  for (let k = 0; k < 4; k++) {
    for (const along of [-18, -6, 6, 18]) {
      const p = rotPoint(v(along, 0, HALF - 2), k * 90);
      out.push({
        shape: 'cylinder',
        position: v(p.x, -4.5, p.z),
        size: v(0.7, 8, 0),
        color: '#b07a52',
        decorative: true,
      });
    }
  }
  out.push({
    shape: 'box',
    position: v(0, -8.6, 0),
    size: v(150, 0.4, 150),
    color: '#5aa9ff',
    decorative: true,
    pattern: 'dots',
  });
  // Sunset crowds on two boardwalk stands.
  const crowd = ['#ff9a6b', '#c77dff', '#ffd36e', '#fff0e3', '#ff8fab'];
  for (const [deg, seed] of [
    [0, 11],
    [270, 17],
  ] as const) {
    const at = rotPoint(v(0, 0, HALF + 6), deg);
    out.push({
      shape: 'box',
      position: v(at.x, -0.6, at.z),
      size: deg === 0 ? v(26, 1.2, 7) : v(7, 1.2, 26),
      color: '#b07a52',
      decorative: true,
    });
    out.push(...crowdStand(at, deg + 180, 24, 3, crowd, seed));
  }
  return out;
}

const geometry: Piece[] = [
  {
    shape: 'box',
    position: v(0, -0.5, 0),
    size: v(HALF * 2, 1, HALF * 2),
    color: 'primary',
    pattern: 'stripes',
  },
  // Knee-high rails: a shove near the edge is a stumble, not a swim.
  ...[0, 90, 180, 270].map((deg): Piece => ({
    shape: 'box',
    position: rotPoint(v(0, 0.4, HALF - 0.25), deg),
    size: deg % 180 === 0 ? v(HALF * 2, 0.8, 0.5) : v(0.5, 0.8, HALF * 2),
    color: 'neutral',
    bevel: 0.2,
  })),
  ...KIOSKS.flatMap((k, i) => kiosk(k, i)),
  // Lighthouse post in the middle (the sweeper's hub) with its lamp high above.
  {
    shape: 'cylinder',
    position: v(0, 4, 0),
    size: v(0.5, 8, 0),
    color: '#ffffff',
    pattern: 'stripes',
    decorative: true,
  },
  { shape: 'sphere', position: v(0, 8.5, 0), size: v(0.9, 0, 0), color: 'accent', decorative: true },
  ...decor(),
];

const obstacles: Obstacle[] = [
  {
    id: 'sunbeams',
    type: 'sunbeamZones',
    position: v(0, 0, 0),
    params: {
      beams: 12,
      base: 1,
      playersPerBeam: 9,
      radius: 2.8,
      areaX: 18,
      areaZ: 18,
      drift: 0.16,
      rate: 1,
    },
  },
  {
    id: 'sweeper',
    type: 'sweeperArm',
    position: v(0, 0, 0),
    params: {
      armLength: 12,
      armCount: 1,
      armHeight: 0.45,
      baseSpeed: 0.55,
      maxSpeed: 1.1,
      accel: 0.004,
      postRadius: 0.75,
      postHeight: 1.2,
      knockSpeed: 6,
      knockLift: 5,
    },
  },
];

export default defineRound({
  id: 'sunbeam-squabble',
  name: 'Sunbeam Squabble',
  type: 'hunt',
  theme: 'sunset',
  objective: 'Soak up 10 sunshine points!',
  tips: [
    'Crowded beams share their sunshine. Find an empty one!',
    'Shove rivals out of your beam.',
    'Hop the sweeper arm or it will push you out of the light.',
  ],
  rulesCard: [
    { icon: '☀️', text: 'Stand in a sunbeam to score' },
    { icon: '👥', text: 'Crowded beams share their points' },
    { icon: '✅', text: 'First to 10 points qualify' },
  ],
  players: { min: 2, max: 100, ideal: 60 },
  qualification: { mode: 'scoreTarget', ratio: 0.55, scoreGoal: 10 },
  duration: { seconds: 120, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-50, -15, -50), max: v(50, 30, 50) },
  // South of the sweeper's reach.
  spawn: { origin: v(0, 0.1, -17.5), yaw: 0, cols: 14, spacing: 1.2 },
  geometry,
  obstacles,
  triggers: [
    {
      id: 'plaza',
      kind: 'checkpoint',
      position: v(0, 1.5, 0),
      size: v(HALF * 2, 5, HALF * 2),
      index: 0,
      respawn: [-12, -6, 0, 6, 12].map((x) => v(x, 0.1, -19)),
      respawnYaw: 0,
    },
  ],
  flyover: {
    path: [v(-36, 20, -36), v(0, 24, -40), v(36, 18, -30), v(0, 14, -30)],
    lookAt: [v(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_sunset_boardwalk',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'respawnCheckpoint',
  botNav: [
    { id: 0, position: v(0, 0, 0), radius: 4, next: [] },
    ...[0, 90, 180, 270].map((deg, i) => ({
      id: 1 + i,
      position: rotPoint(v(0, 0, 9), deg),
      radius: 3,
      next: [] as number[],
    })),
  ],
  variations: [
    { id: 'golden-hour', weight: 4, weather: 'sunset', description: 'As authored.' },
    {
      id: 'solar-flares',
      weight: 2,
      weather: 'sunset',
      description: 'Every beam flares for 4 s every 15 s, worth double while it burns.',
      obstacleParams: { sunbeams: { flareEvery: 15, flareTime: 4, flareMult: 2 } },
    },
    {
      id: 'sea-breeze',
      weight: 1,
      weather: 'windy',
      description: 'Beams drift 60 % faster and the sweeper starts quicker.',
      obstacleParams: { sunbeams: { drift: 0.26 }, sweeper: { baseSpeed: 0.8 } },
    },
    {
      id: 'wide-beams',
      weight: 1,
      weather: 'clear',
      description: 'Fatter beams that are easier to share and harder to defend.',
      obstacleParams: { sunbeams: { radius: 3.4 } },
    },
  ],
  decorSeed: 5301,
  designNotes:
    'scoreTarget rules (goal 10, ratio 0.55): sunbeamZones hands each beam 1 point/s split between its occupants and emits a ' +
    'score event per whole point. Live beams = 1 + floor(entrants / 9) (1 at 2 players, 12 at 100). A full lobby needs 500 ' +
    'points from 12 points/s: ≥ 42 s if every beam is always occupied; the 120 s cap fills the quota by score.',
});
