/**
 * Rising slime visual: a glossy magenta goo sheet with TSL noise marbling,
 * foam flecks and vertex waves, a deep goo body beneath, and instanced
 * bubbles that swell and pop. Height follows `risingSlimePose` exactly; the
 * surface glows while a rise is telegraphed.
 */
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';
import {
  float,
  mix,
  mx_noise_float,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { ObstacleInstance } from '@tumble/sim';
import { hash01 } from '@tumble/shared';
import {
  risingSlime,
  risingSlimePose,
  risingSlimeSchema,
  risingSlimeTelegraph,
  type RisingSlimeParams,
} from '../../../sim/src/obstacles/risingSlime.ts';
import { createToonMaterial } from '../materials/toon.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import { VisualBase, applyPose, createPatternMaterial, poseBufferFor, setGlow } from './visual-helpers-a.ts';

const GOO = '#ff4fb0';
const GOO_DEEP = '#b0166e';
const FOAM = '#ffe0f2';
const BUBBLES = 28;
const BODY_DEPTH = 24;

class RisingSlimeVisual extends VisualBase<RisingSlimeParams> {
  private readonly level = new Group();
  private readonly poses;
  private readonly time = uniform(0);
  private readonly surfaceMat;
  private readonly bubbles: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, risingSlimeSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(risingSlime, p, ctx.speedScale);

    const segX = Math.min(128, Math.max(16, Math.round(p.width / 0.6)));
    const segZ = Math.min(128, Math.max(16, Math.round(p.depth / 0.6)));
    const g = positionGeometry;
    const tm = this.time;
    const wave = sin(g.x.mul(0.35).add(tm.mul(1.3)))
      .mul(0.12)
      .add(sin(g.y.mul(0.5).sub(tm.mul(1.1))).mul(0.08))
      .add(mx_noise_float(vec3(g.x.mul(0.2), g.y.mul(0.2), tm.mul(0.35))).mul(0.12));

    this.surfaceMat = createToonMaterial({
      color: GOO,
      emissive: GOO,
      emissiveIntensity: 0.15,
      rimStrength: 0.8,
    });
    // Plane-local Z becomes world +Y once the sheet is laid flat.
    this.surfaceMat.positionNode = positionLocal.add(vec3(0, 0, wave));
    const marble = mx_noise_float(vec3(g.x.mul(0.12), g.y.mul(0.12), tm.mul(0.18)))
      .mul(0.5)
      .add(0.5);
    const foamN = mx_noise_float(vec3(g.x.mul(0.6).add(tm.mul(0.4)), g.y.mul(0.6), tm.mul(0.5)));
    const foam = smoothstep(float(0.48), float(0.6), foamN);
    const goo = mix(uniform(new Color(GOO_DEEP)), uniform(new Color(GOO)), marble);
    this.surfaceMat.colorNode = mix(goo, uniform(new Color(FOAM)), foam);
    const sheet = new Mesh(new PlaneGeometry(p.width, p.depth, segX, segZ), this.surfaceMat);
    sheet.rotation.x = -Math.PI / 2;
    sheet.receiveShadow = true;
    this.level.add(sheet);

    const body = new Mesh(
      new BoxGeometry(p.width, BODY_DEPTH, p.depth),
      createPatternMaterial({ a: GOO_DEEP, b: GOO, pattern: 'bands', scale: 0.4, emissive: GOO }),
    );
    body.position.y = -BODY_DEPTH / 2 - 0.05;
    this.level.add(body);

    this.bubbles = new InstancedMesh(
      new SphereGeometry(0.35, 14, 8),
      createPatternMaterial({ a: FOAM, emissive: GOO }),
      BUBBLES,
    );
    this.bubbles.frustumCulled = false;
    this.level.add(this.bubbles);
    this.add(this.level);
  }

  update(t: number): void {
    const p = this.params;
    this.time.value = t;
    risingSlimePose(t, p, this.poses, this.ctx.speedScale);
    applyPose(this.level, this.poses[0]!);
    setGlow(this.surfaceMat, 0.12 + risingSlimeTelegraph(t, p, this.ctx.speedScale) * 0.9);
    for (let i = 0; i < BUBBLES; i++) {
      const life = 1.4 + hash01(i * 7 + 3) * 1.6;
      const cycle = Math.floor((t + hash01(i) * life) / life);
      const u = ((((t + hash01(i) * life) % life) + life) % life) / life;
      const seed = i * 131 + cycle * 7919;
      const sc = u < 0.85 ? Math.sin((u / 0.85) * Math.PI * 0.5) * (0.4 + hash01(seed) * 0.9) : 0;
      this.v.set(
        (hash01(seed + 1) - 0.5) * p.width * 0.9,
        0.05 + sc * 0.1,
        (hash01(seed + 2) - 0.5) * p.depth * 0.9,
      );
      this.s.set(sc, sc * 0.6, sc);
      this.m.compose(this.v, this.q, this.s);
      this.bubbles.setMatrixAt(i, this.m);
    }
    this.bubbles.instanceMatrix.needsUpdate = true;
  }
}

/** Rising slime visual factory. */
export const risingSlimeVisual: ObstacleVisualFactory = (instance, ctx) =>
  new RisingSlimeVisual(instance, ctx);
