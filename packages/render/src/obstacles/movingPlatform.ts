/**
 * Moving platform visual: a checkered safe-coloured deck with a yellow bumper
 * lip and propeller-free "hover" jets, plus a dotted track (one
 * InstancedMesh) tracing the authored path so players can read where it goes.
 */
import {
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Color,
  SphereGeometry,
} from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import {
  movingPlatform,
  movingPlatformPose,
  movingPlatformSchema,
  type MovingPlatformParams,
} from '../../../sim/src/obstacles/movingPlatform.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  applyPose,
  createPatternMaterial,
  poseBufferFor,
  roundedBox,
  shadedMesh,
} from './visual-helpers-a.ts';

const DOT_SPACING = 0.9;

class MovingPlatformVisual extends VisualBase<MovingPlatformParams> {
  private readonly deck = new Group();
  private readonly jets: Group[] = [];
  private readonly poses;

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, movingPlatformSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(movingPlatform, p, ctx.speedScale);

    const slab = shadedMesh(
      roundedBox(p.size.x, p.size.y, p.size.z, Math.min(0.15, p.size.y * 0.3)),
      createPatternMaterial({ a: C.safe, b: C.mint, pattern: 'checker', scale: 1.4 }),
    );
    slab.position.y = -p.size.y / 2;
    this.deck.add(slab);
    const lip = shadedMesh(
      roundedBox(p.size.x + 0.2, p.size.y * 0.45, p.size.z + 0.2, 0.08),
      createPatternMaterial({ a: C.interact, b: C.dangerAlt, pattern: 'stripes', scale: 1.6 }),
    );
    lip.position.y = -p.size.y * 0.75;
    this.deck.add(lip);

    const jetMat = new MeshBasicNodeMaterial({
      color: new Color(C.sky),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const jetGeo = new ConeGeometry(0.32, 0.9, 16, 1, true);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const jet = new Group();
        const flame = new InstancedMesh(jetGeo, jetMat, 1);
        flame.setMatrixAt(0, new Matrix4().makeRotationX(Math.PI));
        jet.add(flame);
        jet.position.set(sx * p.size.x * 0.32, -p.size.y - 0.5, sz * p.size.z * 0.32);
        this.deck.add(jet);
        this.jets.push(jet);
      }
    }
    this.add(this.deck);
    this.buildTrack();
  }

  /** Dotted guide along every path segment (decorative, static). */
  private buildTrack(): void {
    const pts = this.params.points;
    if (pts.length < 2) return;
    const closed = this.params.mode === 'loop';
    const segs = closed ? pts.length : pts.length - 1;
    let total = 0;
    for (let s = 0; s < segs; s++) {
      const a = pts[s]!;
      const b = pts[(s + 1) % pts.length]!;
      total += Math.max(1, Math.floor(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / DOT_SPACING));
    }
    const dots = this.add(
      new InstancedMesh(new SphereGeometry(0.12, 8, 6), createPatternMaterial({ a: C.cream }), total),
    );
    const m = new Matrix4();
    let k = 0;
    for (let s = 0; s < segs; s++) {
      const a = pts[s]!;
      const b = pts[(s + 1) % pts.length]!;
      const n = Math.max(1, Math.floor(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / DOT_SPACING));
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        m.makeTranslation(
          a.x + (b.x - a.x) * f,
          a.y + (b.y - a.y) * f - this.params.size.y - 0.9,
          a.z + (b.z - a.z) * f,
        );
        dots.setMatrixAt(k++, m);
      }
    }
  }

  update(t: number): void {
    movingPlatformPose(t, this.params, this.poses, this.ctx.speedScale);
    applyPose(this.deck, this.poses[0]!);
    for (let i = 0; i < this.jets.length; i++) {
      const flicker = 0.85 + 0.15 * Math.sin(t * 31 + i * 1.7);
      this.jets[i]!.scale.set(flicker, 0.8 + 0.3 * flicker, flicker);
    }
  }
}

/** Moving platform visual factory. */
export const movingPlatformVisual: ObstacleVisualFactory = (instance, ctx) =>
  new MovingPlatformVisual(instance, ctx);
