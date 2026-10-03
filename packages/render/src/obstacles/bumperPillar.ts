/**
 * Bumper pillar visual: a glossy pink-and-white banded column with a gumdrop
 * cap that squash-wobbles whenever the sim reports a bounce.
 */
import { CylinderGeometry, Group, SphereGeometry, TorusGeometry } from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime } from '@tumble/sim';
import {
  bumperPillar,
  bumperPillarPose,
  bumperPillarSchema,
  type BumperPillarParams,
  type BumperPillarView,
} from '../../../sim/src/obstacles/bumperPillar.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  applyPose,
  createPatternMaterial,
  poseBufferFor,
  runtimeView,
  setGlow,
  shadedMesh,
  wobble,
} from './visual-helpers-a.ts';

class BumperPillarVisual extends VisualBase<BumperPillarParams> {
  private readonly root = new Group();
  private readonly body = new Group();
  private readonly poses;
  private readonly bodyMat;

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, bumperPillarSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(bumperPillar, p, ctx.speedScale);

    this.bodyMat = createPatternMaterial({
      a: C.pink,
      b: C.white,
      pattern: 'bands',
      scale: 1.6,
      emissive: C.danger,
      rimStrength: 0.7,
    });
    const column = shadedMesh(new CylinderGeometry(p.radius, p.radius, p.height, 40), this.bodyMat);
    column.position.y = p.height / 2;
    this.body.add(column);
    const cap = shadedMesh(
      new SphereGeometry(p.radius * 1.02, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      createPatternMaterial({ a: C.danger }),
    );
    cap.position.y = p.height;
    addOutline(cap, 0.03);
    this.body.add(cap);
    const ringGeo = new TorusGeometry(p.radius * 1.02, 0.14, 10, 40);
    const ringMat = createPatternMaterial({ a: C.interact });
    for (const y of [0.18, p.height * 0.55]) {
      const ring = shadedMesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.body.add(ring);
    }
    this.root.add(this.body);
    this.add(this.root);
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    bumperPillarPose(t, this.params, this.poses, this.ctx.speedScale);
    applyPose(this.root, this.poses[0]!);
    const view = runtimeView<BumperPillarView>(runtime, 'lastHitTime');
    const w = view ? wobble(t - view.lastHitTime) : 0;
    this.body.scale.set(1 + w * 0.12, 1 - w * 0.1, 1 + w * 0.12);
    setGlow(this.bodyMat, Math.abs(w) * 0.8);
  }
}

/** Bumper pillar visual factory. */
export const bumperPillarVisual: ObstacleVisualFactory = (instance, ctx) =>
  new BumperPillarVisual(instance, ctx);
