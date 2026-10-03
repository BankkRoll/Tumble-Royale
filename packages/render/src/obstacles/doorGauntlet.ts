/**
 * Door gauntlet visual. Every door is drawn by one InstancedMesh with the same
 * geometry and a per-row colour, so fake and solid doors are pixel-identical
 * until one bursts — no cheating tells. Broken doors tip over, shrink and
 * spray candy crumbs (a second, pooled InstancedMesh).
 */
import {
  Color,
  Euler,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
  IcosahedronGeometry,
} from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime } from '@tumble/sim';
import { hash01 } from '@tumble/shared';
import {
  doorGauntletSchema,
  doorRowZ,
  doorX,
  type DoorGauntletParams,
  type DoorGauntletView,
} from '../../../sim/src/obstacles/doorGauntlet.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  createPatternMaterial,
  roundedBox,
  runtimeView,
} from './visual-helpers-a.ts';

const ROW_COLORS = [C.safe, C.interact, C.pink, C.mint, C.sky, C.lilac];
const CRUMBS_PER_DOOR = 10;
const CRUMB_POOL = 80;
const BURST_TIME = 0.9;
const TIP_TIME = 0.35;

class DoorGauntletVisual extends VisualBase<DoorGauntletParams> {
  private readonly doors: InstancedMesh;
  private readonly knobs: InstancedMesh;
  private readonly crumbs: InstancedMesh;
  private readonly count: number;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly s = new Vector3();
  private readonly zero = new Matrix4().makeScale(0, 0, 0);

  constructor(instance: ObstacleInstance, _ctx: ObstacleVisualContext) {
    super(instance, doorGauntletSchema.parse(instance.params));
    const p = this.params;
    this.count = p.rows * p.doorsPerRow;
    const pitch = p.doorWidth + p.postWidth;

    const frameMat = createPatternMaterial({ a: C.grape, b: C.lilac, pattern: 'bands', scale: 1.5 });
    const posts = this.add(new InstancedMesh(roundedBox(p.postWidth, p.wallHeight, p.doorThickness + 0.2, 0.12), frameMat, p.rows * (p.doorsPerRow + 1)));
    const lintelH = Math.max(0.3, p.wallHeight - p.doorHeight);
    const lintels = this.add(
      new InstancedMesh(roundedBox(p.doorsPerRow * pitch + p.postWidth, lintelH, p.doorThickness + 0.2, 0.15), createPatternMaterial({ a: C.interact, b: C.cream, pattern: 'stripes', scale: 1.2 }), p.rows),
    );
    let k = 0;
    for (let r = 0; r < p.rows; r++) {
      const z = doorRowZ(r, p);
      for (let c = 0; c <= p.doorsPerRow; c++) {
        this.m.makeTranslation((c - p.doorsPerRow / 2) * pitch, p.wallHeight / 2, z);
        posts.setMatrixAt(k++, this.m);
      }
      this.m.makeTranslation(0, p.wallHeight - lintelH / 2, z);
      lintels.setMatrixAt(r, this.m);
    }
    for (const im of [posts, lintels]) {
      im.castShadow = true;
      im.receiveShadow = true;
    }

    this.doors = this.add(new InstancedMesh(roundedBox(p.doorWidth, p.doorHeight, p.doorThickness, 0.14), createPatternMaterial({ a: C.white }), this.count));
    this.knobs = this.add(new InstancedMesh(new SphereGeometry(0.16, 12, 8), createPatternMaterial({ a: C.interact }), this.count * 2));
    const tint = new Color();
    for (let i = 0; i < this.count; i++) {
      const row = Math.floor(i / p.doorsPerRow);
      this.doors.setColorAt(i, tint.set(ROW_COLORS[row % ROW_COLORS.length]!));
    }
    this.doors.castShadow = true;
    this.doors.receiveShadow = true;
    this.knobs.castShadow = true;

    this.crumbs = this.add(new InstancedMesh(new IcosahedronGeometry(0.18, 0), createPatternMaterial({ a: C.white }), CRUMB_POOL));
    for (let i = 0; i < CRUMB_POOL; i++) {
      this.crumbs.setMatrixAt(i, this.zero);
      this.crumbs.setColorAt(i, tint.set(ROW_COLORS[i % ROW_COLORS.length]!));
    }
    this.crumbs.frustumCulled = false;
    this.layout(null, 0);
  }

  /** Writes every door/knob matrix for the current broken state. */
  private layout(view: DoorGauntletView | null, t: number): void {
    const p = this.params;
    let crumb = 0;
    for (let i = 0; i < this.count; i++) {
      const row = Math.floor(i / p.doorsPerRow);
      const col = i % p.doorsPerRow;
      const x = doorX(col, p);
      const z = doorRowZ(row, p);
      const broken = view?.doorBroken[i] === 1;
      const tau = broken ? t - view!.doorBrokenTime[i]! : -1;
      if (broken && tau > BURST_TIME) {
        this.doors.setMatrixAt(i, this.zero);
        this.knobs.setMatrixAt(i * 2, this.zero);
        this.knobs.setMatrixAt(i * 2 + 1, this.zero);
        continue;
      }
      let angle = 0;
      let scale = 1;
      if (broken) {
        const k = Math.min(1, Math.max(0, tau) / TIP_TIME);
        angle = k * k * (Math.PI / 2);
        scale = tau < TIP_TIME ? 1 : Math.max(0, 1 - (tau - TIP_TIME) / (BURST_TIME - TIP_TIME));
        for (let c = 0; c < CRUMBS_PER_DOOR && crumb < CRUMB_POOL; c++, crumb++) this.placeCrumb(crumb, i, c, x, z, Math.max(0, tau));
      }
      // Hinge about the door's bottom-front edge so it slaps down onto the course.
      const half = p.doorHeight / 2;
      const back = -p.doorThickness / 2;
      const cy = half * Math.cos(angle) - back * Math.sin(angle);
      const cz = half * Math.sin(angle) + back * Math.cos(angle);
      this.e.set(angle, 0, 0);
      this.q.setFromEuler(this.e);
      this.v.set(x, cy * scale, z + p.doorThickness / 2 + cz * scale);
      this.s.set(scale, scale, scale);
      this.m.compose(this.v, this.q, this.s);
      this.doors.setMatrixAt(i, this.m);
      for (let side = 0; side < 2; side++) {
        const kz = (side === 0 ? 1 : -1) * (p.doorThickness / 2 + 0.08);
        const ky = 0.15 - p.doorHeight * 0.05;
        const ly = ky * Math.cos(angle) - kz * Math.sin(angle);
        const lz = ky * Math.sin(angle) + kz * Math.cos(angle);
        this.v.set(x + p.doorWidth * 0.32 * scale, (cy + ly) * scale, z + p.doorThickness / 2 + (cz + lz) * scale);
        this.m.compose(this.v, this.q, this.s);
        this.knobs.setMatrixAt(i * 2 + side, this.m);
      }
    }
    for (; crumb < CRUMB_POOL; crumb++) this.crumbs.setMatrixAt(crumb, this.zero);
    this.doors.instanceMatrix.needsUpdate = true;
    this.knobs.instanceMatrix.needsUpdate = true;
    this.crumbs.instanceMatrix.needsUpdate = true;
  }

  private placeCrumb(slot: number, door: number, c: number, x: number, z: number, tau: number): void {
    const p = this.params;
    const seed = door * 131 + c * 17;
    const vx = (hash01(seed) - 0.5) * 7;
    const vy = 3 + hash01(seed + 1) * 6;
    const vz = 1.5 + hash01(seed + 2) * 5;
    const sx = (hash01(seed + 3) - 0.5) * p.doorWidth;
    const sy = hash01(seed + 4) * p.doorHeight;
    const y = Math.max(0.1, sy + vy * tau - 12 * tau * tau);
    const life = 1 - tau / BURST_TIME;
    this.e.set(tau * 9 + c, tau * 7, 0);
    this.q.setFromEuler(this.e);
    this.v.set(x + sx + vx * tau, y, z + vz * tau);
    const sc = Math.max(0, life) * (0.7 + hash01(seed + 5) * 0.8);
    this.s.set(sc, sc, sc);
    this.m.compose(this.v, this.q, this.s);
    this.crumbs.setMatrixAt(slot, this.m);
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtimeView<DoorGauntletView>(runtime, 'doorBroken');
    if (view) this.layout(view, t);
  }
}

/** Door gauntlet visual factory. */
export const doorGauntletVisual: ObstacleVisualFactory = (instance, ctx) => new DoorGauntletVisual(instance, ctx);
