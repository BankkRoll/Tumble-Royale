/**
 * Collapsing Bridge — a span of segments that crack, wobble and drop one after
 * another, then (optionally) float back up so the cycle repeats. Every segment's
 * state is a pure function of `(t, params)`; the runtime only turns phase edges
 * into `tileWarn` / `tileFell` events and audio cues.
 */
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatFromEulerYXZ, quatIdentity } from '@tumble/shared';
import { z } from 'zod';
import {
  KinematicRig,
  PARK_Y,
  PhysicsBag,
  emitCue,
  ensurePoseSamples,
  hash3,
  instanceFrame,
  timeJumped,
  toWorld,
  writeSample,
} from './helpers-b.ts';
import type { ObstacleModule, ObstacleRuntime, PoseSample } from './types.ts';

/**
 * Collapsing Bridge parameters. Metres, seconds. Origin = centre of the near
 * end of the deck's top surface; segments run along local +Z.
 */
export const CollapsingBridgeSchema = z.object({
  segments: z.number().int().min(1).max(32).default(8),
  /** Length of one segment along Z. */
  segmentLength: z.number().positive().default(2.5),
  width: z.number().positive().default(3.2),
  thickness: z.number().positive().default(0.5),
  /** Gap between segments. */
  gap: z.number().min(0).default(0.08),
  /** Match time the first segment starts warning. */
  startDelay: z.number().default(4),
  /** Seconds between successive segments starting to warn. */
  interval: z.number().min(0).default(1.1),
  order: z.enum(['sequential', 'reverse', 'random', 'alternating']).default('sequential'),
  /** Crack + wobble duration before dropping. */
  warnTime: z.number().min(0).default(1.4),
  /** Seconds a segment is visibly falling before it is removed. */
  fallTime: z.number().positive().default(1.2),
  /** Fall acceleration (m/s²). */
  gravity: z.number().positive().default(24),
  /** Whether fallen segments return and the whole cycle repeats. */
  respawn: z.boolean().default(true),
  /** Seconds a segment stays gone before rising back. */
  respawnDelay: z.number().min(0).default(4),
  /** Seconds to rise back into place. */
  riseTime: z.number().positive().default(0.8),
  /** Extra stable time between cycles. */
  cycleGap: z.number().min(0).default(2),
  seed: z.number().int().default(1),
});

/** Validated Collapsing Bridge parameters. */
export type CollapsingBridgeParams = z.output<typeof CollapsingBridgeSchema>;

/** Segment lifecycle phases. */
export const BridgePhase = { Stable: 0, Warn: 1, Falling: 2, Gone: 3, Rising: 4 } as const;

/** Numeric bridge phase id. */
export type BridgePhaseId = (typeof BridgePhase)[keyof typeof BridgePhase];

/** Phase state for one segment. */
export interface BridgeSegmentState {
  phase: BridgePhaseId;
  /** Seconds since the phase began. */
  time: number;
  /** Repeat cycle this state belongs to. */
  cycle: number;
}

/** Repeat period of the whole bridge (Infinity when it never respawns). */
export function bridgePeriod(p: CollapsingBridgeParams): number {
  if (!p.respawn) return Infinity;
  return (p.segments - 1) * p.interval + p.warnTime + p.fallTime + p.respawnDelay + p.riseTime + p.cycleGap;
}

/** Collapse order rank of segment `i` in cycle `c` (0 = first to go). Pure. */
export function bridgeRank(p: CollapsingBridgeParams, i: number, c: number): number {
  const n = p.segments;
  switch (p.order) {
    case 'reverse':
      return n - 1 - i;
    case 'alternating':
      // Ends first, closing in on the middle: 0, n-1, 1, n-2, …
      return i < n / 2 ? 2 * i : 2 * (n - 1 - i) + 1;
    case 'random': {
      const h = hash3(p.seed, c, i);
      let rank = 0;
      for (let j = 0; j < n; j++) {
        const hj = hash3(p.seed, c, j);
        if (hj < h || (hj === h && j < i)) rank++;
      }
      return rank;
    }
    default:
      return i;
  }
}

/**
 * Phase of segment `i` at scaled time `ts`. Pure.
 */
export function bridgeSegmentState(ts: number, p: CollapsingBridgeParams, i: number, out: BridgeSegmentState): BridgeSegmentState {
  const P = bridgePeriod(p);
  const u = ts - p.startDelay;
  const c = u < 0 || !Number.isFinite(P) ? 0 : Math.floor(u / P);
  let tau = u - (Number.isFinite(P) ? c * P : 0) - bridgeRank(p, i, c) * p.interval;
  out.cycle = c;
  out.phase = BridgePhase.Stable;
  out.time = tau;
  if (tau < 0) return out;
  if (tau < p.warnTime) {
    out.phase = BridgePhase.Warn;
    return out;
  }
  tau -= p.warnTime;
  if (tau < p.fallTime) {
    out.phase = BridgePhase.Falling;
    out.time = tau;
    return out;
  }
  tau -= p.fallTime;
  if (!p.respawn || tau < p.respawnDelay) {
    out.phase = BridgePhase.Gone;
    out.time = tau;
    return out;
  }
  tau -= p.respawnDelay;
  if (tau < p.riseTime) {
    out.phase = BridgePhase.Rising;
    out.time = tau;
    return out;
  }
  out.time = tau - p.riseTime;
  return out;
}

/** Depth below the deck a respawning segment rises from. */
export const BRIDGE_RISE_DEPTH = 3;

const st: BridgeSegmentState = { phase: 0, time: 0, cycle: 0 };
const q = quatIdentity();

/** Local Z centre of segment `i`. */
export const bridgeSegmentZ = (p: CollapsingBridgeParams, i: number): number => (i + 0.5) * p.segmentLength;

/**
 * Pure pose: one sample per segment (centre of the segment box). Warning
 * segments wobble slightly; falling ones accelerate down and tumble; gone ones
 * are parked far below.
 */
export function collapsingBridgePose(t: number, p: CollapsingBridgeParams, out: PoseSample[], speedScale: number): void {
  ensurePoseSamples(out, p.segments);
  const ts = t * speedScale;
  const hy = -p.thickness / 2;
  for (let i = 0; i < p.segments; i++) {
    const s = out[i] as PoseSample;
    const z = bridgeSegmentZ(p, i);
    bridgeSegmentState(ts, p, i, st);
    switch (st.phase) {
      case BridgePhase.Warn: {
        const k = st.time / Math.max(p.warnTime, 1e-3);
        const roll = 0.03 * k * Math.sin(st.time * 38 + i);
        const pitch = 0.015 * k * Math.sin(st.time * 31 + i * 2);
        writeSample(s, 0, hy, z, quatFromEulerYXZ(0, pitch, roll, q));
        break;
      }
      case BridgePhase.Falling: {
        const spin = (hash3(p.seed, i, 0xfa11) - 0.5) * 2.4;
        writeSample(
          s,
          0,
          hy - 0.5 * p.gravity * st.time * st.time,
          z,
          quatFromEulerYXZ(0, spin * st.time * st.time, spin * 0.6 * st.time, q),
        );
        break;
      }
      case BridgePhase.Gone:
        writeSample(s, 0, PARK_Y - i * 4, z, quatFromEulerYXZ(0, 0, 0, q));
        break;
      case BridgePhase.Rising: {
        const x = st.time / p.riseTime;
        const e = 1 - (1 - x) * (1 - x) * (1 - x);
        writeSample(s, 0, hy - BRIDGE_RISE_DEPTH * (1 - e), z, quatFromEulerYXZ(0, 0, 0, q));
        break;
      }
      default:
        writeSample(s, 0, hy, z, quatFromEulerYXZ(0, 0, 0, q));
    }
  }
}

/** Collapsing Bridge obstacle module. */
export const collapsingBridge: ObstacleModule<CollapsingBridgeParams> = {
  type: 'collapsingBridge',
  displayName: 'Crumble Bridge',
  schema: CollapsingBridgeSchema,
  audioCues: ['bridgeCrack', 'bridgeCollapse', 'bridgeRespawn'],
  pose: collapsingBridgePose,
  create(instance, ctx): ObstacleRuntime {
    const p = CollapsingBridgeSchema.parse(instance.params);
    const { R } = ctx;
    const scale = ctx.speedScale;
    const frame = instanceFrame(instance);
    const bag = new PhysicsBag(ctx);
    const bodies: RigidBody[] = [];
    const hl = Math.max(0.05, (p.segmentLength - p.gap) / 2);
    for (let i = 0; i < p.segments; i++) {
      const b = bag.kinematic(frame);
      bag.collider(
        R.ColliderDesc.cuboid(p.width / 2, p.thickness / 2, hl).setCollisionGroups(InteractionGroups.kinematic),
        b,
        { kind: 'normal', ownerId: instance.id },
      );
      bodies.push(b);
    }
    const rig = new KinematicRig(frame, bodies, (t, out) => collapsingBridgePose(t, p, out, scale));
    const phases = new Int8Array(p.segments);
    const segState: BridgeSegmentState = { phase: 0, time: 0, cycle: 0 };
    const cuePos = { x: 0, y: 0, z: 0 };
    let prevT = Number.NaN;

    return {
      instance,
      colliders: bag.colliders,
      update(sctx) {
        const jumped = timeJumped(prevT, sctx.t, sctx.dt);
        prevT = sctx.t;
        const ts = sctx.t * scale;
        for (let i = 0; i < p.segments; i++) {
          const ph = bridgeSegmentState(ts, p, i, segState).phase;
          const prev = phases[i] as BridgePhaseId;
          if (ph === prev) continue;
          phases[i] = ph;
          // Parked ↔ visible transitions are teleports, never sweeps.
          if (ph === BridgePhase.Gone || ph === BridgePhase.Rising) rig.markSnap(i);
          if (jumped) continue;
          cuePos.x = 0;
          cuePos.y = 0;
          cuePos.z = bridgeSegmentZ(p, i);
          toWorld(frame, cuePos, null, cuePos, null);
          if (ph === BridgePhase.Warn) {
            sctx.events.push({ type: 'tileWarn', obstacle: instance.id, tile: i });
            emitCue(sctx.events, instance.id, 'bridgeCrack', cuePos);
          } else if (ph === BridgePhase.Falling) {
            sctx.events.push({ type: 'tileFell', obstacle: instance.id, tile: i });
            emitCue(sctx.events, instance.id, 'bridgeCollapse', cuePos);
          } else if (ph === BridgePhase.Rising) {
            emitCue(sctx.events, instance.id, 'bridgeRespawn', cuePos);
          }
        }
        rig.apply(sctx.t, sctx.dt);
      },
      telegraph(t) {
        const ts = t * scale;
        let m = 0;
        for (let i = 0; i < p.segments; i++) {
          bridgeSegmentState(ts, p, i, segState);
          if (segState.phase === BridgePhase.Warn) m = Math.max(m, segState.time / Math.max(p.warnTime, 1e-3));
        }
        return m;
      },
      dispose: () => bag.dispose(),
    };
  },
};
