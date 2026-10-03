/**
 * Bounce Pad — a springy disc that launches players along an authored local
 * velocity vector. The velocity component along the launch direction is
 * replaced (so repeated bounces are consistent); sideways momentum is kept.
 */
import { z } from 'zod';
import type { Collider } from '@dimforge/rapier3d-compat';
import { rotateVec, vec3, type Vec3 } from '@tumble/shared';
import { ActorCooldown, ObstacleGroups, RuntimeBase } from './helpers-a.ts';
import type {
  ObstacleActor,
  ObstacleBuildContext,
  ObstacleInstance,
  ObstacleModule,
  ObstacleRuntime,
  ObstacleStepContext,
} from './types.ts';

const Vec3Param = z.object({ x: z.number(), y: z.number(), z: z.number() });

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
  private readonly launchDir: Vec3;
  private readonly launchSpeed: number;
  private readonly dv = vec3();

  constructor(
    instance: ObstacleInstance<BouncePadParams>,
    ctx: ObstacleBuildContext,
    private readonly p: BouncePadParams,
  ) {
    super(instance, ctx);
    const { R } = ctx;
    this.launchWorld = rotateVec(this.frame.rot, vec3(p.launch.x, p.launch.y, p.launch.z), vec3());
    this.launchSpeed = Math.hypot(this.launchWorld.x, this.launchWorld.y, this.launchWorld.z);
    const inv = this.launchSpeed > 0 ? 1 / this.launchSpeed : 0;
    this.launchDir = vec3(this.launchWorld.x * inv, this.launchWorld.y * inv, this.launchWorld.z * inv);

    const body = this.addBody(R.RigidBodyDesc.fixed());
    this.addCollider(
      R.ColliderDesc.roundCylinder(p.height / 2 - 0.08, p.radius - 0.08, 0.08)
        .setTranslation(0, p.height / 2, 0)
        .setCollisionGroups(ObstacleGroups.static),
      body,
      { kind: 'bouncy', bounceImpulse: this.launchSpeed },
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

  /** Launches `actor` if its cooldown allows. Shared by trigger and contact routing. */
  private launch(actor: ObstacleActor, ctx: ObstacleStepContext): void {
    if (this.launchSpeed <= 0 || !this.cooldown.ready(actor.id, ctx.t, this.p.cooldown)) return;
    const v = actor.body.linvel();
    const n = this.launchDir;
    const along = v.x * n.x + v.y * n.y + v.z * n.z;
    this.dv.x = this.launchWorld.x - along * n.x;
    this.dv.y = this.launchWorld.y - along * n.y;
    this.dv.z = this.launchWorld.z - along * n.z;
    actor.push(this.dv);
    this.lastBounceTime = ctx.t;
    const pos = actor.body.translation();
    ctx.events.push({ type: 'bounce', player: actor.id, pos: { x: pos.x, y: pos.y, z: pos.z }, obstacle: this.instance.id });
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
