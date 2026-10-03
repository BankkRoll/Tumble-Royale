/**
 * S3 — Rising Goo Tower (LEVELS.md §5). A seven-tier jelly cake in a lake of
 * rising goo: climb by staircases (slow, safe) or bounce pads (fast, risky)
 * while the goo floods a tier every 15 s.
 *
 * Module mapping:
 * - `risingSlime` `sizeX/sizeZ/startY/schedule[{t,y}]` → `width/depth/
 *   keyframes[{t,h}]` with `easing: 'linear'` (the design is piecewise-linear);
 *   `surgeTelegraph` → `telegraphLead`. `waveAmplitude/wavePeriod` don't exist.
 * - `bouncePad` `targetApex/targetRange/landingDelta` → a solved local
 *   `launch` velocity (gravity 24 m/s², fall gravity ×2 in the controller).
 * - The spoon drips (`cannon`, `aim pattern` over 5 yaws, `activeFrom 60`) →
 *   five single-direction cannons with staggered `startDelay`.
 * - Staircases and pads are generated from the design's formula; the bot
 *   graph routes every tier's landings to the next tier's stairs/pads along
 *   arcs that avoid staircases and stray pads.
 */
import { defineRound } from '@tumble/shared';
import { hash01, polar, r3, round3, v3, yawTowardCentre, type ObstacleInput, type PieceInput, type WaypointInput } from '../tile-panic/kit.ts';

const DEG = Math.PI / 180;
/** Tier radii T0…T6. */
const R = [28, 20, 16.5, 13, 10, 7.5, 5] as const;
/** Tier top heights T0…T6. */
const TOP = [0, 7, 14, 21, 28, 35, 42] as const;
const TIER_BASE = -4;
const TIER_COLORS = ['primary', 'secondary', 'accent', 'primary', 'secondary', 'accent', 'primary'];

const rAt = (i: number): number => R[i] as number;
const topAt = (i: number): number => TOP[i] as number;

/** Staircase base angles (degrees) per transition Ti → Ti+1. */
const STAIR_BASES: readonly (readonly number[])[] = [[0, 180], [60, 240], [120, 300], [180, 0], [240], [300]];
/** Bounce pad polar angles (degrees) per transition, ids `pad-<i><a|b>`. */
const PAD_ANGLES: readonly (readonly number[])[] = [[90, 270], [150, 330], [210, 30], [270, 90], [60, 180], [210]];

/** Radial depth of transition i's staircase: min(3, ring − 0.5). */
const depthOf = (i: number): number => Math.min(3, rAt(i) - rAt(i + 1) - 0.5);
/** Radius of transition i's staircase centre line (and its pads). */
const rhoOf = (i: number): number => rAt(i + 1) + depthOf(i) / 2 + 0.05;
const STEP_COUNT = 5;
const STEP_RISE = 1.4;
const STEP_ARC = 3.2;

interface Stair {
  transition: number;
  base: number;
  /** Step centres on top (walk height) + box data. */
  steps: { centre: { x: number; y: number; z: number }; height: number; yaw: number; angle: number }[];
  /** Occupied polar interval (degrees, unwrapped from `base`). */
  span: [number, number];
}

const stairs: Stair[] = [];
for (let i = 0; i < STAIR_BASES.length; i++) {
  const rho = rhoOf(i);
  const dA = STEP_ARC / rho / DEG;
  for (const base of STAIR_BASES[i] as number[]) {
    const steps: Stair['steps'] = [];
    for (let k = 1; k <= STEP_COUNT; k++) {
      const a = base + k * dA;
      const h = STEP_RISE * k;
      steps.push({ centre: polar(rho, a, topAt(i) + h / 2), height: h, yaw: -a, angle: a });
    }
    stairs.push({ transition: i, base, steps, span: [base + dA - 1.5 / rho / DEG - 2, base + STEP_COUNT * dA + 1.5 / rho / DEG + 2] });
  }
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const geometry: PieceInput[] = [];
for (let i = 0; i < R.length; i++) {
  const h = topAt(i) - TIER_BASE;
  geometry.push({
    shape: 'cylinder',
    position: v3(0, TIER_BASE + h / 2, 0),
    size: v3(rAt(i), h, 0),
    color: TIER_COLORS[i] ?? 'primary',
    bevel: 0.3,
  });
  // Frosting band on the rim (deco).
  geometry.push({ shape: 'torus', position: v3(0, topAt(i) + 0.02, 0), size: v3(rAt(i) - 0.15, 0.3, 0), color: 'safe', decorative: true });
}
for (const s of stairs) {
  for (const st of s.steps) {
    geometry.push({
      shape: 'box',
      position: r3(st.centre),
      size: v3(depthOf(s.transition), st.height, 3.0),
      rotation: { yaw: round3(st.yaw) },
      color: 'neutral',
      bevel: 0.2,
    });
  }
}
// Cherry on top, at the very centre of T6 (stand-on-able bump, 0.5 m).
geometry.push({ shape: 'sphere', position: v3(0, topAt(6) - 0.4, 0), size: v3(0.9, 0.9, 0.9), color: 'danger', decorative: true });
// The giant spoon the drips fall from (deco).
geometry.push(
  { shape: 'sphere', position: v3(0, 53.5, 0), size: v3(4.2, 4.2, 4.2), color: '#d9dff2', decorative: true },
  { shape: 'cylinder', position: v3(9, 58, 6), size: v3(0.7, 16, 0), rotation: { yaw: 56, pitch: 0, roll: -55 }, color: '#d9dff2', decorative: true },
);
// Fruit-slice islands in the goo lake and bubbling beaker spires (deco).
for (let i = 0; i < 10; i++) {
  const p = polar(33 + hash01(2301, i) * 5, i * 36 + 12, -2.5);
  const s = 2 + hash01(5, i) * 2;
  geometry.push(
    { shape: 'cylinder', position: r3(p), size: v3(s, 0.8, 0), color: i % 2 ? 'accent' : '#ffb347', pattern: 'stripes', decorative: true },
    { shape: 'sphere', position: r3(v3(p.x, p.y + 1, p.z)), size: v3(s * 0.45, s * 0.45, s * 0.45), color: 'neutral', decorative: true },
  );
}
for (let i = 0; i < 4; i++) {
  const p = polar(37, i * 90 + 45, 6);
  geometry.push(
    { shape: 'cylinder', position: r3(p), size: v3(1.6, 16, 0), color: 'secondary', decorative: true },
    { shape: 'sphere', position: r3(v3(p.x, 15, p.z)), size: v3(2.2, 2.2, 2.2), color: 'accent', decorative: true },
  );
}

// -----------------------------------------------------------------------------
// Obstacles
// -----------------------------------------------------------------------------

/** Launch velocity solving apex 9 m over the pad, 7 m rise, ~3.5 m inward. */
const PAD_LAUNCH = { x: 0, y: 20.8, z: 3.2 };
/**
 * Pads are sunk into the tier so only 0.12 m stands proud.
 * NOTE: the controller turns any steep bouncy contact into a sideways bumper
 * kick at the pad's full launch speed (21 m/s), which flung climbers off the
 * cake; a 0.12 m lip keeps the walk-on contact reading as floor.
 */
const PAD_HEIGHT = 0.2;
const PAD_SINK = 0.08;

interface Pad {
  id: string;
  transition: number;
  angle: number;
  pos: { x: number; y: number; z: number };
}
const normDeg = (a: number): number => ((a % 360) + 360) % 360;
/** Angular distance (deg) from `a` to the interval [s0, s1]; 0 inside. */
function spanGap(a: number, [s0, s1]: [number, number]): number {
  const into = normDeg(a - s0);
  if (into <= s1 - s0) return 0;
  return Math.min(normDeg(s0 - a), into - (s1 - s0));
}

/**
 * Nearest angle to the design angle whose pad (on tier i) and landing (on
 * tier i+1) both stay clear of staircases.
 *
 * NOTE: LEVELS.md places each pad 90° from its own staircases, which lands it
 * in the middle of the *next* tier's staircase (rotated +60° per tier) — the
 * player would slam into 7 m of steps. Pads slide to the nearest clear angle.
 */
function clearPadAngle(i: number, design: number, avoid: readonly number[] = []): number | undefined {
  const own = stairs.filter((s) => s.transition === i).map((s) => s.span);
  const next = stairs.filter((s) => s.transition === i + 1).map((s) => s.span);
  const ownClear = 2.6 / rhoOf(i) / DEG;
  const nextClear = 2.6 / Math.max(rAt(i + 1) - 1.9, 1.5) / DEG;
  const padClear = 3.2 / rhoOf(i) / DEG;
  for (let d = 0; d <= 180; d += 2) {
    for (const a of [design + d, design - d]) {
      const apart = avoid.every((b) => Math.abs(normDeg(a - b + 180) - 180) >= padClear);
      if (apart && own.every((s) => spanGap(a, s) >= ownClear) && next.every((s) => spanGap(a, s) >= nextClear)) return normDeg(a);
    }
  }
  return undefined;
}

const pads: Pad[] = [];
PAD_ANGLES.forEach((angles, i) => {
  angles.forEach((design, k) => {
    const a = clearPadAngle(i, design);
    if (a === undefined) throw new Error(`rising-goo-tower: no clear pad angle for transition ${i}`);
    pads.push({ id: `pad-${i}${k === 0 ? 'a' : 'b'}`, transition: i, angle: a, pos: r3(polar(rhoOf(i), a, topAt(i))) });
  });
});
/** `bouncy-cake`: a second pad ~45° on from each pad where one fits clear of stairs and other pads. */
function extraPads(): Pad[] {
  const out: Pad[] = [];
  for (const p of pads) {
    const taken = [...pads, ...out].filter((o) => o.transition === p.transition).map((o) => o.angle);
    const a = clearPadAngle(p.transition, p.angle + 45, taken);
    // Narrow upper tiers may have no room left; those simply keep one pad.
    if (a === undefined) continue;
    out.push({ ...p, angle: a, pos: r3(polar(rhoOf(p.transition), a, topAt(p.transition))) });
  }
  return out;
}
const padObstacles = (list: Pad[], suffix = ''): ObstacleInput[] =>
  list.map((p) => ({
    id: `${p.id}${suffix}`,
    type: 'bouncePad',
    position: { ...p.pos, y: round3(p.pos.y - PAD_SINK) },
    rotation: { yaw: round3(yawTowardCentre(p.angle)) },
    params: { radius: 1.0, height: PAD_HEIGHT, launch: PAD_LAUNCH, cooldown: 0.35 },
  }));

const GOO_KEYS = [
  { t: 0, h: -3 },
  { t: 15, h: -3 },
  { t: 25, h: 3.5 },
  { t: 40, h: 7.5 },
  { t: 55, h: 14.5 },
  { t: 70, h: 21.5 },
  { t: 85, h: 28.5 },
  { t: 100, h: 35.5 },
  { t: 120, h: 38.5 },
];
const goo: ObstacleInput = {
  id: 'goo',
  type: 'risingSlime',
  position: v3(0, 0, 0),
  params: { width: 80, depth: 80, keyframes: GOO_KEYS, easing: 'linear', telegraphLead: 2, volumeDepth: 10 },
};

/** Spoon drips: 5 directions, one every 3 s from 60 s (each direction every 15 s). */
const drips: ObstacleInput[] = [0, 72, 144, 216, 288].map((yaw, i) => {
  const off = polar(0.9, -yaw + 90, 50);
  return {
    id: `drip-${i + 1}`,
    type: 'cannon',
    position: r3(off),
    rotation: { yaw },
    params: {
      pivotHeight: 1.6,
      barrelLength: 2.0,
      range: 5.5,
      // Lands on T5 (y 35): ring r 5–7.5 around the top disc.
      landingHeight: topAt(5) - 50,
      laneCount: 3,
      laneSpacing: 2.5,
      flightTime: 1.4,
      rollTime: 0.7,
      rollSpeed: 3,
      bounceHeight: 0.5,
      period: 15,
      startDelay: 60 + 3 * i,
      pattern: 'random',
      seed: 2301 + i,
      ballRadius: 0.8,
      knockImpulse: 7,
      aimTime: 1.0,
    },
  };
});

// -----------------------------------------------------------------------------
// Bot graph
// -----------------------------------------------------------------------------

/**
 * Builds the climb graph: per tier, every landing (or the spawn) gets an arc
 * chain to every stair entry / pad approach of that tier that can be reached
 * without crossing a staircase or another pad; stairs are jump chains; pads
 * are approach → (bounce) → landing on the next tier. T6 centre is the sink.
 */
function buildNav(): WaypointInput[] {
  const nav: WaypointInput[] = [];
  let nextId = 0;
  const add = (pos: { x: number; y: number; z: number }, radius: number, action: WaypointInput['action'] = 'run'): WaypointInput => {
    const w: WaypointInput = { id: nextId++, position: r3(pos), radius, next: [], action };
    nav.push(w);
    return w;
  };
  const link = (a: WaypointInput, b: WaypointInput): void => {
    (a.next ??= []).push(b.id);
  };
  const norm = (a: number): number => ((a % 360) + 360) % 360;
  /** Does the arc from a0 sweeping by `sweep` degrees cross the interval [s0, s1]? */
  const crosses = (a0: number, sweep: number, s0: number, s1: number): boolean => {
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 2));
    for (let k = 1; k < steps; k++) {
      const a = norm(a0 + (sweep * k) / steps);
      const lo = norm(s0);
      const len = s1 - s0;
      if (norm(a - lo) <= len) return true;
    }
    return false;
  };

  const top = add(v3(0, topAt(6), 0), 2.5);
  /** Sources on each tier: landings (T0: spawn). */
  const sources: { w: WaypointInput; angle: number }[][] = R.map(() => []);
  const spawnNode = add(v3(0, 0, -25), 3);
  (sources[0] as { w: WaypointInput; angle: number }[]).push({ w: spawnNode, angle: 270 });

  /** Staircase of transition `tier` whose occupied arc contains `angle`, if any. */
  const stairAt = (tier: number, angle: number): Stair | undefined =>
    stairs.find((s) => s.transition === tier && norm(angle - s.span[0]) <= s.span[1] - s.span[0]);
  const firstStep = new Map<Stair, WaypointInput>();
  const chains: [WaypointInput, Stair][] = [];

  /** Entry targets per tier. */
  const targets: { w: WaypointInput; angle: number; blockedBy: [number, number][] }[][] = R.map(() => []);
  for (let i = 0; i < 6; i++) {
    const rho = rhoOf(i);
    const tierStairs = stairs.filter((s) => s.transition === i);
    const tierPads = pads.filter((p) => p.transition === i);
    const padSpan = (p: Pad): [number, number] => [p.angle - 1.8 / rho / DEG, p.angle + 1.8 / rho / DEG];
    for (const s of tierStairs) {
      const entryAngle = s.base - 0.7 / rho / DEG;
      const entry = add(polar(rho, entryAngle, topAt(i)), 1.0, 'jump');
      let prev = entry;
      s.steps.forEach((st, k) => {
        const w = add(v3(st.centre.x, topAt(i) + st.height, st.centre.z), 1.0, k < STEP_COUNT - 1 ? 'jump' : 'run');
        link(prev, w);
        if (k === 0) firstStep.set(s, w);
        prev = w;
      });
      const landAngle = (s.steps[STEP_COUNT - 1] as Stair['steps'][number]).angle;
      // Upper staircases top out beside the next tier's first step (LEVELS.md chains them): hop straight across.
      const chainTo = i + 1 < 6 ? stairAt(i + 1, landAngle) : undefined;
      if (chainTo) {
        prev.action = 'jump';
        chains.push([prev, chainTo]);
      } else {
        const landing = add(polar(rAt(i + 1) - 1.6, landAngle, topAt(i + 1)), 1.4);
        link(prev, landing);
        (sources[i + 1] as { w: WaypointInput; angle: number }[]).push({ w: landing, angle: landAngle });
      }
      const blockedBy = [...tierStairs.filter((o) => o !== s).map((o) => o.span), ...(i === 0 ? [] : tierPads.map(padSpan)), s.span];
      (targets[i] as { w: WaypointInput; angle: number; blockedBy: [number, number][] }[]).push({ w: entry, angle: entryAngle, blockedBy });
    }
    for (const p of tierPads) {
      const approach = add(polar(Math.min(rho + 1.6, rAt(i) - 0.5), p.angle, topAt(i)), 0.9);
      const landing = add(polar(Math.max(rAt(i + 1) - 1.9, 1.5), p.angle, topAt(i + 1)), 1.6);
      link(approach, landing);
      (sources[i + 1] as { w: WaypointInput; angle: number }[]).push({ w: landing, angle: p.angle });
      const blockedBy = [...tierStairs.map((o) => o.span), ...(i === 0 ? [] : tierPads.filter((o) => o !== p).map(padSpan))];
      (targets[i] as { w: WaypointInput; angle: number; blockedBy: [number, number][] }[]).push({ w: approach, angle: p.angle, blockedBy });
    }
  }
  for (const src of sources[6] as { w: WaypointInput; angle: number }[]) link(src.w, top);
  for (const [from, stair] of chains) link(from, firstStep.get(stair) as WaypointInput);

  // Arc chains on each tier from every source to every reachable target.
  for (let i = 0; i < 6; i++) {
    // T0 walks its wide outer strip (pads sit inside it); upper rings walk the middle and dodge stairs and pads.
    const pathR = i === 0 ? 25.5 : (rAt(i) + rAt(i + 1)) / 2;
    for (const src of sources[i] as { w: WaypointInput; angle: number }[]) {
      let linked = 0;
      if (stairAt(i, src.angle)) throw new Error(`rising-goo-tower: tier ${i} landing inside a staircase`);
      for (const tgt of targets[i] as { w: WaypointInput; angle: number; blockedBy: [number, number][] }[]) {
        const d = norm(tgt.angle - src.angle);
        const options = [d, d - 360].sort((a, b) => Math.abs(a) - Math.abs(b));
        const sweep = options.find((sw) => !tgt.blockedBy.some(([s0, s1]) => crosses(src.angle, sw, s0, s1)));
        if (sweep === undefined) continue;
        let prev = src.w;
        const n = Math.floor(Math.abs(sweep) / 28);
        for (let k = 1; k <= n; k++) {
          const w = add(polar(pathR, src.angle + (sweep * k) / (n + 1), topAt(i)), 1.6);
          link(prev, w);
          prev = w;
        }
        link(prev, tgt.w);
        linked++;
      }
      if (linked === 0) throw new Error(`rising-goo-tower: tier ${i} source has no route`);
    }
  }
  return nav;
}

export default defineRound({
  id: 'rising-goo-tower',
  name: 'Rising Goo Tower',
  type: 'survival',
  theme: 'goo',
  objective: 'Climb the tower! The goo is rising.',
  tips: [
    'Stairs are slow and safe. Bounce pads are fast — if you aim well.',
    'The goo surges when the drums kick in. Get above it!',
    'The top is tiny. Get there early, or push your way in.',
  ],
  players: { min: 10, max: 40, ideal: 30 },
  qualification: { mode: 'survive', ratio: 0.6 },
  duration: { seconds: 120, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v3(-40, -15, -40), max: v3(40, 70, 40) },
  // NOTE: LEVELS.md says yaw 180 "facing the tower", but the grid sits at −z, so +Z (yaw 0) faces it.
  spawn: { origin: v3(0, 0.1, -25), yaw: 0, cols: 10, spacing: 1.3 },
  geometry,
  obstacles: [goo, ...padObstacles(pads), ...drips],
  triggers: [],
  flyover: {
    path: [v3(0, 8, -45), v3(35, 25, -20), v3(25, 45, 25), v3(0, 60, 0)],
    lookAt: [v3(0, 0, -24), v3(0, 14, 0), v3(0, 28, 0), v3(0, 42, 0)],
    duration: 6,
  },
  cameraMode: 'orbit',
  music: 'mus_goo_gloopgroove',
  speedScaleByStage: [1.0, 1.05, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  botNav: buildNav(),
  variations: [
    { id: 'slow-ooze', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'surge-storm',
      weight: 2,
      weather: 'stormy',
      description: 'The goo holds still, then surges a whole tier in 2 s.',
      obstacleParams: {
        goo: {
          keyframes: [
            { t: 0, h: -3 },
            { t: 20, h: -3 },
            { t: 22, h: 3.5 },
            { t: 35, h: 3.5 },
            { t: 37, h: 7.5 },
            { t: 50, h: 7.5 },
            { t: 52, h: 14.5 },
            { t: 65, h: 14.5 },
            { t: 67, h: 21.5 },
            { t: 80, h: 21.5 },
            { t: 82, h: 28.5 },
            { t: 95, h: 28.5 },
            { t: 97, h: 35.5 },
            { t: 120, h: 38.5 },
          ],
        },
      },
    },
    {
      id: 'sticky-steps',
      weight: 1,
      weather: 'clear',
      description: 'Staircases from T2 up are coated in sticky goo.',
      addObstacles: stairs
        .filter((s) => s.transition >= 2)
        .flatMap((s, si) =>
          s.steps.map((st, k) => ({
            id: `sticky-${si}-${k}`,
            type: 'stickyGoo',
            position: r3(v3(st.centre.x, topAt(s.transition) + st.height, st.centre.z)),
            rotation: { yaw: round3(st.yaw) },
            params: { shape: 'box', sizeX: depthOf(s.transition) - 0.2, sizeZ: 2.8, thickness: 0.12, surface: 'sticky' },
          })),
        ),
    },
    {
      id: 'bouncy-cake',
      weight: 2,
      weather: 'sunset',
      description: 'Extra pads everywhere: pads are duplicated ~45° around their tier wherever one fits.',
      addObstacles: padObstacles(extraPads(), '-x'),
    },
    { id: 'midnight-snack', weight: 1, weather: 'night', description: 'Goo glows; tiers outlined.' },
  ],
  decorSeed: 2301,
  designNotes: [
    'Seven solid cake tiers (r 28→5, top 0→42 in 7 m steps), 10 generated staircases (5 × 1.4 m jumps) and 11 bounce pads (apex ~9 m, ~3.5 m inward).',
    'Goo keyframes −3 → 38.5 (T0 floods at 25 s, then a tier per 15 s; T5 at 100 s leaves only the 10 m top disc).',
    'speedScaleByStage compresses the goo curve and cannon timing. No wave amplitude in risingSlime.',
    'Spoon drips from 60 s onto T5 (knock only). Pads slide off the design angles where those would land on the next tier\'s staircase; bouncy-cake duplicates likewise.',
    'sticky-steps stickyGoo pads sit on step tops (0.12 m proud). Bots: Sharp take pads more often via the greedy shortest route.',
  ].join(' '),
});

/** Generated parts, exported for the group-3 tests. */
export const risingGooParts = { stairs, pads, R, TOP };
