/**
 * Seesaw — a long plank (along local X) on a fulcrum hinge about local Z.
 * Server-simulated dynamic body with limits, damping and weak self-centring;
 * hinge angle + rate replicate via net state.
 */
import { z } from 'zod';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { quatFromAxisAngle, quatIdentity, rotateVec, vec3, type Vec3 } from '@tumble/shared';
import {
  DEG2RAD,
  ObstacleGroups,
  RuntimeBase,
  configureHinge,
  dequantize,
  hingeAngle,
  hingeRate,
  quantize,
  quatMultiply,
  toWorldPoint,
} from './helpers-a.ts';
import type {
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from './types.ts';

/** Seesaw parameters. Origin = ground point under the fulcrum. */
export const seesawSchema = z.object({
  /** Plank length along X (m). */
  length: z.number().positive().default(10),
  /** Plank width along Z (m). */
  width: z.number().positive().default(3),
  thickness: z.number().positive().default(0.5),
  /** Hinge height above the origin (m). */
  pivotHeight: z.number().positive().default(1.4),
  /** Tilt limit (degrees). */
  maxTiltDeg: z.number().min(1).max(45).default(18),
  /** Self-centring stiffness (N·m/rad); low so one Tumbler can tip it. */
  stiffness: z.number().min(0).default(120),
  /** Hinge damping (N·m·s/rad). */
  damping: z.number().min(0).default(50),
  /** Plank mass (kg). */
  mass: z.number().positive().default(20),
  /** Build the static fulcrum wedge. */
  fulcrum: z.boolean().default(true),
});

/** Validated seesaw params. */
export type SeesawParams = z.output<typeof seesawSchema>;

/** Replicated/visual seesaw state. */
export interface SeesawView extends ObstacleRuntime {
  /** Plank angle about local Z (rad); positive raises the +X end. */
  readonly angle: number;
}

const NET_SCALE = 1000;

/** Seesaw runtime. */
export class SeesawRuntime extends RuntimeBase implements SeesawView {
  /** The plank body. */
  readonly plank: RigidBody;
  private readonly pivot: Vec3;
  private readonly zero = vec3();
  private thunkArmed = true;

  constructor(
    instance: ObstacleInstance<SeesawParams>,
    ctx: ObstacleBuildContext,
    private readonly p: SeesawParams,
  ) {
    super(instance, ctx);
    const { R, world } = ctx;
    const pivotLocal = vec3(0, p.pivotHeight, 0);
    this.pivot = toWorldPoint(this.frame, pivotLocal, vec3());

    const base = this.addBody(R.RigidBodyDesc.fixed(), pivotLocal);
    if (p.fulcrum) {
      const hw = Math.min(1.1, p.length * 0.12);
      const hz = p.width / 2 - 0.1;
      const top = -0.08;
      const bottom = -p.pivotHeight;
      const pts = new Float32Array([
        -hw,
        bottom,
        -hz,
        hw,
        bottom,
        -hz,
        0,
        top,
        -hz,
        -hw,
        bottom,
        hz,
        hw,
        bottom,
        hz,
        0,
        top,
        hz,
      ]);
      const hull = R.ColliderDesc.convexHull(pts);
      if (hull) this.addCollider(hull.setCollisionGroups(ObstacleGroups.static), base);
    }

    this.plank = this.addBody(
      R.RigidBodyDesc.dynamic().setCanSleep(false).setAngularDamping(0.4).setLinearDamping(0.5),
      pivotLocal,
    );
    this.addCollider(
      R.ColliderDesc.cuboid(p.length / 2, p.thickness / 2, p.width / 2)
        .setTranslation(0, p.thickness / 2, 0)
        .setDensity(p.mass / (p.length * p.width * p.thickness))
        .setFriction(0.9)
        .setCollisionGroups(ObstacleGroups.kinematic),
      this.plank,
      { kind: 'normal' },
    );
    const joint = world.createImpulseJoint(
      R.JointData.revolute(vec3(), vec3(), vec3(0, 0, 1)),
      base,
      this.plank,
      true,
    );
    configureHinge(R, joint, p.maxTiltDeg * DEG2RAD, p.stiffness, p.damping);
    this.joints.push(joint);
  }

  get angle(): number {
    return hingeAngle(this.frame.rot, this.plank.rotation(), 'z');
  }

  /** Hinge angular rate (rad/s). */
  get rate(): number {
    return hingeRate(this.frame.rot, this.zero, this.plank.angvel(), 'z');
  }

  update(ctx: ObstacleStepContext): void {
    if (ctx.tick % 4 === 0) {
      const a = Math.abs(this.angle);
      const max = this.p.maxTiltDeg * DEG2RAD;
      if (this.thunkArmed && a > max * 0.93) {
        this.thunkArmed = false;
        this.cue(ctx.events, 'thunk', Math.sign(this.angle) * -this.p.length * 0.45, 0.2, 0);
      } else if (a < max * 0.6) {
        this.thunkArmed = true;
      }
    }
    this.endStep(ctx);
  }

  /** `[angle, rate]` in milli-radians (per second). */
  getNetState(): number[] {
    return [quantize(this.angle, NET_SCALE), quantize(this.rate, NET_SCALE)];
  }

  setNetState(state: readonly number[]): void {
    const a = dequantize(state[0], NET_SCALE);
    const rate = dequantize(state[1], NET_SCALE);
    const rot = quatMultiply(this.frame.rot, quatFromAxisAngle(0, 0, 1, a, quatIdentity()), quatIdentity());
    this.plank.setTranslation(this.pivot, true);
    this.plank.setLinvel(this.zero, true);
    this.plank.setRotation(rot, true);
    this.plank.setAngvel(rotateVec(this.frame.rot, vec3(0, 0, rate), vec3()), true);
  }
}

/** Seesaw obstacle module. */
export const seesaw: ObstacleModule<SeesawParams> = {
  type: 'seesaw',
  displayName: 'Teeter Plank',
  schema: seesawSchema,
  create: (instance, ctx) => new SeesawRuntime(instance, ctx, seesawSchema.parse(instance.params)),
  audioCues: ['thunk'],
};
