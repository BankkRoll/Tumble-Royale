/**
 * F5 — Throne Rush. A round throne room floating above the clouds. The court
 * band plays while everyone mills about the floor; when it stops, throne spots
 * glow and thrones rise, one fewer than... well, a quarter fewer than the
 * Tumblers left (always at least one short). Grab a throne: first to sit owns
 * it and bounces anyone else off. Then the floor opens, and everyone without
 * a seat falls. Repeat until one Tumbler is left on the last throne.
 *
 * Layout: a 13 m floor disc with sixteen throne spots on two rings, ringed by
 * decorative columns and banners off the floor. Falls are eliminations
 * (lastStanding). At the buzzer (after 30 s of overtime) the highest Tumbler,
 * which means a seated one, wins.
 */
import { defineRound } from '@tumble/shared';
import { rotPoint, v } from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];

const FLOOR = 13;

function hall(): Piece[] {
  const out: Piece[] = [
    // Gilded rim around the floor and the castle keep it hangs from.
    {
      shape: 'torus',
      position: v(0, -0.4, 0),
      size: v(FLOOR + 0.2, 0.45, 0),
      color: 'secondary',
      decorative: true,
    },
    { shape: 'cylinder', position: v(0, -6, 0), size: v(9, 8, 0), color: 'neutral', decorative: true },
    { shape: 'cylinder', position: v(0, -11, 0), size: v(5, 4, 0), color: 'primary', decorative: true },
    // The empty royal dais behind the floor, with the Crown on a cushion (out of reach).
    { shape: 'box', position: v(0, 1, FLOOR + 6), size: v(8, 2, 4), color: 'primary', decorative: true },
    { shape: 'box', position: v(0, 4.5, FLOOR + 7.4), size: v(5, 5, 0.8), color: 'accent', decorative: true },
    {
      shape: 'cylinder',
      position: v(0, 2.3, FLOOR + 5.6),
      size: v(0.9, 0.5, 0),
      color: '#c0392b',
      decorative: true,
    },
    {
      shape: 'torus',
      position: v(0, 3, FLOOR + 5.6),
      size: v(0.55, 0.16, 0),
      color: '#ffd23f',
      decorative: true,
    },
  ];
  // Columns and banners around the hall, off the floor.
  for (let k = 0; k < 12; k++) {
    const p = rotPoint(v(0, 0, FLOOR + 4.5), k * 30 + 15);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, 3, p.z),
        size: v(0.8, 10, 0),
        color: 'neutral',
        decorative: true,
        pattern: 'stripes',
      },
      { shape: 'sphere', position: v(p.x, 8.4, p.z), size: v(1, 0, 0), color: 'secondary', decorative: true },
    );
    if (k % 2 === 0) {
      const b = rotPoint(v(0, 0, FLOOR + 3.6), k * 30 + 15);
      out.push({
        shape: 'box',
        position: v(b.x, 5.2, b.z),
        size: v(1.6, 3.4, 0.12),
        rotation: { yaw: k * 30 + 15 },
        color: k % 4 === 0 ? 'accent' : 'primary',
        decorative: true,
        pattern: 'chevron',
      });
    }
  }
  // Chandeliers high above the floor.
  for (let k = 0; k < 3; k++) {
    const p = rotPoint(v(0, 0, 7), k * 120);
    out.push(
      {
        shape: 'torus',
        position: v(p.x, 14, p.z),
        size: v(1.6, 0.18, 0),
        color: 'secondary',
        decorative: true,
      },
      {
        shape: 'sphere',
        position: v(p.x, 14.3, p.z),
        size: v(0.5, 0, 0),
        color: '#fff3c4',
        decorative: true,
      },
    );
  }
  return out;
}

const obstacles: Obstacle[] = [
  {
    id: 'thrones',
    type: 'throneFloor',
    position: v(0, 0, 0),
    params: { radius: FLOOR },
  },
];

export default defineRound({
  id: 'throne-rush',
  name: 'Throne Rush',
  type: 'final',
  theme: 'castle',
  objective: 'Grab a throne before the floor opens!',
  tips: [
    'When the music stops, the throne spots glow. Run!',
    'First to sit owns the throne. Everyone else bounces off.',
    'Dive into a sitting rival to knock them off their throne.',
  ],
  rulesCard: [
    { icon: '🎵', text: 'When the music stops, thrones rise' },
    { icon: '🪑', text: 'One Tumbler per throne' },
    { icon: '⬇️', text: 'No throne? The floor opens!' },
    { icon: '👑', text: 'Last one seated wins the Crown' },
  ],
  players: { min: 1, max: 15, ideal: 8 },
  qualification: { mode: 'lastStanding', ratio: 0.5 },
  duration: { seconds: 150, overtimeSeconds: 30 },
  killY: -8,
  bounds: { min: v(-35, -20, -35), max: v(35, 30, 35) },
  spawn: { origin: v(0, 0.1, 0), yaw: 0, cols: 5, spacing: 1.6 },
  geometry: hall(),
  obstacles,
  triggers: [],
  flyover: {
    path: [v(-22, 16, -26), v(0, 22, -24), v(22, 14, -18), v(0, 11, -20)],
    lookAt: [v(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_final_crownfever',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  // Wander anchors for bots while the floor is plain (their roaming centre is the middle).
  botNav: [
    { id: 0, position: v(0, 0, 0), radius: 3, next: [] },
    ...[0, 90, 180, 270].map((deg, i) => ({
      id: 1 + i,
      position: rotPoint(v(0, 0, 6.5), deg),
      radius: 2.5,
      next: [] as number[],
    })),
  ],
  variations: [
    { id: 'royal-court', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'quickstep',
      weight: 2,
      weather: 'sunset',
      description: 'Shorter dances and less time to scramble for a seat.',
      obstacleParams: { thrones: { roamMin: 2, roamMax: 4, scramble: 2.4, minScramble: 1.6 } },
    },
    {
      id: 'harsh-court',
      weight: 1,
      weather: 'night',
      description: 'A third of the court goes without a throne every round.',
      obstacleParams: { thrones: { cut: 0.34 } },
    },
    {
      id: 'royal-guards',
      weight: 1,
      weather: 'clear',
      description: 'Two bumper guards patrol between the throne rings.',
      addObstacles: [0, Math.PI].map((phase, i) => ({
        id: `guard-${i + 1}`,
        type: 'bumperPillar',
        position: v(0, 0, 0),
        params: { radius: 0.8, height: 2.4, orbitRadius: 6.75, orbitSpeed: 0.5, phase, bounceSpeed: 8 },
      })),
    },
  ],
  decorSeed: 5601,
  designNotes:
    'throneFloor: cycles of roam (3–5.5 s seeded ÷ stage speed, ≥ 2 s) → 0.9 s glowing spots → thrones rise 0.45 s → scramble ' +
    '3 s (−0.1 s per cycle, ≥ 2 s) → shake 0.7 s → floor open 1.8 s → restore 0.8 s. Seats = standing − max(1, ⌊standing × 0.25⌋): ' +
    '15 → 12 → 9 → 7 → 6 → 5 → 4 → 3 → 2 → 1 in ~11 s cycles (~100 s with no other falls). A cycle with no throne held is voided. ' +
    'lastStanding rules: the same-step tiebreak and the overtime height tiebreak always crown exactly one.',
});
