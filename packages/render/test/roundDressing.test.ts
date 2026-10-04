/**
 * Set-dressing placement audit for every round (every show round, the test
 * arena and Practice Island) × every variation × every weather the round's
 * theme allows × every quality tier's environment detail.
 *
 * Builds the real environment headlessly (`createEnvironment`, exactly as the
 * round view calls it) and checks where its backdrop props ended up
 * (`env.dressing`):
 * - no cloud drift lane, island, balloon column, blimp orbit or spectator
 *   stand touches the course (`measureCourse`) padded by the gameplay
 *   camera's reach, measured from the camera rig's own settings;
 * - none of them is in front of the intro flyover camera: the camera path is
 *   recorded from a real `ThirdPersonCamera` playing the round's flyover the
 *   way the round view starts it, and every frame's camera position and its
 *   sightline to the look-at target must stay clear;
 * - stands sit at the floor they watch (never sunk under the course) and
 *   face the course.
 */
import { PerspectiveCamera, type Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS } from '@tumble/content/rounds';
import { TUTORIAL_ROUND_INPUT } from '@tumble/content/rounds/practice-island';
import { getTheme, type Weather } from '@tumble/content/themes';
import { RoundDefinitionSchema, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createMatchSim, createSimpleController, measureCourse, type CourseBox } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { DEFAULT_CAMERA_SETTINGS, ThirdPersonCamera } from '../src/camera/index.ts';
import {
  CAMERA_REACH,
  FLYOVER_CLEARANCE,
  SIGHTLINE_CLEARANCE,
  createEnvironment,
  roundDressing,
  standBox,
  type BoxLike,
  type EnvironmentDressing,
  type Vec3Like,
} from '../src/environment/index.ts';
import { QUALITY_PRESETS, QUALITY_TIERS } from '../src/quality/presets.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const ALL_ROUNDS: RoundDefinition[] = [...ROUNDS, TUTORIAL_ROUND_INPUT].map((r) =>
  RoundDefinitionSchema.parse(r),
);

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

const HUGE = 1e7;

function pointBoxDistance(p: Vec3Like, b: BoxLike): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

function grow(b: BoxLike, r: number): BoxLike {
  return {
    min: { x: b.min.x - r, y: b.min.y - r, z: b.min.z - r },
    max: { x: b.max.x + r, y: b.max.y + r, z: b.max.z + r },
  };
}

/** Slab test: does segment a→b touch box `box`? */
function segmentHitsBox(a: Vec3Like, b: Vec3Like, box: BoxLike): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) {
      if (a[k] < box.min[k] || a[k] > box.max[k]) return false;
      continue;
    }
    let ta = (box.min[k] - a[k]) / d;
    let tb = (box.max[k] - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Distance between a segment and a box. The point-to-box distance is convex
 * along the segment, so a ternary search finds its minimum; the slab test
 * skips the search for boxes farther than `cap` (the answer is then `cap`).
 */
function segmentBoxDistance(a: Vec3Like, b: Vec3Like, box: BoxLike, cap: number): number {
  if (!segmentHitsBox(a, b, grow(box, cap))) return cap;
  const at = (t: number): number =>
    pointBoxDistance({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, box);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (at(m1) <= at(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(cap, at((lo + hi) / 2), at(0), at(1));
}

// -----------------------------------------------------------------------------
// Camera reach
// -----------------------------------------------------------------------------

/** How far the gameplay camera can get from the followed Tumbler's feet, from the rig's own settings. */
interface Reach {
  side: number;
  up: number;
  down: number;
}

/**
 * Worst-case camera offsets in the follow modes: the arm at any allowed pitch
 * behind a pivot that leads the player by up to `lookAheadMax`.
 */
function rigReach(mode: 'orbit' | 'sideFixed' | 'topDownTilt'): Reach {
  const s = DEFAULT_CAMERA_SETTINGS;
  const arm = (pitch: number, dist: number): { h: number; v: number } => ({
    h: Math.cos(pitch) * dist,
    v: Math.sin(pitch) * dist,
  });
  const pitches =
    mode === 'orbit' ? [s.pitchMin, 0, s.pitchMax] : mode === 'sideFixed' ? [0.18] : [s.topDownPitch];
  const dist = mode === 'orbit' ? s.distance : mode === 'sideFixed' ? s.sideDistance : s.topDownDistance;
  let side = 0;
  let up = 0;
  let down = 0;
  for (const p of pitches) {
    const a = arm(p, dist);
    side = Math.max(side, a.h + s.lookAheadMax);
    up = Math.max(up, s.pivotHeight + a.v);
    down = Math.max(down, -(s.pivotHeight + a.v));
  }
  return { side, up, down };
}

function padded(course: CourseBox, r: Reach): BoxLike {
  return {
    min: { x: course.min.x - r.side, y: course.min.y - r.down, z: course.min.z - r.side },
    max: { x: course.max.x + r.side, y: course.max.y + r.up, z: course.max.z + r.side },
  };
}

// -----------------------------------------------------------------------------
// Flyover
// -----------------------------------------------------------------------------

interface FlyoverFrame {
  cam: Vec3Like;
  look: Vec3Like;
}

/**
 * Records the intro flyover frame by frame from a real camera rig, started
 * with the same arguments as `RoundView.playFlyover`.
 */
function recordFlyover(round: RoundDefinition): FlyoverFrame[] {
  const camera = new PerspectiveCamera();
  const rig = new ThirdPersonCamera(camera, { yaw: round.spawn.yaw });
  const f = round.flyover;
  let points = f.path;
  if (points.length < 2) {
    const o = round.spawn.origin;
    points = [
      { x: o.x - 18, y: o.y + 14, z: o.z - 12 },
      { x: o.x + 18, y: o.y + 10, z: o.z + 12 },
    ];
  }
  let done = false;
  rig.playFlyover({
    points,
    lookAts: f.lookAt.length ? f.lookAt : [round.spawn.origin],
    duration: Math.max(1, f.duration),
    then: 'orbit',
    onDone: () => (done = true),
  });
  const target = { position: round.spawn.origin, velocity: { x: 0, y: 0, z: 0 }, grounded: true };
  const look = (rig as unknown as { lookTarget: Vector3 }).lookTarget;
  const frames: FlyoverFrame[] = [];
  for (let i = 0; i < 10_000 && !done; i++) {
    rig.update(1 / 30, target);
    frames.push({
      cam: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      look: { x: look.x, y: look.y, z: look.z },
    });
  }
  return frames;
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface Prop {
  label: string;
  box: BoxLike;
}

/** Blimp hull half length / radius at instance scale, plus its 1.5 m bob (mirrors balloons.ts). */
const BLIMP_HALF = 7.7;
const BLIMP_HALF_HEIGHT = 3 + 1.5;

/** World boxes for every prop the environment placed (blimp orbits sampled densely). */
function propsOf(d: EnvironmentDressing): Prop[] {
  const props: Prop[] = [];
  d.clouds.forEach((c, i) =>
    props.push({
      label: `cloud ${i}`,
      box: {
        min: { x: -HUGE, y: c.lane.y0 + d.cloudOrigin.y, z: c.lane.z0 + d.cloudOrigin.z },
        max: { x: HUGE, y: c.lane.y1 + d.cloudOrigin.y, z: c.lane.z1 + d.cloudOrigin.z },
      },
    }),
  );
  d.islands.forEach((s, i) => props.push({ label: `island ${i}`, box: s.bounds }));
  d.balloonColumns.forEach((b, i) => props.push({ label: `balloon ${i}`, box: b }));
  d.blimpOrbits.forEach((o, i) => {
    const steps = Math.max(48, Math.ceil((o.radius * Math.PI * 2) / 4));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = d.center.x + Math.cos(a) * o.radius;
      const z = d.center.z + Math.sin(a) * o.radius;
      props.push({
        label: `blimp ${i}`,
        box: {
          min: { x: x - BLIMP_HALF, y: o.height - BLIMP_HALF_HEIGHT, z: z - BLIMP_HALF },
          max: { x: x + BLIMP_HALF, y: o.height + BLIMP_HALF_HEIGHT, z: z + BLIMP_HALF },
        },
      });
    }
  });
  d.stands.forEach((s, i) =>
    props.push({
      label: `stand ${i}`,
      box: standBox({ position: s.position, yaw: s.yaw, width: s.width ?? 16, rows: s.rows ?? 4 }),
    }),
  );
  return props;
}

function overlaps(a: BoxLike, b: BoxLike): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

// -----------------------------------------------------------------------------
// Audit
// -----------------------------------------------------------------------------

interface Case {
  round: RoundDefinition;
  variationId: string | null;
  course: CourseBox;
}

function courseFor(round: RoundDefinition, variationId: string | null): CourseBox {
  const sim = createMatchSim(
    {
      R,
      round,
      seed: 1,
      stage: 0,
      players: [],
      mode: 'offline',
      ...(variationId ? { variationId } : {}),
    },
    { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
  );
  expect(sim.warnings, `${round.id}/${variationId}`).toEqual([]);
  // The round view measures `sim.round`: variations add, move and remove obstacles.
  const course = measureCourse(sim.round, sim.obstacleRuntimes);
  sim.dispose();
  return course;
}

function weathersFor(round: RoundDefinition): Weather[] {
  const theme = getTheme(round.theme);
  const set = new Set<Weather>([theme.weather.default, ...theme.weather.allowed]);
  for (const v of round.variations) if (v.weather !== 'clear') set.add(v.weather);
  return [...set];
}

/** Box around every flyover camera position and look target, grown by `r`. */
function flyoverBounds(frames: readonly FlyoverFrame[], r: number): BoxLike {
  const b: BoxLike = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const f of frames)
    for (const p of [f.cam, f.look])
      for (const k of ['x', 'y', 'z'] as const) {
        b.min[k] = Math.min(b.min[k], p[k]);
        b.max[k] = Math.max(b.max[k], p[k]);
      }
  return grow(b, r);
}

/** Problems found for one environment, as readable strings. */
function audit(c: Case, flyover: readonly FlyoverFrame[], d: EnvironmentDressing): string[] {
  const out: string[] = [];
  const reachBox = padded(c.course, rigReach(c.round.cameraMode));
  const contractBox = padded(c.course, CAMERA_REACH);
  const near = flyoverBounds(flyover, Math.max(FLYOVER_CLEARANCE, SIGHTLINE_CLEARANCE));
  for (const p of propsOf(d)) {
    if (overlaps(p.box, reachBox)) out.push(`${p.label} inside the gameplay camera's reach of the course`);
    else if (overlaps(p.box, contractBox)) out.push(`${p.label} inside the course padded by CAMERA_REACH`);
    if (!overlaps(p.box, near)) continue;
    let cam = Infinity;
    let sight = Infinity;
    for (const f of flyover) {
      cam = Math.min(cam, pointBoxDistance(f.cam, p.box));
      sight = Math.min(sight, segmentBoxDistance(f.cam, f.look, p.box, SIGHTLINE_CLEARANCE));
    }
    if (cam < FLYOVER_CLEARANCE)
      out.push(`${p.label} ${cam.toFixed(2)} m from the flyover camera (< ${FLYOVER_CLEARANCE})`);
    if (sight < SIGHTLINE_CLEARANCE)
      out.push(`${p.label} ${sight.toFixed(2)} m from a flyover sightline (< ${SIGHTLINE_CLEARANCE})`);
  }
  return out;
}

const CASES: { round: RoundDefinition; variationId: string | null }[] = ALL_ROUNDS.flatMap((round) => [
  { round, variationId: null },
  ...round.variations.map((v) => ({ round, variationId: v.id })),
]);

describe('round dressing', () => {
  it('the dressing keep-out covers the camera rig reach in every follow mode rounds use', () => {
    for (const mode of new Set(ALL_ROUNDS.map((r) => r.cameraMode))) {
      const r = rigReach(mode);
      expect(CAMERA_REACH.side, mode).toBeGreaterThanOrEqual(r.side);
      expect(CAMERA_REACH.up, mode).toBeGreaterThanOrEqual(r.up);
      expect(CAMERA_REACH.down, mode).toBeGreaterThanOrEqual(r.down);
    }
  });

  it.each(ALL_ROUNDS.map((r) => [r.id, r] as const))(
    '%s: props clear the course, camera reach and intro flyover; stands face the course',
    (_id, round) => {
      const theme = getTheme(round.theme);
      const flyover = recordFlyover(round);
      expect(flyover.length).toBeGreaterThan(10);
      const problems: string[] = [];
      let envs = 0;
      for (const { variationId } of CASES.filter((c) => c.round === round)) {
        const course = courseFor(round, variationId);
        const dressing = roundDressing(round, course);
        const anchors = dressing.standAnchors;
        for (const weather of weathersFor(round)) {
          for (const tier of QUALITY_TIERS) {
            const env = createEnvironment(theme, {
              weather,
              ...dressing,
              seed: round.decorSeed,
              detail: QUALITY_PRESETS[tier].environment,
            });
            envs++;
            const tag = `${variationId ?? 'base'}/${weather}/${tier}`;
            for (const p of audit({ round, variationId, course }, flyover, env.dressing))
              problems.push(`${tag}: ${p}`);
            for (const [i, s] of env.dressing.stands.entries()) {
              const floor = i === 0 ? anchors.start : anchors.end;
              // Front row seats sit 0.6 m above the stand origin (crowd.ts).
              const seat = s.position.y + 0.6;
              if (seat < floor.y - 0.5 || seat > floor.y + 1)
                problems.push(
                  `${tag}: stand ${i} front row at y=${seat.toFixed(2)}, floor ${floor.y.toFixed(2)}`,
                );
              const top = standBox({
                position: s.position,
                yaw: s.yaw,
                width: s.width ?? 16,
                rows: s.rows ?? 4,
              }).max.y;
              if (top < floor.y + 3)
                problems.push(`${tag}: stand ${i} barely rises above the floor it faces`);
              // The crowd faces local -Z rotated by yaw; its line of sight must cross the course.
              const dir = { x: -Math.sin(s.yaw), z: -Math.cos(s.yaw) };
              const far = { x: s.position.x + dir.x * 1e4, y: s.position.y, z: s.position.z + dir.z * 1e4 };
              const flat: BoxLike = {
                min: { ...course.min, y: -HUGE },
                max: { ...course.max, y: HUGE },
              };
              if (!segmentHitsBox(s.position, far, flat))
                problems.push(`${tag}: stand ${i} faces away from the course`);
            }
            env.dispose();
          }
        }
      }
      expect(envs).toBeGreaterThan(0);
      expect(problems.slice(0, 40), `${problems.length} problems`).toEqual([]);
    },
  );
});
