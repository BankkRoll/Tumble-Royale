/**
 * Paint Grid visual: glowing team-colour paint splats over the plaza (one
 * instanced draw for every cell), a pop when a cell changes hands, the rinse
 * fountain with its rotating water-curtain arms, and the paint buckets.
 *
 * Cell owners and bucket timers come from the replicated runtime; the rinse is
 * a pure function of time, mirrored exactly from the sim.
 */
import {
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import { float, fract, mix, positionLocal, sin, smoothstep, time, uv } from 'three/tsl';
import { TEAM_COLORS, hash01 } from '@tumble/shared';
import type { ObstacleRuntime } from '@tumble/sim';
import {
  PaintGridSchema,
  paintCellCenter,
  paintCellCount,
  paintLayout,
  paintRinseAngle,
  type PaintGridParams,
  type PaintGridView,
  type PaintLayout,
} from '@tumble/sim/obstacles';
import { Disposer, PAL, addOutline, applyInstanceTransform, glowMaterial, parseParams, solid, stripedToon, toon } from './visual-helpers-b.ts';
import type { ObstacleVisualFactory } from './types.ts';

const POP_TIME = 0.32;
const TEAM = TEAM_COLORS.map((c) => new Color(c));

/** A wobbly paint-blob disc (lying flat), radius ≈ 1. */
function splatGeometry(d: Disposer): BufferGeometry {
  const g = d.track(new CircleGeometry(1, 20));
  const pos = g.getAttribute('position');
  for (let i = 1; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const a = Math.atan2(y, x);
    const k = 1 + 0.12 * Math.sin(a * 5 + 0.7) + 0.06 * Math.sin(a * 9 + 2.1);
    pos.setXY(i, x * k, y * k);
  }
  pos.needsUpdate = true;
  g.rotateX(-Math.PI / 2);
  return g;
}

class PaintGridVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: PaintGridParams;
  private readonly layout: PaintLayout;
  private readonly count: number;
  private readonly splats: InstancedMesh;
  private readonly owner: Int8Array;
  private readonly changedAt: Float32Array;
  private readonly yaw: Float32Array;
  private readonly centres: Float32Array;
  /** Cells still animating a pop. */
  private readonly popping = new Set<number>();
  private readonly rinse = new Group();
  private readonly buckets: Group[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private lastT = 0;

  constructor(
    instance: Parameters<ObstacleVisualFactory>[0],
    private readonly ctx: Parameters<ObstacleVisualFactory>[1],
  ) {
    const d = this.d;
    const p = (this.p = parseParams(PaintGridSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    this.layout = paintLayout(p);
    this.count = paintCellCount(p);
    this.owner = new Int8Array(this.count).fill(-2);
    this.changedAt = new Float32Array(this.count);
    this.yaw = new Float32Array(this.count);
    this.centres = new Float32Array(this.count * 2);
    const c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.count; i++) {
      paintCellCenter(i, p, c);
      this.centres[i * 2] = c.x;
      this.centres[i * 2 + 1] = c.z;
      this.yaw[i] = hash01(i * 7 + 3) * Math.PI * 2;
    }

    // Unlit paint so the plaza glows as it is painted (night theme); a soft
    // wet sheen band drifts across the blobs.
    const mat = d.track(new MeshBasicNodeMaterial());
    const r = uv().sub(0.5).length().mul(2);
    const sheen = smoothstep(float(0.82), float(1), sin(positionLocal.x.mul(2.2).add(positionLocal.z.mul(1.4)).add(time.mul(1.3))));
    mat.colorNode = mix(float(1.18), float(0.9), r).mul(float(1).add(sheen.mul(0.25)));
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.splats = new InstancedMesh(splatGeometry(d), mat, this.count);
    this.splats.frustumCulled = false;
    this.splats.renderOrder = 3;
    for (let i = 0; i < this.count; i++) {
      this.splats.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      this.splats.setColorAt(i, TEAM[0]!);
    }
    this.object.add(this.splats);

    this.buildRinse();
    this.buildBuckets();
    this.syncCells(null, 0);
  }

  private buildRinse(): void {
    const d = this.d;
    const p = this.p;
    if (p.rinseArms <= 0) return;
    // Fountain tower on the hub.
    const tower = solid(d.track(new CylinderGeometry(0.7, 1.1, p.rinseHeight + 0.6, 24)), stripedToon(d, PAL.cyan, PAL.white, 2, 'y'));
    tower.position.y = (p.rinseHeight + 0.6) / 2;
    this.object.add(tower);
    const bowl = solid(d.track(new CylinderGeometry(1.6, 1.0, 0.5, 28)), toon(d, { color: PAL.cyan, rimStrength: 0.8 }));
    bowl.position.y = p.rinseHeight + 0.7;
    addOutline(d, bowl, 0.04);
    this.object.add(bowl);

    const len = p.rinseLength - p.rinseHubRadius;
    const pipeMat = stripedToon(d, PAL.white, PAL.cyan, 1.2, 'y');
    const pipeGeo = d.track(new CylinderGeometry(0.22, 0.22, len, 12));
    const curtain = glowMaterial(d, '#7fe8ff', { additive: true, doubleSide: true });
    // Falling-water streaks scrolling down the curtain.
    curtain.mat.opacityNode = fract(uv().y.mul(3).add(time.mul(1.8)).add(sin(uv().x.mul(40)).mul(0.08)))
      .mul(0.35)
      .add(0.12)
      .mul(smoothstep(float(0), float(0.15), uv().y));
    const curtainGeo = d.track(new PlaneGeometry(len, p.rinseHeight));
    const wash = glowMaterial(d, '#b8f6ff', { additive: true });
    wash.mat.opacityNode = sin(positionLocal.x.mul(3).sub(time.mul(6))).mul(0.15).add(0.35);
    const washGeo = d.track(new PlaneGeometry(len, p.rinseWidth));
    washGeo.rotateX(-Math.PI / 2);
    for (let k = 0; k < p.rinseArms; k++) {
      const arm = new Group();
      arm.rotation.y = (k / p.rinseArms) * Math.PI * 2;
      const pipe = solid(pipeGeo, pipeMat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(p.rinseHubRadius + len / 2, p.rinseHeight, 0);
      arm.add(pipe);
      const sheet = new Mesh(curtainGeo, curtain.mat);
      sheet.position.set(p.rinseHubRadius + len / 2, p.rinseHeight / 2, 0);
      sheet.renderOrder = 6;
      arm.add(sheet);
      const floor = new Mesh(washGeo, wash.mat);
      floor.position.set(p.rinseHubRadius + len / 2, 0.06, 0);
      floor.renderOrder = 6;
      arm.add(floor);
      const nozzle = solid(d.track(new CylinderGeometry(0.4, 0.3, 0.5, 14)), toon(d, { color: PAL.yellow }));
      nozzle.position.set(p.rinseLength, p.rinseHeight, 0);
      arm.add(nozzle);
      this.rinse.add(arm);
    }
    this.object.add(this.rinse);
  }

  private buildBuckets(): void {
    const d = this.d;
    const p = this.p;
    if (p.buckets.length === 0) return;
    const pailGeo = d.track(new CylinderGeometry(0.55, 0.42, 0.8, 20));
    const pailMat = toon(d, { color: '#ffffff', rimStrength: 0.7 });
    const paintGeo = d.track(new CylinderGeometry(0.5, 0.5, 0.08, 20));
    const handleGeo = d.track(new TorusGeometry(0.5, 0.05, 8, 20, Math.PI));
    const ring = glowMaterial(d, PAL.yellow, { additive: true });
    const ringGeo = d.track(new TorusGeometry(1.05, 0.06, 8, 32));
    ringGeo.rotateX(Math.PI / 2);
    p.buckets.forEach((b, i) => {
      const g = new Group();
      const pail = solid(pailGeo, pailMat);
      addOutline(d, pail, 0.035);
      g.add(pail);
      // Rainbow of the four team colours: buckets belong to nobody.
      const top = solid(paintGeo, toon(d, { color: TEAM_COLORS[i % 4]!, emissive: TEAM_COLORS[i % 4]!, emissiveIntensity: 0.4 }));
      top.position.y = 0.36;
      g.add(top);
      const handle = solid(handleGeo, toon(d, { color: PAL.ink }));
      handle.position.y = 0.38;
      g.add(handle);
      const halo = new Mesh(ringGeo, ring.mat);
      halo.position.y = -0.35;
      g.add(halo);
      g.position.set(b.x, 0.6, b.z);
      this.buckets.push(g);
      this.object.add(g);
    });
  }

  /** Syncs splats with cell owners; pops changed cells. */
  private syncCells(view: PaintGridView | null, t: number): void {
    const p = this.p;
    let dirtyM = false;
    let dirtyC = false;
    for (let i = 0; i < this.count; i++) {
      const o = view ? view.cellOwner[i]! : -1;
      if (o === this.owner[i]) continue;
      this.owner[i] = o;
      this.changedAt[i] = t;
      if (o >= 0) {
        this.splats.setColorAt(i, TEAM[o % TEAM.length]!);
        dirtyC = true;
        this.popping.add(i);
      } else {
        this.popping.delete(i);
        this.splats.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        dirtyM = true;
      }
    }
    const base = (p.cellSize / 2) * 1.18;
    for (const i of this.popping) {
      const age = t - this.changedAt[i]!;
      const k = Math.min(1, Math.max(0, age / POP_TIME));
      // Overshoot pop: 0 → 1.25 → 1.
      const sc = base * (k < 0.6 ? (k / 0.6) * 1.25 : 1.25 - 0.25 * ((k - 0.6) / 0.4));
      this.q.setFromAxisAngle(this.up, this.yaw[i]!);
      this.v.set(this.centres[i * 2]!, this.layout.height[i]! + 0.035 + (i % 3) * 0.002, this.centres[i * 2 + 1]!);
      this.s.set(sc, 1, sc);
      this.splats.setMatrixAt(i, this.m.compose(this.v, this.q, this.s));
      dirtyM = true;
      if (k >= 1) this.popping.delete(i);
    }
    if (dirtyM) this.splats.instanceMatrix.needsUpdate = true;
    if (dirtyC && this.splats.instanceColor) this.splats.instanceColor.needsUpdate = true;
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtime && 'cellOwner' in runtime ? (runtime as unknown as PaintGridView) : null;
    // A rewind (restart) resets the pop clock.
    if (t < this.lastT - 1) this.changedAt.fill(t);
    this.lastT = t;
    this.syncCells(view, t);
    if (this.p.rinseArms > 0) this.rinse.rotation.y = paintRinseAngle(t, this.p, this.ctx.speedScale);
    for (let b = 0; b < this.buckets.length; b++) {
      const g = this.buckets[b]!;
      const ready = view ? view.bucketReadyAt[b]! : 0;
      const since = t - ready;
      g.visible = since >= 0;
      if (!g.visible) continue;
      const pop = since < 0.4 ? Math.sin((since / 0.4) * Math.PI) * 0.3 + since / 0.4 : 1;
      g.scale.setScalar(Math.max(0.01, Math.min(1.3, pop)));
      g.position.y = 0.75 + Math.sin(t * 2.4 + b) * 0.15;
      g.rotation.y = t * 1.2 + b;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.splats.dispose();
    this.d.dispose();
  }
}


/** Paint Grid visual factory. */
export const paintGridVisual: ObstacleVisualFactory = (instance, ctx) => new PaintGridVisual(instance, ctx);
