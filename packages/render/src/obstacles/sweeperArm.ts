/**
 * Sweeper arm visual: striped candy post with low hazard bar(s) whose glow
 * builds as the sweeper approaches top speed.
 */
import { CapsuleGeometry, CylinderGeometry, Group, SphereGeometry } from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import {
  sweeperArm,
  sweeperArmPose,
  sweeperArmSchema,
  sweeperArmTelegraph,
  sweeperPartCount,
  type SweeperArmParams,
} from '../../../sim/src/obstacles/sweeperArm.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  applyPose,
  createPatternMaterial,
  poseBufferFor,
  setGlow,
  shadedMesh,
} from './visual-helpers-a.ts';

class SweeperArmVisual extends VisualBase<SweeperArmParams> {
  private readonly parts: Group[] = [];
  private readonly poses;
  private readonly barMat;

  constructor(instance: ObstacleInstance, private readonly ctx: ObstacleVisualContext) {
    super(instance, sweeperArmSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(sweeperArm, p, ctx.speedScale);

    const post = this.add(
      shadedMesh(
        new CylinderGeometry(p.postRadius * 0.9, p.postRadius, p.postHeight, 32),
        createPatternMaterial({ a: C.interact, b: C.cream, pattern: 'stripes', scale: 2 }),
      ),
    );
    post.position.y = p.postHeight / 2;
    const dome = this.add(shadedMesh(new SphereGeometry(p.postRadius * 0.9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), createPatternMaterial({ a: C.pink })));
    dome.position.y = p.postHeight;
    addOutline(dome, 0.03);

    this.barMat = createPatternMaterial({ a: C.danger, b: C.dangerAlt, pattern: 'stripes', scale: 2.4, emissive: C.glowDanger });
    const tipMat = createPatternMaterial({ a: C.interact });
    const reach = p.armLength - p.postRadius * 0.6;
    const barGeo = new CapsuleGeometry(p.armRadius, Math.max(0.05, reach - 2 * p.armRadius), 6, 16);
    const tipGeo = new SphereGeometry(p.armRadius * 1.25, 16, 10);
    for (let part = 0; part < sweeperPartCount(p); part++) {
      const g = new Group();
      for (let a = 0; a < p.armCount; a++) {
        const pivot = new Group();
        pivot.rotation.y = (a / p.armCount) * Math.PI * 2;
        const bar = shadedMesh(barGeo, this.barMat);
        bar.rotation.z = Math.PI / 2;
        bar.position.x = p.postRadius * 0.6 + reach / 2;
        pivot.add(bar);
        const tip = shadedMesh(tipGeo, tipMat);
        tip.position.x = p.armLength - p.armRadius;
        pivot.add(tip);
        g.add(pivot);
      }
      this.parts.push(this.add(g));
    }
  }

  update(t: number): void {
    sweeperArmPose(t, this.params, this.poses, this.ctx.speedScale);
    for (let i = 0; i < this.parts.length; i++) applyPose(this.parts[i]!, this.poses[i]!);
    setGlow(this.barMat, 0.12 + sweeperArmTelegraph(t, this.params, this.ctx.speedScale) * 0.8);
  }
}

/** Sweeper arm visual factory. */
export const sweeperArmVisual: ObstacleVisualFactory = (instance, ctx) => new SweeperArmVisual(instance, ctx);
