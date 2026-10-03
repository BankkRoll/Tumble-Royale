/**
 * Pendulum hammer visual: lilac gantry, candy-cane arm and a striped mallet
 * head with squishy bumper rings; posed from `pendulumHammerPose`.
 */
import { CylinderGeometry, Group, TorusGeometry } from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import {
  pendulumHammer,
  pendulumHammerPose,
  pendulumHammerSchema,
  pendulumHammerTelegraph,
  pendulumSupportSpan,
  type PendulumHammerParams,
} from '../../../sim/src/obstacles/pendulumHammer.ts';
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

class PendulumHammerVisual extends VisualBase<PendulumHammerParams> {
  private readonly swing = new Group();
  private readonly poses;
  private readonly headMat;

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, pendulumHammerSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(pendulumHammer, p, ctx.speedScale);

    if (p.supports) {
      const span = pendulumSupportSpan(p);
      const postH = p.pivotHeight + 0.6;
      const postMat = createPatternMaterial({ a: C.lilac, b: C.cream, pattern: 'bands', scale: 1.2 });
      const postGeo = new CylinderGeometry(0.45, 0.55, postH, 24);
      for (const side of [-1, 1]) {
        const post = this.add(shadedMesh(postGeo, postMat));
        post.position.set(side * span, postH / 2, 0);
      }
      const beam = this.add(
        shadedMesh(roundedBox(span * 2 + 0.9, 0.8, 1, 0.3), createPatternMaterial({ a: C.grape })),
      );
      beam.position.y = p.pivotHeight + 0.6;
    }

    const axle = shadedMesh(
      new CylinderGeometry(0.35, 0.35, 1.3, 20),
      createPatternMaterial({ a: C.interact }),
    );
    axle.rotation.x = Math.PI / 2;
    this.swing.add(axle);

    const arm = shadedMesh(
      roundedBox(p.armThickness, p.armLength, p.armThickness, p.armThickness * 0.4),
      createPatternMaterial({ a: C.cream, b: C.pink, pattern: 'stripes', scale: 2 }),
    );
    arm.position.y = -p.armLength / 2;
    this.swing.add(arm);

    this.headMat = createPatternMaterial({
      a: C.danger,
      b: C.dangerAlt,
      pattern: 'stripes',
      scale: 1.1,
      emissive: C.glowDanger,
    });
    const head = shadedMesh(
      new CylinderGeometry(p.headRadius, p.headRadius, p.headLength, 40, 1),
      this.headMat,
    );
    head.rotation.z = Math.PI / 2;
    head.position.y = -p.armLength;
    addOutline(head, 0.04);
    this.swing.add(head);

    const ringMat = createPatternMaterial({ a: C.interact });
    const ringGeo = new TorusGeometry(p.headRadius * 0.92, p.headRadius * 0.16, 12, 36);
    for (const side of [-1, 1]) {
      const ring = shadedMesh(ringGeo, ringMat);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(side * (p.headLength / 2), -p.armLength, 0);
      this.swing.add(ring);
    }
    this.add(this.swing);
  }

  update(t: number): void {
    pendulumHammerPose(t, this.params, this.poses, this.ctx.speedScale);
    applyPose(this.swing, this.poses[0]!);
    setGlow(this.headMat, 0.1 + pendulumHammerTelegraph(t, this.params, this.ctx.speedScale) * 0.9);
  }
}

/** Pendulum hammer visual factory. */
export const pendulumHammerVisual: ObstacleVisualFactory = (instance, ctx) =>
  new PendulumHammerVisual(instance, ctx);
