/**
 * Comet Field visual: every live comet as a glowing core with a short tail.
 *
 * - Flying: the comet arcs from its last spot to the next one while a landing
 *   ring pulses on the target spot (the telegraph).
 * - Resting: the comet bobs above its spot under a tall, soft light pillar
 *   that reads across the whole deck; golden comets are gold.
 * - Caught: hidden until its next hop (the catch burst is the `catch` cue).
 *
 * Positions come from the sim module's pure schedule; the comet seed, the
 * live count and the caught hops come from the runtime.
 */
import {
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  RingGeometry,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import type { ObstacleRuntime } from '@tumble/sim';
import {
  CometFieldSchema,
  cometActiveCount,
  cometHop,
  cometHopTime,
  cometSpotIndex,
  type CometFieldParams,
  type CometFieldView,
} from '@tumble/sim/obstacles';
import {
  Disposer,
  PAL,
  applyInstanceTransform,
  glowMaterial,
  parseParams,
  setInstanceTRS,
} from './visual-helpers-b.ts';
import type { ObstacleVisualFactory } from './types.ts';

const TAIL = 4;
const PILLAR_HEIGHT = 9;
const NO_HOP = -1_000_000;

class CometFieldVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: CometFieldParams;
  private readonly cores: InstancedMesh;
  private readonly golden: InstancedMesh;
  private readonly tails: InstancedMesh;
  private readonly rings: InstancedMesh;
  private readonly pillars: InstancedMesh;
  private readonly ringGlow;

  constructor(
    instance: Parameters<ObstacleVisualFactory>[0],
    private readonly ctx: Parameters<ObstacleVisualFactory>[1],
  ) {
    const d = this.d;
    const p = (this.p = parseParams(CometFieldSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    const n = p.slots;
    const core = d.track(new IcosahedronGeometry(0.55, 2));
    this.cores = this.instanced(core, glowMaterial(d, '#dff8ff', { additive: false }).mat, n);
    this.golden = this.instanced(core, glowMaterial(d, PAL.gold, { additive: false }).mat, n);
    this.tails = this.instanced(core, glowMaterial(d, PAL.cyan, { opacity: 0.55 }).mat, n * TAIL);
    const ring = d.track(new RingGeometry(p.catchRadius * 0.7, p.catchRadius, 40));
    ring.rotateX(-Math.PI / 2);
    const rg = glowMaterial(d, PAL.cyan, { opacity: 0.9, doubleSide: true });
    this.ringGlow = rg.intensity;
    this.rings = this.instanced(ring, rg.mat, n);
    const pillar = d.track(new CylinderGeometry(0.32, 0.55, PILLAR_HEIGHT, 16, 1, true));
    pillar.translate(0, PILLAR_HEIGHT / 2, 0);
    this.pillars = this.instanced(
      pillar,
      glowMaterial(d, '#bfefff', { opacity: 0.18, doubleSide: true }).mat,
      n,
    );
    this.update(0, 0);
  }

  private instanced(geo: BufferGeometry, mat: Material, n: number): InstancedMesh {
    const m = new InstancedMesh(geo, mat, n);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    this.object.add(m);
    return m;
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const p = this.p;
    const view = runtime && 'cometSeed' in runtime ? (runtime as unknown as CometFieldView) : null;
    const seed = view?.cometSeed ?? this.ctx.seed;
    const active = view?.activeCount ?? cometActiveCount(p, 0);
    const scale = this.ctx.speedScale;
    this.ringGlow.value = 0.55 + 0.45 * Math.sin(t * 10);
    for (let i = 0; i < p.slots; i++) {
      const golden = i < p.bonusSlots;
      const own = golden ? this.golden : this.cores;
      const other = golden ? this.cores : this.golden;
      setInstanceTRS(other, i, 0, -1e4, 0, null, 0);
      if (i >= active) {
        this.hide(i, own);
        continue;
      }
      const hop = cometHop(i, t, p, scale);
      const u = cometHopTime(i, t, p, scale);
      const to = p.spots[cometSpotIndex(i, hop, p, seed)]!;
      if (u < p.flight) {
        const from = p.spots[cometSpotIndex(i, hop - 1, p, seed)]!;
        const k = u / p.flight;
        for (let s = 0; s <= TAIL; s++) {
          const kk = Math.max(0, k - s * 0.045);
          const x = from.x + (to.x - from.x) * kk;
          const z = from.z + (to.z - from.z) * kk;
          const y = from.y + (to.y - from.y) * kk + p.hover + p.arc * 4 * kk * (1 - kk);
          if (s === 0) setInstanceTRS(own, i, x, y, z, null, 1);
          else setInstanceTRS(this.tails, i * TAIL + s - 1, x, y, z, null, 1 - s * 0.2);
        }
        setInstanceTRS(this.rings, i, to.x, to.y + 0.04, to.z, null, 1 - 0.25 * k);
        setInstanceTRS(this.pillars, i, 0, -1e4, 0, null, 0);
        continue;
      }
      if (view && view.caughtHop(i) === hop && hop !== NO_HOP) {
        this.hide(i, own);
        continue;
      }
      const bob = Math.sin(t * 2.6 + i * 1.7) * 0.15;
      const pulse = 1 + 0.08 * Math.sin(t * 7 + i);
      setInstanceTRS(own, i, to.x, to.y + p.hover + bob, to.z, null, pulse);
      for (let s = 0; s < TAIL; s++) setInstanceTRS(this.tails, i * TAIL + s, 0, -1e4, 0, null, 0);
      setInstanceTRS(this.rings, i, to.x, to.y + 0.04, to.z, null, 1);
      setInstanceTRS(this.pillars, i, to.x, to.y, to.z, null, 1);
    }
    for (const m of [this.cores, this.golden, this.tails, this.rings, this.pillars])
      m.instanceMatrix.needsUpdate = true;
  }

  private hide(i: number, own: InstancedMesh): void {
    setInstanceTRS(own, i, 0, -1e4, 0, null, 0);
    setInstanceTRS(this.rings, i, 0, -1e4, 0, null, 0);
    setInstanceTRS(this.pillars, i, 0, -1e4, 0, null, 0);
    for (let s = 0; s < TAIL; s++) setInstanceTRS(this.tails, i * TAIL + s, 0, -1e4, 0, null, 0);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.d.dispose();
  }
}

/** Comet Field visual factory. */
export const cometFieldVisual: ObstacleVisualFactory = (instance, ctx) => new CometFieldVisual(instance, ctx);
