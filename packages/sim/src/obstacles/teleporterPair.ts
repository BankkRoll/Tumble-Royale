/**
 * Teleporter Pads — step on the entrance pad and get zapped to an exit pad.
 * Exits can be fixed, seeded-random or round-robin; pads can be two-way; the
 * `sendBack` variant is the same machinery dressed as a trap that returns
 * players down the course. Per-actor cooldowns plus "must step off the pad you
 * arrived on" stop ping-ponging.
 */
import { InteractionGroups, vec3, yawFromQuat, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldowns,
  ActorSet,
  DEG,
  PhysicsBag,
  emitCue,
  hash3,
  instanceFrame,
  toWorld,
} from './helpers-b.ts';
import type { EventSink } from '../events.ts';
import type { ObstacleActor, ObstacleModule, ObstacleRuntime } from './types.ts';

const LocalPoint = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Teleporter parameters. Metres, degrees, seconds. Origin = entrance pad centre on the floor. */
export const TeleporterPairSchema = z.object({
  padRadius: z.number().positive().default(1.2),
  /** Exit pad centres in local space (floor level). At least one. */
  exits: z
    .array(LocalPoint)
    .min(1)
    .default([{ x: 0, y: 0, z: 14 }]),
  /** How an exit is chosen when there are several. */
  mode: z.enum(['first', 'random', 'roundRobin']).default('first'),
  /** Exit pads also send players back to the entrance. */
  twoWay: z.boolean().default(false),
  /** `sendBack` = trap styling (danger colours, different cue). Behaviour is set by `exits`. */
  variant: z.enum(['normal', 'sendBack']).default('normal'),
  /** Facing (local yaw, degrees) after arriving at an exit. */
  exitYaw: z.number().default(0),
  /** Facing (local yaw, degrees) after returning to the entrance (two-way). */
  returnYaw: z.number().default(180),
  /** Per-player cooldown after a teleport. */
  cooldown: z.number().min(0).default(1),
  /** Arrival height above the destination pad. */
  arrivalHeight: z.number().min(0).default(0.9),
  /** Height of the trigger column above each pad. */
  triggerHeight: z.number().positive().default(1.6),
  seed: z.number().int().default(1),
});

/** Validated Teleporter parameters. */
export type TeleporterPairParams = z.output<typeof TeleporterPairSchema>;

/** Local centre of pad `i` (0 = entrance, 1… = exits). */
export function teleporterPadLocal(p: TeleporterPairParams, i: number, out: Vec3): Vec3 {
  if (i === 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  } else {
    const e = p.exits[i - 1]!;
    out.x = e.x;
    out.y = e.y;
    out.z = e.z;
  }
  return out;
}

/**
 * Picks the exit index (0-based into `exits`) for a teleport. Pure given the
 * use counter, so server and predicting client agree.
 */
export function teleporterPickExit(p: TeleporterPairParams, actorId: number, uses: number): number {
  const n = p.exits.length;
  if (n <= 1 || p.mode === 'first') return 0;
  if (p.mode === 'roundRobin') return uses % n;
  return Math.min(n - 1, Math.floor(hash3(p.seed, actorId, uses) * n));
}

/** Runtime extras for teleporters (visual flash timing). */
export interface TeleporterRuntime extends ObstacleRuntime {
  /** Match time of the last zap per pad (NaN = never). Visuals flash pads from it. */
  readonly lastZap: Float64Array;
}

/** Teleporter Pads obstacle module. */
export const teleporterPair: ObstacleModule<TeleporterPairParams> = {
  type: 'teleporterPair',
  displayName: 'Warp Pads',
  schema: TeleporterPairSchema,
  audioCues: ['teleportZap', 'teleportArrive', 'teleportTrap'],
  create(instance, ctx): TeleporterRuntime {
    const p = TeleporterPairSchema.parse(instance.params);
    const { R } = ctx;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const padCount = p.exits.length + 1;
    const padWorld: Vec3[] = [];
    const padOf = new Map<number, number>();
    const inside: ActorSet<ObstacleActor>[] = [];
    const body = bag.fixed(frame);
    const local = vec3();
    for (let i = 0; i < padCount; i++) {
      teleporterPadLocal(p, i, local);
      const w = vec3();
      toWorld(frame, local, null, w, null);
      padWorld.push(w);
      bag.collider(
        R.ColliderDesc.cylinder(0.08, p.padRadius)
          .setTranslation(local.x, local.y + 0.08, local.z)
          .setCollisionGroups(InteractionGroups.static),
        body,
        { kind: 'normal', ownerId: instance.id },
      );
      const sensor = bag.collider(
        R.ColliderDesc.cylinder(p.triggerHeight / 2, p.padRadius * 0.85)
          .setTranslation(local.x, local.y + 0.16 + p.triggerHeight / 2, local.z)
          .setSensor(true)
          .setCollisionGroups(InteractionGroups.trigger)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        body,
      );
      padOf.set(sensor.handle, i);
      inside.push(new ActorSet<ObstacleActor>());
    }

    const frameYaw = yawFromQuat(frame.rot);
    const cooldowns = new ActorCooldowns();
    /** Actor id → pad they arrived on; that pad is ignored until they step off it. */
    const arrivedOn = new Map<number, number>();
    const lastZap = new Float64Array(padCount).fill(Number.NaN);
    const dest = vec3();
    let uses = 0;

    const zap = (a: ObstacleActor, from: number, t: number, events: EventSink): void => {
      const to = from === 0 ? 1 + teleporterPickExit(p, a.id, uses) : 0;
      uses++;
      const target = padWorld[to]!;
      dest.x = target.x;
      dest.y = target.y + p.arrivalHeight;
      dest.z = target.z;
      const fromPos = a.body.translation();
      const yaw = frameYaw + (to === 0 ? p.returnYaw : p.exitYaw) * DEG;
      a.teleport(dest, yaw);
      cooldowns.arm(a.id, t, p.cooldown);
      arrivedOn.set(a.id, to);
      inside[from]!.remove(a.id);
      lastZap[from] = t;
      lastZap[to] = t;
      events.push({
        type: 'teleport',
        player: a.id,
        from: { x: fromPos.x, y: fromPos.y, z: fromPos.z },
        to: { x: dest.x, y: dest.y, z: dest.z },
      });
      emitCue(events, instance.id, p.variant === 'sendBack' ? 'teleportTrap' : 'teleportZap', fromPos);
      emitCue(events, instance.id, 'teleportArrive', dest);
    };

    return {
      instance,
      colliders: bag.colliders,
      lastZap,
      update(sctx) {
        for (let pad = 0; pad < padCount; pad++) {
          if (pad > 0 && !p.twoWay) continue;
          const set = inside[pad]!;
          // Iterate backwards: zap() removes from this set.
          for (let i = set.items.length - 1; i >= 0; i--) {
            const a = set.items[i]!;
            if (arrivedOn.get(a.id) === pad || !cooldowns.ready(a.id, sctx.t)) continue;
            zap(a, pad, sctx.t, sctx.events);
          }
        }
      },
      onTrigger(actor, collider, entered) {
        const pad = padOf.get(collider.handle);
        if (pad === undefined) return;
        if (entered) inside[pad]!.add(actor);
        else {
          inside[pad]!.remove(actor.id);
          if (arrivedOn.get(actor.id) === pad) arrivedOn.delete(actor.id);
        }
      },
      getNetState: () => [uses],
      setNetState(state) {
        uses = state[0] ?? 0;
      },
      dispose: () => {
        for (const s of inside) s.clear();
        arrivedOn.clear();
        bag.dispose();
      },
    };
  },
};
