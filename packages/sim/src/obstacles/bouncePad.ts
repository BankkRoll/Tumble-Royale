/**
 * Bounce Pad — a springy disc that launches players who land on its top with
 * exactly the authored local velocity vector, so designed arcs land where the
 * level expects. Touching the side or rim is only a soft bump (handled by the
 * character controller through the surface's `bounceVelocity`).
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import { rotateVec, vec3, type Vec3 } from '@tumble/shared';
import { ActorCooldown, ObstacleGroups, RuntimeBase, toLocalPoint } from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from './types.ts';

const Vec3Param = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Horizontal slack (m) past the pad radius that still counts as over the top (rim landings). */
const TOP_RIM_SLACK = 0.15;

/** Bounce pad parameters. Origin = centre of the pad's base. */
export const bouncePadSchema = z.object({
  radius: z.number().positive().default(1.4),
  /** Pad height (m). */
  height: z.number().positive().default(0.4),
  /** Launch velocity in instance-local space (m/s). */
  launch: Vec3Param.default({ x: 0, y: 18, z: 4 }),
  /** Minimum seconds between launches of the same player. */
  cooldown: z.number().min(0).default(0.35),
});

/** Validated bounce pad params. */
export type BouncePadParams = z.output<typeof bouncePadSchema>;

/** Runtime state the visual reads for its squash animation. */
export interface BouncePadView extends ObstacleRuntime {
  /** Match time of the most recent launch, or -Infinity. */
  readonly lastBounceTime: number;
}

class BouncePadRuntime extends RuntimeBase implements BouncePadView {
  lastBounceTime = Number.NEGATIVE_INFINITY;
  private readonly cooldown = new ActorCooldown();
  private readonly launchWorld: Vec3;
  private readonly launchSpeed: number;
  private readonly dv = vec3();
  private readonly local = vec3();

  constructor(
    instance: ObstacleInstance<BouncePadParams>,
    ctx: ObstacleBuildContext,
    private readonly p: BouncePadParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.launchWorld = rotateVec(this.frame.rot, vec3(p.launch.x, p.launch.y, p.launch.z), vec3());
    this.launchSpeed = Math.hypot(this.launchWorld.x, this.launchWorld.y, this.launchWorld.z);

    const body = this.addBody(R.RigidBodyDesc.fixed());
    this.addCollider(
      R.ColliderDesc.roundCylinder(p.height / 2 - 0.08, p.radius - 0.08, 0.08)
        .setTranslation(0, p.height / 2, 0)
        .setCollisionGroups(ObstacleGroups.static),
      body,
      {
        kind: 'bouncy',
        bounceImpulse: this.launchSpeed,
        bounceVelocity: this.launchWorld,
        bounceUp: rotateVec(this.frame.rot, vec3(0, 1, 0), vec3()),
      },
    );
    this.addCollider(
      R.ColliderDesc.cylinder(0.3, p.radius * 0.95)
        .setTranslation(0, p.height + 0.3, 0)
        .setSensor(true)
        .setCollisionGroups(ObstacleGroups.trigger),
      body,
    );
  }

  update(ctx: ObstacleStepContext): void {
    this.endStep(ctx);
  }

  /**
   * Launches `actor` with exactly the authored velocity if it is over the pad
   * top and its cooldown allows. Shared by trigger and contact routing.
   *
   * Side contacts (walking or climbing into the pad) are rejected by requiring
   * the actor's centre to sit above the top face and inside its rim: a body
   * pressed against the side has its centre a full body radius outside.
   */
  private launch(actor: ObstacleActor, ctx: ObstacleStepContext): void {
    if (this.launchSpeed <= 0) return;
    const l = toLocalPoint(this.frame, actor.body.translation(), this.local);
    if (l.y < this.p.height || Math.hypot(l.x, l.z) > this.p.radius + TOP_RIM_SLACK) return;
    if (!this.cooldown.ready(actor.id, ctx.t, this.p.cooldown)) return;
    const v = actor.body.linvel();
    this.dv.x = this.launchWorld.x - v.x;
    this.dv.y = this.launchWorld.y - v.y;
    this.dv.z = this.launchWorld.z - v.z;
    // The controller usually launched this step already (feet on the pad); then there is nothing to add.
    if (this.dv.x * this.dv.x + this.dv.y * this.dv.y + this.dv.z * this.dv.z > 1e-6) actor.push(this.dv);
    this.lastBounceTime = ctx.t;
    const pos = actor.body.translation();
    ctx.events.push({
      type: 'bounce',
      player: actor.id,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      obstacle: this.instance.id,
    });
    this.cue(ctx.events, 'boing', 0, this.p.height, 0);
  }

  onTrigger(actor: ObstacleActor, _collider: Collider, entered: boolean, ctx: ObstacleStepContext): void {
    if (entered) this.launch(actor, ctx);
  }

  onContact(actor: ObstacleActor, _collider: Collider, ctx: ObstacleStepContext): void {
    this.launch(actor, ctx);
  }
}

/** Bounce pad obstacle module. */
export const bouncePad: ObstacleModule<BouncePadParams> = {
  type: 'bouncePad',
  displayName: 'Boing Pad',
  schema: bouncePadSchema,
  create: (instance, ctx) => new BouncePadRuntime(instance, ctx, bouncePadSchema.parse(instance.params)),
  audioCues: ['boing'],
};
