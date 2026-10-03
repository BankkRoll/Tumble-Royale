/**
 * Goal Zone — a team-owned box that watches gameplay props (balls, eggs).
 *
 * Responsibilities:
 * - `goal` mode: a ball entering the box is a goal. The round's `goal` trigger
 *   (same box) already scored it with the team rules; this module celebrates
 *   (`goal` cue, replicated goal counter for the net-flash visual) and sends the
 *   ball back to its spawner, which re-drops it after its respawn delay.
 * - `nest` mode: counts the props resting inside and holds the *extra* value
 *   of special props (golden eggs) as live team points via `addTeamScores`;
 *   the round's `nest` trigger scores the base point per prop.
 *
 * Props are recognised by the surface registry's `ownerId` (the spawner's
 * obstacle id), so no direct coupling to the Prop Spawner runtime is needed.
 */
import type { Collider } from '@dimforge/rapier3d-compat';
import { CollisionGroup, SIM_DT, groups, vec3 } from '@tumble/shared';
import { z } from 'zod';
import { PARK_Y } from './helpers-b.ts';
import { RuntimeBase, toWorldPoint } from './helpers-a.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext } from './types.ts';

/**
 * Goal Zone parameters. Metres, seconds. Origin = floor point of the goal mouth / nest centre;
 * the watched box spans `bottom` … `bottom + sizeY` above it.
 */
export const GoalZoneSchema = z.object({
  mode: z.enum(['goal', 'nest']).default('goal'),
  /** Owning team: the team that scores in this goal / owns this nest. */
  team: z.number().int().min(0).max(3).default(0),
  sizeX: z.number().positive().default(11),
  /** Box bottom relative to the origin (m); negative dips it under the floor. */
  bottom: z.number().default(0),
  sizeY: z.number().positive().default(5),
  sizeZ: z.number().positive().default(3),
  /** Prop spawner ids whose props count; empty = every prop. */
  spawners: z.array(z.string()).default([]),
  /** Nest mode: extra points per resting prop, keyed by spawner id (golden eggs). */
  bonus: z.record(z.string(), z.number()).default({}),
  /** Goal mode: visual net/frame width and height (m), for the goal-mouth dressing. */
  mouthWidth: z.number().positive().default(12),
  mouthHeight: z.number().positive().default(5),
  /** Goal mode: distance from the box centre to the goal line along local +Z (visual); defaults to the box front. */
  mouthOffset: z.number().optional(),
  /** Nest mode: basket radius for the visual (m). */
  basketRadius: z.number().positive().default(4.6),
});

/** Validated Goal Zone parameters. */
export type GoalZoneParams = z.output<typeof GoalZoneSchema>;

const PROP_QUERY = groups(0xffff, CollisionGroup.DynamicProp);
const MAX_INSIDE = 64;

/** What the visual reads from a live goal zone. */
export interface GoalZoneView {
  /** Goals scored here (goal mode). */
  readonly goals: number;
  /** Match time of the latest goal, or -Infinity. */
  readonly lastGoalTime: number;
  /** Props currently resting inside (nest mode). */
  readonly inside: number;
}

/** Live goal zone. */
export class GoalZoneRuntime extends RuntimeBase implements GoalZoneView {
  goals = 0;
  lastGoalTime = -Infinity;
  inside = 0;
  /** Extra team points held right now (nest bonuses). */
  private bonusNow = 0;
  private readonly shape;
  private readonly centre = vec3();
  private readonly found: Collider[] = [];
  private readonly ownerIds = new Set<string>();
  /** Goal mode: consecutive updates each prop collider has been inside. */
  private readonly seenSteps = new Map<number, number>();
  private readonly onHit = (c: Collider): boolean => {
    if (this.found.length >= MAX_INSIDE) return false;
    const owner = this.build.surfaces.get(c.handle)?.ownerId;
    if (owner === undefined || (this.ownerIds.size > 0 && !this.ownerIds.has(owner))) return true;
    if (!c.parent()?.isDynamic()) return true;
    this.found.push(c);
    return true;
  };

  constructor(
    instance: ObstacleInstance<GoalZoneParams>,
    ctx: ObstacleBuildContext,
    readonly params: GoalZoneParams,
  ) {
    super(instance, ctx);
    this.shape = new ctx.R.Cuboid(params.sizeX / 2, params.sizeY / 2, params.sizeZ / 2);
    toWorldPoint(this.frame, vec3(0, params.bottom + params.sizeY / 2, 0), this.centre);
    for (const id of params.spawners) this.ownerIds.add(id);
  }

  update(ctx: ObstacleStepContext): void {
    this.found.length = 0;
    this.build.world.intersectionsWithShape(
      this.centre,
      this.frame.rot,
      this.shape,
      this.onHit,
      this.build.R.QueryFilterFlags.EXCLUDE_SENSORS,
      PROP_QUERY,
    );
    if (this.params.mode === 'goal') this.updateGoal(ctx);
    else this.updateNest(ctx);
    this.endStep(ctx);
  }

  private updateGoal(ctx: ObstacleStepContext): void {
    if (ctx.t < 0) return;
    // Rapier reports sensor overlaps one step after the query pipeline sees them, so a ball is
    // only taken once it has been inside for two updates: the goal trigger has scored it by then.
    const seen = this.seenSteps;
    for (const h of seen.keys()) if (!this.found.some((c) => c.handle === h)) seen.delete(h);
    for (const c of this.found) {
      const steps = (seen.get(c.handle) ?? 0) + 1;
      seen.set(c.handle, steps);
      if (steps < 2) continue;
      seen.delete(c.handle);
      const body = c.parent();
      if (!body) continue;
      const p = body.translation();
      ctx.events.push({
        type: 'obstacleCue',
        obstacle: this.instance.id,
        cue: 'goal',
        pos: { x: p.x, y: p.y, z: p.z },
      });
      this.goals++;
      this.lastGoalTime = ctx.t;
      // Below every spawner's respawn line: the spawner hides it and re-drops it at home after its delay.
      body.setTranslation({ x: p.x, y: PARK_Y, z: p.z }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private updateNest(ctx: ObstacleStepContext): void {
    let bonus = 0;
    for (const c of this.found)
      bonus += this.params.bonus[this.build.surfaces.get(c.handle)?.ownerId ?? ''] ?? 0;
    if (this.found.length > this.inside && ctx.t >= 0) this.cue(ctx.events, 'nestDeposit', 0, 0.6, 0);
    this.inside = this.found.length;
    this.bonusNow = bonus;
  }

  /** Nest bonuses for the owning team (team rules read this every step). */
  addTeamScores(out: number[]): void {
    if (this.params.team < out.length) out[this.params.team] = (out[this.params.team] ?? 0) + this.bonusNow;
  }

  /** `[goals, ticks since last goal (-1 = never), inside, bonus]`. */
  getNetState(): number[] {
    const now = Number.isNaN(this.lastT) ? 0 : this.lastT;
    const since = Number.isFinite(this.lastGoalTime)
      ? Math.min(1 << 20, Math.round((now - this.lastGoalTime) / SIM_DT))
      : -1;
    return [this.goals, since, this.inside, this.bonusNow];
  }

  setNetState(state: readonly number[]): void {
    const now = Number.isNaN(this.lastT) ? 0 : this.lastT;
    this.goals = state[0] ?? 0;
    const since = state[1] ?? -1;
    this.lastGoalTime = since < 0 ? -Infinity : now - since * SIM_DT;
    this.inside = state[2] ?? 0;
    this.bonusNow = state[3] ?? 0;
  }
}

/** Goal Zone obstacle module. */
export const goalZone: ObstacleModule<GoalZoneParams> = {
  type: 'goalZone',
  displayName: 'Team Goal',
  schema: GoalZoneSchema,
  create: (instance, ctx) => new GoalZoneRuntime(instance, ctx, GoalZoneSchema.parse(instance.params)),
  audioCues: ['goal', 'nestDeposit'],
};
