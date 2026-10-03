/**
 * Pop-up Foam Blocks — a floor grid of foam blocks. Each cycle a seeded pattern
 * of blocks glows (telegraph), then punches upward, launching anyone on top,
 * holds, and sinks back flush. Every block height is a pure function of
 * `(t, params)`, so no replication is needed.
 */
import type { Collider } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatIdentity, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import {
  ActorCooldowns,
  KinematicRig,
  PhysicsBag,
  emitCue,
  ensurePoseSamples,
  hash3,
  instanceFrame,
  pulse,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

/** Pop-up Blocks parameters. Metres and seconds. Origin = centre of the grid's top surface. */
export const PopupBlocksSchema = z.object({
  cols: z.number().int().min(1).max(16).default(6),
  rows: z.number().int().min(1).max(16).default(6),
  /** Grid pitch (block footprint incl. gap). */
  cellSize: z.number().positive().default(2),
  /** Visual/physical gap between neighbouring blocks. */
  gap: z.number().min(0).default(0.12),
  /** Block body height; at rest the top is flush with y = 0. */
  blockHeight: z.number().positive().default(2),
  /** How far an active block rises. */
  popHeight: z.number().positive().default(1.6),
  /** Seconds per pattern cycle. */
  period: z.number().positive().default(3.5),
  /** Telegraph (glow + wobble) before rising. */
  warnTime: z.number().min(0).default(1.0),
  /** Rise duration — short is punchy and launches harder. */
  riseTime: z.number().positive().default(0.16),
  holdTime: z.number().min(0).default(0.9),
  /** Sink back duration. */
  fallTime: z.number().positive().default(0.5),
  /** Seconds before the first cycle (match time). */
  startDelay: z.number().default(0),
  /** Which blocks pop each cycle. */
  pattern: z.enum(['random', 'checker', 'rows', 'cols', 'ring']).default('random'),
  /** Fraction of blocks active per cycle (`random`), or 1/stride for row/col/ring patterns. */
  density: z.number().min(0.05).max(1).default(0.35),
  /** Pattern seed; change per instance/variation for different layouts. */
  seed: z.number().int().default(1),
  /** Upward impulse (N·s ≈ Δv m/s for a Tumbler) given to players on a rising block. */
  launchImpulse: z.number().min(0).default(10),
});

/** Validated Pop-up Blocks parameters. */
export type PopupBlocksParams = z.output<typeof PopupBlocksSchema>;

/** Phases of one block within a cycle. */
export const PopupPhase = { Rest: 0, Warn: 1, Rise: 2, Hold: 3, Fall: 4 } as const;

/** Numeric popup phase id. */
export type PopupPhaseId = (typeof PopupPhase)[keyof typeof PopupPhase];

const ID = quatIdentity();

/** @returns Pattern cycle index at scaled time `ts`, or -1 before the first cycle. */
export function popupCycle(ts: number, p: PopupBlocksParams): number {
  const u = ts - p.startDelay;
  return u < 0 ? -1 : Math.floor(u / p.period);
}

/**
 * Whether block `i` is part of cycle `k`'s pattern. Pure.
 */
export function popupBlockActive(p: PopupBlocksParams, i: number, k: number): boolean {
  if (k < 0) return false;
  const col = i % p.cols;
  const row = Math.floor(i / p.cols);
  const stride = Math.max(2, Math.round(1 / p.density));
  switch (p.pattern) {
    case 'checker':
      return (col + row + k) % 2 === 0;
    case 'rows':
      return (row + k) % stride === 0;
    case 'cols':
      return (col + k) % stride === 0;
    case 'ring': {
      const ring = Math.floor(Math.max(Math.abs(col - (p.cols - 1) / 2), Math.abs(row - (p.rows - 1) / 2)));
      return (ring + k) % stride === 0;
    }
    default:
      return hash3(p.seed, k, i) < p.density;
  }
}

/** Phase and normalised progress of an active block at cycle-local time `tau`. */
export function popupPhaseAt(tau: number, p: PopupBlocksParams): PopupPhaseId {
  if (tau < p.warnTime) return PopupPhase.Warn;
  let u = tau - p.warnTime;
  if (u < p.riseTime) return PopupPhase.Rise;
  u -= p.riseTime;
  if (u < p.holdTime) return PopupPhase.Hold;
  u -= p.holdTime;
  if (u < p.fallTime) return PopupPhase.Fall;
  return PopupPhase.Rest;
}

/** Height offset (0 … popHeight) of an active block at cycle-local time `tau`. */
export function popupHeightAt(tau: number, p: PopupBlocksParams): number {
  if (tau < p.warnTime) return 0;
  let u = tau - p.warnTime;
  if (u < p.riseTime) {
    const x = u / p.riseTime;
    // Ease-out: fastest at the start so the launch is a punch, not a lift.
    return p.popHeight * (1 - (1 - x) * (1 - x));
  }
  u -= p.riseTime;
  if (u < p.holdTime) return p.popHeight;
  u -= p.holdTime;
  if (u < p.fallTime) {
    const x = u / p.fallTime;
    return p.popHeight * (1 - x * x * (3 - 2 * x));
  }
  return 0;
}

/** Local centre of block `i` on the XZ grid (y excluded). */
export function popupBlockXZ(p: PopupBlocksParams, i: number, out: Vec3): Vec3 {
  out.x = ((i % p.cols) - (p.cols - 1) / 2) * p.cellSize;
  out.y = 0;
  out.z = (Math.floor(i / p.cols) - (p.rows - 1) / 2) * p.cellSize;
  return out;
}

/**
 * Per-block telegraph intensity 0–1 at match time `t` (pulses while warning).
 */
export function popupBlockTelegraph(t: number, p: PopupBlocksParams, i: number, speedScale: number): number {
  const ts = t * speedScale;
  const k = popupCycle(ts, p);
  if (!popupBlockActive(p, i, k)) return 0;
  const tau = ts - p.startDelay - k * p.period;
  if (tau >= p.warnTime) return 0;
  return 0.35 + 0.65 * pulse(tau, 3 + 3 * (tau / Math.max(p.warnTime, 1e-3)));
}

const xz = { x: 0, y: 0, z: 0 };

/**
 * Pure pose: one sample per block (row-major), centre positions in local space.
 */
export function popupBlocksPose(
  t: number,
  p: PopupBlocksParams,
  out: PoseSample[],
  speedScale: number,
): void {
  const n = p.cols * p.rows;
  ensurePoseSamples(out, n);
  const ts = t * speedScale;
  const k = popupCycle(ts, p);
  const tau = ts - p.startDelay - k * p.period;
  for (let i = 0; i < n; i++) {
    popupBlockXZ(p, i, xz);
    const h = popupBlockActive(p, i, k) ? popupHeightAt(tau, p) : 0;
    writeSample(out[i] as PoseSample, xz.x, h - p.blockHeight / 2, xz.z, ID);
  }
}

/** Pop-up Blocks obstacle module. */
export const popupBlocks: ObstacleModule<PopupBlocksParams> = {
  type: 'popupBlocks',
  displayName: 'Pop-up Foam Blocks',
  schema: PopupBlocksSchema,
  audioCues: ['popupWarn', 'popupPop'],
  pose: popupBlocksPose,
  create(instance, ctx): ObstacleRuntime {
    const p = PopupBlocksSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const n = p.cols * p.rows;
    const half = Math.max(0.05, (p.cellSize - p.gap) / 2);
    const blockOf = new Map<number, number>();
    const bodies = [];
    for (let i = 0; i < n; i++) {
      const body = bag.kinematic(frame);
      const c = bag.collider(
        R.ColliderDesc.cuboid(half, p.blockHeight / 2, half)
          .setFriction(0.9)
          .setCollisionGroups(InteractionGroups.kinematic)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        body,
        { kind: 'normal', ownerId: instance.id },
      );
      blockOf.set(c.handle, i);
      bodies.push(body);
    }
    const rig = new KinematicRig(frame, bodies, (t, out) => popupBlocksPose(t, p, out, scale));
    const hits = new ActorCooldowns();
    let lastCycle = -2;
    let lastPhase: PopupPhaseId = PopupPhase.Rest;

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        rig.apply(sctx.t, sctx.dt);
        const ts = sctx.t * scale;
        const k = popupCycle(ts, p);
        if (k < 0) return;
        const phase = popupPhaseAt(ts - p.startDelay - k * p.period, p);
        if (k !== lastCycle || phase !== lastPhase) {
          if (phase === PopupPhase.Warn && (k !== lastCycle || lastPhase !== PopupPhase.Warn))
            emitCue(sctx.events, instance.id, 'popupWarn', frame.pos);
          if (phase === PopupPhase.Rise) emitCue(sctx.events, instance.id, 'popupPop', frame.pos);
          lastCycle = k;
          lastPhase = phase;
        }
      },
      onContact(actor, collider: Collider, sctx) {
        const i = blockOf.get(collider.handle);
        if (i === undefined || p.launchImpulse <= 0) return;
        const ts = sctx.t * scale;
        const k = popupCycle(ts, p);
        if (!popupBlockActive(p, i, k)) return;
        if (popupPhaseAt(ts - p.startDelay - k * p.period, p) !== PopupPhase.Rise) return;
        // Only riders on top get launched; side contacts are just a shove from the moving body.
        const blockTop = (rig.bodies[i]?.translation().y ?? 0) + p.blockHeight / 2;
        if (actor.body.translation().y < blockTop - 0.2) return;
        if (!hits.ready(actor.id, sctx.t)) return;
        hits.arm(actor.id, sctx.t, p.riseTime + 0.2);
        launch.y = p.launchImpulse;
        actor.knock(launch, false);
      },
      telegraph(t) {
        const ts = t * scale;
        const k = popupCycle(ts, p);
        if (k < 0) return 0;
        const tau = ts - p.startDelay - k * p.period;
        return tau < p.warnTime ? 0.35 + 0.65 * pulse(tau, 3) : 0;
      },
      dispose: () => bag.dispose(),
    };
  },
};

const launch = { x: 0, y: 0, z: 0 };
