/**
 * Spinwheel visual: banded candy hub, hazard-striped arms with gumdrop tips,
 * one group per tier posed from the sim's `spinwheelPose`.
 */
import { CylinderGeometry, Group, SphereGeometry } from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import {
  spinwheel,
  spinwheelPose,
  spinwheelSchema,
  spinwheelTelegraph,
  type SpinwheelParams,
} from '../../../sim/src/obstacles/spinwheel.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  applyPose,
  createPatternMaterial,
  poseBufferFor,
  roundedBox,
  setGlow,
  shadedMesh,
} from './visual-helpers-a.ts';

class SpinwheelVisual extends VisualBase<SpinwheelParams> {
  private readonly tiers: Group[] = [];
  private readonly poses;
  private readonly armMat;
  private readonly tipMat;

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, spinwheelSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(spinwheel, p, ctx.speedScale);

    const hubMat = createPatternMaterial({ a: C.interact, b: C.cream, pattern: 'bands', scale: 2.2 });
    const hub = this.add(
      shadedMesh(new CylinderGeometry(p.hubRadius * 0.9, p.hubRadius, p.hubHeight, 32), hubMat),
    );
    hub.position.y = p.hubHeight / 2;
    const cap = this.add(
      shadedMesh(new SphereGeometry(p.hubRadius * 0.75, 24, 12), createPatternMaterial({ a: C.pink })),
    );
    cap.position.y = p.hubHeight;
    addOutline(cap, 0.03);
    const foot = this.add(
      shadedMesh(
        new CylinderGeometry(p.hubRadius * 1.6, p.hubRadius * 1.8, 0.25, 32),
        createPatternMaterial({ a: C.mint }),
      ),
    );
    foot.position.y = 0.12;

    this.armMat = createPatternMaterial({
      a: C.danger,
      b: C.dangerAlt,
      pattern: 'stripes',
      scale: 1.4,
      emissive: C.glowDanger,
    });
    this.tipMat = createPatternMaterial({ a: C.danger, emissive: C.glowWarn });
    const halfLen = (p.armLength - p.hubRadius * 0.5) / 2;
    const armGeo = roundedBox(halfLen * 2, p.armThickness, p.armThickness, p.armThickness * 0.35);
    const tipGeo = new SphereGeometry(p.armThickness * 0.85, 20, 12);
    for (let tier = 0; tier < p.tiers; tier++) {
      const g = new Group();
      for (let a = 0; a < p.armCount; a++) {
        const yaw = (a / p.armCount) * Math.PI * 2;
        const pivot = new Group();
        pivot.rotation.y = yaw;
        const arm = shadedMesh(armGeo, this.armMat);
        arm.position.x = p.hubRadius * 0.5 + halfLen;
        pivot.add(arm);
        const tip = shadedMesh(tipGeo, this.tipMat);
        tip.position.x = p.armLength;
        pivot.add(tip);
        g.add(pivot);
      }
      const collar = shadedMesh(
        new CylinderGeometry(p.hubRadius * 1.05, p.hubRadius * 1.05, p.armThickness * 1.2, 24),
        this.tipMat,
      );
      g.add(collar);
      this.tiers.push(this.add(g));
    }
  }

  update(t: number): void {
    spinwheelPose(t, this.params, this.poses, this.ctx.speedScale);
    for (let i = 0; i < this.tiers.length; i++) applyPose(this.tiers[i]!, this.poses[i]!);
    const g = spinwheelTelegraph(t, this.params);
    setGlow(this.armMat, 0.15 + g);
    setGlow(this.tipMat, 0.2 + g * 1.2);
  }
}

/** Spinwheel visual factory. */
export const spinwheelVisual: ObstacleVisualFactory = (instance, ctx) => new SpinwheelVisual(instance, ctx);
