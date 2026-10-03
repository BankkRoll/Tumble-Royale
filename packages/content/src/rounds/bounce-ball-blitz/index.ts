/**
 * T2 — Bounce Ball Blitz (LEVELS.md §6). Two teams on a sunset beach pitch
 * knock a giant ball into the opposing goal; a second ball drops from the
 * blimp's hatch at 60 s; ties at full time go to 60 s of golden goal.
 *
 * Point-symmetric: everything is authored for team 0's half (−Z, defending
 * the −Z goal) and mirrored through the centre spot for team 1.
 *
 * Goal trigger `index` is the team that SCORES there (team rules and bots read
 * it that way); goal frames, nets and crests use the DEFENDING team's colour.
 * Goal triggers reach below the goal floor so the generic floor marker (drawn
 * at the trigger's base) stays hidden under it and the dressing reads cleanly.
 */
import { defineRound } from '@tumble/shared';
import {
  crestBoard,
  crowdStand,
  rotObstacle,
  rotPiece,
  rotPoint,
  rotTrigger,
  team,
  teamBanner,
  v,
} from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];
type Trigger = NonNullable<Def['triggers']>[number];

const GRAVITY = 24;

/**
 * Bounce-pad launch velocity (local, +Z forward) for a target apex above the
 * pad and a horizontal range at `landingDelta` relative height.
 */
function padLaunch(apex: number, range: number, landingDelta = 0): { x: number; y: number; z: number } {
  const vy = Math.sqrt(2 * GRAVITY * apex);
  const flight = vy / GRAVITY + Math.sqrt((2 * (apex - landingDelta)) / GRAVITY);
  return { x: 0, y: Math.round(vy * 100) / 100, z: Math.round((range / flight) * 100) / 100 };
}

/** Point mirror through the centre spot (team 0's half → team 1's). */
const mirror = 180;

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

/** Team 0's end (−Z): goal frame and walls in team 0's colour, crest, mascot, banners. */
function endPieces(t: number): Piece[] {
  return [
    // f.6 bouncy end walls either side of the goal.
    {
      shape: 'box',
      position: v(-13, 2, -32.5),
      size: v(14, 4, 1),
      surface: 'bouncy',
      color: 'neutral',
      pattern: 'dots',
    },
    {
      shape: 'box',
      position: v(13, 2, -32.5),
      size: v(14, 4, 1),
      surface: 'bouncy',
      color: 'neutral',
      pattern: 'dots',
    },
    // f.7 goal frame (12 × 5 m clear mouth) in the defending team's colour.
    {
      shape: 'box',
      position: v(-6.25, 2.75, -32),
      size: v(0.5, 5.5, 0.5),
      color: team(t),
      pattern: 'stripes',
    },
    {
      shape: 'box',
      position: v(6.25, 2.75, -32),
      size: v(0.5, 5.5, 0.5),
      color: team(t),
      pattern: 'stripes',
    },
    { shape: 'box', position: v(0, 5.25, -32), size: v(13, 0.5, 0.5), color: team(t), pattern: 'stripes' },
    // f.8 – f.10 goal back wall, side walls and floor.
    { shape: 'box', position: v(0, 2.5, -36.5), size: v(12, 5, 1), color: 'neutral' },
    { shape: 'box', position: v(-6.25, 2.5, -34.5), size: v(0.5, 5, 4), color: 'neutral' },
    { shape: 'box', position: v(6.25, 2.5, -34.5), size: v(0.5, 5, 4), color: 'neutral' },
    { shape: 'box', position: v(0, -0.5, -34.5), size: v(12, 1, 4), color: 'neutral', pattern: 'checker' },
    // Crest board over the goal and an inflatable mascot behind it (decor).
    ...crestBoard(t, v(0, 7.4, -36.4), 0, 3),
    { shape: 'sphere', position: v(0, 4, -42), size: v(3.6, 0, 0), color: team(t), decorative: true },
    { shape: 'sphere', position: v(0, 8.6, -42), size: v(2.4, 0, 0), color: team(t), decorative: true },
    {
      shape: 'sphere',
      position: v(-0.9, 9.2, -39.8),
      size: v(0.5, 0, 0),
      color: '#ffffff',
      decorative: true,
    },
    { shape: 'sphere', position: v(0.9, 9.2, -39.8), size: v(0.5, 0, 0), color: '#ffffff', decorative: true },
    {
      shape: 'cylinder',
      position: v(0, -1.6, -42),
      size: v(4, 1.2, 0),
      color: 'secondary',
      decorative: true,
    },
    ...teamBanner(t, v(-17, 0, -34), 0, 7),
    ...teamBanner(t, v(17, 0, -34), 0, 7),
    // Stand section on this half: team-coloured banners hang on the stand front.
    ...crestBoard(t, v(-21.1, 5.2, -16), 90, 2.2),
    ...crestBoard(t, v(21.1, 5.2, -16), -90, 2.2),
  ];
}

/** Side stands with an instanced-looking crowd (decor; no colliders so stray balls fall out and respawn). */
function stands(): Piece[] {
  const crowd = ['#ff9a6b', '#c77dff', '#ffd36e', '#5ef2d0', '#fff0e3', '#ff2f6d'];
  const out: Piece[] = [];
  for (const side of [-1, 1]) {
    out.push({
      shape: 'box',
      position: v(side * 26, 0.25, 0),
      size: v(10, 0.5, 70),
      color: 'neutral',
      pattern: 'stripes',
      decorative: true,
    });
    for (let k = 0; k < 4; k++) {
      out.push(
        ...crowdStand(
          v(side * 22.5, 0.5, -24 + k * 16),
          side * 90 + 180,
          13,
          3,
          crowd,
          k + (side > 0 ? 4 : 0),
        ),
      );
    }
  }
  return out;
}

/** Boardwalk dressing: string-light posts, beach huts, palms, the scoreboard blimp. */
function boardwalk(): Piece[] {
  const out: Piece[] = [];
  const huts = ['#ff9a6b', '#c77dff', '#ffd36e', '#5ef2d0'];
  for (let i = 0; i < 6; i++) {
    for (const side of [-1, 1]) {
      const z = -30 + i * 12;
      out.push(
        {
          shape: 'box',
          position: v(side * 34, 3, z),
          size: v(5, 6, 6),
          color: huts[(i + (side > 0 ? 1 : 0)) % 4]!,
          decorative: true,
          pattern: 'stripes',
        },
        {
          shape: 'wedge',
          position: v(side * 34, 7, z),
          size: v(6, 2, 6.4),
          color: 'neutral',
          decorative: true,
        },
        {
          shape: 'cylinder',
          position: v(side * 31, 6, z + 6),
          size: v(0.25, 12, 0),
          color: '#6a4f8f',
          decorative: true,
        },
        {
          shape: 'sphere',
          position: v(side * 31, 12.4, z + 6),
          size: v(0.5, 0, 0),
          color: 'accent',
          decorative: true,
        },
      );
    }
  }
  for (const [x, z] of [
    [-30, -44],
    [30, -44],
    [-30, 44],
    [30, 44],
    [-12, 46],
    [12, -46],
  ] as const) {
    out.push(
      {
        shape: 'cylinder',
        position: v(x, 4, z),
        size: v(0.5, 9, 0),
        color: '#6a4f8f',
        decorative: true,
        pattern: 'stripes',
      },
      { shape: 'sphere', position: v(x, 9, z), size: v(2.4, 0, 0), color: '#5a3f8f', decorative: true },
    );
  }
  // Scoreboard blimp; its gondola hatch holds the second ball until 60 s.
  out.push(
    { shape: 'sphere', position: v(0, 21.4, 0), size: v(3.4, 0, 0), color: 'secondary', decorative: true },
    { shape: 'sphere', position: v(0, 21.4, 3.2), size: v(2.6, 0, 0), color: 'secondary', decorative: true },
    { shape: 'sphere', position: v(0, 21.4, -3.2), size: v(2.6, 0, 0), color: 'secondary', decorative: true },
    { shape: 'wedge', position: v(0, 24.2, -5), size: v(0.4, 2.4, 3), color: 'accent', decorative: true },
    {
      shape: 'box',
      position: v(0, 17.4, 0),
      size: v(4.8, 1.2, 5.4),
      color: 'neutral',
      decorative: true,
      pattern: 'stripes',
    },
  );
  return out;
}

const halfPieces = (t: number): Piece[] => endPieces(t);

const geometry: Piece[] = [
  // f.1 pitch, f.2 halfway line, f.3 centre circle (deco), f.4 midfield hump.
  { shape: 'box', position: v(0, -0.5, 0), size: v(40, 1, 64), color: 'primary', bevel: 0.3 },
  // Halfway line along the hump's ridge and the centre spot ring on the pitch either side of it.
  { shape: 'box', position: v(0, 0.81, 0), size: v(16, 0.02, 0.3), color: '#ffffff', decorative: true },
  { shape: 'box', position: v(-14, 0.01, 0), size: v(12, 0.02, 0.3), color: '#ffffff', decorative: true },
  { shape: 'box', position: v(14, 0.01, 0), size: v(12, 0.02, 0.3), color: '#ffffff', decorative: true },
  { shape: 'torus', position: v(0, 0.02, 0), size: v(9.5, 0.15, 0), color: '#ffffff', decorative: true },
  // Goal boxes in front of each mouth.
  ...[1, -1].flatMap((s): Piece[] => [
    {
      shape: 'box',
      position: v(0, 0.01, s * 24.5),
      size: v(18, 0.02, 0.3),
      color: '#ffffff',
      decorative: true,
    },
    {
      shape: 'box',
      position: v(-9, 0.01, s * 28.25),
      size: v(0.3, 0.02, 7.5),
      color: '#ffffff',
      decorative: true,
    },
    {
      shape: 'box',
      position: v(9, 0.01, s * 28.25),
      size: v(0.3, 0.02, 7.5),
      color: '#ffffff',
      decorative: true,
    },
    {
      shape: 'box',
      position: v(0, 0.01, s * 31.9),
      size: v(12, 0.02, 0.2),
      color: '#ffffff',
      decorative: true,
    },
  ]),
  { shape: 'ramp', position: v(0, 0.4, -4), size: v(16, 0.8, 8), rotation: { yaw: 0 }, color: 'secondary' },
  { shape: 'ramp', position: v(0, 0.4, 4), size: v(16, 0.8, 8), rotation: { yaw: 180 }, color: 'secondary' },
  // Banked edges and corner deflectors roll a pinned ball back into play (bots love wall scrums).
  {
    shape: 'ramp',
    position: v(18.75, 0.4, 0),
    size: v(56, 0.8, 2.5),
    rotation: { yaw: 90 },
    color: 'secondary',
    pattern: 'chevron',
  },
  {
    shape: 'ramp',
    position: v(-18.75, 0.4, 0),
    size: v(56, 0.8, 2.5),
    rotation: { yaw: -90 },
    color: 'secondary',
    pattern: 'chevron',
  },
  ...[45, 135, -135, -45].map((yaw): Piece => {
    const c = rotPoint(v(0, 0, 1), yaw);
    return {
      shape: 'ramp',
      position: v(Math.sign(c.x) * 18.2, 0.6, Math.sign(c.z) * 30.2),
      size: v(7, 1.2, 3),
      rotation: { yaw },
      color: 'secondary',
      pattern: 'chevron',
    };
  }),
  // f.5 bouncy side boards.
  {
    shape: 'box',
    position: v(-20.5, 2, 0),
    size: v(1, 4, 64),
    surface: 'bouncy',
    color: 'neutral',
    pattern: 'dots',
  },
  {
    shape: 'box',
    position: v(20.5, 2, 0),
    size: v(1, 4, 64),
    surface: 'bouncy',
    color: 'neutral',
    pattern: 'dots',
  },
  ...halfPieces(0),
  ...halfPieces(1).map((p) => rotPiece(p, mirror)),
  ...stands(),
  ...boardwalk(),
];

// -----------------------------------------------------------------------------
// Obstacles (team 0's half, mirrored)
// -----------------------------------------------------------------------------

const halfObstacles: Obstacle[] = [
  {
    id: 'bump-1',
    type: 'bumperPillar',
    position: v(-10, 0, -12),
    params: { radius: 1, height: 2.4, bounceSpeed: 10 },
  },
  {
    id: 'bump-2',
    type: 'bumperPillar',
    position: v(10, 0, -12),
    params: { radius: 1, height: 2.4, bounceSpeed: 10 },
  },
  // Launches toward +Z: favours team 0's attack (pad-B is its point mirror).
  {
    id: 'pad-A',
    type: 'bouncePad',
    position: v(-16, 0, -6),
    rotation: { yaw: 0 },
    params: { radius: 1.5, launch: padLaunch(6, 14) },
  },
  {
    id: 'pad-gk-0',
    type: 'bouncePad',
    position: v(0, 0, -27),
    rotation: { yaw: 0 },
    params: { radius: 1.2, launch: padLaunch(4, 10) },
  },
  {
    id: 'goal-zone-0',
    type: 'goalZone',
    position: v(0, 0, -35.15),
    rotation: { yaw: 0 },
    params: {
      mode: 'goal',
      team: 0,
      sizeX: 11.4,
      sizeY: 6,
      sizeZ: 2.3,
      bottom: -1.1,
      mouthOffset: 3.15,
      spawners: ['ball', 'ball-2'],
      mouthWidth: 12,
      mouthHeight: 5,
    },
  },
];
const mirroredIds: Record<string, string> = {
  'bump-1': 'bump-3',
  'bump-2': 'bump-4',
  'pad-A': 'pad-B',
  'pad-gk-0': 'pad-gk-1',
  'goal-zone-0': 'goal-zone-1',
};

const BALL_SCALE = 1.8 / 1.6;

const obstacles: Obstacle[] = [
  ...halfObstacles,
  ...halfObstacles.map((o) => {
    const m = rotObstacle(o, mirror, mirroredIds[o.id]!);
    return o.type === 'goalZone' ? { ...m, params: { ...o.params, team: 1 } } : m;
  }),
  {
    id: 'ball',
    type: 'propSpawner',
    position: v(0, 8, 0),
    params: { kind: 'ball', idBase: 1000, scale: BALL_SCALE, respawnDelay: 3 },
  },
  // Second ball waits on the blimp gondola's hatch; the hatch splits open at 60 s (2 s countdown).
  {
    id: 'ball-2',
    type: 'propSpawner',
    position: v(0, 13, 0),
    params: { kind: 'ball', idBase: 1010, scale: BALL_SCALE, respawnDelay: 3, respawnBelow: -30 },
  },
  {
    id: 'ball-2-hatch',
    type: 'startGate',
    // Pitched flat: the barrier's height runs along +Z from here, its top face at y 13.
    position: v(0, 12.75, -3),
    rotation: { pitch: 90 },
    params: {
      width: 6,
      height: 6,
      thickness: 0.5,
      openTime: 60,
      style: 'split',
      openDuration: 0.5,
      countdown: 2,
    },
  },
];

// -----------------------------------------------------------------------------
// Triggers
// -----------------------------------------------------------------------------

/** Goal at −Z: defended by team 0, scored by team 1 (index = scoring team). */
const goal0: Trigger = {
  id: 'goal-0',
  kind: 'goal',
  position: v(0, 1.9, -35.15),
  size: v(11.4, 6, 2.3),
  index: 1,
};
const cp0: Trigger = {
  id: 'cp-t0',
  kind: 'checkpoint',
  position: v(0, 2, -20),
  size: v(30, 4, 10),
  index: 0,
  respawn: [-9, -5, -1.5, 1.5, 5, 9].map((x) => v(x, 0.1, -22)),
  respawnYaw: 0,
};
const triggers: Trigger[] = [
  goal0,
  rotTrigger(goal0, mirror, 'goal-1', 0),
  cp0,
  rotTrigger(cp0, mirror, 'cp-t1', 1),
];

export default defineRound({
  id: 'bounce-ball-blitz',
  name: 'Bounce Ball Blitz',
  type: 'team',
  theme: 'sunset',
  objective: 'Knock the giant ball into the other goal!',
  tips: [
    'Dive into the ball for a big kick.',
    'Bounce pads launch you into the action — and the ball too.',
    "A second ball joins at 60 seconds. Don't forget your goal!",
  ],
  players: { min: 6, max: 100, ideal: 60 },
  qualification: { mode: 'teamScore', teams: 2, teamsEliminated: 1, ratio: 0.5 },
  duration: { seconds: 120, overtimeSeconds: 60 },
  killY: -8,
  bounds: { min: v(-35, -15, -45), max: v(35, 30, 45) },
  spawn: { origin: v(0, 0, 0), yaw: 0, cols: 10, spacing: 1.3, teamOrigins: [v(0, 0.1, -18), v(0, 0.1, 18)] },
  geometry,
  obstacles,
  triggers,
  flyover: {
    path: [v(-30, 20, -40), v(0, 26, 0), v(30, 20, 40), v(0, 10, -30)],
    lookAt: [v(0, 0, -32), v(0, 0, 0), v(0, 0, 32), v(0, 2, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_sunset_boardwalk',
  speedScaleByStage: [1, 1, 1, 1, 1],
  fallBehavior: 'respawnCheckpoint',
  botNav: [
    { id: 0, position: v(0, 0.8, 0), radius: 4, next: [] },
    { id: 100, position: v(0, 0, -27), radius: 3, next: [] },
    { id: 101, position: v(0, 0, -14), radius: 3, next: [] },
    { id: 200, position: v(0, 0, 27), radius: 3, next: [] },
    { id: 201, position: v(0, 0, 14), radius: 3, next: [] },
  ],
  variations: [
    { id: 'sunset-cup', weight: 4, weather: 'sunset', description: 'As authored.' },
    {
      id: 'mega-ball',
      weight: 2,
      weather: 'clear',
      description: 'One huge ball, no second ball.',
      obstacleParams: { ball: { scale: 2.6 / 1.6 } },
      removeObstacles: ['ball-2', 'ball-2-hatch'],
    },
    {
      id: 'pinball',
      weight: 2,
      weather: 'night',
      description: 'Extra bumpers under the floodlights.',
      addObstacles: [
        {
          id: 'bump-5',
          type: 'bumperPillar',
          position: v(0, 0, -14),
          params: { radius: 1, height: 2.4, bounceSpeed: 10 },
        },
        {
          id: 'bump-6',
          type: 'bumperPillar',
          position: v(0, 0, 14),
          params: { radius: 1, height: 2.4, bounceSpeed: 10 },
        },
        {
          id: 'bump-7',
          type: 'bumperPillar',
          position: v(-16, 0, 0),
          params: { radius: 1, height: 2.4, bounceSpeed: 10 },
        },
        {
          id: 'bump-8',
          type: 'bumperPillar',
          position: v(16, 0, 0),
          params: { radius: 1, height: 2.4, bounceSpeed: 10 },
        },
      ],
    },
    {
      id: 'windy-final',
      weight: 1,
      weather: 'windy',
      description: 'A crosswind gusts across the pitch in 15 s pulses.',
      addObstacles: [
        {
          id: 'w-cross',
          type: 'fanZone',
          position: v(-21, 4, 0),
          rotation: { yaw: 90 },
          params: {
            width: 64,
            height: 8,
            length: 42,
            strength: 3,
            falloff: 0,
            onTime: 15,
            offTime: 15,
            telegraphLead: 1.5,
            housingDepth: 0.8,
          },
        },
      ],
    },
  ],
  decorSeed: 3201,
  designNotes:
    'Point-symmetric (team 0 half mirrored through the centre spot). Goal trigger index = scoring team (rules/bots); frames, nets and ' +
    'crests use the defending colour. goalZone sends a scored ball back to its spawner (3 s respawn, dropped from y ≈ 10). ' +
    'Ball 2 rests on a pitched startGate hatch under the blimp (opens 60 s, 2 s countdown). Overtime 60 s golden goal via team ' +
    'rules. Deviations: no ball-only ceiling (schema has no collision-group pieces; stands are decorative so stray balls fall and ' +
    'respawn); pads moved 1 m inboard (±16) to clear the banked edges; ball mass/damping use propSpawner defaults (scale 1.125 ⇒ r 1.8); windy-final alternates on/off instead of flipping.',
});

/** Exported for tests: the bounce-pad solver used above. */
export { padLaunch };
