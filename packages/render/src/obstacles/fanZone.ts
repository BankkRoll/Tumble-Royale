/**
 * Fan zone visual: a chunky ringed fan whose blades spin up with the sim's
 * wind intensity, plus instanced wind streaks flowing through the volume.
 * The ring pulses before each gust.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import { hash01 } from '@tumble/shared';
import {
  fanHousingRadius,
  fanIntensity,
  fanZoneSchema,
  fanZoneTelegraph,
  type FanZoneParams,
} from '../../../sim/src/obstacles/fanZone.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  createPatternMaterial,
  roundedBox,
  setGlow,
  shadedMesh,
} from './visual-helpers-a.ts';

const STREAKS = 42;

class FanZoneVisual extends VisualBase<FanZoneParams> {
  private readonly blades = new Group();
  private readonly streaks: InstancedMesh;
  private readonly ringMat;
  private bladeAngle = 0;
  /** Cosmetic, dt-integrated so streaks glide smoothly as the fan spins up and down. */
  private flowPhase = 0;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly q = new Quaternion();

  constructor(instance: ObstacleInstance, _ctx: ObstacleVisualContext) {
    super(instance, fanZoneSchema.parse(instance.params));
    const p = this.params;
    const R = fanHousingRadius(p);

    this.ringMat = createPatternMaterial({ a: C.interact, emissive: C.glowWarn });
    const ring = this.add(shadedMesh(new TorusGeometry(R, 0.28, 14, 48), this.ringMat));
    addOutline(ring, 0.03);
    const drum = this.add(
      shadedMesh(
        new CylinderGeometry(R * 0.98, R * 0.9, p.housingDepth, 40, 1, true),
        createPatternMaterial({ a: C.lilac, b: C.grape, pattern: 'bands', scale: 3 }),
      ),
    );
    drum.rotation.x = Math.PI / 2;
    drum.position.z = -p.housingDepth / 2;
    const back = this.add(
      shadedMesh(new CylinderGeometry(R * 0.92, R * 0.92, 0.2, 40), createPatternMaterial({ a: C.grape })),
    );
    back.rotation.x = Math.PI / 2;
    back.position.z = -p.housingDepth;
    const grilleMat = createPatternMaterial({ a: C.cream });
    for (let i = 0; i < 2; i++) {
      const bar = this.add(shadedMesh(roundedBox(R * 2, 0.08, 0.08, 0.03), grilleMat, false));
      bar.rotation.z = (i * Math.PI) / 2;
      bar.position.z = 0.15;
    }

    const bladeMat = createPatternMaterial({ a: C.safe, b: C.white, pattern: 'stripes', scale: 2.5 });
    const bladeGeo = roundedBox(0.7, R * 0.82, 0.12, 0.05);
    for (let i = 0; i < 4; i++) {
      const pivot = new Group();
      pivot.rotation.z = (i * Math.PI) / 2;
      const blade = shadedMesh(bladeGeo, bladeMat);
      blade.position.y = R * 0.45;
      blade.rotation.y = 0.45;
      pivot.add(blade);
      this.blades.add(pivot);
    }
    const hub = shadedMesh(new SphereGeometry(R * 0.18, 20, 12), createPatternMaterial({ a: C.danger }));
    this.blades.add(hub);
    this.blades.position.z = -0.25;
    this.add(this.blades);

    const streakMat = new MeshBasicNodeMaterial({
      color: new Color(C.white),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.streaks = this.add(new InstancedMesh(new BoxGeometry(0.06, 0.06, 1), streakMat, STREAKS));
    this.streaks.frustumCulled = false;
    this.streaks.castShadow = false;
  }

  update(t: number, dt: number): void {
    const p = this.params;
    const k = fanIntensity(t, p);
    this.bladeAngle += dt * (1.5 + 24 * k);
    this.blades.rotation.z = this.bladeAngle;
    setGlow(this.ringMat, 0.1 + fanZoneTelegraph(t, p) + k * 0.25);

    this.flowPhase += dt * (0.35 + 0.65 * k);
    for (let i = 0; i < STREAKS; i++) {
      const hx = hash01(i * 3 + 1);
      const hy = hash01(i * 3 + 2);
      const hz = hash01(i * 3 + 3);
      const speed = 0.6 + hz * 0.5;
      const u = (hz + this.flowPhase * speed) % 1;
      const len = (0.8 + hx * 1.6) * k;
      const fade = Math.sin(Math.PI * u);
      this.v.set((hx - 0.5) * p.width, (hy - 0.5) * p.height, u * p.length);
      this.s.set(fade, fade, Math.max(1e-4, len * fade));
      this.m.compose(this.v, this.q, this.s);
      this.streaks.setMatrixAt(i, this.m);
    }
    this.streaks.instanceMatrix.needsUpdate = true;
  }
}

/** Fan zone visual factory. */
export const fanZoneVisual: ObstacleVisualFactory = (instance, ctx) => new FanZoneVisual(instance, ctx);
