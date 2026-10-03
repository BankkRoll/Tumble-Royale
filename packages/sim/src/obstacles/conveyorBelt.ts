/**
 * Conveyor Belt — a static slab whose surface carries players along local +Z
 * (or −Z). The belt velocity is a pure function of time and is written into
 * the collider's SurfaceInfo each step; the character controller applies it.
 */
import { z } from 'zod';
import { rotateVec, vec3, type Vec3 } from '@tumble/shared';
import {
  ObstacleGroups,
  RuntimeBase,
  crossedPeriodic,
  leadTelegraph,
  squareWave,
  squareWaveIntegral,
  timeToSwitch,
} from './helpers-a.ts';
import type { SurfaceInfo } from '../physics/surfaces.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext } from './types.ts';

/** Conveyor belt parameters. Origin = centre of the belt's top surface. */
export const conveyorBeltSchema = z.object({
  /** Belt length along local Z (m). */
  length: z.number().positive().default(12),
  width: z.number().positive().default(4),
  thickness: z.number().positive().default(0.5),
  /** Belt speed (m/s). Scaled by speedScale. */
  speed: z.number().min(0).default(4),
  /** forward = +Z, backward = −Z, switch = reverses every `switchPeriod`. */
  pattern: z.enum(['forward', 'backward', 'switch']).default('forward'),
  /** Seconds between reversals for `switch`. */
  switchPeriod: z.number().positive().default(6),
  /** Seconds the reversal ramp takes. */
  switchRamp: z.number().min(0.05).default(0.8),
  /** Warning before a reversal (s). */
  telegraphLead: z.number().min(0).default(1.2),
  /** Add side rails. */
  rails: z.boolean().default(true),
  railHeight: z.number().positive().default(0.6),
  railWidth: z.number().positive().default(0.3),
});

/** Validated conveyor params. */
export type ConveyorBeltParams = z.output<typeof conveyorBeltSchema>;

/**
 * Signed belt speed along local +Z (m/s) at time t. Pure.
 */
export function conveyorVelocity(t: number, p: ConveyorBeltParams, speedScale: number): number {
  const s = p.speed * speedScale;
  if (p.pattern === 'forward') return s;
  if (p.pattern === 'backward') return -s;
  return s * squareWave(t, p.switchPeriod, p.switchRamp);
}

/**
 * Belt surface displacement along +Z (m) since t = 0 — the exact integral of
 * {@link conveyorVelocity}, so the visual's scrolling chevrons match the sim.
 */
export function conveyorTravel(t: number, p: ConveyorBeltParams, speedScale: number): number {
  const s = p.speed * speedScale;
  if (p.pattern === 'forward') return s * t;
  if (p.pattern === 'backward') return -s * t;
  return s * squareWaveIntegral(t, p.switchPeriod, p.switchRamp);
}

/** Warning before each reversal, 0..1 (always 0 for fixed-direction belts). */
export function conveyorTelegraph(t: number, p: ConveyorBeltParams): number {
  if (p.pattern !== 'switch') return 0;
  return leadTelegraph(timeToSwitch(t, p.switchPeriod), p.telegraphLead);
}

class ConveyorBeltRuntime extends RuntimeBase {
  private readonly beltVel: Vec3 = vec3();
  private readonly axis: Vec3;

  constructor(
    instance: ObstacleInstance<ConveyorBeltParams>,
    ctx: ObstacleBuildContext,
    private readonly p: ConveyorBeltParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.axis = rotateVec(this.frame.rot, vec3(0, 0, 1), vec3());
    const body = this.addBody(R.RigidBodyDesc.fixed());
    const surface: SurfaceInfo = { kind: 'conveyor', conveyorVelocity: this.beltVel };
    this.addCollider(
      R.ColliderDesc.cuboid(p.width / 2, p.thickness / 2, p.length / 2)
        .setTranslation(0, -p.thickness / 2, 0)
        .setFriction(1)
        .setCollisionGroups(ObstacleGroups.static),
      body,
      surface,
    );
    if (p.rails) {
      for (const side of [-1, 1]) {
        this.addCollider(
          R.ColliderDesc.cuboid(p.railWidth / 2, (p.railHeight + p.thickness) / 2, p.length / 2)
            .setTranslation(side * (p.width / 2 + p.railWidth / 2), (p.railHeight - p.thickness) / 2, 0)
            .setCollisionGroups(ObstacleGroups.static),
          body,
        );
      }
    }
    this.writeVelocity(0);
  }

  private writeVelocity(t: number): void {
    const v = conveyorVelocity(t, this.p, this.build.speedScale);
    this.beltVel.x = this.axis.x * v;
    this.beltVel.y = this.axis.y * v;
    this.beltVel.z = this.axis.z * v;
  }

  update(ctx: ObstacleStepContext): void {
    this.writeVelocity(ctx.t);
    if (this.p.pattern === 'switch' && crossedPeriodic(this.lastT, ctx.t, this.p.switchPeriod, 0)) {
      this.cue(ctx.events, 'switch', 0, 0.5, 0);
    }
    this.endStep(ctx);
  }

  telegraph(t: number): number {
    return conveyorTelegraph(t, this.p);
  }
}

/** Conveyor belt obstacle module. */
export const conveyorBelt: ObstacleModule<ConveyorBeltParams> = {
  type: 'conveyorBelt',
  displayName: 'Treadmill Trouble',
  schema: conveyorBeltSchema,
  create: (instance, ctx) =>
    new ConveyorBeltRuntime(instance, ctx, conveyorBeltSchema.parse(instance.params)),
  audioCues: ['hum', 'switch'],
};
