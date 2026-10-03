/**
 * Boulder lane visual: candy jawbreakers (one InstancedMesh for the whole
 * pool) with swirl stripes in a per-ball colour, rolling exactly along
 * `boulderLanePose`. Includes drop chutes over each lane and painted
 * hazard lane dividers.
 */
import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import { atan, fract, instancedBufferAttribute, mix, positionGeometry, smoothstep, vec3 } from 'three/tsl';
import type { ObstacleInstance } from '@tumble/sim';
import {
  BOULDER_PARKED_Y,
  boulderLane,
  boulderLanePose,
  boulderLaneSchema,
  type BoulderLaneParams,
} from '../../../sim/src/obstacles/boulderLane.ts';
import { createToonMaterial } from '../materials/toon.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  createPatternMaterial,
  poseBufferFor,
  shadedMesh,
} from './visual-helpers-a.ts';

const BALL_COLORS = [C.danger, C.dangerAlt, C.grape, C.safe, C.interact];

class BoulderLaneVisual extends VisualBase<BoulderLaneParams> {
  private readonly balls: InstancedMesh;
  private readonly poses;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  constructor(
    instance: ObstacleInstance,
    private readonly ctx: ObstacleVisualContext,
  ) {
    super(instance, boulderLaneSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(boulderLane, p, ctx.speedScale);
    const pool = this.poses.length;

    const tints = new Float32Array(pool * 3);
    const c = new Color();
    for (let i = 0; i < pool; i++) c.set(BALL_COLORS[i % BALL_COLORS.length]!).toArray(tints, i * 3);
    const tint = instancedBufferAttribute<'vec3'>(new InstancedBufferAttribute(tints, 3), 'vec3');
    const mat = createToonMaterial({ color: C.white, rimStrength: 0.75 });
    const g = positionGeometry;
    const swirl = fract(
      atan(g.z, g.x)
        .div(Math.PI * 2)
        .mul(5)
        .add(g.y.div(p.radius).mul(0.9)),
    );
    const band = smoothstep(0.42, 0.46, swirl).mul(smoothstep(0.62, 0.58, swirl));
    mat.colorNode = mix(tint, vec3(1, 0.97, 0.94), band);
    this.balls = this.add(new InstancedMesh(new SphereGeometry(p.radius, 40, 24), mat, pool));
    this.balls.castShadow = true;
    this.balls.frustumCulled = false;

    const chuteMat = createPatternMaterial({ a: C.lilac, b: C.cream, pattern: 'bands', scale: 3 });
    const chuteGeo = new TorusGeometry(p.radius * 1.35, 0.25, 12, 32, Math.PI);
    for (let l = 0; l < p.lanes; l++) {
      const chute = this.add(shadedMesh(chuteGeo, chuteMat));
      chute.position.set((l - (p.lanes - 1) / 2) * p.laneSpacing, p.radius + p.dropHeight * 0.55, -0.4);
    }
    const paint = createPatternMaterial({ a: C.danger, b: C.interact, pattern: 'stripes', scale: 1.4 });
    const stripGeo = new PlaneGeometry(0.35, p.length);
    for (let l = 0; l <= p.lanes; l++) {
      const strip = this.add(shadedMesh(stripGeo, paint, false, true));
      strip.rotation.x = -Math.PI / 2;
      strip.position.set((l - p.lanes / 2) * p.laneSpacing, 0.02, p.length / 2);
    }
  }

  update(t: number): void {
    const p = this.params;
    const speed = p.speed * this.ctx.speedScale;
    boulderLanePose(t, p, this.poses, this.ctx.speedScale);
    for (let i = 0; i < this.poses.length; i++) {
      const sample = this.poses[i]!;
      const parked = sample.pos.y <= BOULDER_PARKED_Y + 1;
      // Shrink over the final ~0.3 s of the lane so balls vanish with a pop rather than blinking out.
      const remain = (p.length - sample.pos.z) / (speed * 0.3);
      const sc = parked ? 0 : Math.min(1, Math.max(0, remain));
      this.v.set(sample.pos.x, parked ? 0 : sample.pos.y, sample.pos.z);
      this.q.set(sample.rot.x, sample.rot.y, sample.rot.z, sample.rot.w);
      this.s.set(sc, sc, sc);
      this.m.compose(this.v, this.q, this.s);
      this.balls.setMatrixAt(i, this.m);
    }
    this.balls.instanceMatrix.needsUpdate = true;
  }
}

/** Boulder lane visual factory. */
export const boulderLaneVisual: ObstacleVisualFactory = (instance, ctx) =>
  new BoulderLaneVisual(instance, ctx);
