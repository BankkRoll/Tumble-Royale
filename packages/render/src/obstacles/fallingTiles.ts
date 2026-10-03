/**
 * Falling tiles visual: the whole grid is one InstancedMesh (hundreds of
 * tiles, one draw call). Warning tiles flash hot and shake, fallen tiles drop
 * and tumble away, respawned tiles pop back in. Idle tiles are only rewritten
 * when their state changes, so large fields cost almost nothing per frame.
 */
import {
  Color,
  CylinderGeometry,
  Euler,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime } from '@tumble/sim';
import { hash01, vec3 } from '@tumble/shared';
import {
  TileState,
  fallingTileCenter,
  fallingTileCount,
  fallingTilesSchema,
  type FallingTilesParams,
  type FallingTilesView,
} from '../../../sim/src/obstacles/fallingTiles.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  createPatternMaterial,
  roundedBox,
  runtimeView,
} from './visual-helpers-a.ts';

const DROP_TIME = 1.6;
const POP_TIME = 0.35;

class FallingTilesVisual extends VisualBase<FallingTilesParams> {
  private readonly mesh: InstancedMesh;
  private readonly count: number;
  private readonly centers: Float32Array;
  private readonly baseColors: Color[] = [];
  /** 1 once an idle tile's rest matrix/colour has been written. */
  private readonly settled: Uint8Array;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly s = new Vector3();
  private readonly col = new Color();
  private readonly warnA = new Color(C.dangerAlt);
  private readonly warnB = new Color(C.danger);

  constructor(instance: ObstacleInstance, _ctx: ObstacleVisualContext) {
    super(instance, fallingTilesSchema.parse(instance.params));
    const p = this.params;
    this.count = fallingTileCount(p);
    this.centers = new Float32Array(this.count * 2);
    this.settled = new Uint8Array(this.count);
    let geo: BufferGeometry;
    if (p.shape === 'hex') {
      const R = p.tileSize / Math.sqrt(3);
      geo = new CylinderGeometry(R, R * 0.94, p.thickness, 6, 1);
    } else {
      geo = roundedBox(p.tileSize, p.thickness, p.tileSize, 0.12);
    }
    geo.translate(0, -p.thickness / 2, 0);
    this.mesh = this.add(
      new InstancedMesh(geo, createPatternMaterial({ a: C.white, rimStrength: 0.55 }), this.count),
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    const palette = [C.safe, C.mint, C.sky, C.lilac];
    const c = vec3();
    for (let i = 0; i < this.count; i++) {
      fallingTileCenter(i, p, c);
      this.centers[i * 2] = c.x;
      this.centers[i * 2 + 1] = c.z;
      const row = Math.floor(i / p.cols);
      const colIdx = i % p.cols;
      this.baseColors.push(new Color(palette[(row + colIdx * 2) % palette.length]!));
    }
    this.draw(null, 0);
  }

  private draw(view: FallingTilesView | null, t: number): void {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const state = view ? view.tileState[i]! : TileState.Idle;
      const age = view ? t - view.tileTime[i]! : Infinity;
      // tileTime 0 means "never changed" — only genuine respawns pop in.
      const popping =
        state === TileState.Idle && view !== null && view.tileTime[i] !== 0 && age >= 0 && age < POP_TIME;
      if (state === TileState.Idle && !popping && this.settled[i]) continue;
      this.settled[i] = state === TileState.Idle && !popping ? 1 : 0;
      dirty = true;

      const x = this.centers[i * 2]!;
      const z = this.centers[i * 2 + 1]!;
      let y = 0;
      let sc = 1;
      this.e.set(0, 0, 0);
      this.col.copy(this.baseColors[i]!);
      if (state === TileState.Warning) {
        const k = Math.min(1, Math.max(0, age) / Math.max(0.05, this.params.warnTime));
        const shake = 0.05 + 0.1 * k;
        const ph = t * (38 + 30 * k) + i;
        this.e.set(Math.sin(ph) * shake * 0.4, 0, Math.cos(ph * 1.3) * shake * 0.4);
        y = Math.abs(Math.sin(ph * 0.7)) * shake * 0.6;
        const flash = 0.5 + 0.5 * Math.sin(t * (10 + 20 * k));
        this.col.lerp(flash > 0.5 ? this.warnB : this.warnA, 0.35 + 0.55 * k);
      } else if (state === TileState.Fallen) {
        const a = Math.max(0, age);
        if (a > DROP_TIME) {
          sc = 0;
        } else {
          y = -0.5 * 22 * a * a;
          const spin = (hash01(i) - 0.5) * 6;
          this.e.set(a * spin, 0, a * (hash01(i + 99) - 0.5) * 6);
          sc = a < DROP_TIME * 0.6 ? 1 : 1 - (a - DROP_TIME * 0.6) / (DROP_TIME * 0.4);
          this.col.lerp(this.warnB, 0.5);
        }
      } else if (popping) {
        const k = age / POP_TIME;
        sc = 1 + Math.sin(k * Math.PI) * 0.15;
        sc *= Math.min(1, k * 3);
      }
      this.q.setFromEuler(this.e);
      this.v.set(x, y, z);
      this.s.set(sc, sc, sc);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.col);
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtimeView<FallingTilesView>(runtime, 'tileState');
    if (view) this.draw(view, t);
  }
}

/** Falling tiles visual factory. */
export const fallingTilesVisual: ObstacleVisualFactory = (instance, ctx) =>
  new FallingTilesVisual(instance, ctx);
