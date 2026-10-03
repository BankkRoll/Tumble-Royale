/**
 * Void Trigger — a huge sensor slab under the level. Entering it emits
 * `fellOut`; the round logic decides between respawn and elimination. The slab
 * is deliberately deep (`sizeY`): a falling Tumbler would need ~1200 m/s to skip
 * a 20 m sensor in one 60 Hz step, so no per-step position polling is needed.
 */
import { InteractionGroups } from '@tumble/shared';
import { z } from 'zod';
import type { EventSink } from '../events.ts';
import { PhysicsBag, instanceFrame } from './helpers-b.ts';
import type { ObstacleActor, ObstacleModule, ObstacleRuntime } from './types.ts';

/** Void Trigger parameters. Metres. Origin = centre of the box. */
export const VoidTriggerSchema = z.object({
  sizeX: z.number().positive().default(400),
  /** Box height; tall enough that 60 Hz falls can't skip it entirely. */
  sizeY: z.number().positive().default(20),
  sizeZ: z.number().positive().default(400),
  /** Show a soft fog plane on the top face (render only). */
  fog: z.boolean().default(true),
  /** Seconds before the same player may fall out again (respawn grace). */
  refireDelay: z.number().min(0).default(0.5),
});

/** Validated Void Trigger parameters. */
export type VoidTriggerParams = z.output<typeof VoidTriggerSchema>;

/** Void Trigger obstacle module. */
export const voidTrigger: ObstacleModule<VoidTriggerParams> = {
  type: 'voidTrigger',
  displayName: 'Void',
  schema: VoidTriggerSchema,
  audioCues: ['fallWhoosh'],
  create(instance, ctx): ObstacleRuntime {
    const p = VoidTriggerSchema.parse(instance.params);
    const { R } = ctx;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const body = bag.fixed(frame);
    bag.collider(
      R.ColliderDesc.cuboid(p.sizeX / 2, p.sizeY / 2, p.sizeZ / 2)
        .setSensor(true)
        .setCollisionGroups(InteractionGroups.trigger)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      body,
      { kind: 'normal', lethal: true, ownerId: instance.id },
    );
    const lastFire = new Map<number, number>();

    const fire = (a: ObstacleActor, t: number, events: EventSink): void => {
      const prev = lastFire.get(a.id);
      if (prev !== undefined && t - prev < p.refireDelay && t >= prev) return;
      lastFire.set(a.id, t);
      const pos = a.body.translation();
      events.push({ type: 'fellOut', player: a.id, pos: { x: pos.x, y: pos.y, z: pos.z } });
    };

    return {
      instance,
      colliders: bag.colliders,
      update() {},
      onTrigger(actor, _collider, entered, sctx) {
        if (entered) fire(actor, sctx.t, sctx.events);
      },
      dispose: () => {
        lastFire.clear();
        bag.dispose();
      },
    };
  },
};
