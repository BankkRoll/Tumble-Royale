/**
 * Motion audit for every round (all show rounds, the test arena and Practice
 * Island), every variation, every show stage's speed scale, the Speed Demons
 * mutator and the private-show timer scales:
 * - every obstacle whose pure `pose(t)` moves at some point of the round
 *   really moves its colliders in the sim over the same window (catches
 *   frozen time bases, zeroed speed params and runtimes that ignore `pose`);
 * - the sim reports the speed scale it built obstacles with (stage scale plus
 *   mutator bonus), which visuals must use to stay on their colliders;
 * - every tilt plate and seesaw reacts visibly to riders and sways on its own,
 *   so balance pieces never read as static scenery.
 */
import { RoundDefinitionSchema, RoundPhase, type RoundDefinition } from '@tumble/shared';
import { MUTATORS } from '@tumble/sim/mutators';
import { createMatchSim, createSimpleController, type MatchSimHandle } from '@tumble/sim/match';
import type { TiltPlatformRuntime } from '@tumble/sim/obstacles';
import {
  OBSTACLE_REGISTRY,
  SeesawRuntime,
  getObstacleModule,
  type ObstacleRuntime,
  type PoseSample,
} from '@tumble/sim/obstacles';
import { loadRapier, type Rapier } from '@tumble/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS } from '../src/rounds/index.ts';
import { TUTORIAL_ROUND_INPUT } from '../src/rounds/tutorial.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const ALL_ROUNDS: RoundDefinition[] = [...ROUNDS, TUTORIAL_ROUND_INPUT].map((r) =>
  RoundDefinitionSchema.parse(r),
);
const DT = 1 / 60;
/** Pose change (m, or quaternion units) that counts as motion. */
const MOVE_EPS = 1e-3;
/** Collider change that counts as motion (colliders lag their pose by one step). */
const COLLIDER_EPS = 1e-5;

interface SimConfig {
  label: string;
  stage: number;
  variationId?: string;
  mutatorId?: string;
  roundTimeScale?: number;
  /** Seconds of PLAYING to audit. */
  seconds: number;
}

function build(round: RoundDefinition, cfg: SimConfig): MatchSimHandle {
  return createMatchSim(
    {
      R,
      round,
      seed: 17,
      stage: cfg.stage,
      players: [{ id: 0, name: 'p', isBot: true, team: round.qualification.teams > 0 ? 0 : -1 }],
      mode: 'offline',
      ...(cfg.variationId ? { variationId: cfg.variationId } : {}),
      ...(cfg.mutatorId ? { mutatorId: cfg.mutatorId } : {}),
      ...(cfg.roundTimeScale !== undefined ? { roundTimeScale: cfg.roundTimeScale } : {}),
    },
    { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
  );
}

function colliderSnapshot(rt: ObstacleRuntime): number[] {
  const out: number[] = [];
  for (const c of rt.colliders) {
    const t = c.translation();
    const r = c.rotation();
    out.push(t.x, t.y, t.z, r.x, r.y, r.z, r.w);
  }
  return out;
}

function maxDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** Flattened `pose(t)` samples, or null when the module has no pure pose. */
function poseAt(rt: ObstacleRuntime, t: number, speedScale: number): number[] | null {
  const mod = getObstacleModule(rt.instance.type);
  if (!mod?.pose) return null;
  const n = mod.poseCount?.(rt.instance.params, speedScale) ?? 32;
  const out: PoseSample[] = Array.from({ length: Math.max(1, n) }, () => ({
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
  }));
  mod.pose(t, rt.instance.params, out, speedScale);
  return out.flatMap((s) => [s.pos.x, s.pos.y, s.pos.z, s.rot.x, s.rot.y, s.rot.z, s.rot.w]);
}

/** Expected speed scale: the stage table entry plus the mutator's bonus. */
function expectedSpeedScale(round: RoundDefinition, cfg: SimConfig): number {
  const s = round.speedScaleByStage;
  const base = s.length > 0 ? (s[Math.max(0, Math.min(cfg.stage, s.length - 1))] ?? 1) : 1;
  return base + ((cfg.mutatorId && MUTATORS[cfg.mutatorId]?.speedScaleBonus) || 0);
}

/**
 * Steps the sim through PLAYING, sampling every half second, and returns the
 * obstacles whose pose moved over an interval while their colliders did not.
 */
function auditMotion(round: RoundDefinition, cfg: SimConfig): string[] {
  const sim = build(round, cfg);
  expect(sim.warnings, `${round.id} ${cfg.label}`).toEqual([]);
  expect(sim.speedScale).toBeCloseTo(expectedSpeedScale(round, cfg), 9);
  const speed = sim.speedScale;
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < 180; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
  const rts = sim.obstacleRuntimes;
  let prevPose = rts.map((rt) => poseAt(rt, sim.time, speed));
  let prevCol = rts.map(colliderSnapshot);
  const stuck = new Map<string, number>();
  // A move that starts right at a sample instant (a cannon firing at t = 2) reaches the colliders a
  // step or two later; such intervals get one more sample to show up before they count as stuck.
  const pending = new Map<number, { since: number[]; t: number }>();
  const step = 0.5;
  for (let t = step; t <= cfg.seconds + 1e-9; t += step) {
    while (sim.time < t - 1e-9) sim.step();
    sim.step();
    const pose = rts.map((rt) => poseAt(rt, t, speed));
    const col = rts.map(colliderSnapshot);
    for (const [i, p] of pending) {
      if (maxDiff(p.since, col[i]!) < COLLIDER_EPS) stuck.set(rts[i]!.instance.id, p.t);
      pending.delete(i);
    }
    rts.forEach((_rt, i) => {
      const a = prevPose[i];
      const b = pose[i];
      if (!a || !b || maxDiff(a, b) < MOVE_EPS) return;
      if (maxDiff(prevCol[i]!, col[i]!) < COLLIDER_EPS) pending.set(i, { since: prevCol[i]!, t });
    });
    prevPose = pose;
    prevCol = col;
  }
  sim.dispose();
  return [...stuck].map(([id, t]) => `${id} posed to move by t=${t} but its colliders did not`);
}

function tumblerLoad(
  rt: TiltPlatformRuntime | SeesawRuntime,
  riders: number,
): { body: SeesawRuntime['plank']; offset: number } {
  if (rt instanceof SeesawRuntime) {
    const p = rt.instance.params as { length: number };
    return { body: rt.plank, offset: p.length * 0.4 * (riders > 0 ? 1 : 0) };
  }
  const p = rt.instance.params as { shape: string; sizeX: number; sizeZ: number; radius: number };
  const half = p.shape === 'disc' ? p.radius : Math.min(p.sizeX, p.sizeZ) / 2;
  return { body: rt.chain[rt.chain.length - 1]!, offset: half * 0.8 };
}

/** Peak hinge angle (degrees) of a tilt plate or seesaw, from its replicated state. */
function hingeDeg(rt: ObstacleRuntime): number {
  const st = rt.getNetState?.() ?? [];
  const n = rt instanceof SeesawRuntime ? 1 : st.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) a = Math.max(a, Math.abs(st[i]! / 1000));
  return (a * 180) / Math.PI;
}

/**
 * Presses `riders` Tumbler weights (1 kg each, the controller's weight model)
 * onto the piece at 80 % of its half-span for 3 s and returns the peak tilt.
 */
function loadedTilt(round: RoundDefinition, id: string, riders: number, variationId?: string): number {
  const sim = build(round, { label: 'load', stage: 0, seconds: 0, ...(variationId ? { variationId } : {}) });
  sim.setPhase(RoundPhase.Playing, 0);
  const rt = sim.obstacle(id) as TiltPlatformRuntime | SeesawRuntime;
  const { body, offset } = tumblerLoad(rt, riders);
  let peak = 0;
  for (let i = 0; i < 180; i++) {
    const p = body.translation();
    const q = body.rotation();
    // Rider position along the piece's local X (planks lie along X; plates tip about Z for X offsets).
    const ax = {
      x: 1 - 2 * (q.y * q.y + q.z * q.z),
      y: 2 * (q.x * q.y + q.z * q.w),
      z: 2 * (q.x * q.z - q.y * q.w),
    };
    const at = { x: p.x + ax.x * offset, y: p.y + ax.y * offset, z: p.z + ax.z * offset };
    body.applyImpulseAtPoint({ x: 0, y: -9.81 * riders * DT, z: 0 }, at, true);
    sim.step();
    peak = Math.max(peak, hingeDeg(rt));
  }
  sim.dispose();
  return peak;
}

function unloadedSwing(round: RoundDefinition, id: string): number {
  const sim = build(round, { label: 'idle', stage: 0, seconds: 0 });
  sim.setPhase(RoundPhase.Playing, 0);
  const rt = sim.obstacle(id)!;
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    sim.step();
    peak = Math.max(peak, hingeDeg(rt));
  }
  sim.dispose();
  return peak;
}

describe.each(ALL_ROUNDS.map((r) => [r.id, r] as const))('%s motion', (_id, round) => {
  const configs: SimConfig[] = [
    { label: 'base', stage: 0, seconds: Math.min(round.duration.seconds, 150) },
    ...round.variations.map((v) => ({
      label: `variation ${v.id}`,
      stage: 0,
      variationId: v.id,
      seconds: 40,
    })),
    { label: 'last stage', stage: 4, seconds: 30 },
    ...Object.values(MUTATORS)
      .filter((m) => m.speedScaleBonus)
      .map((m) => ({ label: `mutator ${m.id}`, stage: 2, mutatorId: m.id, seconds: 30 })),
    { label: 'half timer', stage: 0, roundTimeScale: 0.5, seconds: 30 },
    { label: 'double timer', stage: 0, roundTimeScale: 2, seconds: 30 },
  ];

  it.each(configs.map((c) => [c.label, c] as const))(
    'posed obstacles move their colliders (%s)',
    { timeout: 300_000 },
    (_label, cfg) => {
      expect(auditMotion(round, cfg)).toEqual([]);
    },
  );

  const hinged = round.obstacles.filter((o) => o.type === 'tiltPlatform' || o.type === 'seesaw');
  if (hinged.length > 0) {
    it.each(hinged.map((o) => [o.id] as const))(
      '%s tips under riders and sways when empty',
      { timeout: 120_000 },
      async (id) => {
        const rt = build(round, { label: 'probe', stage: 0, seconds: 0 });
        const inst = rt.obstacle(id)!.instance.params as { maxTiltDeg: number; swayDeg: number };
        rt.dispose();
        const single = loadedTilt(round, id, 1);
        const crowd = loadedTilt(round, id, 8);
        const idle = unloadedSwing(round, id);
        if (process.env.HINGE_LOG)
          (await import('node:fs')).appendFileSync(
            process.env.HINGE_LOG,
            `${id} max ${inst.maxTiltDeg} sway ${inst.swayDeg} single ${single.toFixed(2)} crowd ${crowd.toFixed(2)} idle ${idle.toFixed(2)}\n`,
          );
        // The peak includes the idle sway's phase, so one rider only has to register; the
        // start plaza and the 24 m tables are crowd pieces by design.
        expect(single, `${id}: one rider`).toBeGreaterThan(0.5);
        expect(crowd, `${id}: eight riders`).toBeGreaterThan(Math.min(inst.maxTiltDeg * 0.6, 3.5));
        // Visible on its own: heavy planks lag their motor target, so the floor is absolute.
        expect(idle, `${id}: idle sway`).toBeGreaterThan(Math.min(inst.swayDeg * 0.5, 0.6));
        expect(idle, `${id}: idle sway stays gentle`).toBeLessThan(inst.maxTiltDeg);
      },
    );
  }
});
