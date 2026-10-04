/**
 * Throne Floor visual: the throne room's round floor, its glowing throne spots
 * and the thrones themselves.
 *
 * - The floor is twelve marble petals. They tremble while the floor shakes,
 *   swing down on their outer hinges while it is open, and swing back up.
 * - Throne spots pulse gold during the telegraph and while thrones rise.
 * - Thrones rise and sink with the sim's own height curve; a claimed throne's
 *   cushion turns mint, a free one stays royal red.
 *
 * Cycle timings come from the floor's schedule; seat counts, owners and voided
 * cycles come from the runtime. Without a runtime (gallery) only the floor and
 * its petals are drawn.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import type { ObstacleRuntime } from '@tumble/sim';
import {
  ThroneFloorSchema,
  ThronePhase,
  throneCycleIndexAt,
  thronePhaseOf,
  throneTop,
  type ThroneCycle,
  type ThroneFloorParams,
  type ThroneFloorView,
} from '@tumble/sim/obstacles';
import {
  Disposer,
  PAL,
  applyInstanceTransform,
  glowMaterial,
  parseParams,
  setInstanceTRS,
  toon,
} from './visual-helpers-b.ts';
import type { ObstacleVisualFactory } from './types.ts';

const PETALS = 12;
const COLUMN = 4;
/** Petals swing down this far while the floor is open (rad). */
const OPEN_ANGLE = 1.7;
const FREE = new Color('#c0392b');
const HELD = new Color(PAL.mint);
const PETAL_A = new Color('#b9a6ff');
const PETAL_B = new Color('#9a84ec');
const WARN = new Color('#ff7a1a');
const UP = new Vector3(0, 1, 0);

class ThroneFloorVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: ThroneFloorParams;
  private readonly petals: InstancedMesh;
  private readonly columns: InstancedMesh;
  private readonly cushions: InstancedMesh;
  private readonly backs: InstancedMesh;
  private readonly finials: InstancedMesh;
  private readonly spots: InstancedMesh;
  private readonly spotGlow;
  private readonly m = new Matrix4();
  private readonly hinge = new Matrix4();
  private readonly back = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly axis = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly c = new Color();

  constructor(instance: Parameters<ObstacleVisualFactory>[0]) {
    const d = this.d;
    const p = (this.p = parseParams(ThroneFloorSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    const n = p.spots.length;
    const petal = d.track(
      new CylinderGeometry(p.radius, p.radius, p.thickness, 6, 1, false, 0, (Math.PI * 2) / PETALS),
    );
    petal.translate(0, -p.thickness / 2, 0);
    this.petals = this.instanced(petal, toon(d, { color: '#ffffff', rimStrength: 0.45 }), PETALS, true);
    const column = d.track(new CylinderGeometry(p.seatRadius * 0.82, p.seatRadius * 0.9, COLUMN, 20));
    column.translate(0, -COLUMN / 2 - 0.2, 0);
    this.columns = this.instanced(column, toon(d, { color: PAL.gold, rimStrength: 0.5 }), n, true);
    const cushion = d.track(new CylinderGeometry(p.seatRadius, p.seatRadius, 0.2, 24));
    cushion.translate(0, -0.1, 0);
    this.cushions = this.instanced(cushion, toon(d, { color: '#ffffff', rimStrength: 0.4 }), n, true);
    const backGeo = d.track(new BoxGeometry(p.seatRadius * 1.6, 1.4, 0.22));
    backGeo.translate(0, 0.7, -p.seatRadius * 0.85);
    this.backs = this.instanced(backGeo, toon(d, { color: PAL.gold, rimStrength: 0.5 }), n, true);
    const finial = d.track(new SphereGeometry(0.16, 10, 8));
    this.finials = this.instanced(finial, toon(d, { color: '#ff7eb6', rimStrength: 0.5 }), n * 2, false);
    const ring = d.track(new RingGeometry(p.seatRadius * 0.7, p.seatRadius * 1.15, 36));
    ring.rotateX(-Math.PI / 2);
    const sg = glowMaterial(d, PAL.gold, { opacity: 0.95, doubleSide: true, additive: false });
    this.spotGlow = sg.intensity;
    this.spots = this.instanced(ring, sg.mat, n, false);
    // Instance colours must exist before the first render, or the material compiles without them.
    for (let j = 0; j < n; j++) this.cushions.setColorAt(j, FREE);
    this.update(0, 0);
  }

  private instanced(geo: BufferGeometry, mat: Material, n: number, shadows: boolean): InstancedMesh {
    const m = new InstancedMesh(geo, mat, n);
    m.frustumCulled = false;
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    this.object.add(m);
    return m;
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtime && 'seatsIn' in runtime ? (runtime as unknown as ThroneFloorView) : null;
    const k = view ? throneCycleIndexAt(view.schedule, t) : -1;
    const c = k >= 0 ? view!.schedule[k]! : null;
    const phase = c ? thronePhaseOf(c, t) : ThronePhase.Idle;
    const open = !!c && phase === ThronePhase.Fallen && !view!.isVoided(c.index);
    this.drawPetals(c, phase, open, t);
    this.drawThrones(c, view, phase, t);
  }

  private drawPetals(c: ThroneCycle | null, phase: number, open: boolean, t: number): void {
    const p = this.p;
    const step = (Math.PI * 2) / PETALS;
    for (let i = 0; i < PETALS; i++) {
      // CylinderGeometry measures theta from +Z toward +X; the petal's middle sits half a step in.
      const mid = i * step + step / 2;
      let angle = 0;
      let jitter = 0;
      this.c.copy(i % 2 === 0 ? PETAL_A : PETAL_B);
      if (c && phase === ThronePhase.Shake) {
        const kk = (t - c.shakeAt) / Math.max(0.05, c.fallAt - c.shakeAt);
        jitter = Math.sin(t * 43 + i * 2.3) * 0.04 * (1 + kk);
        this.c.lerp(WARN, 0.3 + 0.4 * kk * (Math.sin(t * 30) > 0 ? 1 : 0.5));
      } else if (open) {
        // Swing open fast, and be shut again by the time the floor collider returns.
        angle = OPEN_ANGLE * Math.min(1, ((t - c!.fallAt) / 0.35) ** 2, (c!.restoreAt - t) / 0.35);
      }
      // Hinge on the petal's outer rim: swing down about the rim tangent.
      this.axis.set(Math.cos(mid), 0, -Math.sin(mid));
      this.v.set(Math.sin(mid) * p.radius, 0, Math.cos(mid) * p.radius);
      this.q.setFromAxisAngle(this.axis, -angle + jitter);
      this.hinge.makeTranslation(this.v.x, this.v.y, this.v.z);
      this.m.makeRotationFromQuaternion(this.q);
      this.hinge.multiply(this.m);
      this.m.makeTranslation(-this.v.x, -this.v.y, -this.v.z);
      this.hinge.multiply(this.m);
      this.m.makeRotationAxis(UP, i * step);
      this.hinge.multiply(this.m);
      this.petals.setMatrixAt(i, this.hinge);
      this.petals.setColorAt(i, this.c);
    }
    this.petals.instanceMatrix.needsUpdate = true;
    if (this.petals.instanceColor) this.petals.instanceColor.needsUpdate = true;
  }

  private drawThrones(c: ThroneCycle | null, view: ThroneFloorView | null, phase: number, t: number): void {
    const p = this.p;
    const seats = c && view ? view.seatsIn(c.index) : 0;
    const top = c ? throneTop(c, t, p) : -10;
    const glowing = phase === ThronePhase.Telegraph || phase === ThronePhase.Rise;
    this.spotGlow.value = glowing ? 0.6 + 0.4 * Math.sin(t * 16) : 0;
    for (let j = 0; j < p.spots.length; j++) {
      const used = !!c && j < seats;
      if (!used) {
        for (const m of [this.columns, this.cushions, this.backs, this.spots])
          setInstanceTRS(m, j, 0, -1e4, 0, null, 0);
        setInstanceTRS(this.finials, j * 2, 0, -1e4, 0, null, 0);
        setInstanceTRS(this.finials, j * 2 + 1, 0, -1e4, 0, null, 0);
        continue;
      }
      const s = p.spots[c!.order[j]!]!;
      const y = s.y + top;
      // Seats face the middle of the room, backrests outward.
      const yaw = Math.atan2(-s.x, -s.z);
      this.q.setFromAxisAngle(UP, yaw);
      setInstanceTRS(this.columns, j, s.x, y, s.z, null, 1);
      setInstanceTRS(this.cushions, j, s.x, y, s.z, null, 1);
      // Sunk thrones hide under the floor; only the backrest would poke through.
      const shown = top > 0 ? 1 : 0;
      setInstanceTRS(this.backs, j, s.x, y, s.z, this.q, shown);
      this.back.makeRotationAxis(UP, yaw);
      for (const side of [-1, 1]) {
        this.v.set(side * p.seatRadius * 0.8, 1.48, -p.seatRadius * 0.85).applyMatrix4(this.back);
        setInstanceTRS(
          this.finials,
          j * 2 + (side > 0 ? 1 : 0),
          s.x + this.v.x,
          y + this.v.y,
          s.z + this.v.z,
          null,
          shown,
        );
      }
      this.cushions.setColorAt(j, view!.ownerOf(j) >= 0 ? HELD : FREE);
      setInstanceTRS(this.spots, j, s.x, s.y + 0.03, s.z, null, glowing ? 1 : 0);
    }
    for (const m of [this.columns, this.cushions, this.backs, this.finials, this.spots])
      m.instanceMatrix.needsUpdate = true;
    if (this.cushions.instanceColor) this.cushions.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.d.dispose();
  }
}

/** Throne Floor visual factory. */
export const throneFloorVisual: ObstacleVisualFactory = (instance) => new ThroneFloorVisual(instance);
