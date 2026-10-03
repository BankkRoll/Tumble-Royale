/**
 * T1 — Egg Heist (LEVELS.md §6). Three teams, a jungle temple clearing with a
 * giant egg pile on the central dais and one nest per team at 26 m. Score =
 * value of the eggs resting in your nest at the buzzer; golden eggs (worth 5)
 * are released from the temple vault at 60 s.
 *
 * Layout is authored for team 0 (at +Z) and rotated by 120° / 240° for teams 1
 * and 2, so the arena is 3-fold symmetric by construction.
 */
import { defineRound } from '@tumble/shared';
import {
  crestBoard,
  crowdStand,
  radial,
  rotObstacle,
  rotPiece,
  rotPoint,
  rotTrigger,
  team,
  teamBanner,
  v,
  wrapDeg,
} from '../group-4-kit.ts';

type Def = Parameters<typeof defineRound>[0];
type Piece = Def['geometry'][number];
type Obstacle = NonNullable<Def['obstacles']>[number];
type Trigger = NonNullable<Def['triggers']>[number];

/** Yaw-sense rotation that carries team 0's spoke (+Z) onto team k's. */
const teamRot = (k: number): number => wrapDeg(-120 * k);
const TEAMS = [0, 1, 2];
const NEST_R = 26;

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

/** Per-team pieces authored on team 0's spoke (+Z), coloured for team `t`. */
function spokePieces(t: number): Piece[] {
  return [
    // a.3 dais ramp toward the nest.
    {
      shape: 'ramp',
      position: v(0, 0.5, 9.5),
      size: v(4, 1, 3),
      rotation: { yaw: 180 },
      color: 'secondary',
      pattern: 'chevron',
    },
    // a.4 nest platform and a.5 basket rim (eggs stay in; players hop the 0.35 m tube).
    { shape: 'cylinder', position: v(0, 0.3, NEST_R), size: v(5, 0.6, 0), color: team(t), pattern: 'dots' },
    { shape: 'torus', position: v(0, 0.9, NEST_R), size: v(4.6, 0.35, 0), color: team(t) },
    // a.6 carved back wall with the team crest.
    { shape: 'box', position: v(0, 2, 32), size: v(10, 4, 1), color: 'neutral', bevel: 0.3 },
    ...crestBoard(t, v(0, 2.6, 31.35), 180, 2.6),
    // Woven basket posts around the nest.
    ...[-50, -25, 25, 50].map((a): Piece => ({
      shape: 'cylinder',
      position: v(5.4 * Math.sin((a * Math.PI) / 180), 1.0, NEST_R + 5.4 * Math.cos((a * Math.PI) / 180)),
      size: v(0.22, 2, 0),
      color: team(t),
      pattern: 'stripes',
      decorative: true,
    })),
    ...teamBanner(t, v(-4.6, 0, 30.6), 180, 6.5),
    ...teamBanner(t, v(4.6, 0, 30.6), 180, 6.5),
  ];
}

/** Outer ruin walls (a.8) flanking the raid lanes at θ = 18°/42° (+120° copies). */
function ruinWalls(): Piece[] {
  const out: Piece[] = [];
  for (const theta of [18, 42, 138, 162, 258, 282]) {
    const a = (theta * Math.PI) / 180;
    // θ is measured from +X toward +Z; the long side runs along the rim.
    out.push({
      shape: 'box',
      position: v(
        Math.round(33 * Math.cos(a) * 1000) / 1000,
        1.5,
        Math.round(33 * Math.sin(a) * 1000) / 1000,
      ),
      size: v(6, 3, 2),
      rotation: { yaw: wrapDeg(90 - theta) },
      color: 'neutral',
      bevel: 0.3,
      pattern: 'stripes',
    });
  }
  return out;
}

/** Temple pillars between the ramps (3, for exact 3-fold symmetry) and the vault canopy. */
function temple(): Piece[] {
  const pillars: Piece[] = radial(
    [{ shape: 'cylinder', position: v(0, 3, 6.5), size: v(0.8, 6, 0), color: 'neutral', pattern: 'stripes' }],
    3,
    60,
  );
  return [
    ...pillars,
    // Lintel ring on the pillar tops and a golden egg idol hovering over the vault (decor, open to the sky).
    { shape: 'torus', position: v(0, 6.2, 0), size: v(6.5, 0.35, 0), color: 'secondary', decorative: true },
    { shape: 'sphere', position: v(0, 8.4, 0), size: v(0.9, 0, 0), color: '#ffc83d', decorative: true },
    { shape: 'sphere', position: v(0, 7.7, 0), size: v(0.75, 0, 0), color: '#ffc83d', decorative: true },
    // Vault plinth the golden eggs rest on.
    { shape: 'cylinder', position: v(0, 1.1, 0), size: v(1.5, 0.2, 0), color: 'accent', pattern: 'checker' },
  ];
}

/** Jungle set dressing outside the play space (all decorative). */
function decor(): Piece[] {
  const out: Piece[] = [];
  // Giant stone tiki heads between the nests (θ = 30°, 150°, 270° spokes at R 42).
  for (const k of TEAMS) {
    const yaw = teamRot(k) + 180;
    const base = rotPoint(v(0, 0, -42), teamRot(k));
    out.push(
      {
        shape: 'box',
        position: v(base.x, 4, base.z),
        size: v(5, 8, 4),
        rotation: { yaw },
        color: 'neutral',
        bevel: 0.6,
        decorative: true,
      },
      {
        shape: 'box',
        position: rotPoint(v(0, 5, -39.8), teamRot(k)),
        size: v(3.6, 1.0, 0.6),
        rotation: { yaw },
        color: 'secondary',
        decorative: true,
      },
      {
        shape: 'sphere',
        position: rotPoint(v(-1.1, 6.2, -39.9), teamRot(k)),
        size: v(0.6, 0, 0),
        color: '#ffffff',
        decorative: true,
      },
      {
        shape: 'sphere',
        position: rotPoint(v(1.1, 6.2, -39.9), teamRot(k)),
        size: v(0.6, 0, 0),
        color: '#ffffff',
        decorative: true,
      },
    );
  }
  // Waterfalls pouring off the rim into the void, and lily-pad frog spectators.
  for (let i = 0; i < 6; i++) {
    const yaw = 30 + i * 60;
    out.push(
      {
        ...rotPiece(
          {
            shape: 'box',
            position: v(0, -4, 38),
            size: v(5, 12, 0.6),
            color: '#7fd8ff',
            decorative: true,
            pattern: 'stripes',
          },
          yaw,
        ),
      },
      {
        ...rotPiece(
          {
            shape: 'cylinder',
            position: v(0, -0.3, 47),
            size: v(3.2, 0.3, 0),
            color: 'primary',
            decorative: true,
          },
          yaw + 30,
        ),
      },
      ...crowdStand(
        rotPoint(v(0, 0, 47), yaw + 30),
        wrapDeg(yaw + 30 + 180),
        4.5,
        1,
        ['#6ee7a8', '#8cc45a', '#3ce6e0'],
        i,
      ),
    );
  }
  // Floating root islands with jungle trees, and glowing flowers around the clearing edge.
  for (let i = 0; i < 6; i++) {
    const p = rotPoint(v(0, 0, 41), i * 60);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, -1.5, p.z),
        size: v(3.4, 3, 0),
        color: '#b8956a',
        decorative: true,
      },
      {
        shape: 'cylinder',
        position: v(p.x, 4, p.z),
        size: v(0.45, 8, 0),
        color: '#b8956a',
        decorative: true,
        pattern: 'stripes',
      },
      { shape: 'sphere', position: v(p.x, 8.6, p.z), size: v(2.6, 0, 0), color: 'primary', decorative: true },
      {
        shape: 'sphere',
        position: v(p.x + 1.4, 7.6, p.z + 0.6),
        size: v(1.6, 0, 0),
        color: 'primary',
        decorative: true,
      },
    );
  }
  for (let i = 0; i < 12; i++) {
    const p = rotPoint(v(0, 0.6, 32.6), i * 30 + 15);
    out.push(
      {
        shape: 'cylinder',
        position: v(p.x, 0.6, p.z),
        size: v(0.12, 1.2, 0),
        color: 'primary',
        decorative: true,
      },
      {
        shape: 'sphere',
        position: v(p.x, 1.4, p.z),
        size: v(0.45, 0, 0),
        color: i % 2 ? 'accent' : 'danger',
        decorative: true,
      },
    );
  }
  return out;
}

const geometry: Piece[] = [
  // a.1 clearing floor r 34 (top 0) and a.2 temple dais r 8 (top 1.0).
  { shape: 'cylinder', position: v(0, -0.5, 0), size: v(34, 1, 0), color: 'primary' },
  { shape: 'cylinder', position: v(0, 0.5, 0), size: v(8, 1, 0), color: 'secondary', pattern: 'checker' },
  ...TEAMS.flatMap((k) => spokePieces(k).map((p) => rotPiece(p, teamRot(k)))),
  ...ruinWalls(),
  ...temple(),
  ...decor(),
];

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

/** Egg pile: 6 points on the dais × 5 eggs = 30 (LEVELS: area 10 × 10 around the vault). */
const pilePoints = [0, 60, 120, 180, 240, 300].map((a) => {
  const p = rotPoint(v(0, 0, 4), a + 30);
  return v(p.x, 0, p.z);
});

const perTeam: Obstacle[] = [
  {
    id: 'bump-0a',
    type: 'bumperPillar',
    position: v(-3, 0, 14),
    params: { radius: 0.9, height: 2.4, bounceSpeed: 8 },
  },
  {
    id: 'bump-0b',
    type: 'bumperPillar',
    position: v(3, 0, 14),
    params: { radius: 0.9, height: 2.4, bounceSpeed: 8 },
  },
  // Negative spin carries the top toward local +Z (the nest): helps carriers home, slows raiders leaving.
  {
    id: 'log-0',
    type: 'rollingDrum',
    position: v(0, 0.6, 19),
    rotation: { yaw: 0 },
    params: { length: 6, radius: 0.6, spinSpeed: -114.6, ridges: 6, ridgeHeight: 0.12 },
  },
  {
    id: 'nest-zone-0',
    type: 'goalZone',
    position: v(0, 0, NEST_R),
    params: {
      mode: 'nest',
      team: 0,
      sizeX: 8,
      sizeY: 3,
      sizeZ: 8,
      spawners: ['eggs', 'eggs-gold'],
      bonus: { 'eggs-gold': 4 },
      basketRadius: 4.6,
    },
  },
];

/** Golden-egg vault: four gates around the plinth that drop at 60 s (2 s countdown lights). */
const vault: Obstacle[] = [0, 90, 180, 270].map((yaw, i) => {
  const p = rotPoint(v(0, 1, -1.75), yaw);
  return {
    id: `vault-${i}`,
    type: 'startGate',
    position: p,
    rotation: { yaw },
    params: {
      width: 3.8,
      height: 2.8,
      thickness: 0.3,
      openTime: 60,
      style: 'drop',
      openDuration: 0.6,
      countdown: 2,
    },
  };
});

const obstacles: Obstacle[] = [
  {
    id: 'eggs',
    type: 'propSpawner',
    position: v(0, 1, 0),
    params: {
      kind: 'egg',
      points: pilePoints,
      perPoint: 5,
      idBase: 1000,
      respawnDelay: 3,
      respawnBelow: -12,
    },
  },
  {
    id: 'eggs-gold',
    type: 'propSpawner',
    position: v(0, 1.2, 0),
    params: {
      kind: 'egg',
      points: [v(0, 0, 0)],
      perPoint: 3,
      idBase: 1100,
      scale: 1.3,
      respawnDelay: 3,
      respawnBelow: -12,
    },
  },
  ...vault,
  ...TEAMS.flatMap((k) =>
    perTeam.map((o) => {
      const r = rotObstacle(o, teamRot(k), o.id.replace('0', String(k)));
      return o.type === 'goalZone' ? { ...r, params: { ...o.params, team: k } } : r;
    }),
  ),
  // Mud lanes between the nests (θ 30°/150°/270°, R 24).
  ...[30, 150, 270].map((theta, i): Obstacle => {
    const a = (theta * Math.PI) / 180;
    return {
      id: `mud-${i}`,
      type: 'stickyGoo',
      position: v(Math.round(24 * Math.cos(a) * 1000) / 1000, 0, Math.round(24 * Math.sin(a) * 1000) / 1000),
      rotation: { yaw: wrapDeg(90 - theta) },
      params: { shape: 'box', sizeX: 8, sizeZ: 8, surface: 'sticky' },
    };
  }),
];

// -----------------------------------------------------------------------------
// Triggers
// -----------------------------------------------------------------------------

const nest0: Trigger = {
  id: 'nest-0',
  kind: 'nest',
  position: v(0, 1.5, NEST_R),
  size: v(8, 3, 8),
  index: 0,
  respawn: [v(-2, 0.7, 24), v(0, 0.7, 24), v(2, 0.7, 24), v(-2, 0.7, 27), v(0, 0.7, 27), v(2, 0.7, 27)],
  respawnYaw: 180,
};
// Team rounds respawn at the checkpoint whose index is the player's team: the own nest.
const cp0: Trigger = { ...nest0, id: 'cp-0', kind: 'checkpoint', size: v(9, 3, 9) };

const triggers: Trigger[] = TEAMS.flatMap((k) => [
  rotTrigger(nest0, teamRot(k), `nest-${k}`, k),
  rotTrigger(cp0, teamRot(k), `cp-${k}`, k),
]);

// -----------------------------------------------------------------------------
// Bot hints: centre, spoke points at R 14 / 22, nest centres
// -----------------------------------------------------------------------------

const botNav: NonNullable<Def['botNav']> = [
  { id: 0, position: v(0, 1, 0), radius: 4, next: [] },
  ...TEAMS.flatMap((k) =>
    [14, 22, NEST_R].map((r, j) => ({
      id: 100 * (k + 1) + j,
      position: rotPoint(v(0, 0, r), teamRot(k)),
      radius: j === 2 ? 3 : 2,
      next: [] as number[],
    })),
  ),
];

export default defineRound({
  id: 'egg-heist',
  name: 'Egg Heist',
  type: 'team',
  theme: 'jungle',
  objective: 'Bring eggs to your nest. Steal theirs!',
  tips: [
    "Hold Grab to pick up an egg. You can't jump high while carrying.",
    'Golden eggs appear at 60 s and are worth 5.',
    'Guard your nest — or raid someone else’s.',
  ],
  players: { min: 9, max: 100, ideal: 75 },
  qualification: { mode: 'teamScore', teams: 3, teamsEliminated: 1, ratio: 0.67 },
  duration: { seconds: 120, overtimeSeconds: 0 },
  killY: -8,
  bounds: { min: v(-45, -15, -45), max: v(45, 25, 45) },
  spawn: {
    origin: v(0, 0, 0),
    yaw: 180,
    cols: 16,
    spacing: 1.3,
    teamOrigins: TEAMS.map((k) => {
      const p = rotPoint(v(0, 0.7, 17.6), teamRot(k));
      return v(p.x, 0.7, p.z);
    }),
  },
  geometry,
  obstacles,
  triggers,
  flyover: {
    path: [v(0, 30, 45), v(40, 22, 0), v(0, 18, -40), v(-30, 14, 10)],
    lookAt: [v(0, 1, 0)],
    duration: 5,
  },
  cameraMode: 'orbit',
  music: 'mus_jungle_bongobounce',
  speedScaleByStage: [1, 1, 1, 1, 1],
  fallBehavior: 'respawnCheckpoint',
  botNav,
  variations: [
    { id: 'jungle-classic', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'scramble',
      weight: 2,
      weather: 'clear',
      description: 'A smaller pile, and eggs rain across the whole clearing at the whistle.',
      obstacleParams: { eggs: { perPoint: 2 } },
      addObstacles: [
        {
          id: 'eggs-rain',
          type: 'propSpawner',
          position: v(0, 14, 0),
          params: {
            kind: 'egg',
            idBase: 1200,
            respawnDelay: 15,
            respawnBelow: -25,
            points: [0, 40, 80, 120, 160, 200, 240, 280, 320].flatMap((a) => [
              rotPoint(v(0, 0, 13), a),
              rotPoint(v(0, 0, 21), a + 20),
            ]),
          },
        },
      ],
    },
    {
      id: 'golden-glut',
      weight: 1,
      weather: 'sunset',
      description: 'The vault opens at 30 s with five golden eggs.',
      obstacleParams: {
        'eggs-gold': { perPoint: 5 },
        ...Object.fromEntries(vault.map((g) => [g.id, { openTime: 30 }])),
      },
    },
    {
      id: 'monsoon',
      weight: 1,
      weather: 'stormy',
      description: 'Gusting wind across the clearing and slick mud lanes.',
      obstacleParams: {
        'mud-0': { surface: 'slime' },
        'mud-1': { surface: 'slime' },
        'mud-2': { surface: 'slime' },
      },
      addObstacles: [
        {
          id: 'w-gust',
          type: 'fanZone',
          position: v(-36, 2.5, 0),
          rotation: { yaw: 90 },
          params: {
            width: 70,
            height: 5,
            length: 72,
            strength: 3,
            falloff: 0,
            onTime: 5,
            offTime: 2,
            telegraphLead: 1,
            housingDepth: 0.8,
          },
        },
      ],
    },
  ],
  decorSeed: 3101,
  designNotes:
    'Team 0 spoke authored at +Z, rotated ±120° (yaw = −120·k). Nest triggers (index = owner) score 1 per egg resting inside; ' +
    'goalZone nest instances add the golden bonus (+4) as live team points and fire deposit cues. Golden eggs wait in a vault of ' +
    'four startGates (openTime 60, 2 s countdown) on the dais plinth. Respawn = own nest (checkpoint index = team). ' +
    'Deviations: 3 temple pillars instead of 4 (exact 3-fold symmetry); propSpawner has no per-egg mass/bounciness; mud uses the ' +
    'sticky surface tuning instead of speedMul/jumpMul; LEVELS tie-break (later final score loses) maps to team rules (earlier score wins).',
});
