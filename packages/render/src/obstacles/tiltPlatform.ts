/**
 * Tilt platform visual: a checkered candy plate with a yellow rim on a
 * striped column. Plate orientation comes from the replicated/predicted
 * runtime's hinge angles.
 */
import { CylinderGeometry, Group, SphereGeometry, TorusGeometry } from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime } from '@tumble/sim';
import { quatIdentity } from '@tumble/shared';
import {
  tiltPlatformSchema,
  tiltRotation,
  type TiltPlatformParams,
  type TiltPlatformView,
} from '../../../sim/src/obstacles/tiltPlatform.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  createPatternMaterial,
  createTopSheenMaterial,
  roundedBox,
  runtimeView,
  shadedMesh,
} from './visual-helpers-a.ts';

class TiltPlatformVisual extends VisualBase<TiltPlatformParams> {
  private readonly plate = new Group();
  private readonly q = quatIdentity();

  constructor(instance: ObstacleInstance, _ctx: ObstacleVisualContext) {
    super(instance, tiltPlatformSchema.parse(instance.params));
    const p = this.params;
    const pivotY = -p.pivotDepth;
    this.plate.position.y = pivotY;

    const topMat = createPatternMaterial({ a: C.safe, b: C.mint, pattern: 'checker', scale: 0.9 });
    const rimMat = createPatternMaterial({ a: C.interact, b: C.dangerAlt, pattern: 'stripes', scale: 1.4 });
    if (p.shape === 'disc') {
      const disc = shadedMesh(new CylinderGeometry(p.radius, p.radius * 0.97, p.thickness, 56), topMat);
      disc.position.y = p.pivotDepth;
      this.plate.add(disc);
      const rim = shadedMesh(new TorusGeometry(p.radius, p.thickness * 0.3, 10, 64), rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = p.pivotDepth + p.thickness * 0.3;
      this.plate.add(rim);
    } else {
      const slab = shadedMesh(roundedBox(p.sizeX, p.thickness, p.sizeZ, 0.18), topMat);
      slab.position.y = p.pivotDepth;
      this.plate.add(slab);
      const lip = shadedMesh(roundedBox(p.sizeX + 0.24, p.thickness * 0.5, p.sizeZ + 0.24, 0.1), rimMat);
      lip.position.y = p.pivotDepth - p.thickness * 0.3;
      this.plate.add(lip);
    }
    const knob = shadedMesh(new SphereGeometry(0.45, 20, 10), createPatternMaterial({ a: C.pink }));
    knob.position.y = p.pivotDepth - p.thickness / 2 - 0.25;
    addOutline(knob, 0.03);
    this.plate.add(knob);
    this.add(this.plate);

    if (p.column) {
      const top = -p.thickness / 2 - 0.45;
      const col = this.add(
        shadedMesh(
          new CylinderGeometry(0.55, 0.75, p.columnHeight, 32),
          createPatternMaterial({ a: C.white, b: C.pink, pattern: 'stripes', scale: 1.8 }),
        ),
      );
      col.position.y = top - p.columnHeight / 2;
      const cup = this.add(
        shadedMesh(new CylinderGeometry(0.8, 0.6, 0.35, 32), createTopSheenMaterial(C.cream, C.lilac)),
      );
      cup.position.y = top - 0.05;
    }
  }

  update(_t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtimeView<TiltPlatformView>(runtime, 'tiltX');
    tiltRotation(view?.tiltX ?? 0, view?.tiltZ ?? 0, this.q);
    this.plate.quaternion.set(this.q.x, this.q.y, this.q.z, this.q.w);
  }
}

/** Tilt platform visual factory. */
export const tiltPlatformVisual: ObstacleVisualFactory = (instance, ctx) =>
  new TiltPlatformVisual(instance, ctx);
