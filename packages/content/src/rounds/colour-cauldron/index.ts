/**
 * L2 — Colour Cauldron. A bubbling witch's kitchen: a 5 × 5 floor of paint
 * tiles hangs over a cauldron of goo. The big screen calls out a colour sum
 * ("RED + BLUE") or a difference ("PURPLE − RED"); stand on the colour it
 * makes before the timer runs out, because every other tile drops into the
 * goo. Primaries carry a shape (red ●, yellow ▲, blue ■) and mixes carry both
 * parents' shapes, so every sum can be solved without telling colours apart.
 *
 * Rules escalate per board round: a teaching sum (the answer glows near the
 * end), sums, differences, fewer answer tiles, shorter timers, and from round
 * 4 a floor that fades to grey part-way through: remember where the colours
 * were. Falls are eliminations (logicSurvive); the round ends once survivors
 * reach the 60 % quota or at the 150 s cap.
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

function kitchen(): Piece[] {
  const out: Piece[] = [
    // The screen housing: a giant recipe board on two ladle posts behind the floor.
    {
      shape: 'box',
      position: v(0, 11, 22),
      size: v(24, 11.5, 1),
      color: '#5b3a8c',
      bevel: 0.3,
      decorative: true,
    },
    { shape: 'box', position: v(0, 17, 22), size: v(25, 0.5, 1.4), color: 'secondary', decorative: true },
    { shape: 'box', position: v(0, 5, 22), size: v(25, 0.5, 1.4), color: 'secondary', decorative: true },
    {
      shape: 'cylinder',
      position: v(-11, 2.5, 22.4),
      size: v(0.6, 5, 0),
      color: 'neutral',
      decorative: true,
    },
    { shape: 'cylinder', position: v(11, 2.5, 22.4), size: v(0.6, 5, 0), color: 'neutral', decorative: true },
    // The cauldron below the floor: rim, belly and bubbling goo.
    { shape: 'torus', position: v(0, -7, 0), size: v(20, 1.4, 0), color: '#3a3248', decorative: true },
    { shape: 'cylinder', position: v(0, -12, 0), size: v(19, 9, 0), color: '#3a3248', decorative: true },
    {
      shape: 'cylinder',
      position: v(0, -8.2, 0),
      size: v(18.6, 0.6, 0),
      color: 'secondary',
      decorative: true,
    },
  ];
  for (let k = 0; k < 7; k++) {
    const p = rotPoint(v(0, 0, 6 + (k % 3) * 4), k * 51);
    out.push({
      shape: 'sphere',
      position: v(p.x, -7.7, p.z),
      size: v(1 + (k % 3) * 0.4, 0, 0),
      color: 'secondary',
      decorative: true,
    });
  }
  // Paint pots on shelves either side, and spoon pylons at the corners.
  const pots = ['#ff3d4f', '#ffd23f', '#2f7bff', '#ff8a1f', '#3fcf5a', '#a259ff'];
  for (const side of [-1, 1]) {
    out.push({
      shape: 'box',
      position: v(side * 25, 1.2, 4),
      size: v(2, 0.4, 22),
      color: '#7a5636',
      decorative: true,
    });
    pots.forEach((c, i) =>
      out.push({
        shape: 'cylinder',
        position: v(side * 25, 2.2, -5 + i * 3.6),
        size: v(0.8, 1.6, 0),
        color: c,
        decorative: true,
      }),
    );
  }
  for (let k = 0; k < 4; k++) {
    const p = rotPoint(v(0, 0, 23), 45 + k * 90);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, 1, p.z),
        size: v(0.5, 9, 0),
        color: 'neutral',
        decorative: true,
        pattern: 'stripes',
      },
      { shape: 'sphere', position: v(p.x, 6, p.z), size: v(1.3, 0, 0), color: 'accent', decorative: true },
    );
  }
  // A crowd of kitchen helpers watching from the back and the sides.
  const crowd = ['#b98cff', '#7cf27c', '#ffb347', '#f1ecff', '#ff7ab8'];
  for (const [x, z, yaw, w] of [
    [-29, 2, 90, 24],
    [29, 2, -90, 24],
    [0, -27, 0, 28],
  ] as const) {
    out.push({
      shape: 'box',
      position: v(x, -0.6, z),
      size: yaw === 0 ? v(w + 2, 1.2, 6) : v(6, 1.2, w + 2),
      color: 'primary',
      decorative: true,
    });
    out.push(...crowdStand(v(x, 0, z), yaw, w, 4, crowd, Math.abs(x) + 5));
  }
  return out;
}

export default defineRound({
  id: 'colour-cauldron',
  name: 'Colour Cauldron',
  type: 'logic',
  theme: 'goo',
  objective: 'Mix the colours. Stand on the answer!',
  tips: [
    'Red + yellow = orange, yellow + blue = green, red + blue = purple.',
    'Mixed tiles show both parent shapes: ● red, ▲ yellow, ■ blue.',
    'From round 4 the floor fades to grey. Remember the colours!',
  ],
  rulesCard: [
    { icon: '🎨', text: 'Read the colour sum on the screen' },
    { icon: '🟪', text: 'Stand on the colour it makes' },
    { icon: '⬇️', text: 'Every other tile drops' },
  ],
  players: { min: 2, max: 100, ideal: 60 },
  qualification: { mode: 'logicSurvive', ratio: 0.6 },
  duration: { seconds: 150, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-35, -20, -35), max: v(35, 40, 35) },
  spawn: { origin: v(0, 0.1, -2), yaw: 0, cols: 12, spacing: 1.25 },
  geometry: kitchen(),
  obstacles: [
    {
      id: 'floor',
      type: 'puzzleFloor',
      position: v(0, 0, 0),
      params: {
        puzzle: 'mix',
        cols: COLS,
        rows: COLS,
        tileSize: TILE,
        gap: GAP,
        memoryFrom: 4,
        screen: { x: 0, y: 11, z: 21.4, width: 22, height: 10 },
      },
    },
  ],
  triggers: [],
  flyover: {
    path: [v(0, 30, -32), v(0, 34, 0), v(0, 17, -6)],
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
    { id: 'house-recipe', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'hot-stove',
      weight: 2,
      weather: 'clear',
      description: 'Starts at board round 3: differences and shorter timers from the first question.',
      obstacleParams: { floor: { startRound: 3 } },
    },
    {
      id: 'fading-paint',
      weight: 1,
      weather: 'night',
      description: 'The floor fades from round 2, and stays readable for less of each question.',
      obstacleParams: { floor: { memoryFrom: 2, memoryShown: 0.45 } },
    },
    {
      id: 'slow-simmer',
      weight: 1,
      weather: 'stormy',
      description: 'A fifth more time to think on every question.',
      obstacleParams: { floor: { thinkScale: 1.2 } },
    },
  ],
  decorSeed: 5401,
  designNotes:
    'puzzleFloor (mix): seeded boards with the answer colour on 5 → 2 tiles (never all in one line), every other colour at ' +
    'least twice, never the same answer twice running. Reading time 9 s → 4.5 s ÷ stage speed (floor 3.5 s), shake 0.8 s, ' +
    'down 1.8 s. A drop that would leave nobody on an answer tile is voided. Bots learn the answer 40 % into reading and ' +
    'apply their own memory. Quota end (survive rules) at 60 %.',
});
