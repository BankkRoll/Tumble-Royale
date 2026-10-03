/**
 * Tilt Platform — a plate balanced on a gimbal (two nested revolute joints)
 * that tips under players' weight, with damping, angle limits and a
 * self-centring motor. Server-simulated dynamic bodies; the hinge angles and
 * rates are replicated via net state.
 */
import { z } from 'zod';
import type { ImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat';
import { quatFromAxisAngle, quatIdentity, rotateVec, vec3, type Quat, type Vec3 } from '@tumble/shared';
import {
  DEG2RAD,
  ObstacleGroups,
  RuntimeBase,
  configureHinge,
  setHingeTarget,
  swayAngle,
  dequantize,
  hingeAngle,
  hingeRate,
  quantize,
  quatMultiply,
  toWorldPoint,
  type HingeAxis,
} from './helpers-a.ts';
import type {
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from './types.ts';

/** Tilt platform parameters. Origin = centre of the plate at rest. */
export const tiltPlatformSchema = z.object({
  shape: z.enum(['box', 'disc']).default('box'),
  /** Box plate size along X (m). */
  sizeX: z.number().positive().default(8),
  /** Box plate size along Z (m). */
  sizeZ: z.number().positive().default(8),
  /** Disc plate radius (m). */
  radius: z.number().positive().default(4.5),
  thickness: z.number().positive().default(0.6),
  /** Which local axes the plate may tip about. */
  axes: z.enum(['both', 'x', 'z']).default('both'),
  /** Hard tilt limit (degrees). */
  maxTiltDeg: z.number().min(1).max(60).default(22),
  /** Self-centring stiffness (N·m/rad). A ~1 kg Tumbler at the rim of an 8 m plate tips it ~8°. */
  stiffness: z.number().min(0).default(500),
  /** Hinge damping (N·m·s/rad). */
  damping: z.number().min(0).default(160),
  /** Plate mass (kg). Heavier plates react more sluggishly. */
  mass: z.number().positive().default(30),
  /** How far below the plate centre the pivot sits (m). Deeper = tippier. */
  pivotDepth: z.number().min(0).default(0),
  /** Build a static support column under the pivot. */
  column: z.boolean().default(true),
  columnHeight: z.number().positive().default(6),
  /** Idle sway: peak rest-angle drift (degrees) so an empty plate still wobbles. 0 = still. */
  swayDeg: z.number().min(0).max(30).default(0),
  /** Seconds per sway cycle. Scaled by speedScale. */
  swayPeriod: z.number().positive().default(5),
  /** Sway phase (radians), to desynchronise neighbouring plates. */
  swayPhase: z.number().default(0),
});

/** Validated tilt platform params. */
export type TiltPlatformParams = z.output<typeof tiltPlatformSchema>;

/** Replicated/visual tilt state. */
export interface TiltPlatformView extends ObstacleRuntime {
  /** Tilt about local X (rad). */
  readonly tiltX: number;
  /** Tilt about local Z (rad). */
  readonly tiltZ: number;
}

/** Angles and rates are packed as milli-units. */
const NET_SCALE = 1000;

/** Hinge axes used for a given `axes` param, outermost first. */
export function tiltAxes(p: TiltPlatformParams): HingeAxis[] {
  return p.axes === 'both' ? ['x', 'z'] : [p.axes];
}

/** Composes the plate's local rotation from hinge angles (outer about X, inner about Z). */
export function tiltRotation(tiltX: number, tiltZ: number, out: Quat): Quat {
  const ax = Math.sin(tiltX * 0.5);
  const aw = Math.cos(tiltX * 0.5);
  const bz = Math.sin(tiltZ * 0.5);
  const bw = Math.cos(tiltZ * 0.5);
  // Hamilton product (ax,0,0,aw)·(0,0,bz,bw) with zero terms dropped — allocation-free for per-frame use.
  out.x = ax * bw;
  out.y = -ax * bz;
  out.z = aw * bz;
  out.w = aw * bw;
  return out;
}

/** Tilt platform runtime. */
export class TiltPlatformRuntime extends RuntimeBase implements TiltPlatformView {
  /** Hinge chain bodies, outermost first; the last one carries the plate collider. */
  readonly chain: RigidBody[] = [];
  private readonly axes: HingeAxis[];
  private readonly pivot: Vec3;
  private readonly qTmp = quatIdentity();
  private readonly vTmp = vec3();
  private creakArmed = true;

  constructor(
    instance: ObstacleInstance<TiltPlatformParams>,
    ctx: ObstacleBuildContext,
    private readonly p: TiltPlatformParams,
  ) {
    super(instance, ctx);
    const { R, world } = ctx;
    this.axes = tiltAxes(p);
    const pivotLocal = vec3(0, -p.pivotDepth, 0);
    this.pivot = toWorldPoint(this.frame, pivotLocal, vec3());

    const base = this.addBody(R.RigidBodyDesc.fixed(), pivotLocal);
    if (p.column) {
      const top = -p.thickness / 2 - 0.45 + p.pivotDepth;
      this.addCollider(
        R.ColliderDesc.cylinder(p.columnHeight / 2, 0.6)
          .setTranslation(0, top - p.columnHeight / 2, 0)
          .setCollisionGroups(ObstacleGroups.static),
        base,
      );
    }

    let parent = base;
    const maxA = p.maxTiltDeg * DEG2RAD;
    for (let i = 0; i < this.axes.length; i++) {
      const isPlate = i === this.axes.length - 1;
      const desc = R.RigidBodyDesc.dynamic().setCanSleep(false).setAngularDamping(0.5).setLinearDamping(0.5);
      // The gimbal ring has no collider; give it plate-like inertia so the inner hinge
      // limit stays stiff (a featherweight ring lets the chain stretch past its limits).
      if (!isPlate) {
        const span = p.shape === 'disc' ? p.radius * 2 : Math.max(p.sizeX, p.sizeZ);
        const inertia = (p.mass * span * span) / 12;
        desc.setAdditionalMassProperties(p.mass, vec3(), vec3(inertia, inertia, inertia), quatIdentity());
      }
      const body = this.addBody(desc, pivotLocal);
      if (isPlate) {
        const volume =
          p.shape === 'disc' ? Math.PI * p.radius * p.radius * p.thickness : p.sizeX * p.sizeZ * p.thickness;
        const shape =
          p.shape === 'disc'
            ? R.ColliderDesc.cylinder(p.thickness / 2, p.radius)
            : R.ColliderDesc.cuboid(p.sizeX / 2, p.thickness / 2, p.sizeZ / 2);
        this.addCollider(
          shape
            .setTranslation(0, p.pivotDepth, 0)
            .setDensity(p.mass / volume)
            .setFriction(0.9)
            .setCollisionGroups(ObstacleGroups.kinematic),
          body,
          { kind: 'normal' },
        );
      }
      const axis = this.axes[i] === 'x' ? vec3(1, 0, 0) : vec3(0, 0, 1);
      const joint: ImpulseJoint = world.createImpulseJoint(
        R.JointData.revolute(vec3(), vec3(), axis),
        parent,
        body,
        true,
      );
      configureHinge(R, joint, maxA, p.stiffness, p.damping);
      this.joints.push(joint);
      this.chain.push(body);
      parent = body;
    }
  }

  private parentRot(i: number): Quat {
    if (i === 0) return this.frame.rot;
    const r = this.chain[i - 1]!.rotation();
    this.qTmp.x = r.x;
    this.qTmp.y = r.y;
    this.qTmp.z = r.z;
    this.qTmp.w = r.w;
    return this.qTmp;
  }

  /** Hinge angle `i` (outermost first), radians. */
  angle(i: number): number {
    const body = this.chain[i];
    if (!body) return 0;
    return hingeAngle(this.parentRot(i), body.rotation(), this.axes[i]!);
  }

  /** Hinge angular rate `i`, rad/s. */
  rate(i: number): number {
    const body = this.chain[i];
    if (!body) return 0;
    const parentW = i === 0 ? this.vTmp : this.chain[i - 1]!.angvel();
    if (i === 0) this.vTmp.x = this.vTmp.y = this.vTmp.z = 0;
    return hingeRate(this.parentRot(i), parentW, body.angvel(), this.axes[i]!);
  }

  get tiltX(): number {
    const i = this.axes.indexOf('x');
    return i < 0 ? 0 : this.angle(i);
  }

  get tiltZ(): number {
    const i = this.axes.indexOf('z');
    return i < 0 ? 0 : this.angle(i);
  }

  update(ctx: ObstacleStepContext): void {
    const p = this.p;
    if (p.swayDeg > 0) {
      const amp = p.swayDeg * DEG2RAD;
      const t = ctx.t * this.build.speedScale;
      // The two gimbal axes sway a quarter cycle apart, so a 'both' plate circles instead of see-sawing.
      for (let i = 0; i < this.joints.length; i++) {
        const target = swayAngle(t, amp, p.swayPeriod, p.swayPhase + i * Math.PI * 0.5);
        setHingeTarget(this.joints[i]!, target, p.stiffness, p.damping);
      }
    }
    // Hysteresis so a plate resting near the threshold doesn't creak every step.
    if (ctx.tick % 6 === 0) {
      const max = this.p.maxTiltDeg * DEG2RAD;
      let a = 0;
      for (let i = 0; i < this.chain.length; i++) a = Math.max(a, Math.abs(this.angle(i)));
      if (this.creakArmed && a > max * 0.7) {
        this.creakArmed = false;
        this.cue(ctx.events, 'creak');
      } else if (a < max * 0.35) {
        this.creakArmed = true;
      }
    }
    this.endStep(ctx);
  }

  /** `[angle0, angle1?, rate0, rate1?]` in milli-radians (per second). */
  getNetState(): number[] {
    const n = this.chain.length;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(quantize(this.angle(i), NET_SCALE));
    for (let i = 0; i < n; i++) out.push(quantize(this.rate(i), NET_SCALE));
    return out;
  }

  setNetState(state: readonly number[]): void {
    const n = this.chain.length;
    const rot = quatIdentity();
    const w = vec3();
    const tmp = vec3();
    rot.x = this.frame.rot.x;
    rot.y = this.frame.rot.y;
    rot.z = this.frame.rot.z;
    rot.w = this.frame.rot.w;
    for (let i = 0; i < n; i++) {
      const a = dequantize(state[i], NET_SCALE);
      const rate = dequantize(state[n + i], NET_SCALE);
      const ax = this.axes[i] === 'x';
      // Angular velocity accumulates down the chain: each hinge adds its rate about its parent's axis.
      rotateVec(rot, ax ? vec3(rate, 0, 0) : vec3(0, 0, rate), tmp);
      w.x += tmp.x;
      w.y += tmp.y;
      w.z += tmp.z;
      quatMultiply(rot, quatFromAxisAngle(ax ? 1 : 0, 0, ax ? 0 : 1, a), rot);
      const body = this.chain[i]!;
      body.setTranslation(this.pivot, true);
      body.setLinvel(vec3(), true);
      body.setRotation(rot, true);
      body.setAngvel(w, true);
    }
  }
}

/** Tilt platform obstacle module. */
export const tiltPlatform: ObstacleModule<TiltPlatformParams> = {
  type: 'tiltPlatform',
  displayName: 'Wobble Plate',
  schema: tiltPlatformSchema,
  create: (instance, ctx) =>
    new TiltPlatformRuntime(instance, ctx, tiltPlatformSchema.parse(instance.params)),
  audioCues: ['creak'],
};
