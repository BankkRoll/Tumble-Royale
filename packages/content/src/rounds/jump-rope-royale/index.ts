/**
 * S4 — Jump Rope Royale (LEVELS.md §5). A round sandbar in a turquoise
 * lagoon; foam ropes sweep around a palm-tree hub — jump the yellow ones,
 * dive under the striped one.
 *
 * Module mapping (`jumpRopeBeam` has no `innerRadius`, `heightSchedule`,
 * `speedSchedule` or `activeFrom`):
 * - Speed schedules → `startSpeed` + linear `acceleration` to `maxSpeed`
 *   (deg/s), fitted through the design's 0 / 25 / 60 / 75 s steps.
 * - Concentric rings → every rope starts at the hub; the outer ropes span the
 *   whole sandbar (r 20) and the inner rope only the inner ring (r 9.5), so
 *   the inner ring sees both — "shorter rope, less room" still holds.
 * - Low/high switching → fixed layers. The outer rope's dive phases become a
 *   dedicated striped dive rope that creeps from the start and reaches the
 *   design's 1.0 rad/s at 35 s ("The Switch"), 1.5 by 57 s.
 * - Every rope moves from t = 0: the inner rope runs from 0 s instead of 10 s,
 *   and the 50 s "Double Dutch" second outer rope is not in the base layout
 *   (low-tide runs three evenly spaced outer ropes from the start instead).
 */
import { defineRound } from '@tumble/shared';
import {
  hash01,
  polar,
  r3,
  v3,
  type ObstacleInput,
  type PieceInput,
  type WaypointInput,
} from '../tile-panic/kit.ts';

const HUB_R = 1.5;
const LOW = 0.55;
const HIGH = 1.75;
/** 0.7 → 1.5 rad/s over 75 s, in deg/s. */
const OUT_START = 40.1;
const OUT_ACCEL = 0.61;
const MAX = 86;
const OUT_YAW = -30;
const KNOCK_OUT = 10;
const KNOCK_IN = 9;

/** Outer rope speed at scaled time t (deg/s). */
const outSpeedAt = (t: number): number => Math.min(MAX, OUT_START + OUT_ACCEL * t);

const rope = (id: string, yaw: number, params: Record<string, unknown>): ObstacleInput => ({
  id,
  type: 'jumpRopeBeam',
  position: v3(0, 0, 0),
  rotation: { yaw },
  params: {
    mode: 'arm',
    layers: 'low',
    lowHeight: LOW,
    highHeight: HIGH,
    beamsPerLayer: 1,
    beamRadius: 0.3,
    hubRadius: HUB_R,
    stunOnHit: true,
    ...params,
  },
});

const ropeOut = rope('rope-out', OUT_YAW, {
  radius: 20,
  direction: 1,
  startSpeed: OUT_START,
  acceleration: OUT_ACCEL,
  maxSpeed: MAX,
  startDelay: 0,
  knockImpulse: KNOCK_OUT,
});
const ropeIn = rope('rope-in', 0, {
  radius: 9.5,
  direction: -1,
  // 0.8 → 1.5 rad/s between 10 s and 75 s, extended back to 0 s.
  startSpeed: 39.8,
  acceleration: 0.62,
  maxSpeed: MAX,
  startDelay: 0,
  knockImpulse: KNOCK_IN,
});
const ropeDive = rope('rope-dive', -90, {
  radius: 20,
  layers: 'high',
  // High layers spin opposite to `direction`: +1 here ⇒ clockwise, against rope-out.
  direction: 1,
  highDirection: 'opposite',
  // Creeps at 0.2 rad/s, 1.0 rad/s at 35 s, capped at 1.5 from 57 s.
  startSpeed: 12,
  acceleration: 1.3,
  maxSpeed: MAX,
  startDelay: 0,
  knockImpulse: KNOCK_IN,
});
/**
 * low-tide: three outer ropes a third of a turn apart on one shared, gentler
 * curve (0.45 → 1.5 rad/s at 75 s) — three times the passes, so a slower start.
 */
const TIDE_START = 25;
const TIDE_ACCEL = 0.81;
const outerTwin = (id: string, offsetDeg: number): ObstacleInput =>
  rope(id, OUT_YAW + offsetDeg, {
    radius: 20,
    direction: 1,
    startSpeed: TIDE_START,
    acceleration: TIDE_ACCEL,
    maxSpeed: MAX,
    startDelay: 0,
    knockImpulse: KNOCK_OUT,
  });
const hub: ObstacleInput = {
  id: 'hub',
  type: 'bumperPillar',
  position: v3(0, 0, 0),
  params: { radius: HUB_R, height: 2.5, bounceSpeed: 8, bounceLift: 3 },
};

// -----------------------------------------------------------------------------
// Set dressing
// -----------------------------------------------------------------------------

const geometry: PieceInput[] = [
  // Sandbar (the only solid ground) and its wet rocky skirt.
  { shape: 'cylinder', position: v3(0, -0.5, 0), size: v3(20, 1, 0), color: 'primary', bevel: 0.3 },
  { shape: 'cylinder', position: v3(0, -2.2, 0), size: v3(19.2, 2.4, 0), color: '#d9b77e', decorative: true },
  // Dead-ring paint (r 9.5–10.5) and the hazard edge band, sunk so only a stripe shows.
  { shape: 'torus', position: v3(0, -0.42, 0), size: v3(10, 0.5, 0), color: 'safe', decorative: true },
  {
    shape: 'torus',
    position: v3(0, -0.12, 0),
    size: v3(19.75, 0.2, 0),
    color: 'danger',
    pattern: 'hazard',
    decorative: true,
  },
  // Lagoon.
  { shape: 'cylinder', position: v3(0, -3, 0), size: v3(45, 0.2, 0), color: '#4fd1ff', decorative: true },
  { shape: 'torus', position: v3(0, -2.85, 0), size: v3(21, 0.25, 0), color: '#ffffff', decorative: true },
  // Palm tree over the hub (trunk + fronds), clear of the ropes' sweep.
  {
    shape: 'cylinder',
    position: v3(0, 4.5, 0),
    size: v3(0.45, 4, 0),
    color: '#b8956a',
    pattern: 'stripes',
    decorative: true,
  },
  { shape: 'sphere', position: v3(0, 7, 0), size: v3(2.4, 2.4, 2.4), color: 'accent', decorative: true },
  {
    shape: 'sphere',
    position: v3(0.9, 6.5, 0.6),
    size: v3(0.45, 0.45, 0.45),
    color: '#8a5a2b',
    decorative: true,
  },
  {
    shape: 'sphere',
    position: v3(-0.7, 6.4, -0.8),
    size: v3(0.45, 0.45, 0.45),
    color: '#8a5a2b',
    decorative: true,
  },
];
// Tiki crowd towers with sun umbrellas.
for (let i = 0; i < 6; i++) {
  const p = polar(30, i * 60 + 30, 4);
  geometry.push(
    {
      shape: 'cylinder',
      position: r3(p),
      size: v3(2, 8, 0),
      color: 'secondary',
      pattern: 'stripes',
      decorative: true,
    },
    {
      shape: 'cylinder',
      position: r3(v3(p.x, 8.3, p.z)),
      size: v3(3.4, 0.5, 0),
      color: i % 2 ? 'danger' : 'accent',
      pattern: 'stripes',
      decorative: true,
    },
    {
      shape: 'cylinder',
      position: r3(v3(p.x, -2, p.z)),
      size: v3(3, 2, 0),
      color: 'primary',
      decorative: true,
    },
  );
}
// Inflatable flamingos, beach balls and a DJ booth boat out in the lagoon.
for (let i = 0; i < 8; i++) {
  const p = polar(25 + hash01(2401, i) * 9, i * 45 + 10, -2.4);
  const flamingo = i % 2 === 0;
  geometry.push({
    shape: flamingo ? 'torus' : 'sphere',
    position: r3(p),
    size: flamingo ? v3(1.3, 0.45, 0) : v3(0.8, 0.8, 0.8),
    color: flamingo ? '#ff8fc8' : i % 4 === 1 ? 'accent' : 'secondary',
    decorative: true,
  });
}
const boat = polar(38, 200, -2.2);
geometry.push(
  {
    shape: 'box',
    position: r3(boat),
    size: v3(9, 1.6, 4),
    rotation: { yaw: 70 },
    color: 'neutral',
    bevel: 0.5,
    decorative: true,
  },
  {
    shape: 'box',
    position: r3(v3(boat.x, 0.2, boat.z)),
    size: v3(3, 2.4, 2.4),
    rotation: { yaw: 70 },
    color: 'danger',
    pattern: 'stripes',
    decorative: true,
  },
);

// -----------------------------------------------------------------------------
// Bot zones
// -----------------------------------------------------------------------------

/**
 * Key "band" points in the inner ring (no links ⇒ bots wander around their
 * centroid and jump/dive by reflex). LEVELS.md defaults bots to the outer
 * ring, but a missed rope there bulldozes a Tumbler along the beam and off the
 * sandbar at ~10 m/s; near the hub the beam is slow enough to slip off alive,
 * so bot rounds play out over time instead of ending at the second pass.
 */
const botNav: WaypointInput[] = [
  { id: 0, position: v3(-4, 0, -7.5), radius: 3 },
  { id: 1, position: v3(0, 0, -10), radius: 3 },
  { id: 2, position: v3(4, 0, -7.5), radius: 3 },
  { id: 3, position: v3(0, 0, -9), radius: 3 },
];

export default defineRound({
  id: 'jump-rope-royale',
  name: 'Jump Rope Royale',
  type: 'survival',
  theme: 'beach',
  objective: 'Jump or dive the spinning ropes. Stay on!',
  tips: [
    'Two rings spin opposite ways. Watch the one coming at you.',
    'Glowing yellow rope = jump. Striped red rope = dive under.',
    'The middle ring has a shorter rope, but less room.',
  ],
  players: { min: 8, max: 50, ideal: 30 },
  qualification: { mode: 'survive', ratio: 0.65 },
  duration: { seconds: 90, overtimeSeconds: 0 },
  killY: -6,
  bounds: { min: v3(-35, -15, -35), max: v3(35, 20, 35) },
  spawn: { origin: v3(0, 0.1, -14), yaw: 0, cols: 8, spacing: 1.4 },
  geometry,
  obstacles: [hub, ropeOut, ropeIn, ropeDive],
  triggers: [],
  flyover: {
    path: [v3(0, 25, -35), v3(35, 18, 0), v3(0, 15, 35), v3(-20, 10, -10)],
    lookAt: [v3(0, 0, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_beach_tikitumble',
  speedScaleByStage: [1.0, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  botNav,
  variations: [
    { id: 'beach-party', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'same-way',
      weight: 2,
      weather: 'clear',
      description: 'Both rings spin the same way (passes sync — tricky crossings).',
      obstacleParams: { 'rope-in': { direction: 1 } },
    },
    {
      id: 'heatwave',
      weight: 1,
      weather: 'sunset',
      description: 'Faster earlier: every speed curve runs 10 s ahead.',
      obstacleParams: {
        'rope-out': { startSpeed: outSpeedAt(10) },
        'rope-in': { startSpeed: 46 },
        'rope-dive': { startSpeed: 25 },
      },
    },
    {
      id: 'low-tide',
      weight: 2,
      weather: 'clear',
      description: 'No dive rope; three outer ropes a third of a turn apart.',
      removeObstacles: ['rope-dive'],
      obstacleParams: { 'rope-out': { startSpeed: TIDE_START, acceleration: TIDE_ACCEL } },
      addObstacles: [outerTwin('rope-out-2', 120), outerTwin('rope-out-3', 240)],
    },
    {
      id: 'stormy-surf',
      weight: 1,
      weather: 'stormy',
      description: 'A sea breeze pushes everyone toward the east edge.',
      addObstacles: [
        {
          id: 'w-gust',
          type: 'fanZone',
          position: v3(-23, 2, 0),
          rotation: { yaw: 90 },
          params: {
            width: 40,
            height: 4,
            length: 44,
            strength: 4,
            falloff: 0,
            onTime: 5,
            offTime: 0,
            telegraphLead: 0.8,
          },
        },
      ],
    },
  ],
  decorSeed: 2401,
  designNotes: [
    'Sandbar r 20 (top 0) with a bouncy palm hub. rope-out (low, r 20, 0.7→1.5 rad/s), rope-in (low, r 9.5, opposite, 0.7→1.5),',
    'rope-dive (striped high bar 1.75, r 20, creeping 0.2 → 1.0 rad/s at 35 s → 1.5). All ropes run from t = 0.',
    'jumpRopeBeam lacks innerRadius/heightSchedule/speedSchedule/activeFrom: ropes span hub→radius, layers are fixed, speeds ramp linearly;',
    'the 50 s Double Dutch rope is dropped from the base layout; low-tide runs three outer ropes a third of a turn apart.',
    'A missed rope trips the Tumbler (stun, hop and a push back behind the beam); the rim is where trips turn into falls.',
    'Expected (humans): 30 → ~20 between 60 and 90 s.',
  ].join(' '),
});
