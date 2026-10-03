/**
 * S1 — Spin Cycle (survival, factory).
 *
 * Tumblers are laundry inside a giant toy washing-machine drum: a low bar to
 * jump and a counter-rotating high bar you must not jump into, both speeding
 * up, while the outer rings of the drum floor fall away at 60 s and 75 s.
 * Transcribed from docs/design/LEVELS.md §S1.
 *
 * Module mapping notes:
 * - Bars are `jumpRopeBeam` (low/high layers, linear speed ramp, start
 *   delay) — `sweeperArm` has neither a delayed start nor a high layer that
 *   counter-rotates. Speed schedules become one linear ramp; the design's
 *   reversals (45 s low, 70 s high) are not supported by any module.
 * - The high bar cannot be parked at 6 m and lowered; it hangs still (and
 *   harmless) at its final height until it starts at 20 s.
 * - Timed ring drops use radial one-shot `movingPlatform` panels (see drum.ts);
 *   there is no 1.5 s shake, so painted danger seams mark the doomed rings.
 */
import { defineRound, type RoundDefinitionInput } from '@tumble/shared';
import { bar, decorRng, hexCore, ringPanels, ringSeam } from './drum.ts';

type Piece = RoundDefinitionInput['geometry'][number];
type Obstacle = NonNullable<RoundDefinitionInput['obstacles']>[number];
type Waypoint = NonNullable<RoundDefinitionInput['botNav']>[number];

const v = (x: number, y: number, z: number) => ({ x, y, z });

const deco = (
  shape: Piece['shape'],
  pos: ReturnType<typeof v>,
  size: ReturnType<typeof v>,
  color: string,
  extra: Partial<Piece> = {},
): Piece => ({
  shape,
  position: pos,
  size,
  color,
  decorative: true,
  pattern: 'none',
  bevel: 0.15,
  ...extra,
});

/** Inner disc radius that never drops (design: final arena r 13). */
const CORE = 13;

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const geometry: Piece[] = [
  // Solid core floor; hex tiles on top are decoration.
  {
    shape: 'cylinder',
    position: v(0, -0.3, 0),
    size: v(CORE + 0.1, 0.6, CORE + 0.1),
    color: 'neutral',
    bevel: 0.2,
    pattern: 'none',
  },
  ...hexCore({
    radius: CORE - 1.3,
    tile: 1.6,
    gap: 0.12,
    colors: ['primary', 'secondary'],
    centreRadius: 2.6,
    centreColor: 'accent',
  }),
  // "Slow zone" paint ring, porthole rim and the suds pool below.
  deco('torus', v(0, 0.04, 0), v(9, 0.08, 9), 'safe'),
  ringSeam(CORE),
  ringSeam(17),
  deco('torus', v(0, 6, 0), v(27, 1.2, 27), 'neutral'),
  deco('cylinder', v(0, -6, 0), v(24, 0.2, 24), '#bfe9ff'),
  // Agitator column under the drum.
  deco('cylinder', v(0, -3.5, 0), v(4, 6, 4), 'secondary', { pattern: 'stripes' }),
  // Giant drum ring turning behind the arena, and the control panel with its dials.
  deco('torus', v(0, 8, 44), v(36, 1.6, 36), 'secondary', { rotation: { pitch: 90 } }),
  deco('torus', v(0, 8, 44), v(31, 0.6, 31), 'accent', { rotation: { pitch: 90 } }),
  deco('box', v(0, 15, -46), v(26, 10, 2), 'neutral', { bevel: 0.6 }),
  deco('cylinder', v(-7, 16, -44.8), v(2.4, 0.5, 2.4), 'accent', { rotation: { pitch: 90 } }),
  deco('cylinder', v(0, 16, -44.8), v(2.4, 0.5, 2.4), 'danger', { rotation: { pitch: 90 } }),
  deco('cylinder', v(7, 16, -44.8), v(2.4, 0.5, 2.4), 'safe', { rotation: { pitch: 90 } }),
  deco('box', v(0, 11.5, -44.8), v(18, 1.2, 0.6), 'secondary', { pattern: 'chevron' }),
];

// Foam bubbles bobbing in the suds, and laundry tumbling slowly in the sky.
const rng = decorRng(2101);
for (let k = 0; k < 40; k++) {
  const a = rng() * Math.PI * 2;
  const r = 24 + rng() * 16;
  const s = 0.5 + rng() * 1.5;
  geometry.push(deco('sphere', v(Math.cos(a) * r, -4 + rng() * 3, Math.sin(a) * r), v(s, s, s), '#ffffff'));
}
const LAUNDRY = ['#ff8fb8', '#7fd4ff', '#ffe066', '#b7f27a', '#c9a4ff'];
for (let k = 0; k < 10; k++) {
  const a = (k / 10) * Math.PI * 2 + rng();
  const r = 42 + rng() * 14;
  geometry.push(
    deco(
      'box',
      v(Math.cos(a) * r, 14 + rng() * 16, Math.sin(a) * r),
      v(3 + rng() * 2, 0.4, 2.2 + rng()),
      LAUNDRY[k % LAUNDRY.length]!,
      {
        rotation: { yaw: rng() * 360, pitch: rng() * 40 - 20, roll: rng() * 40 - 20 },
        bevel: 0.2,
        pattern: k % 2 === 0 ? 'stripes' : 'dots',
      },
    ),
  );
}

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

/** Inner falling ring r 13–17 (drops at 75 s) and outer ring r 17–22 (drops at 60 s). */
const ringInner = ringPanels({ prefix: 'ring-in', rIn: CORE, rOut: 17, count: 24, dropAt: 75 });
const ringOuter = ringPanels({ prefix: 'ring-out', rIn: 17, rOut: 22, count: 30, dropAt: 60, offset: 0.05 });

const obstacles: Obstacle[] = [
  ...ringOuter,
  ...ringInner,
  // Hub shove stays under the 9 m/s stun threshold: a stunned Tumbler slides off a 22 m drum.
  {
    id: 'hub',
    type: 'bumperPillar',
    position: v(0, 0, 0),
    params: { radius: 1.6, height: 3.2, bounceSpeed: 7.5, bounceLift: 3 },
  },
  {
    id: 'bar-low',
    type: 'jumpRopeBeam',
    position: v(0, 0, 0),
    // Design schedule 0.8 → 1.6 rad/s over 75 s (steps at 15/35/60/75). Bars reach r 17 (design 22):
    // a stunned Tumbler is dragged by the bar, so the outer ring is the run-out until it drops at 60 s.
    params: bar({
      reach: 17,
      kind: 'low',
      mode: 'full',
      direction: 1,
      startSpeed: 0.8,
      endSpeed: 1.6,
      rampUntil: 75,
      hubRadius: 1.5,
      knockImpulse: 8,
    }),
  },
  {
    id: 'bar-high',
    type: 'jumpRopeBeam',
    position: v(0, 0, 0),
    // Design phase 0.25: a quarter turn ahead of the low bar.
    rotation: { yaw: 90 },
    // Creeps from the start (a still bar is a solid head-height beam), 0.3 → 1.2 rad/s by 75 s.
    params: bar({
      reach: 17,
      kind: 'high',
      mode: 'full',
      direction: 1,
      startSpeed: 0.3,
      endSpeed: 1.2,
      rampUntil: 75,
      hubRadius: 1.5,
      knockImpulse: 8,
    }),
  },
];

// -----------------------------------------------------------------------------
// Bot nav: two running loops. Bots join whichever is nearer their spawn slot:
// the inner band (r 4.5, the design's "bars are slower near the middle") or
// the edge band (r 14.5, on the ring that drops at 75 s — bots do not scramble
// inward, so the edge-huggers are the ones the Ring Drop catches).
// -----------------------------------------------------------------------------

/** One closed loop of `n` nodes at radius `r`, ids from `base`. */
function loop(base: number, r: number, n: number): Waypoint[] {
  return Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return {
      id: base + k,
      position: v(Math.sin(a) * r, 0, Math.cos(a) * r),
      radius: 3,
      next: [base + ((k + 1) % n)],
      action: 'run' as const,
    };
  });
}

const botNav: Waypoint[] = [...loop(0, 4.5, 8), ...loop(100, 14.5, 12)];

const delicates = Object.fromEntries([
  ...ringOuter.map((o) => [o.id, { phase: 70 }] as [string, Record<string, unknown>]),
  // A phase past the round's end keeps the inner ring in its top hold for the whole wash.
  ...ringInner.map((o) => [o.id, { phase: 300 }] as [string, Record<string, unknown>]),
]);

export default defineRound({
  id: 'spin-cycle',
  name: 'Spin Cycle',
  type: 'survival',
  theme: 'factory',
  objective: 'Jump the low bar, dive under the high bar!',
  tips: [
    'Bars move slower near the middle — but it is crowded there.',
    'Yellow bar = jump. Striped red bar = stay low and dive under it.',
    'The outer ring falls away later. Don’t get caught on the edge.',
  ],
  players: { min: 8, max: 40, ideal: 24 },
  qualification: { mode: 'survive', ratio: 0.7 },
  duration: { seconds: 90, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-35, -15, -35), max: v(35, 25, 35) },
  spawn: { origin: v(0, 0.1, -9), yaw: 0, cols: 8, spacing: 1.5 },
  geometry,
  obstacles,
  triggers: [],
  flyover: {
    path: [v(30, 20, 0), v(0, 24, 30), v(-30, 20, 0), v(0, 26, -30)],
    lookAt: [v(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_factory_clockwork',
  speedScaleByStage: [1.0, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  botNav,
  variations: [
    { id: 'normal-wash', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'heavy-duty',
      weight: 2,
      weather: 'clear',
      description: 'Three low arms.',
      // A third arm pointing at +Z rides with the main bar (same speed curve), clear of the spawn grid at −Z.
      addObstacles: [
        {
          id: 'bar-low-3',
          type: 'jumpRopeBeam',
          position: v(0, 0, 0),
          rotation: { yaw: -90 },
          params: bar({
            reach: 17,
            kind: 'low',
            mode: 'arm',
            direction: 1,
            startSpeed: 0.8,
            endSpeed: 1.6,
            rampUntil: 75,
            hubRadius: 1.5,
            knockImpulse: 8,
          }),
        },
      ],
    },
    {
      id: 'delicates',
      weight: 1,
      weather: 'clear',
      description: 'Gentler: only the outer ring drops, at 70 s.',
      obstacleParams: delicates,
    },
    {
      id: 'soap-slick',
      weight: 2,
      weather: 'night',
      description: 'Neon suds; the drum core is slippery.',
      addObstacles: [
        {
          id: 'soap',
          type: 'iceFloor',
          position: v(0, 0.03, 0),
          params: { shape: 'disc', radius: CORE - 0.4, thickness: 0.3, surface: 'ice' },
        },
      ],
    },
    {
      id: 'rinse-and-repeat',
      weight: 1,
      weather: 'clear',
      description: 'High bar from the start, low bar joins at 20 s.',
      obstacleParams: { 'bar-high': { startSpeed: 34.38 }, 'bar-low': { startDelay: 20 } },
    },
  ],
  decorSeed: 2101,
  designNotes: [
    'Escalation: low bar 0.8→1.6 rad/s (linear ramp to 75 s); high bar 0.3→1.2 rad/s; outer ring (r>17) drops at 60 s; ring r>13 drops at 75 s (one-shot movingPlatform panels, sine sag; painted danger seams instead of a shake).',
    'Not supported by modules: bar reversals at 45/70 s, high bar lowering from 6 m (it hangs still and harmless until 20 s).',
    'High bar underside at 2.3 m: diving/standing Tumblers pass, jumpers are hit (capsule never shrinks on dive, so the design 1.40–2.10 m band would be unclearable).',
    'Ring drop times are fixed (design: schedule times are not scaled); bar speeds scale with speedScaleByStage. Expected 24 → ~17 by 75–85 s.',
    'Lighting: key az 0° el 75° #f2f7ff, no fog, bloom on suds.',
  ].join(' '),
});
