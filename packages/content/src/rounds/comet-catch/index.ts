/**
 * H2 — Comet Catch. A round orbital deck where comets streak in, land on a
 * glowing ring, rest for a few seconds and hop away again. Touch a resting
 * comet to catch it; the first Tumblers to catch five qualify.
 *
 * Layout: a 19 m deck with four raised crater mounds (ramps facing the
 * middle) and four bobbing bumper buoys between them. Comets land on rings
 * across the deck and on the mounds, so the crowd keeps spreading out. The
 * comet count grows with the lobby (a duel fights over a handful, a full
 * lobby chases dozens); falls respawn near the middle.
 */
import { defineRound } from '@tumble/shared';
import { crowdStand, rotPoint, v } from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];

const DECK = 19;
const MOUND_R = 3.6;
const MOUND_TOP = 1;
const MOUND_AT = 13;
const BUOY_AT = 7.5;
const MOUNDS = [45, 135, 225, 315].map((deg) => rotPoint(v(0, 0, MOUND_AT), deg));
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Each mound's ramp sits beside it along the ring (clear of the spawn grid in
 * the middle), climbing clockwise onto it.
 */
const RAMPS = MOUNDS.map((m) => {
  const around = Math.atan2(m.x, m.z) - Math.PI / 2;
  const along = { x: Math.sin(around), z: Math.cos(around) };
  return {
    at: v(r2(m.x + along.x * (MOUND_R + 1.4)), MOUND_TOP / 2, r2(m.z + along.z * (MOUND_R + 1.4))),
    yaw: r2((Math.atan2(-along.x, -along.z) * 180) / Math.PI),
  };
});

/** Floor height at a deck point: the mound top inside a mound, else the deck. */
function floorAt(x: number, z: number): number {
  for (const m of MOUNDS) if (Math.hypot(x - m.x, z - m.z) <= MOUND_R - 0.6) return MOUND_TOP;
  return 0;
}

/** Comet landing spots: four rings plus each mound top, lifted onto mounds where they fall on one. */
function spots(): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const ring = (r: number, n: number, offset: number): void => {
    for (let k = 0; k < n; k++) {
      const a = ((k + offset) / n) * Math.PI * 2;
      const x = r2(Math.sin(a) * r);
      const z = r2(Math.cos(a) * r);
      // A comet on a mound's rim or a ramp would hover half inside it.
      const awkward =
        MOUNDS.some((m) => {
          const d = Math.hypot(x - m.x, z - m.z);
          return d > MOUND_R - 0.6 && d < MOUND_R + 0.9;
        }) || RAMPS.some((r) => Math.hypot(x - r.at.x, z - r.at.z) < 2.6);
      if (!awkward) out.push(v(x, floorAt(x, z), z));
    }
  };
  ring(4.5, 6, 0);
  ring(9, 8, 0.5);
  ring(12.5, 12, 0.25);
  ring(16, 14, 0);
  for (const m of MOUNDS) out.push(v(r2(m.x), MOUND_TOP, r2(m.z)));
  return out;
}

function decor(): Piece[] {
  const out: Piece[] = [];
  // Glowing rim around the deck and beacon posts on it (outside the walkable disc).
  out.push({
    shape: 'torus',
    position: v(0, -0.15, 0),
    size: v(DECK + 0.3, 0.35, 0),
    color: 'secondary',
    decorative: true,
  });
  for (let k = 0; k < 8; k++) {
    const p = rotPoint(v(0, 0, DECK + 2.2), k * 45 + 22.5);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, -3, p.z),
        size: v(0.35, 8, 0),
        color: 'neutral',
        decorative: true,
      },
      { shape: 'sphere', position: v(p.x, 1.4, p.z), size: v(0.6, 0, 0), color: 'accent', decorative: true },
    );
  }
  // Underside: a stack of shrinking discs so the deck reads as a floating station.
  out.push(
    { shape: 'cylinder', position: v(0, -2, 0), size: v(15, 2, 0), color: 'neutral', decorative: true },
    { shape: 'cylinder', position: v(0, -4.2, 0), size: v(9, 2.4, 0), color: 'primary', decorative: true },
    {
      shape: 'cylinder',
      position: v(0, -6.6, 0),
      size: v(3.5, 2.4, 0),
      color: 'secondary',
      decorative: true,
    },
  );
  // Distant planets and a ringed giant (well clear of the deck and the flyover).
  out.push(
    { shape: 'sphere', position: v(-58, 22, 64), size: v(11, 0, 0), color: '#ff9be0', decorative: true },
    { shape: 'torus', position: v(-58, 22, 64), size: v(17, 0.8, 0), color: '#ffd36e', decorative: true },
    { shape: 'sphere', position: v(66, 14, -40), size: v(6, 0, 0), color: '#4fd6ff', decorative: true },
    { shape: 'sphere', position: v(40, 30, 70), size: v(3.5, 0, 0), color: '#dcd8ff', decorative: true },
  );
  // Two small viewing galleries of astronaut fans facing the deck.
  const crowd = ['#ff9be0', '#4fd6ff', '#ffd36e', '#dcd8ff', '#8a7bff'];
  for (const [deg, seed] of [
    [180, 3],
    [90, 7],
  ] as const) {
    const at = rotPoint(v(0, -0.6, DECK + 7), deg);
    out.push({
      shape: 'box',
      position: v(at.x, -1.2, at.z),
      size: deg === 180 ? v(16, 1.2, 7) : v(7, 1.2, 16),
      color: 'neutral',
      decorative: true,
    });
    out.push(...crowdStand(at, deg + 180, 14, 3, crowd, seed));
  }
  return out;
}

const geometry: Piece[] = [
  { shape: 'cylinder', position: v(0, -0.5, 0), size: v(DECK, 1, 0), color: 'primary', pattern: 'dots' },
  // Landing rings painted on the deck (decal-thin, decorative).
  { shape: 'torus', position: v(0, 0.02, 0), size: v(9, 0.12, 0), color: 'accent', decorative: true },
  { shape: 'torus', position: v(0, 0.02, 0), size: v(16, 0.12, 0), color: 'accent', decorative: true },
  ...MOUNDS.flatMap((m, i): Piece[] => {
    const ramp = RAMPS[i]!;
    return [
      {
        shape: 'cylinder',
        position: v(r2(m.x), MOUND_TOP / 2, r2(m.z)),
        size: v(MOUND_R, MOUND_TOP, 0),
        color: 'secondary',
        pattern: 'stripes',
      },
      {
        shape: 'ramp',
        position: ramp.at,
        size: v(3, MOUND_TOP, 3),
        rotation: { yaw: ramp.yaw },
        color: 'secondary',
        pattern: 'chevron',
      },
    ];
  }),
  ...decor(),
];

const obstacles: Obstacle[] = [
  {
    id: 'comets',
    type: 'cometField',
    position: v(0, 0, 0),
    params: {
      spots: spots(),
      slots: 40,
      base: 2,
      perPlayer: 0.3,
      hop: 6,
      flight: 1.2,
    },
  },
  // Bobbing bumper buoys on the four axes, between the mounds: comet races get bounced.
  ...[0, 90, 180, 270].map((deg, i): Obstacle => ({
    id: `buoy-${i + 1}`,
    type: 'bumperPillar',
    position: rotPoint(v(0, 0, BUOY_AT), deg),
    params: { radius: 0.9, height: 2.2, bounceSpeed: 9, bobAmplitude: 0.3, bobPeriod: 2.4 + i * 0.3 },
  })),
];

export default defineRound({
  id: 'comet-catch',
  name: 'Comet Catch',
  type: 'hunt',
  theme: 'space',
  objective: 'Catch 5 comets to qualify!',
  tips: [
    'A glowing ring shows where a comet is about to land.',
    'Comets only wait a few seconds before hopping away.',
    'The mounds catch comets too: use the ramps.',
  ],
  rulesCard: [
    { icon: '☄️', text: 'Comets land, then hop away' },
    { icon: '✋', text: 'Touch a resting comet to catch it' },
    { icon: '✅', text: 'First to catch 5 qualify' },
  ],
  players: { min: 2, max: 100, ideal: 60 },
  qualification: { mode: 'scoreTarget', ratio: 0.55, scoreGoal: 5 },
  duration: { seconds: 120, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-45, -20, -45), max: v(45, 30, 45) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 10, spacing: 1.25 },
  geometry,
  obstacles,
  triggers: [
    {
      id: 'deck',
      kind: 'checkpoint',
      position: v(0, 1.5, 0),
      size: v(36, 5, 36),
      index: 0,
      respawn: [0, 60, 120, 180, 240, 300].map((deg) => {
        const p = rotPoint(v(0, 0, 2.6), deg);
        return v(p.x, 0.1, p.z);
      }),
      respawnYaw: 0,
    },
  ],
  flyover: {
    path: [v(-30, 18, -34), v(0, 26, -30), v(28, 16, -20), v(0, 12, -24)],
    lookAt: [v(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_space_orbitparty',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'respawnCheckpoint',
  // Roaming anchors for bots between comets (their wander centre is the centroid: the middle).
  botNav: [
    { id: 0, position: v(0, 0, 0), radius: 3, next: [] },
    ...MOUNDS.map((m, i) => ({ id: 1 + i, position: v(r2(m.x), MOUND_TOP, r2(m.z)), radius: 2, next: [] })),
  ],
  variations: [
    { id: 'clear-orbit', weight: 4, weather: 'night', description: 'As authored.' },
    {
      id: 'golden-comets',
      weight: 2,
      weather: 'night',
      description: 'Four golden comets worth two catches each.',
      obstacleParams: { comets: { bonusSlots: 4, bonusPoints: 2 } },
    },
    {
      id: 'restless-comets',
      weight: 1,
      weather: 'clear',
      description: 'Comets hop every 4.5 s and land faster.',
      obstacleParams: { comets: { hop: 4.5, flight: 0.9 } },
    },
    {
      id: 'pinball-buoys',
      weight: 1,
      weather: 'night',
      description: 'The bumper buoys kick half as hard again and bob higher.',
      obstacleParams: Object.fromEntries(
        [1, 2, 3, 4].map((i) => [`buoy-${i}`, { bounceSpeed: 13.5, bounceLift: 5, bobAmplitude: 0.6 }]),
      ),
    },
  ],
  decorSeed: 5201,
  designNotes:
    'scoreTarget rules (goal 5, ratio 0.55): cometField emits score events (team -1) on catches. Live comets = 2 + ceil(0.3 × entrants) ' +
    '(3 at 2 players, 32 at 100) over 40+ spots; each hops every 6 s ÷ stage speed, 1.2 s of it in flight. A full lobby needs ' +
    '~250 catches: ≥ 45 s at perfect efficiency, so the 120 s cap is a backstop, where the best scores fill the quota.',
});
