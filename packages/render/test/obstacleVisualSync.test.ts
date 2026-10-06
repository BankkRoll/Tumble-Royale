/**
 * Obstacle visuals follow physics: for every round (every show round, the
 * test arena and Practice Island) × every variation, plus the Speed Demons
 * mutator at the last show stage and private-show timer scales, builds the
 * real obstacle visuals headlessly the way the round view does (speed scale
 * from the sim, show seed, one shared MeshBatcher) and steps the sim through
 * COUNTDOWN and PLAYING. At sample times it checks:
 * - every kinematic body of every obstacle with a pure `pose(t)` has a node
 *   (object or instance) in its visual whose world position and rotation
 *   equal the body's, and it is the same node at every sample;
 * - every source mesh the batcher draws for is drawn at its current world
 *   matrix (no stale or missing instance transforms).
 */
import {
  Matrix4,
  Quaternion,
  Scene,
  Vector3,
  type InstancedMesh,
  type Mesh,
  type Object3D,
} from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS } from '@tumble/content/rounds';
import { TUTORIAL_ROUND_INPUT } from '@tumble/content/rounds/practice-island';
import { RoundDefinitionSchema, RoundPhase, SIM_DT, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createMatchSim, createSimpleController, type MatchSimHandle } from '@tumble/sim/match';
import { MUTATORS } from '@tumble/sim/mutators';
import { OBSTACLE_REGISTRY, getObstacleModule, type ObstacleRuntime } from '@tumble/sim/obstacles';
import { MeshBatcher } from '../src/batching/index.ts';
import { getObstacleVisual, type ObstacleVisual } from '../src/obstacles/index.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const ALL_ROUNDS: RoundDefinition[] = [...ROUNDS, TUTORIAL_ROUND_INPUT].map((r) =>
  RoundDefinitionSchema.parse(r),
);
const SEED = 17;
/** Position error allowed between a body and its visual (m); both are float32. */
const POS_EPS = 2e-3;
/** Rotation error allowed, as 1 - |q·q'| (about 0.15° of arc). */
const ROT_EPS = 2e-6;
/** PLAYING seconds at which to compare (the countdown start and its middle are sampled too). */
const PLAY_SAMPLES = [0.5, 1.75, 3.3, 5.05, 8.4, 12.7];

interface Config {
  label: string;
  stage: number;
  variationId?: string;
  mutatorId?: string;
  roundTimeScale?: number;
}

function configsFor(round: RoundDefinition): Config[] {
  const last = Math.max(0, round.speedScaleByStage.length - 1);
  return [
    { label: 'base', stage: 0 },
    ...round.variations.map((v) => ({ label: v.id, stage: 0, variationId: v.id })),
    { label: 'speed-demons', stage: last, mutatorId: 'speed-demons' },
    { label: 'timer x0.5', stage: 1, roundTimeScale: 0.5 },
    { label: 'timer x2', stage: 2, roundTimeScale: 2 },
  ];
}

function build(round: RoundDefinition, cfg: Config): MatchSimHandle {
  return createMatchSim(
    {
      R,
      round,
      seed: SEED,
      stage: cfg.stage,
      players: [],
      mode: 'offline',
      ...(cfg.variationId ? { variationId: cfg.variationId } : {}),
      ...(cfg.mutatorId ? { mutatorId: cfg.mutatorId } : {}),
      ...(cfg.roundTimeScale !== undefined ? { roundTimeScale: cfg.roundTimeScale } : {}),
    },
    { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
  );
}

/** Drives the batcher's per-frame sync the way the renderer does (once per frame id). */
function syncBatches(b: MeshBatcher, frame: number): void {
  (b as unknown as { sync(frame: number): void }).sync(frame);
}

type Body = NonNullable<ReturnType<ObstacleRuntime['colliders'][number]['parent']>>;

interface Tracked {
  rt: ObstacleRuntime;
  visual: ObstacleVisual;
  bodies: Body[];
  /** Per body: keys of visual nodes that matched it at every sample so far (null before the first). */
  candidates: (Set<string> | null)[];
}

const m = new Matrix4();
const inst = new Matrix4();
const pos = new Vector3();
const rot = new Quaternion();
const scl = new Vector3();

/**
 * World pose of every node (and every instance of instanced meshes) under
 * `root`, keyed by tree path. Rotation is null for a collapsed (near-zero
 * scale) node: boulders shrink away over the last 0.3 s of their lane.
 */
function nodePoses(root: Object3D): Map<string, { p: Vector3; q: Quaternion | null }> {
  const out = new Map<string, { p: Vector3; q: Quaternion | null }>();
  const posed = (): { p: Vector3; q: Quaternion | null } => ({
    p: pos.clone(),
    q: Math.min(Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)) > 1e-6 ? rot.clone() : null,
  });
  const visit = (o: Object3D, key: string): void => {
    o.matrixWorld.decompose(pos, rot, scl);
    out.set(key, posed());
    const im = o as InstancedMesh;
    if (im.isInstancedMesh) {
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, inst);
        m.multiplyMatrices(im.matrixWorld, inst).decompose(pos, rot, scl);
        out.set(`${key}#${i}`, posed());
      }
    }
    o.children.forEach((c, i) => visit(c, `${key}/${i}`));
  };
  visit(root, '');
  return out;
}

/** Narrows each body's candidate set to the visual nodes posed exactly like it now. */
function compare(tr: Tracked, killY: number): void {
  const poses = nodePoses(tr.visual.object);
  tr.bodies.forEach((body, bi) => {
    const t = body.translation();
    const r = body.rotation();
    // Pooled projectiles park below the kill plane between uses; the visual hides them its own way.
    if (t.y < killY) return;
    const hits = new Set<string>();
    for (const [key, { p, q }] of poses) {
      if (Math.abs(p.x - t.x) > POS_EPS || Math.abs(p.y - t.y) > POS_EPS || Math.abs(p.z - t.z) > POS_EPS)
        continue;
      if (!q || 1 - Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w) <= ROT_EPS) hits.add(key);
    }
    const prev = tr.candidates[bi];
    tr.candidates[bi] =
      prev === null || prev === undefined ? hits : new Set([...prev].filter((k) => hits.has(k)));
  });
}

function key16(e: ArrayLike<number>, offset = 0): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += `${Math.fround(e[offset + i]!)},`;
  return s;
}

/** Every batched source mesh must be drawn by some batch at its current world matrix. */
function checkBatches(batcher: MeshBatcher, roots: readonly Object3D[]): string[] {
  const drawn = new Set<string>();
  // Batches and the one-instance stand-ins of diverging sources; hidden stand-ins draw nothing.
  for (const b of batcher.object.children as InstancedMesh[]) {
    if (!b.visible) continue;
    const arr = b.instanceMatrix.array as Float32Array;
    for (let i = 0; i < b.count; i++) drawn.add(key16(arr, i * 16));
  }
  const problems: string[] = [];
  for (const root of roots)
    root.traverse((o) => {
      const mesh = o as Mesh & { isInstancedMesh?: boolean };
      if (!mesh.isMesh || mesh.layers.mask !== 0 || !isShown(mesh)) return;
      if (mesh.isInstancedMesh) {
        const im = mesh as unknown as InstancedMesh;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, inst);
          if (!drawn.has(key16(m.multiplyMatrices(im.matrixWorld, inst).elements)))
            problems.push(`${root.name} ${mesh.name || mesh.type}#${i} not drawn at its pose`);
        }
      } else if (!drawn.has(key16(mesh.matrixWorld.elements)))
        problems.push(`${root.name} ${mesh.name || mesh.type} not drawn at its pose`);
    });
  return problems;
}

function isShown(o: Object3D): boolean {
  for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

/** Runs one configuration; returns readable problems. */
function audit(round: RoundDefinition, cfg: Config): { problems: string[]; bodies: number } {
  const sim = build(round, cfg);
  expect(sim.warnings, `${round.id} ${cfg.label}`).toEqual([]);
  const bonus = (cfg.mutatorId && MUTATORS[cfg.mutatorId]?.speedScaleBonus) || 0;
  const stages = round.speedScaleByStage;
  const base = stages.length > 0 ? (stages[Math.min(cfg.stage, stages.length - 1)] ?? 1) : 1;
  expect(sim.speedScale, `${round.id} ${cfg.label}`).toBeCloseTo(base + bonus, 9);

  const scene = new Scene();
  const batcher = new MeshBatcher();
  const tracked: Tracked[] = [];
  for (const rt of sim.obstacleRuntimes) {
    const factory = getObstacleVisual(rt.instance.type);
    if (!factory) continue;
    // Same context the round view passes: the sim's speed scale (stage + mutator) and the show seed.
    const visual = factory(rt.instance, { theme: round.theme, speedScale: sim.speedScale, seed: SEED });
    scene.add(visual.object);
    batcher.add(visual.object);
    if (!getObstacleModule(rt.instance.type)?.pose) {
      tracked.push({ rt, visual, bodies: [], candidates: [] });
      continue;
    }
    const bodies = [
      ...new Set(rt.colliders.map((c) => c.parent()).filter((b): b is Body => !!b && b.isKinematic())),
    ];
    tracked.push({ rt, visual, bodies, candidates: bodies.map(() => null) });
  }
  batcher.build();
  scene.add(batcher.object);

  const problems: string[] = [];
  let frame = 0;
  const sample = (): void => {
    // Kinematic targets are set from `pose(sim.time)` inside the step, so bodies show the pre-step time.
    const t = sim.time;
    sim.step();
    for (const tr of tracked) tr.visual.update(t, SIM_DT, tr.rt);
    scene.updateMatrixWorld(true);
    syncBatches(batcher, ++frame);
    for (const tr of tracked) compare(tr, sim.round.killY);
    for (const p of checkBatches(
      batcher,
      tracked.map((tr) => tr.visual.object),
    ))
      problems.push(`t=${t.toFixed(3)} ${p}`);
  };

  sim.setPhase(RoundPhase.Countdown);
  sample();
  while (sim.time < -1.5) sim.step();
  sample();
  while (sim.time < 0) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
  for (const at of PLAY_SAMPLES) {
    while (sim.time < at - 1e-9) sim.step();
    sample();
  }

  let bodies = 0;
  for (const tr of tracked)
    tr.bodies.forEach((_b, bi) => {
      bodies++;
      const c = tr.candidates[bi];
      if (c && c.size === 0)
        problems.push(
          `${tr.rt.instance.id} (${tr.rt.instance.type}) body ${bi} has no visual node following it`,
        );
    });
  batcher.dispose();
  for (const tr of tracked) tr.visual.dispose();
  sim.dispose();
  return { problems, bodies };
}

describe('obstacle visuals follow physics', () => {
  it.each(ALL_ROUNDS.map((r) => [r.id, r] as const))('%s', (_id, round) => {
    const problems: string[] = [];
    for (const cfg of configsFor(round))
      for (const p of audit(round, cfg).problems) problems.push(`${cfg.label}: ${p}`);
    expect(problems.slice(0, 30), `${problems.length} problems`).toEqual([]);
  });
});
