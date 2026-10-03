/**
 * L1 — Pattern Panic (LEVELS.md §8). A neon game-show memory floor: sixteen
 * 6 m tiles flash symbols, go dark, the Big Screen names the safe symbol and
 * every other tile drops. Rules escalate per board round (teach → memory →
 * two-tile targets → double target → NOT round → low sweeper → seeded twists).
 *
 * The `patternBoard` obstacle owns the tiles, the schedule, the screen and the
 * sweeper; falls are eliminations (logicSurvive), and the round ends once the
 * survivors reach the 60 % quota or the 150 s hard cap.
 */
import { defineRound } from '@tumble/shared';
import { crowdStand, rotPoint, v } from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];

const PITCH = 7;
const tileCentre = (i: number) => v(((i % 4) - 1.5) * PITCH, 0, (Math.floor(i / 4) - 1.5) * PITCH);

function studio(): Piece[] {
  const out: Piece[] = [
    // b.2 the Big Screen housing (the board's visual draws the live screen face on its front).
    { shape: 'box', position: v(0, 12, 22), size: v(24, 12, 1), color: 'neutral', bevel: 0.3, decorative: true },
    { shape: 'box', position: v(-9, 3, 22.4), size: v(1.2, 6, 1.2), color: 'neutral', decorative: true },
    { shape: 'box', position: v(9, 3, 22.4), size: v(1.2, 6, 1.2), color: 'neutral', decorative: true },
    { shape: 'box', position: v(0, 18.4, 22), size: v(25, 0.4, 1.4), color: 'accent', decorative: true },
    { shape: 'box', position: v(0, 5.6, 22), size: v(25, 0.4, 1.4), color: 'accent', decorative: true },
    // b.4 neon ring under the board.
    { shape: 'torus', position: v(0, -6, 0), size: v(30, 1, 0), color: 'accent', decorative: true },
    { shape: 'torus', position: v(0, -9, 0), size: v(22, 0.6, 0), color: 'secondary', decorative: true },
    // Host podium island in front of the screen.
    { shape: 'cylinder', position: v(0, -1, 18), size: v(3, 2, 0), color: 'primary', decorative: true },
    // Confetti cannons either side of the screen.
    { shape: 'cylinder', position: v(-14.5, 4, 21), size: v(1, 2.2, 0), rotation: { pitch: -35 }, color: 'secondary', decorative: true, pattern: 'stripes' },
    { shape: 'cylinder', position: v(14.5, 4, 21), size: v(1, 2.2, 0), rotation: { pitch: -35 }, color: 'secondary', decorative: true, pattern: 'stripes' },
    { shape: 'cylinder', position: v(-14.5, 1.5, 21.6), size: v(1.6, 3, 0), color: 'neutral', decorative: true },
    { shape: 'cylinder', position: v(14.5, 1.5, 21.6), size: v(1.6, 3, 0), color: 'neutral', decorative: true },
  ];
  // Tiered neon audience stands behind and beside the board.
  const crowd = ['#ff3df2', '#00e5ff', '#2bffb8', '#ffd23f', '#cfd3ff', '#ff7a1a'];
  for (const [x, z, yaw, w] of [
    [-24, 4, 90, 26],
    [24, 4, -90, 26],
    [0, -26, 0, 30],
  ] as const) {
    out.push({ shape: 'box', position: v(x, -0.6, z), size: yaw === 0 ? v(w + 2, 1.2, 6) : v(6, 1.2, w + 2), color: 'primary', decorative: true });
    out.push(...crowdStand(v(x, 0, z), yaw, w, 4, crowd, Math.abs(x) + 3));
  }
  // Laser-fan pylons at the four corners (decor lasers are accent/neutral, never danger).
  for (let k = 0; k < 4; k++) {
    const p = rotPoint(v(0, 0, 21), 45 + k * 90);
    out.push(
      { shape: 'cylinder', position: v(p.x, -2, p.z), size: v(1.2, 8, 0), color: 'neutral', decorative: true, pattern: 'stripes' },
      { shape: 'sphere', position: v(p.x, 2.4, p.z), size: v(0.9, 0, 0), color: 'accent', decorative: true },
    );
  }
  return out;
}

export default defineRound({
  id: 'pattern-panic',
  name: 'Pattern Panic',
  type: 'logic',
  theme: 'neon',
  objective: 'Remember the symbols. Stand on the right one!',
  tips: [
    "Watch the tiles while they're lit — they go dark fast.",
    'The big screen shows the symbol you need. Get on it before the timer ends!',
    'Later rounds have tricks: two targets, and "NOT" rounds.',
  ],
  players: { min: 6, max: 40, ideal: 24 },
  qualification: { mode: 'logicSurvive', ratio: 0.6 },
  duration: { seconds: 150, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v(-30, -15, -30), max: v(30, 40, 30) },
  spawn: { origin: v(0, 0.1, -10.5), yaw: 0, cols: 8, spacing: 1.4 },
  geometry: studio(),
  obstacles: [
    {
      id: 'board',
      type: 'patternBoard',
      position: v(0, 0, 0),
      params: {
        cols: 4,
        rows: 4,
        tileSize: 6,
        gap: 1,
        thickness: 0.8,
        startTime: 0.5,
        shakeTime: 0.6,
        downTime: 1.9,
        riseTime: 0.6,
        fallDepth: 12,
        sweeperFrom: 7,
        sweeperLength: 14.5,
        sweeperHeight: 0.55,
        sweeperRadius: 0.3,
        sweeperSpeed: 1.6,
        hubRadius: 0.6,
        hubHeight: 0.9,
        screen: { x: 0, y: 12, z: 21.4, width: 22, height: 10.5 },
      },
    },
  ],
  triggers: [],
  flyover: {
    path: [v(0, 30, -30), v(0, 34, 0), v(0, 16, -4)],
    lookAt: [v(0, 0, 0), v(0, 0, 0), v(0, 12, 22)],
    duration: 4,
  },
  cameraMode: 'topDownTilt',
  music: 'mus_logic_ticktock',
  speedScaleByStage: [1, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  // Tile centres (ids = tile index), fully connected: logic bots read the board's safe spot; this is their map.
  botNav: Array.from({ length: 16 }, (_, i) => ({
    id: i,
    position: tileCentre(i),
    radius: 2.5,
    next: Array.from({ length: 16 }, (_, j) => j).filter((j) => j !== i),
  })),
  variations: [
    { id: 'classic-show', weight: 4, weather: 'night', description: 'As authored.' },
    { id: 'speed-round', weight: 2, weather: 'night', description: 'Starts at board round 3 timings.', obstacleParams: { board: { startRound: 3 } } },
    {
      id: 'shifting-floor',
      weight: 1,
      weather: 'night',
      description: 'From board round 6 the whole board slides one column during HIDE — remember the shift.',
      obstacleParams: { board: { shiftFrom: 6 } },
    },
    {
      id: 'memory-marathon',
      weight: 1,
      weather: 'night',
      description: 'Two-second looks from round 2 on, with a little longer to decide.',
      obstacleParams: { board: { showFlat: 2 } },
    },
  ],
  decorSeed: 5101,
  designNotes:
    'patternBoard replaces LEVELS’ fallingTiles + sweeperArm pair (schema wish §11 #7): seeded layouts (no identical neighbours ' +
    'from round 2, targets never all in one line from round 4, NOT targets touch a centre tile), SHOW/HIDE/DECIDE/DROP timings ' +
    '÷ speedScale with floors (SHOW ≥ 1.5 s, DECIDE ≥ 3 s), wrong tiles shake 0.6 s then drop for 1.9 s, a drop that would ' +
    'leave nobody on a safe tile is voided. Sweeper bar lowers only during DECIDE from board round 7. Bots get a correct tile ' +
    'from botSafeSpot and apply their own skill-based memory. Quota end (survive rules) = LEVELS’ 40 % cut.',
});
