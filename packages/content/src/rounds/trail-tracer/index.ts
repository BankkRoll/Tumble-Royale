/**
 * L3 — Trail Tracer. A frozen signpost square: a 5 × 5 floor of ice tiles,
 * each with a painted arrow, a few of them flying a start flag. The scoreboard
 * says how many steps to walk ("FOLLOW 3 STEPS"); trace the arrows from any
 * flag, step by step, and stand where the trail ends. Every other tile drops
 * into the frozen lake.
 *
 * Rules escalate per board round: a two-step teaching trail that lights up
 * near the end, then longer trails, fewer flags, shorter timers, and from
 * round 4 arrows that frost over part-way through: trace fast or remember.
 * Falls are eliminations (logicSurvive); the round ends once survivors reach
 * the 60 % quota or at the 150 s cap.
 */
import { defineRound } from '@tumble/shared';
import { crowdStand, rotPoint, v } from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];

const COLS = 5;
const TILE = 5;
const GAP = 0.8;
const PITCH = TILE + GAP;
const tileCentre = (i: number) =>
  v(((i % COLS) - (COLS - 1) / 2) * PITCH, 0, (Math.floor(i / COLS) - (COLS - 1) / 2) * PITCH);

function pine(x: number, z: number, h: number): Piece[] {
  return [
    {
      shape: 'cylinder',
      position: v(x, h * 0.15, z),
      size: v(0.35, h * 0.3, 0),
      color: '#8a6a4a',
      decorative: true,
    },
    {
      shape: 'cylinder',
      position: v(x, h * 0.45, z),
      size: v(h * 0.28, h * 0.32, 0),
      color: '#3f9a6a',
      decorative: true,
    },
    {
      shape: 'cylinder',
      position: v(x, h * 0.72, z),
      size: v(h * 0.18, h * 0.28, 0),
      color: '#4fb27a',
      decorative: true,
    },
    {
      shape: 'sphere',
      position: v(x, h * 0.92, z),
      size: v(h * 0.08, 0, 0),
      color: '#ffffff',
      decorative: true,
    },
  ];
}

function square(): Piece[] {
  const out: Piece[] = [
    // Scoreboard on two log posts behind the floor.
    {
      shape: 'box',
      position: v(0, 11, 22),
      size: v(24, 11.5, 1),
      color: '#2d4a6b',
      bevel: 0.3,
      decorative: true,
    },
    { shape: 'box', position: v(0, 17.1, 22), size: v(25, 0.6, 1.6), color: 'secondary', decorative: true },
    {
      shape: 'cylinder',
      position: v(-11, 2.5, 22.4),
      size: v(0.7, 5, 0),
      color: '#8a6a4a',
      decorative: true,
    },
    { shape: 'cylinder', position: v(11, 2.5, 22.4), size: v(0.7, 5, 0), color: '#8a6a4a', decorative: true },
    // The frozen lake far below and snow banks around it.
    { shape: 'cylinder', position: v(0, -12, 0), size: v(34, 0.6, 0), color: '#bfe6ff', decorative: true },
    { shape: 'torus', position: v(0, -11.6, 0), size: v(34, 2.4, 0), color: 'secondary', decorative: true },
  ];
  // Signposts at the four corners of the floor (just off it), pointing every which way.
  for (let k = 0; k < 4; k++) {
    const p = rotPoint(v(0, 0, 21), 45 + k * 90);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, 1.5, p.z),
        size: v(0.25, 7, 0),
        color: '#8a6a4a',
        decorative: true,
      },
      {
        shape: 'box',
        position: v(p.x, 3.8, p.z),
        size: v(2.6, 0.6, 0.15),
        rotation: { yaw: k * 70 },
        color: 'accent',
        decorative: true,
      },
      {
        shape: 'box',
        position: v(p.x, 2.9, p.z),
        size: v(2.2, 0.55, 0.15),
        rotation: { yaw: k * 70 + 110 },
        color: 'primary',
        decorative: true,
      },
    );
  }
  // Pines on snowy ledges either side.
  for (const side of [-1, 1]) {
    out.push({
      shape: 'box',
      position: v(side * 27, -1.5, 2),
      size: v(6, 3, 30),
      color: 'secondary',
      decorative: true,
    });
    for (let k = 0; k < 4; k++) out.push(...pine(side * (26 + (k % 2) * 2), -10 + k * 7, 6 + (k % 3)));
  }
  // Bundled-up spectators on the back bank.
  const crowd = ['#9fd8ff', '#ffffff', '#b28dff', '#ff8fab', '#ffd36e'];
  out.push({
    shape: 'box',
    position: v(0, -0.6, -27),
    size: v(30, 1.2, 6),
    color: 'neutral',
    decorative: true,
  });
  out.push(...crowdStand(v(0, 0, -27), 0, 28, 4, crowd, 9));
  return out;
}

export default defineRound({
  id: 'trail-tracer',
  name: 'Trail Tracer',
  type: 'logic',
  theme: 'frosty',
  objective: 'Follow the arrows. Stand where they end!',
  tips: [
    'Start on a flag and step one tile the way each arrow points.',
    'The scoreboard says how many steps. Count carefully!',
    'From round 4 the arrows frost over. Trace them fast!',
  ],
  rulesCard: [
    { icon: '🚩', text: 'Start on a flag' },
    { icon: '➡️', text: 'Follow the arrows, step by step' },
    { icon: '⬇️', text: 'Only the trail ends stay up' },
  ],
  players: { min: 2, max: 100, ideal: 60 },
  qualification: { mode: 'logicSurvive', ratio: 0.6 },
  duration: { seconds: 150, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-35, -20, -35), max: v(35, 40, 35) },
  spawn: { origin: v(0, 0.1, -2), yaw: 0, cols: 12, spacing: 1.25 },
  geometry: square(),
  obstacles: [
    {
      id: 'floor',
      type: 'puzzleFloor',
      position: v(0, 0, 0),
      params: {
        puzzle: 'trail',
        cols: COLS,
        rows: COLS,
        tileSize: TILE,
        gap: GAP,
        memoryFrom: 4,
        playersPerSafeTile: 20,
        screen: { x: 0, y: 11, z: 21.4, width: 22, height: 10 },
      },
    },
  ],
  triggers: [],
  flyover: {
    path: [v(-26, 26, -28), v(0, 34, -4), v(0, 17, -6)],
    lookAt: [v(0, 0, 0), v(0, 0, 0), v(0, 11, 22)],
    duration: 4,
  },
  cameraMode: 'topDownTilt',
  music: 'mus_logic_ticktock',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  // Tile centres (ids = tile index), fully connected: logic bots read the floor's safe spot; this is their map.
  botNav: Array.from({ length: COLS * COLS }, (_, i) => ({
    id: i,
    position: tileCentre(i),
    radius: 2,
    next: Array.from({ length: COLS * COLS }, (_, j) => j).filter((j) => j !== i),
  })),
  variations: [
    { id: 'fresh-snow', weight: 4, weather: 'snow', description: 'As authored.' },
    {
      id: 'long-trails',
      weight: 2,
      weather: 'snow',
      description: 'Starts at board round 4: four-step trails that frost over.',
      obstacleParams: { floor: { startRound: 4 } },
    },
    {
      id: 'whiteout',
      weight: 1,
      weather: 'stormy',
      description: 'Arrows frost over from round 2 and stay readable for less of each question.',
      obstacleParams: { floor: { memoryFrom: 2, memoryShown: 0.45 } },
    },
    {
      id: 'clear-skies',
      weight: 1,
      weather: 'clear',
      description: 'A fifth more time to trace every trail.',
      obstacleParams: { floor: { thinkScale: 1.2 } },
    },
  ],
  decorSeed: 5501,
  designNotes:
    'puzzleFloor (trail): seeded walks of 2 → 6 arrows from 3 (later 2) flag tiles to distinct landing tiles; walks may share ' +
    'arrows but never cross another walk’s flag or landing, and never revisit a tile; unused tiles get decoy arrows. Reading ' +
    'time 8 s → 5 s ÷ stage speed (floor 3.5 s). Big fields walk more trails in the first three board rounds (one per 20 ' +
    'entrants, up to 6) so a full field fits on the landings. Voids, bot solving and the quota end as in Colour Cauldron.',
});
