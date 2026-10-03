/**
 * F4 — Goo Peak Final (LEVELS.md §9). A stepped jelly mountain of cracking
 * hex rings in a lake of rising goo; climb, carve, and be the last one above
 * the goo.
 *
 * Layout fix: LEVELS.md gives ring k radii 21 − 3k … 24 − 3k, which makes
 * ring 7 a 0–3 m disc directly under the r 3 summit. Rings are shifted out
 * one step (ring k: 24 − 3k … 27 − 3k; ring 0 widened to 32 so the spawn
 * grid sits outside its climbing line), keeping all nine tiers, the +1.5 m
 * zero-gap steps and the goo heights that flood ring k at 1.5k + 0.5.
 *
 * Module mapping:
 * - Annulus/disc masks → {@link tileField} hex blocks (design circumradius
 *   1.2 ⇒ flat-to-flat 2.08); `shakeTime` → `warnTime`.
 * - Summit timed drops (185 / 190 / 195 s) → the summit's outer rows become
 *   crumbly at 180 / 188 s; the middle row holds to the cap.
 *   Ring random drops and the shake schedule have no module equivalent; each
 *   ring instead starts cracking 20 s before the goo floods it, so the
 *   crumbling band rides just above the goo.
 * - Goo `schedule` → `keyframes` (linear); the last key stops just under the
 *   summit top (11.85) so the end is decided by the crumbling summit or the
 *   hard cap (highest survivor) — a full flood would eliminate everyone in
 *   the same tick and crown nobody.
 * - Summit geyser (`cannon` aim pattern of 6 yaws) → two back-to-back
 *   three-lane cannons under the summit, alternating every 4 s from 70 s.
 */
import { defineRound } from '@tumble/shared';
import {
  hash01,
  overrideAll,
  polar,
  r3,
  round3,
  tileField,
  v3,
  type ObstacleInput,
  type PieceInput,
  type WaypointInput,
} from '../tile-panic/kit.ts';

/** Design circumradius 1.2 m ⇒ flat-to-flat 2.08 m. */
const HEX = 2.08;
const GAP = 0.08;
const RING_COUNT = 8;
const SUMMIT_Y = 12;
const SUMMIT_R = 3;
const ringIn = (k: number): number => 24 - 3 * k;
const ringOut = (k: number): number => (k === 0 ? 32 : 27 - 3 * k);
const ringY = (k: number): number => 1.5 * k;
/**
 * Masks test tile centres, and a hex reaches ~1 m past its centre, so every
 * ring is pulled in by 0.9 m: the next ring's outer tile edges then land on
 * the nominal radius instead of overhanging the ring below by a whole tile.
 */
const MASK_SHIFT = 0.9;
/** Seconds at which each ring floods (goo reaches its top + 0.5 m). */
const FLOOD = [35, 55, 70, 85, 100, 115, 130, 150] as const;
/**
 * A ring starts cracking 20 s before the goo reaches it (the spawn ring at
 * 15 s): the crumbling band rides just above the goo and herds the climb.
 */
const ringWake = (k: number): number => (FLOOD[k] as number) - 20;

const ringFields = Array.from({ length: RING_COUNT }, (_, k) =>
  tileField({
    idPrefix: `ring-${k}`,
    shape: 'hex',
    tileSize: HEX,
    gap: GAP,
    thickness: 0.5,
    warnTime: 1.4,
    startTime: ringWake(k),
    centre: v3(0, ringY(k), 0),
    extent: ringOut(k) + 1,
    include: (x, z) => {
      const r = Math.hypot(x, z);
      // Ring 7 stops at the summit so no tile sits 1 m under another.
      return (
        r >= Math.max(ringIn(k) - MASK_SHIFT, k === RING_COUNT - 1 ? SUMMIT_R : 0) &&
        r < ringOut(k) - MASK_SHIFT
      );
    },
  }),
);
/**
 * Summit rows crumble in turn: south row from 180 s, north row 188 s. The
 * middle row holds to the hard cap — if it crumbled, everyone left would drop
 * in the same tick and the final would crown nobody.
 */
const summit = tileField({
  idPrefix: 'summit',
  shape: 'hex',
  tileSize: HEX,
  gap: GAP,
  thickness: 0.5,
  warnTime: 2.0,
  startTime: ({ row }) => (row < 0 ? 180 : row > 0 ? 188 : 200),
  mergeRows: false,
  centre: v3(0, SUMMIT_Y, 0),
  extent: SUMMIT_R + 1,
  include: (x, z) => Math.hypot(x, z) < SUMMIT_R,
});
const ringTiles = ringFields.flatMap((f) => f.instances);

const GOO_KEYS = [
  { t: 0, h: -2 },
  { t: 20, h: -2 },
  { t: 35, h: 0.5 },
  { t: 55, h: 2.0 },
  { t: 70, h: 3.5 },
  { t: 85, h: 5.0 },
  { t: 100, h: 6.5 },
  { t: 115, h: 8.0 },
  { t: 130, h: 9.5 },
  { t: 150, h: 11.0 },
  { t: 175, h: 11.6 },
  { t: 195, h: 11.85 },
];
/** `lava-lamp`: the same heights at the same times, each reached by a 2 s surge after a hold. */
const GOO_STEPPED = GOO_KEYS.flatMap((k, i) => {
  const prev = GOO_KEYS[i - 1];
  return prev && k.t - prev.t > 2 ? [{ t: k.t - 2, h: prev.h }, k] : [k];
});
const goo: ObstacleInput = {
  id: 'goo',
  type: 'risingSlime',
  position: v3(0, 0, 0),
  params: { width: 70, depth: 70, keyframes: GOO_KEYS, easing: 'linear', telegraphLead: 2, volumeDepth: 10 },
};

/** Geyser under the summit: pivot just below the summit tiles, nozzle poking through. */
const spouts: ObstacleInput[] = [0, 180].map((yaw, i) => ({
  id: `spout-${i + 1}`,
  type: 'cannon',
  position: v3(0, 9, 0),
  rotation: { yaw },
  params: {
    pivotHeight: 2.4,
    barrelLength: 2.0,
    range: 12,
    // Lands on ring 4 (top 6, r 12–15).
    landingHeight: ringY(4) - 9,
    laneCount: 3,
    // ±37° fan ⇒ with the back-to-back pair, six lob directions like the design's patternYaws.
    laneSpacing: 9,
    flightTime: 1.3,
    rollTime: 0.8,
    rollSpeed: 5,
    bounceHeight: 0.6,
    period: 8,
    startDelay: 70 + 4 * i,
    pattern: 'random',
    seed: 9401 + i,
    ballRadius: 0.7,
    knockImpulse: 8,
    aimTime: 1.0,
  },
}));

// -----------------------------------------------------------------------------
// Set dressing
// -----------------------------------------------------------------------------

const geometry: PieceInput[] = [
  // Jelly mountain core under the rings (deco; the rings float).
  { shape: 'cylinder', position: v3(0, -6, 0), size: v3(26, 8, 0), color: 'neutral', decorative: true },
  // Geyser crater rim under the summit.
  { shape: 'torus', position: v3(0, 11.2, 0), size: v3(1.6, 0.35, 0), color: 'danger', decorative: true },
];
// Fruit islands with gummy crowds around the lake.
for (let i = 0; i < 20; i++) {
  const p = polar(34 + hash01(9401, i) * 22, i * 18 + hash01(2, i) * 9, -3.5);
  const s = 2 + hash01(3, i) * 4;
  geometry.push({
    shape: 'sphere',
    position: r3(p),
    size: v3(s, s, s),
    color: i % 3 === 0 ? '#ffb347' : 'accent',
    decorative: true,
  });
  if (i % 2 === 0) {
    geometry.push({
      shape: 'cylinder',
      position: r3(v3(p.x, p.y + s * 0.8, p.z)),
      size: v3(0.5, 1.2, 0),
      color: 'danger',
      decorative: true,
    });
  }
}
// Lab-glass spires with goo drips.
for (let i = 0; i < 6; i++) {
  const p = polar(40, i * 60, 4);
  geometry.push(
    {
      shape: 'cylinder',
      position: r3(p),
      size: v3(1.4, 18, 0),
      color: 'secondary',
      pattern: 'stripes',
      decorative: true,
    },
    {
      shape: 'sphere',
      position: r3(v3(p.x, 14, p.z)),
      size: v3(2.4, 2.4, 2.4),
      color: 'safe',
      decorative: true,
    },
  );
}

// -----------------------------------------------------------------------------
// Bot climb graph
// -----------------------------------------------------------------------------

/** Climbing lines on ring 0, about this far apart (m); inner rings merge lines. */
const LINE_SPACING = 3;
/**
 * Bot climb graph: straight hop lines up the rings. A node sits 2.2 m outside
 * the next ring's edge, which is also where a hop from the ring below lands,
 * so bots chain jumps with full inward speed (a sideways arrival kills the
 * jump; walking along a 3 m crumbling ring proved fatal). The rings below the
 * goo line are still solid (see {@link ringWake}), so the race to the summit
 * is safe; the danger is the summit crush and the rising crumble band.
 */
function buildNav(): WaypointInput[] {
  const nav: WaypointInput[] = [{ id: 0, position: v3(0, SUMMIT_Y, 0), radius: 2, next: [] }];
  const nodeR = (k: number): number => ringIn(k) + 2.2;
  const countOf = (k: number): number =>
    Math.max(6, Math.round((2 * Math.PI * nodeR(0) * (nodeR(k) / nodeR(0))) / LINE_SPACING));
  const idOf = (k: number, j: number): number => 1000 * (k + 1) + j;
  for (let k = 0; k < RING_COUNT; k++) {
    const n = countOf(k);
    const nIn = k + 1 < RING_COUNT ? countOf(k + 1) : 0;
    for (let j = 0; j < n; j++) {
      const angle = (360 / n) * j;
      nav.push({
        id: idOf(k, j),
        position: r3(polar(nodeR(k), angle, ringY(k))),
        radius: k === 0 ? 0.5 : 0.8,
        next: [nIn > 0 ? idOf(k + 1, Math.round((angle / 360) * nIn) % nIn) : 0],
        action: 'jump',
      });
    }
  }
  return nav;
}

export default defineRound({
  id: 'goo-peak-final',
  name: 'Goo Peak Final',
  type: 'final',
  theme: 'goo',
  objective: 'Climb above the goo. Last one standing wins!',
  tips: [
    'Rings crack under you as the goo closes in. Keep climbing.',
    'The goo never stops. The summit is tiny.',
    'Breaking the ring above a rival can strand them.',
  ],
  players: { min: 1, max: 15, ideal: 8 },
  qualification: { mode: 'lastStanding' },
  duration: { seconds: 200, overtimeSeconds: 0 },
  killY: -10,
  bounds: { min: v3(-35, -15, -35), max: v3(35, 40, 35) },
  spawn: { origin: v3(0, 0.1, -28.2), yaw: 0, cols: 12, spacing: 1.3 },
  geometry,
  obstacles: [...ringTiles, ...summit.instances, goo, ...spouts],
  triggers: [],
  flyover: {
    path: [v3(0, 8, -45), v3(35, 16, 0), v3(0, 22, 30), v3(-18, 20, -10)],
    lookAt: [v3(0, 0, -22), v3(0, 6, 0), v3(0, 12, 0), v3(0, 12, 0)],
    duration: 6,
  },
  cameraMode: 'orbit',
  music: 'mus_final_crownfever',
  speedScaleByStage: [1.0, 1.0, 1.1, 1.15, 1.2],
  fallBehavior: 'eliminate',
  botNav: buildNav(),
  variations: [
    { id: 'ooze-peak', weight: 4, weather: 'clear', description: 'As authored.' },
    {
      id: 'lava-lamp',
      weight: 2,
      weather: 'night',
      description: 'Goo glows; it holds still, then surges to each new height in 2 s.',
      obstacleParams: { goo: { keyframes: GOO_STEPPED } },
    },
    {
      id: 'brittle-rings',
      weight: 1,
      weather: 'clear',
      description: 'Odd rings are brittle candy glass: they drop almost as soon as you land.',
      obstacleParams: overrideAll(
        ringFields.filter((_, k) => k % 2 === 1).flatMap((f) => f.instances),
        { warnTime: 0.6 },
      ),
    },
  ],
  decorSeed: 9401,
  designNotes: [
    `Eight hex rings (3 m wide, +1.5 m zero-gap steps; ring 0 r 24–32) and an r 3 summit at y 12, ${ringTiles.length + summit.instances.length} fallingTiles blocks.`,
    'Rings crack on touch (1.4 s) from 20 s before their flood (ring 0 at 15 s … ring 7 at 130 s); the summit is solid until its outer rows turn crumbly at 180 / 188 s (2.0 s); its middle row holds to the cap.',
    'Goo floods ring k at 1.5k + 0.5 (ring 0 at 35 s … ring 7 at 150 s), then creeps to 11.85, just under the summit top. speedScaleByStage compresses the goo but not the tile wake times.',
    'Variation slippery-slope (odd rings ice) is impossible without a fallingTiles surface param → brittle-rings.',
    `Geyser lobs from 70 s onto ring 4. Expected (humans): 2–3 alive at 150 s, winner 160–200 s; bot finals end ~80–100 s (summit shoving). Spawn grid: ring 0 south (${round3(ringOut(0))} m outer edge).`,
  ].join(' '),
});

/** Generated parts, exported for the group-3 tests. */
export const gooPeakParts = { ringFields, summit, ringIn, ringOut, ringY };
