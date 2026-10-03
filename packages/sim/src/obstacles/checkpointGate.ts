/**
 * Checkpoint Gate — a flag arch with a trigger plane. The first time each
 * player passes through, it emits a `checkpoint` event with the gate's index;
 * the round logic then respawns that player at this gate's respawn points.
 */
import type { Vec3 } from '@tumble/shared';
import { InteractionGroups, vec3, yawFromQuat } from '@tumble/shared';
import { z } from 'zod';
import { DEG, PhysicsBag, archParts, emitCue, instanceFrame, toWorld } from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime } from './types.ts';

const LocalPoint = z.object({ x: z.number(), y: z.number(), z: z.number() });

/**
 * Checkpoint Gate parameters. Metres, degrees. Origin = centre of the gate
 * opening on the floor; the course passes through along local +Z.
 */
export const CheckpointGateSchema = z.object({
  /** Checkpoint order (0 = start, 1 = first checkpoint, …). */
  index: z.number().int().min(0).default(1),
  /** Opening width (between pillars). */
  width: z.number().positive().default(10),
  height: z.number().positive().default(5),
  pillarSize: z.number().positive().default(0.9),
  /** Trigger thickness along Z. */
  triggerDepth: z.number().positive().default(1.2),
  /** Render/collide the arch (false = invisible trigger only). */
  arch: z.boolean().default(true),
  /**
   * Explicit respawn points (local, floor level). Empty = an automatic grid
   * `respawnDistance` past the gate.
   */
  respawnPoints: z.array(LocalPoint).default([]),
  respawnRows: z.number().int().min(1).default(2),
  respawnCols: z.number().int().min(1).default(5),
  respawnSpacing: z.number().positive().default(1.6),
  respawnDistance: z.number().default(3),
  /** Respawn facing, local yaw in degrees (0 = continue along +Z). */
  respawnYaw: z.number().default(0),
});

/** Validated Checkpoint Gate parameters. */
export type CheckpointGateParams = z.output<typeof CheckpointGateSchema>;

/** Local respawn points for a gate (explicit list or generated grid). Build-time allocation. */
export function checkpointRespawnPoints(p: CheckpointGateParams): Vec3[] {
  if (p.respawnPoints.length > 0) return p.respawnPoints.map((v) => vec3(v.x, v.y, v.z));
  const pts: Vec3[] = [];
  for (let r = 0; r < p.respawnRows; r++)
    for (let c = 0; c < p.respawnCols; c++)
      pts.push(vec3((c - (p.respawnCols - 1) / 2) * p.respawnSpacing, 0, p.respawnDistance + r * p.respawnSpacing));
  return pts;
}

/** Runtime extras exposed to round logic and visuals. */
export interface CheckpointRuntime extends ObstacleRuntime {
  readonly index: number;
  /** Match time of the most recent first-pass trigger (NaN = never). Visuals flash from it. */
  readonly lastTriggerTime: number;
  /** World-space respawn facing in radians. */
  readonly respawnYaw: number;
  /**
   * World-space respawn point for a player. Players are spread over the points
   * by id so simultaneous respawns don't stack.
   */
  respawnPoint(playerId: number, out: Vec3): Vec3;
  /** Whether a player has passed this gate. */
  reached(playerId: number): boolean;
  /** Forget who has passed (round restart). */
  reset(): void;
}

/** Checkpoint Gate obstacle module. */
export const checkpointGate: ObstacleModule<CheckpointGateParams> = {
  type: 'checkpointGate',
  displayName: 'Checkpoint Arch',
  schema: CheckpointGateSchema,
  audioCues: ['checkpointDing'],
  create(instance, ctx): CheckpointRuntime {
    const p = CheckpointGateSchema.parse(instance.params);
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
    const spawns = checkpointRespawnPoints(p).map((v) => {
      const w = vec3();
      toWorld(frame, v, null, w, null);
      return w;
    });
    const passed = new Set<number>();
    let lastTriggerTime = Number.NaN;

    return {
      instance,
      colliders: bag.colliders,
      index: p.index,
      get lastTriggerTime() {
        return lastTriggerTime;
      },
      respawnYaw: yawFromQuat(frame.rot) + p.respawnYaw * DEG,
      update() {},
      onTrigger(actor, _collider, entered, sctx) {
        if (!entered || passed.has(actor.id)) return;
        passed.add(actor.id);
        lastTriggerTime = sctx.t;
        sctx.events.push({ type: 'checkpoint', player: actor.id, index: p.index });
        emitCue(sctx.events, instance.id, 'checkpointDing', actor.body.translation());
      },
      respawnPoint(playerId, out) {
        const n = spawns.length;
        const s = spawns[((playerId % n) + n) % n]!;
        out.x = s.x;
        out.y = s.y;
        out.z = s.z;
        return out;
      },
      reached: (id) => passed.has(id),
      reset() {
        passed.clear();
        lastTriggerTime = Number.NaN;
      },
      dispose: () => {
        passed.clear();
        bag.dispose();
      },
    };
  },
};
