/**
 * Start Gate — the barrier players wait behind during COUNTDOWN. It shows
 * 3-2-1 lights and opens at `openTime` (match time 0 = GO). Purely a function
 * of match time, deliberately NOT scaled by the show-stage speed multiplier:
 * the gate must open exactly on GO.
 */
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatIdentity } from '@tumble/shared';
import { z } from 'zod';
import { KinematicRig, PhysicsBag, emitCue, ensurePoseSamples, instanceFrame, writeSample } from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

/**
 * Start Gate parameters. Metres, seconds. Origin = centre of the barrier's
 * base; the barrier spans local X and players start on the −Z side.
 */
export const StartGateSchema = z.object({
  width: z.number().positive().default(16),
  height: z.number().positive().default(2.6),
  thickness: z.number().positive().default(0.5),
  /** Match time at which the gate opens (0 = GO). */
  openTime: z.number().default(0),
  /** `drop` sinks into the floor, `rise` lifts away, `split` slides apart sideways. */
  style: z.enum(['drop', 'rise', 'split']).default('drop'),
  openDuration: z.number().positive().default(0.45),
  /** Countdown lights before opening (seconds = number of lights). */
  countdown: z.number().int().min(0).max(5).default(3),
});

/** Validated Start Gate parameters. */
export type StartGateParams = z.output<typeof StartGateSchema>;

/** Opening progress 0 (closed) … 1 (fully open) at match time `t`. Pure. */
export function startGateOpenness(t: number, p: StartGateParams): number {
  const x = (t - p.openTime) / p.openDuration;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Ease-in: the gate snaps away rather than drifting.
  return x * x * (2 - x);
}

/**
 * Countdown light state at match time `t`: `countdown + 1` before the
 * countdown starts (idle), then the seconds remaining (3, 2, 1), or -1 once the
 * gate has opened (show "GO").
 */
export function startGateLights(t: number, p: StartGateParams): number {
  if (t >= p.openTime) return -1;
  const left = p.openTime - t;
  if (left > p.countdown) return p.countdown + 1;
  return Math.ceil(left);
}

const q = quatIdentity();

/**
 * Pure pose: two half-panels (left = sample 0 at −X, right = sample 1 at +X).
 * Not affected by `speedScale`.
 */
export function startGatePose(t: number, p: StartGateParams, out: PoseSample[], _speedScale: number): void {
  ensurePoseSamples(out, 2);
  const o = startGateOpenness(t, p);
  const hw = p.width / 4;
  const baseY = p.height / 2;
  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? -1 : 1;
    let x = sx * hw;
    let y = baseY;
    if (p.style === 'drop') y -= o * (p.height + 0.3);
    else if (p.style === 'rise') y += o * (p.height + 4);
    else x += sx * o * (p.width / 2 + 0.4);
    writeSample(out[side] as PoseSample, x, y, 0, q);
  }
}

/** Start Gate obstacle module. */
export const startGate: ObstacleModule<StartGateParams> = {
  type: 'startGate',
  displayName: 'Start Gate',
  schema: StartGateSchema,
  audioCues: ['countdownBeep', 'gateOpen'],
  pose: startGatePose,
  create(instance, ctx): ObstacleRuntime {
    const p = StartGateSchema.parse(instance.params);
    const { R } = ctx;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const bodies: RigidBody[] = [];
    for (let i = 0; i < 2; i++) {
      const b = bag.kinematic(frame);
      bag.collider(
        R.ColliderDesc.cuboid(p.width / 4, p.height / 2, p.thickness / 2).setCollisionGroups(InteractionGroups.kinematic),
        b,
        { kind: 'normal', ownerId: instance.id },
      );
      bodies.push(b);
    }
    const rig = new KinematicRig(frame, bodies, (t, out) => startGatePose(t, p, out, 1));
    let lastLights = Number.NaN;

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        rig.apply(sctx.t, sctx.dt);
        const lights = startGateLights(sctx.t, p);
        if (lights !== lastLights) {
          if (!Number.isNaN(lastLights)) {
            if (lights === -1) emitCue(sctx.events, instance.id, 'gateOpen', frame.pos);
            else if (lights < lastLights) emitCue(sctx.events, instance.id, 'countdownBeep', frame.pos);
          }
          lastLights = lights;
        }
      },
      telegraph(t) {
        const left = p.openTime - t;
        if (left <= 0 || left > p.countdown) return 0;
        // Flash at the start of every countdown second.
        const f = left - Math.floor(left);
        return f > 0.7 ? 1 : f > 0.5 ? (f - 0.5) / 0.2 : 0.15;
      },
      dispose: () => bag.dispose(),
    };
  },
};
