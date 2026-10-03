/**
 * Sticky Goo — a thick puddle that bogs players down. The slowdown is the
 * `sticky` (or `slime`) surface kind's tuning in the character controller, so
 * the obstacle itself is just a raised, high-friction pad.
 */
import { InteractionGroups } from '@tumble/shared';
import { z } from 'zod';
import { PhysicsBag, frictionFor, instanceFrame } from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime } from './types.ts';

/** Sticky Goo parameters. Metres. Origin is the centre of the puddle's base. */
export const StickyGooSchema = z.object({
  shape: z.enum(['box', 'disc']).default('disc'),
  /** Box extents (box only). */
  sizeX: z.number().positive().default(6),
  sizeZ: z.number().positive().default(6),
  /** Disc radius (disc only). */
  radius: z.number().positive().default(3.5),
  /**
   * Height of the goo above its base. Kept proud of the floor so the ground probe
   * reports the goo, not the floor beneath it.
   */
  thickness: z.number().positive().default(0.12),
  /** `sticky` slows and dampens jumps; `slime` is the wading variant. */
  surface: z.enum(['sticky', 'slime']).default('sticky'),
});

/** Validated Sticky Goo parameters. */
export type StickyGooParams = z.output<typeof StickyGooSchema>;

/** Sticky Goo obstacle module. */
export const stickyGoo: ObstacleModule<StickyGooParams> = {
  type: 'stickyGoo',
  displayName: 'Sticky Goo',
  schema: StickyGooSchema,
  create(instance, ctx): ObstacleRuntime {
    const p = StickyGooSchema.parse(instance.params);
    const { R } = ctx;
    const bag = new PhysicsBag(ctx);
    const body = bag.fixed(instanceFrame(instance));
    const ht = p.thickness / 2;
    const desc =
      p.shape === 'box'
        ? R.ColliderDesc.cuboid(p.sizeX / 2, ht, p.sizeZ / 2)
        : R.ColliderDesc.cylinder(ht, p.radius);
    bag.collider(
      desc
        .setTranslation(0, ht, 0)
        .setFriction(frictionFor(p.surface))
        .setCollisionGroups(InteractionGroups.static),
      body,
      { kind: p.surface, ownerId: instance.id },
    );
    return { instance, colliders: bag.colliders, update() {}, dispose: () => bag.dispose() };
  },
};
