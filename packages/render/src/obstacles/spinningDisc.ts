/**
 * Spinning disc visual: a pie-sliced mint/cyan turntable with a yellow rim
 * (which glows before reversals), gumdrop bumper knobs and a candy hub,
 * posed from `spinningDiscPose`.
 */
import { CylinderGeometry, Group, SphereGeometry, TorusGeometry } from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import {
  spinningDisc,
  spinningDiscBump,
  spinningDiscPose,
  spinningDiscSchema,
  spinningDiscTelegraph,
  type SpinningDiscParams,
} from '../../../sim/src/obstacles/spinningDisc.ts';
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

class SpinningDiscVisual extends VisualBase<SpinningDiscParams> {
  private readonly disc = new Group();
  private readonly poses;
  private readonly rimMat;

  constructor(instance: ObstacleInstance, private readonly ctx: ObstacleVisualContext) {
    super(instance, spinningDiscSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(spinningDisc, p, ctx.speedScale);

    const top = shadedMesh(
      new CylinderGeometry(p.radius, p.radius * 0.96, p.thickness, 72),
      createPatternMaterial({ a: C.mint, b: C.safe, pattern: 'pie', scale: 12 }),
    );
    top.position.y = -p.thickness / 2;
    this.disc.add(top);

    this.rimMat = createPatternMaterial({ a: C.interact, b: C.dangerAlt, pattern: 'pie', scale: 48, emissive: C.glowWarn });
    const rim = shadedMesh(new TorusGeometry(p.radius, p.thickness * 0.32, 12, 96), this.rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -p.thickness * 0.35;
    this.disc.add(rim);

    const hub = shadedMesh(new SphereGeometry(Math.min(0.9, p.radius * 0.15), 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), createPatternMaterial({ a: C.pink }));
    addOutline(hub, 0.03);
    this.disc.add(hub);

    if (p.bumps > 0) {
      const bumpMat = createPatternMaterial({ a: C.danger, b: C.white, pattern: 'bands', scale: 6 });
      const bumpGeo = new SphereGeometry(p.bumpRadius, 20, 12);
      for (let i = 0; i < p.bumps; i++) {
        const b = spinningDiscBump(i, p);
        const bump = shadedMesh(bumpGeo, bumpMat);
        bump.position.set(b.x, 0, b.z);
        this.disc.add(bump);
      }
    }
    this.add(this.disc);

    const skirt = this.add(shadedMesh(new CylinderGeometry(p.radius * 0.3, p.radius * 0.2, 1.4, 32), createPatternMaterial({ a: C.lilac, b: C.grape, pattern: 'bands', scale: 2 })));
    skirt.position.y = -p.thickness - 0.7;
  }

  update(t: number): void {
    spinningDiscPose(t, this.params, this.poses, this.ctx.speedScale);
    applyPose(this.disc, this.poses[0]!);
    setGlow(this.rimMat, 0.05 + spinningDiscTelegraph(t, this.params));
  }
}

/** Spinning disc visual factory. */
export const spinningDiscVisual: ObstacleVisualFactory = (instance, ctx) => new SpinningDiscVisual(instance, ctx);
