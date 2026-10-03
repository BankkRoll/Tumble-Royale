/**
 * Bounce pad visual: a yellow drum with a squishy cyan cushion that squashes
 * and springs back on every launch the sim reports, an expanding shock ring,
 * and a chevron pointing along the authored launch direction.
 */
import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime } from '@tumble/sim';
import {
  bouncePadSchema,
  type BouncePadParams,
  type BouncePadView,
} from '../../../sim/src/obstacles/bouncePad.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  createPatternMaterial,
  runtimeView,
  setGlow,
  shadedMesh,
} from './visual-helpers-a.ts';

class BouncePadVisual extends VisualBase<BouncePadParams> {
  private readonly cushion = new Group();
  private readonly ring: Mesh;
  private readonly ringMat: MeshBasicNodeMaterial;
  private readonly cushionMat;

  constructor(instance: ObstacleInstance, _ctx: ObstacleVisualContext) {
    super(instance, bouncePadSchema.parse(instance.params));
    const p = this.params;
    const drum = this.add(
      shadedMesh(
        new CylinderGeometry(p.radius, p.radius * 1.08, p.height * 0.7, 40),
        createPatternMaterial({ a: C.interact, b: C.dangerAlt, pattern: 'stripes', scale: 2.2 }),
      ),
    );
    drum.position.y = p.height * 0.35;

    this.cushionMat = createPatternMaterial({
      a: C.safe,
      b: C.white,
      pattern: 'pie',
      scale: 10,
      emissive: C.safe,
      rimStrength: 0.7,
    });
    const dome = shadedMesh(
      new SphereGeometry(p.radius * 0.94, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      this.cushionMat,
    );
    dome.scale.y = (p.height * 0.9) / (p.radius * 0.94);
    addOutline(dome, 0.03);
    this.cushion.add(dome);
    this.cushion.position.y = p.height * 0.62;
    this.add(this.cushion);

    const len = Math.hypot(p.launch.x, p.launch.y, p.launch.z);
    if (len > 0) {
      const arrow = shadedMesh(new ConeGeometry(0.28, 0.6, 16), createPatternMaterial({ a: C.danger }));
      arrow.position.set(0, p.height * 0.75 + 0.55, 0);
      // Cone points +Y; aim it along the launch vector.
      arrow.quaternion.setFromUnitVectors(
        new Vector3(0, 1, 0),
        new Vector3(p.launch.x / len, p.launch.y / len, p.launch.z / len),
      );
      this.cushion.add(arrow);
    }

    this.ringMat = new MeshBasicNodeMaterial({
      color: new Color(C.white),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.ring = this.add(new Mesh(new TorusGeometry(p.radius, 0.09, 8, 48), this.ringMat));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = p.height + 0.05;
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtimeView<BouncePadView>(runtime, 'lastBounceTime');
    const since = view ? t - view.lastBounceTime : Infinity;
    let squash = 0.03 * Math.sin(t * 3);
    if (since >= 0 && since < 0.8) squash = -0.45 * Math.exp(-since * 7) * Math.cos(since * 22);
    this.cushion.scale.set(1 - squash * 0.4, 1 + squash, 1 - squash * 0.4);
    const ringK = since >= 0 && since < 0.5 ? since / 0.5 : 1;
    this.ring.scale.setScalar(1 + ringK * 1.6);
    this.ringMat.opacity = (1 - ringK) * 0.85;
    this.ring.visible = ringK < 1;
    setGlow(this.cushionMat, since < 0.4 ? (1 - since / 0.4) * 0.8 : 0.05);
  }
}

/** Bounce pad visual factory. */
export const bouncePadVisual: ObstacleVisualFactory = (instance, ctx) => new BouncePadVisual(instance, ctx);
