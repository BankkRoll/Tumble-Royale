/**
 * Finish Line — the festive arch at the end of a race. Finish order must be
 * fair at 60 Hz with 40 players, so the crossing moment is reconstructed to a
 * fraction of a step: when a player's centre passes the finish plane we
 * back-solve when it crossed from its signed distance and velocity along the
 * plane normal.
 */
import { InteractionGroups, vec3 } from '@tumble/shared';
import { z } from 'zod';
import { ActorSet, PhysicsBag, archParts, dirToWorld, emitCue, instanceFrame } from './helpers-b.ts';
import type { ObstacleActor, ObstacleModule, ObstacleRuntime } from './types.ts';

/**
 * Finish Line parameters. Metres. Origin = centre of the finish plane on the
 * floor; the course crosses it along local +Z.
 */
export const FinishLineSchema = z.object({
  width: z.number().positive().default(14),
  height: z.number().positive().default(6.5),
  pillarSize: z.number().positive().default(1.2),
  /** Trigger depth along Z; generous so fast divers are always caught. */
  triggerDepth: z.number().positive().default(3),
  arch: z.boolean().default(true),
});

/** Validated Finish Line parameters. */
export type FinishLineParams = z.output<typeof FinishLineSchema>;

/**
 * Fraction of the last step at which a point crossed a plane.
 *
 * @param distNow - Signed distance past the plane now (≥ 0 means crossed).
 * @param speedAlong - Velocity along the plane normal (m/s).
 * @param dt - Step length (s).
 * @returns Fraction in [0, 1): 0 = at the start of the step, → 1 = at its end.
 */
export function finishSubTick(distNow: number, speedAlong: number, dt: number): number {
  if (speedAlong <= 1e-6 || dt <= 0) return 0;
  const distPrev = distNow - speedAlong * dt;
  if (distPrev >= 0) return 0;
  const f = -distPrev / (speedAlong * dt);
  return f < 0 ? 0 : f >= 1 ? 1 - 1e-9 : f;
}

/** Runtime extras for round logic and visuals. */
export interface FinishLineRuntime extends ObstacleRuntime {
  /** Players finished so far through this line. */
  readonly finishedCount: number;
  /** Match time of the most recent finish (NaN = none). Visuals fire confetti from it. */
  readonly lastFinishTime: number;
  /** Whether a player has finished. */
  hasFinished(playerId: number): boolean;
  /** Clears finishers (round restart). */
  reset(): void;
}

/** Finish Line obstacle module. */
export const finishLine: ObstacleModule<FinishLineParams> = {
  type: 'finishLine',
  displayName: 'Finish Arch',
  schema: FinishLineSchema,
  audioCues: ['finishCross', 'finishFanfare'],
  create(instance, ctx): FinishLineRuntime {
    const p = FinishLineSchema.parse(instance.params);
    const { R } = ctx;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const body = bag.fixed(frame);
    if (p.arch) {
      for (const part of archParts(p.width, p.height, p.pillarSize, p.pillarSize)) {
        bag.collider(
          R.ColliderDesc.cuboid(part.half.x, part.half.y, part.half.z)
            .setTranslation(part.pos.x, part.pos.y, part.pos.z)
            .setCollisionGroups(InteractionGroups.static),
          body,
          { kind: 'normal', ownerId: instance.id },
        );
      }
    }
    bag.collider(
      R.ColliderDesc.cuboid(p.width / 2, p.height / 2, p.triggerDepth / 2)
        .setTranslation(0, p.height / 2, 0)
        .setSensor(true)
        .setCollisionGroups(InteractionGroups.trigger)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      body,
    );

    const normal = dirToWorld(frame, vec3(0, 0, 1), vec3());
    const inside = new ActorSet<ObstacleActor>();
    const finished = new Set<number>();
    let lastFinishTime = Number.NaN;

    return {
      instance,
      colliders: bag.colliders,
      get finishedCount() {
        return finished.size;
      },
      get lastFinishTime() {
        return lastFinishTime;
      },
      update(sctx) {
        // Crossing is judged on the body centre, in update(), so every player is
        // measured at the same point of the step and ordering stays fair.
        const items = inside.items;
        for (let i = items.length - 1; i >= 0; i--) {
          const a = items[i]!;
          if (finished.has(a.id)) continue;
          const pos = a.body.translation();
          const d =
            (pos.x - frame.pos.x) * normal.x + (pos.y - frame.pos.y) * normal.y + (pos.z - frame.pos.z) * normal.z;
          if (d < 0) continue;
          const v = a.body.linvel();
          const vn = v.x * normal.x + v.y * normal.y + v.z * normal.z;
          finished.add(a.id);
          lastFinishTime = sctx.t;
          sctx.events.push({ type: 'finish', player: a.id, tick: sctx.tick, subTick: finishSubTick(d, vn, sctx.dt) });
          emitCue(sctx.events, instance.id, finished.size === 1 ? 'finishFanfare' : 'finishCross', pos);
        }
      },
      onTrigger(actor, _collider, entered) {
        if (entered) inside.add(actor);
        else inside.remove(actor.id);
      },
      hasFinished: (id) => finished.has(id),
      reset() {
        finished.clear();
        lastFinishTime = Number.NaN;
      },
      dispose: () => {
        inside.clear();
        finished.clear();
        bag.dispose();
      },
    };
  },
};
