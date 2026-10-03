/**
 * F3 — Spin Cycle Finale (final, neon).
 *
 * Spin Cycle remixed as a neon nightclub final: three bars (low, high and a
 * second low that joins at 40 s), a drum floor that shrinks every 30 s from
 * r 18 to r 5, and a sudden-death spin-up at 165 s. Last Tumbler standing
 * wins; 180 s is a hard cap. Transcribed from docs/design/LEVELS.md §F3.
 *
 * Module mapping notes: see `../spin-cycle/drum.ts`. Bars are one-sided
 * `jumpRopeBeam` arms with linear speed ramps (design schedules) — the
 * design's reversals at 50/75/100/130/140 s are not supported by any module.
 */
import { defineRound, type RoundDefinitionInput } from '@tumble/shared';
import { bar, decorRng, hexCore, ringPanels, ringSeam } from '../spin-cycle/drum.ts';

type Piece = RoundDefinitionInput['geometry'][number];
type Obstacle = NonNullable<RoundDefinitionInput['obstacles']>[number];
type Waypoint = NonNullable<RoundDefinitionInput['botNav']>[number];

const v = (x: number, y: number, z: number) => ({ x, y, z });

const deco = (shape: Piece['shape'], pos: ReturnType<typeof v>, size: ReturnType<typeof v>, color: string, extra: Partial<Piece> = {}): Piece => ({
  shape,
  position: pos,
  size,
  color,
  decorative: true,
  pattern: 'none',
  bevel: 0.15,
  ...extra,
});

/** Final arena radius: the core never drops. */
const CORE = 5;

/** Shrink schedule: ring [rIn, rOut] drops at `dropAt` seconds. */
const RINGS: { prefix: string; rIn: number; rOut: number; count: number; dropAt: number }[] = [
  { prefix: 'ring-a', rIn: 15, rOut: 18, count: 24, dropAt: 30 },
  { prefix: 'ring-b', rIn: 12, rOut: 15, count: 20, dropAt: 60 },
  { prefix: 'ring-c', rIn: 9, rOut: 12, count: 16, dropAt: 90 },
  { prefix: 'ring-d', rIn: 6.5, rOut: 9, count: 12, dropAt: 120 },
  { prefix: 'ring-e', rIn: CORE, rOut: 6.5, count: 10, dropAt: 150 },
];

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const geometry: Piece[] = [
  { shape: 'cylinder', position: v(0, -0.3, 0), size: v(CORE + 0.1, 0.6, CORE + 0.1), color: 'neutral', bevel: 0.2, pattern: 'none' },
  ...hexCore({ radius: CORE - 1.1, tile: 1.4, gap: 0.12, colors: ['primary', 'secondary'], centreRadius: 1.6, centreColor: 'accent' }),
  // Neon porthole rim, glowing suds pool and the agitator column under the drum.
  deco('torus', v(0, 6, 0), v(22, 1.0, 22), 'accent'),
  deco('torus', v(0, 6.9, 0), v(22, 0.25, 22), 'safe'),
  deco('cylinder', v(0, -6, 0), v(20, 0.2, 20), '#2a1a5e'),
  ...[CORE, 6.5, 9, 12, 15].map((r) => ringSeam(r)),
  deco('cylinder', v(0, -3.5, 0), v(3, 6, 3), 'secondary', { pattern: 'stripes' }),
];

// Club dressing: speaker stacks pulsing at the cardinal points, arcade cabinets,
// accent laser fans and a ring of glow-stick crowd stands.
for (let k = 0; k < 4; k++) {
  const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
  const x = Math.sin(a) * 27;
  const z = Math.cos(a) * 27;
  const yaw = (a * 180) / Math.PI + 180;
  geometry.push(
    deco('box', v(x, 4, z), v(4, 8, 3), 'neutral', { rotation: { yaw }, bevel: 0.4 }),
    deco('cylinder', v(x - Math.sin(a) * 1.6, 5.8, z - Math.cos(a) * 1.6), v(1.2, 0.3, 1.2), 'accent', { rotation: { yaw, pitch: 90 } }),
    deco('cylinder', v(x - Math.sin(a) * 1.6, 2.4, z - Math.cos(a) * 1.6), v(1.5, 0.3, 1.5), 'accent', { rotation: { yaw, pitch: 90 } }),
  );
}
const rng = decorRng(9301);
for (let k = 0; k < 8; k++) {
  const a = (k / 8) * Math.PI * 2;
  const x = Math.sin(a) * 34;
  const z = Math.cos(a) * 34;
  geometry.push(
    deco('box', v(x, 5, z), v(9, 3, 4), 'secondary', { rotation: { yaw: (a * 180) / Math.PI }, pattern: 'stripes', bevel: 0.4 }),
    deco('wedge', v(x, 8, z), v(0.15, 6, 0.15), 'accent', { rotation: { yaw: (a * 180) / Math.PI, roll: 20 + rng() * 40 } }),
    deco('wedge', v(x, 8, z), v(0.15, 6, 0.15), 'accent', { rotation: { yaw: (a * 180) / Math.PI, roll: -20 - rng() * 40 } }),
  );
}
for (let k = 0; k < 6; k++) {
  const a = (k / 6) * Math.PI * 2 + 0.3;
  geometry.push(deco('box', v(Math.sin(a) * 40, 9 + rng() * 6, Math.cos(a) * 40), v(2.4, 4, 2), 'primary', { rotation: { yaw: (a * 180) / Math.PI }, pattern: 'dots', bevel: 0.3 }));
}

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

const rings = RINGS.map((r) => ringPanels({ ...r, offset: r.rIn * 0.01 }));

const obstacles: Obstacle[] = [
  ...rings.flat(),
  // Hub shove stays under the 9 m/s stun threshold: a stunned Tumbler slides clean off the drum.
  { id: 'hub', type: 'bumperPillar', position: v(0, 0, 0), params: { radius: 1.4, height: 3.0, bounceSpeed: 8, bounceLift: 3 } },
  {
    id: 'bar-low',
    type: 'jumpRopeBeam',
    position: v(0, 0, 0),
    // Design schedule 1.0 → 2.2 rad/s (steps every 30 s, 2.2 at 165 s).
    params: bar({ reach: 15, kind: 'low', mode: 'arm', direction: 1, startSpeed: 1.0, endSpeed: 2.2, rampUntil: 165, hubRadius: 1.3, knockImpulse: 8 }),
  },
  {
    id: 'bar-high',
    type: 'jumpRopeBeam',
    position: v(0, 0, 0),
    // Design phase 0.5: half a turn from the low bar.
    rotation: { yaw: 180 },
    params: bar({ reach: 15, kind: 'high', mode: 'arm', direction: 1, startSpeed: 0.8, endSpeed: 1.8, rampUntil: 150, hubRadius: 1.3, knockImpulse: 8 }),
  },
  {
    id: 'bar-low-2',
    type: 'jumpRopeBeam',
    position: v(0, 0, 0),
    // Design: joins at 40 s. A resting low beam is unsafe (Tumblers pinned against a still kinematic
    // bar get squeezed out at absurd speed), so it sweeps from the start: 0.5 → 1.2 rad/s by 120 s.
    rotation: { yaw: -90 },
    params: bar({ reach: 15, kind: 'low', mode: 'arm', direction: 1, startSpeed: 0.5, endSpeed: 1.2, rampUntil: 120, hubRadius: 1.3, knockImpulse: 8 }),
  },
];

// -----------------------------------------------------------------------------
// Bot nav: a running ring at r 3.5 (inside the final core) turning with the low
// bar, so bots meet it at low relative speed until the spin-up catches them.
// -----------------------------------------------------------------------------

const RING_N = 8;
const botNav: Waypoint[] = Array.from({ length: RING_N }, (_, k) => {
  const a = (k / RING_N) * Math.PI * 2;
  return { id: k, position: v(Math.sin(a) * 3.5, 0, Math.cos(a) * 3.5), radius: 1.2, next: [(k + 1) % RING_N], action: 'run' as const };
});

export default defineRound({
  id: 'spin-cycle-finale',
  name: 'Spin Cycle Finale',
  type: 'final',
  theme: 'neon',
  objective: 'Jump, dive, survive. Last one spinning wins!',
  tips: ['Three bars now: low, high… and another low.', 'The drum shrinks every 30 seconds.', 'Push rivals into the bars — it’s a final!'],
  players: { min: 1, max: 15, ideal: 8 },
  qualification: { mode: 'lastStanding', ratio: 0.65 },
  duration: { seconds: 180, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-30, -15, -30), max: v(30, 25, 30) },
  spawn: { origin: v(0, 0.1, -8), yaw: 0, cols: 4, spacing: 2.0 },
  geometry,
  obstacles,
  triggers: [],
  flyover: {
    path: [v(25, 18, 0), v(0, 22, 25), v(-25, 18, 0), v(0, 10, -15)],
    lookAt: [v(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_final_crownfever',
  speedScaleByStage: [1.0, 1.0, 1.05, 1.1, 1.15],
  fallBehavior: 'eliminate',
  botNav,
  variations: [
    { id: 'club-night', weight: 4, weather: 'night', description: 'As authored.' },
    { id: 'strobe', weight: 1, weather: 'night', description: 'Bars flash with the beat (visual only; reduced-flash setting disables).' },
    {
      id: 'heavy-final',
      weight: 2,
      weather: 'night',
      description: 'Two high bars: a second one joins at 60 s.',
      addObstacles: [
        {
          id: 'bar-high-2',
          type: 'jumpRopeBeam',
          position: v(0, 0, 0),
          params: bar({ reach: 15, kind: 'high', mode: 'arm', direction: 1, startSpeed: 0.3, endSpeed: 1.8, rampUntil: 150, hubRadius: 1.3, knockImpulse: 8 }),
        },
      ],
    },
  ],
  decorSeed: 9301,
  designNotes: [
    'Arena r 18 → 15 (30 s) → 12 (60 s) → 9 (90 s) → 6.5 (120 s) → 5 (150 s); one-shot movingPlatform panels with a sine sag and painted danger seams (no 1.5 s shake). Sudden death from 165 s (low bar 2.2 rad/s); 180 s hard cap (ties: highest y, then fewest hits — round rule).',
    'Bars: low 1.0→2.2 rad/s, high (underside 2.3 m: stay low, never jump into it) 0.8→1.8, low-2 0.5→1.2 from the start (design: joins at 40 s; a resting beam pins Tumblers). Reversals (50/75/100/130/140 s) not supported by jumpRopeBeam.',
    'Ring drop times are fixed; bar speeds scale with speedScaleByStage (finals usually stage 3–4: ×1.1–1.15).',
    'Music: mus_final_crownfever (neon layer). Expected: 8 finalists ⇒ winner at 110–170 s.',
  ].join(' '),
});
