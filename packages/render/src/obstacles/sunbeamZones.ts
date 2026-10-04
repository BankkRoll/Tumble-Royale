/**
 * Sunbeam Zones visual: each live beam is a warm shaft of light reaching down
 * from the sky onto a bright pool on the plaza, ringed so its edge reads, with
 * motes drifting up through it.
 *
 * Beam centres come from the sim module's pure drift; the live count and each
 * beam's occupants come from the runtime. A crowded beam dims (its sunshine is
 * shared), an empty one glows full; a flaring beam burns white-gold.
 */
import {
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  TorusGeometry,
  type BufferGeometry,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import { vec3, type Vec3 } from '@tumble/shared';
import type { ObstacleRuntime } from '@tumble/sim';
import {
  SunbeamZonesSchema,
  sunbeamActiveCount,
  sunbeamCentre,
  sunbeamFlaring,
  type SunbeamZonesParams,
  type SunbeamZonesView,
} from '@tumble/sim/obstacles';
import {
  Disposer,
  Sparkles,
  applyInstanceTransform,
  glowMaterial,
  parseParams,
  rand01,
  type FloatUniform,
} from './visual-helpers-b.ts';
import type { ObstacleVisualFactory } from './types.ts';

const SHAFT_HEIGHT = 22;
const MOTES = 10;
const WARM = new Color('#ffd36e');
const FLARE = new Color('#fff6d8');

interface Beam {
  group: Group;
  shaft: FloatUniform;
  pool: FloatUniform;
  rim: FloatUniform;
  /** Shared tint of the shaft and pool (warm, white-gold while flaring). */
  tint: Color;
}

class SunbeamZonesVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: SunbeamZonesParams;
  private readonly beams: Beam[] = [];
  private readonly motes: Sparkles;
  private readonly c: Vec3 = vec3();

  constructor(
    instance: Parameters<ObstacleVisualFactory>[0],
    private readonly ctx: Parameters<ObstacleVisualFactory>[1],
  ) {
    const d = this.d;
    const p = (this.p = parseParams(SunbeamZonesSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    const shaftGeo = d.track(new CylinderGeometry(p.radius * 0.8, p.radius, SHAFT_HEIGHT, 28, 1, true));
    shaftGeo.translate(0, SHAFT_HEIGHT / 2, 0);
    const poolGeo: BufferGeometry = d.track(new CircleGeometry(p.radius, 40));
    poolGeo.rotateX(-Math.PI / 2);
    const rimGeo = d.track(new TorusGeometry(p.radius, 0.09, 6, 48));
    rimGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < p.beams; i++) {
      const group = new Group();
      const shaft = glowMaterial(d, WARM, { opacity: 0.22, doubleSide: true });
      const pool = glowMaterial(d, WARM, { opacity: 0.55 });
      const tint = uniform(WARM.clone());
      shaft.mat.colorNode = tint;
      pool.mat.colorNode = tint;
      const rim = glowMaterial(d, '#fff0b8', { opacity: 0.9 });
      const shaftMesh = new Mesh(shaftGeo, shaft.mat);
      const poolMesh = new Mesh(poolGeo, pool.mat);
      poolMesh.position.y = 0.03;
      const rimMesh = new Mesh(rimGeo, rim.mat);
      rimMesh.position.y = 0.06;
      for (const m of [shaftMesh, poolMesh, rimMesh]) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 3;
        group.add(m);
      }
      this.object.add(group);
      this.beams.push({
        group,
        shaft: shaft.intensity,
        pool: pool.intensity,
        rim: rim.intensity,
        tint: tint.value,
      });
    }
    this.motes = new Sparkles(d, p.beams * MOTES, '#fff3c4', 0.09);
    this.object.add(this.motes.mesh);
    this.update(0, 0);
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const p = this.p;
    const view = runtime && 'occupants' in runtime ? (runtime as unknown as SunbeamZonesView) : null;
    const active = view?.activeCount ?? sunbeamActiveCount(p, 0);
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i]!;
      b.group.visible = i < active;
      if (!b.group.visible) {
        for (let k = 0; k < MOTES; k++) this.motes.set(i * MOTES + k, 0, -1e4, 0, 0);
        continue;
      }
      sunbeamCentre(i, t, p, this.ctx.speedScale, this.c);
      b.group.position.set(this.c.x, this.c.y, this.c.z);
      const crowd = view?.occupants(i) ?? 0;
      const flare = sunbeamFlaring(i, t, p);
      const share = 1 / (1 + 0.35 * Math.max(0, crowd - 1));
      const shimmer = 0.9 + 0.1 * Math.sin(t * 3 + i * 2.1);
      b.shaft.value = (flare ? 1.8 : 1) * shimmer * (0.6 + 0.4 * share);
      b.pool.value = (flare ? 1.6 : 1) * (0.45 + 0.55 * share);
      b.rim.value = flare ? 0.8 + 0.2 * Math.sin(t * 14) : 0.75;
      b.tint.copy(flare ? FLARE : WARM);
      for (let k = 0; k < MOTES; k++) {
        const life = (t * 0.35 + rand01(i * MOTES + k, 3)) % 1;
        const a = rand01(i * MOTES + k, 5) * Math.PI * 2;
        const r = Math.sqrt(rand01(i * MOTES + k, 7)) * p.radius * 0.85;
        this.motes.set(
          i * MOTES + k,
          this.c.x + Math.cos(a) * r,
          0.2 + life * 7,
          this.c.z + Math.sin(a) * r,
          Math.sin(life * Math.PI) * 1.4,
        );
      }
    }
    this.motes.commit();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.d.dispose();
  }
}

/** Sunbeam Zones visual factory. */
export const sunbeamZonesVisual: ObstacleVisualFactory = (instance, ctx) =>
  new SunbeamZonesVisual(instance, ctx);
