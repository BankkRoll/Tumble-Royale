/**
 * Fan Zone — a big fan blowing along local +Z through a box volume. While on,
 * every actor inside is pushed each step (velocity change, with distance
 * falloff). On/off cycles are a pure function of time with a spin-up ramp
 * and a telegraph before each gust. Pitch the instance to make updrafts.
 */
import { z } from 'zod';
import { rotateVec, vec3, type Vec3 } from '@tumble/shared';
import {
  ObstacleGroups,
  RuntimeBase,
  actorLocal,
  crossedPeriodic,
  dutyEnvelope,
  leadTelegraph,
  modPos,
} from './helpers-a.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext } from './types.ts';

/** Fan zone parameters. Origin = centre of the fan face; wind blows toward +Z. */
export const fanZoneSchema = z.object({
  /** Wind volume width along X (m). */
  width: z.number().positive().default(4),
  /** Wind volume height along Y, centred on the origin (m). */
  height: z.number().positive().default(3.5),
  /** Wind reach along +Z (m). */
  length: z.number().positive().default(10),
  /** Push acceleration at the fan face (m/s²). Gravity is 24 for reference. */
  strength: z.number().min(0).default(32),
  /** Fraction of strength lost at the far end (0 = uniform, 1 = none at the end). */
  falloff: z.number().min(0).max(1).default(0.6),
  /** Seconds on per cycle (includes spin-up). */
  onTime: z.number().positive().default(3),
  /** Seconds off per cycle; 0 = always on. */
  offTime: z.number().min(0).default(2),
  /** Spin-up/down ramp (s). */
  spinUp: z.number().min(0.01).default(0.5),
  /** Cycle offset (s). */
  phase: z.number().default(0),
  /** Warning before each gust (s). */
  telegraphLead: z.number().min(0).default(0.8),
  /** Fan housing depth behind the face (m). */
  housingDepth: z.number().positive().default(1.2),
});

/** Validated fan params. */
export type FanZoneParams = z.output<typeof fanZoneSchema>;

/** Wind intensity 0..1 at time t. Pure. */
export function fanIntensity(t: number, p: FanZoneParams): number {
  return dutyEnvelope(t - p.phase, p.onTime, p.offTime, p.spinUp);
}

/** Warning before the fan turns on, 0..1. */
export function fanZoneTelegraph(t: number, p: FanZoneParams): number {
  if (p.offTime <= 0) return 0;
  const period = p.onTime + p.offTime;
  const u = modPos(t - p.phase, period);
  return leadTelegraph(period - u, p.telegraphLead);
}

/** Housing radius derived from the wind volume (m). */
export const fanHousingRadius = (p: FanZoneParams): number => Math.max(p.width, p.height) * 0.5;

class FanZoneRuntime extends RuntimeBase {
  private readonly dir: Vec3;
  private readonly local = vec3();
  private readonly dv = vec3();

  constructor(
    instance: ObstacleInstance<FanZoneParams>,
    ctx: ObstacleBuildContext,
    private readonly p: FanZoneParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.dir = rotateVec(this.frame.rot, vec3(0, 0, 1), vec3());
    const s = Math.SQRT1_2;
    const housing = this.addBody(R.RigidBodyDesc.fixed());
    this.addCollider(
      R.ColliderDesc.cylinder(p.housingDepth / 2, fanHousingRadius(p))
        .setTranslation(0, 0, -p.housingDepth / 2)
        // Cylinder axis Y → Z, so the housing faces down the wind.
        .setRotation({ x: s, y: 0, z: 0, w: s })
        .setCollisionGroups(ObstacleGroups.static),
      housing,
    );
  }

  update(ctx: ObstacleStepContext): void {
    const p = this.p;
    const k = fanIntensity(ctx.t, p);
    if (k > 0) {
      const hw = p.width / 2;
      const hh = p.height / 2;
      for (let i = 0; i < ctx.actors.length; i++) {
        const actor = ctx.actors[i]!;
        const l = actorLocal(this.frame, actor, this.local);
        if (l.z < 0 || l.z > p.length || l.x < -hw || l.x > hw || l.y < -hh || l.y > hh) continue;
        const a = p.strength * k * (1 - p.falloff * (l.z / p.length)) * ctx.dt;
        this.dv.x = this.dir.x * a;
        this.dv.y = this.dir.y * a;
        this.dv.z = this.dir.z * a;
        actor.push(this.dv);
      }
    }
    if (p.offTime > 0) {
      const period = p.onTime + p.offTime;
      if (crossedPeriodic(this.lastT - p.phase, ctx.t - p.phase, period, 0)) this.cue(ctx.events, 'fanOn');
      if (crossedPeriodic(this.lastT - p.phase, ctx.t - p.phase, period, p.onTime)) this.cue(ctx.events, 'fanOff');
    }
    this.endStep(ctx);
  }

  telegraph(t: number): number {
    return fanZoneTelegraph(t, this.p);
  }
}

/** Fan zone obstacle module. */
export const fanZone: ObstacleModule<FanZoneParams> = {
  type: 'fanZone',
  displayName: 'Gusty Fan',
  schema: fanZoneSchema,
  create: (instance, ctx) => new FanZoneRuntime(instance, ctx, fanZoneSchema.parse(instance.params)),
  audioCues: ['fanOn', 'fanOff'],
};
