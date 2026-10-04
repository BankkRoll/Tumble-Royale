/**
 * Comet Field — the pickups of a score-target hunt: glowing comets that land
 * on authored spots, sit there to be caught, then streak off to a new spot.
 *
 * Responsibilities:
 * - Schedule (pure): every comet slot hops on its own staggered clock. Within
 *   a hop it first flies to its next landing spot (the landing ring is the
 *   telegraph), then rests there catchable until the next hop. Spots come
 *   from a seeded hash of (slot, hop), so server and clients agree on every
 *   landing without sending positions.
 * - Scaling: the number of live comets grows with the round's entrants, so a
 *   duel has a handful to fight over and a full lobby has dozens.
 * - Catching (authoritative sims only): the first player to touch a resting
 *   comet catches it (`score` event, team -1) and it is gone until its next
 *   hop. Golden comets are worth more.
 * - Bot hint: `botSafeSpot` names the nearest comet that is resting or about
 *   to land (`botObjective`, so bots race for it).
 * - Replication: the hop each slot was last caught in.
 */
import { vec3, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import { RuntimeBase, actorLocal, toLocalPoint, toWorldPoint } from './helpers-a.ts';
import { hash3 } from './helpers-b.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext } from './types.ts';

const LocalPoint = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Comet Field parameters. Metres, seconds. Spots are local floor points (feet height). */
export const CometFieldSchema = z.object({
  /** Landing spots, local space, at the floor surface. */
  spots: z
    .array(LocalPoint)
    .min(2)
    .default(
      Array.from({ length: 8 }, (_, i) => ({
        x: Math.round(Math.cos((i / 8) * Math.PI * 2) * 600) / 100,
        y: 0,
        z: Math.round(Math.sin((i / 8) * Math.PI * 2) * 600) / 100,
      })),
    ),
  /** Comet slots built (the most that can ever be live). */
  slots: z.number().int().min(1).max(48).default(24),
  /** Live comets with no entrants; each entrant adds `perPlayer` more (rounded up). */
  base: z.number().int().min(1).default(3),
  perPlayer: z.number().min(0).default(0.3),
  /** Seconds between a comet's hops (÷ stage speed scale). */
  hop: z.number().positive().default(6),
  /** Seconds of each hop spent flying to the next spot (not catchable). */
  flight: z.number().positive().default(1.2),
  /** Horizontal catch radius around a resting comet (m). */
  catchRadius: z.number().positive().default(1.1),
  /** Vertical reach between a player's centre and the comet's hover point (m). */
  catchHeight: z.number().positive().default(1.4),
  /** Comet hover height above its spot (m, visual and catch centre). */
  hover: z.number().min(0).default(0.9),
  /** Arc height of a comet's flight (m, visual). */
  arc: z.number().min(0).default(6),
  /** The first `bonusSlots` live comets are golden and worth `bonusPoints`. */
  bonusSlots: z.number().int().min(0).default(0),
  bonusPoints: z.number().int().min(1).default(2),
});

/** Validated Comet Field parameters. */
export type CometFieldParams = z.output<typeof CometFieldSchema>;

/** Comet phase at a moment. */
export const CometPhase = { Inactive: 0, Flying: 1, Resting: 2, Caught: 3 } as const;

/** Golden-ratio stagger, so slots never hop in lockstep whatever their count. */
const STAGGER = 0.6180339887;
/** "Never caught". Small enough to travel as a netcode varint. */
const NO_HOP = -1_000_000;

/**
 * Live comets for a field size.
 *
 * @param p - Params.
 * @param entrants - Players starting the round (0 when unknown).
 * @returns Comets in play, between 1 and `p.slots`.
 */
export function cometActiveCount(p: CometFieldParams, entrants: number): number {
  return Math.max(1, Math.min(p.slots, p.base + Math.ceil(Math.max(0, entrants) * p.perPlayer)));
}

/** Seconds between hops at a speed scale. */
export const cometPeriod = (p: CometFieldParams, speedScale: number): number =>
  p.hop / Math.max(0.1, speedScale);

/**
 * Hop number of slot `i` at time `t` (pure). Hops are numbered from 0 at the
 * slot's first landing; times before the round have negative hops.
 */
export function cometHop(i: number, t: number, p: CometFieldParams, speedScale: number): number {
  const period = cometPeriod(p, speedScale);
  return Math.floor(t / period + ((i * STAGGER) % 1));
}

/** Seconds into slot `i`'s current hop. */
export function cometHopTime(i: number, t: number, p: CometFieldParams, speedScale: number): number {
  const period = cometPeriod(p, speedScale);
  const x = t / period + ((i * STAGGER) % 1);
  return (x - Math.floor(x)) * period;
}

/**
 * Spot index slot `i` lands on in hop `hop`. Even hops use even-numbered
 * spots and odd hops odd ones, so a comet never lands where it just was
 * without the schedule having to remember its previous spot.
 */
export function cometSpotIndex(i: number, hop: number, p: CometFieldParams, seed: number): number {
  const n = p.spots.length;
  const parity = ((hop % 2) + 2) % 2;
  const count = parity === 0 ? Math.ceil(n / 2) : Math.floor(n / 2);
  const k = Math.min(count - 1, Math.floor(hash3(seed, i * 7919 + 17, hop) * count));
  return k * 2 + parity;
}

/** Points a slot's catch is worth. */
export const cometPoints = (i: number, p: CometFieldParams): number => (i < p.bonusSlots ? p.bonusPoints : 1);

/** What the visual reads from a live field. */
export interface CometFieldView {
  readonly cometSeed: number;
  readonly activeCount: number;
  /** Hop in which slot `i` was last caught. */
  caughtHop(i: number): number;
}

/** Live comet field. */
export class CometFieldRuntime extends RuntimeBase implements CometFieldView {
  readonly cometSeed: number;
  readonly activeCount: number;
  readonly botObjective = true as const;
  private readonly caught: Int32Array;
  private readonly tally = new Map<number, number>();
  private readonly authoritative: boolean;
  private readonly local = vec3();
  private readonly spot = vec3();
  /** Actor centres in local space this step (x, y, z per actor). */
  private actorXYZ = new Float64Array(0);

  constructor(
    instance: ObstacleInstance<CometFieldParams>,
    ctx: ObstacleBuildContext,
    readonly params: CometFieldParams,
  ) {
    super(instance, ctx);
    this.cometSeed = ctx.rng.int(1, 0x7ffffffe);
    this.activeCount = cometActiveCount(params, ctx.entrants ?? 0);
    this.caught = new Int32Array(params.slots).fill(NO_HOP);
    this.authoritative = ctx.authoritative ?? true;
  }

  caughtHop(i: number): number {
    return this.caught[i] ?? NO_HOP;
  }

  /**
   * Phase of slot `i` at `t`, writing its landing spot (local, floor height)
   * into `out` when it is flying to it or resting on it.
   */
  phaseAt(i: number, t: number, out: Vec3): number {
    if (i >= this.activeCount) return CometPhase.Inactive;
    const p = this.params;
    const hop = cometHop(i, t, p, this.build.speedScale);
    const s = p.spots[cometSpotIndex(i, hop, p, this.cometSeed)]!;
    out.x = s.x;
    out.y = s.y;
    out.z = s.z;
    if (cometHopTime(i, t, p, this.build.speedScale) < p.flight) return CometPhase.Flying;
    return this.caught[i] === hop ? CometPhase.Caught : CometPhase.Resting;
  }

  update(ctx: ObstacleStepContext): void {
    if (this.authoritative && ctx.t >= 0) this.catchComets(ctx);
    this.endStep(ctx);
  }

  private catchComets(ctx: ObstacleStepContext): void {
    const p = this.params;
    const actors = ctx.actors;
    if (this.actorXYZ.length < actors.length * 3) this.actorXYZ = new Float64Array(actors.length * 3);
    const xyz = this.actorXYZ;
    for (let a = 0; a < actors.length; a++) {
      const l = actorLocal(this.frame, actors[a]!, this.local);
      xyz[a * 3] = l.x;
      xyz[a * 3 + 1] = l.y;
      xyz[a * 3 + 2] = l.z;
    }
    const r2 = p.catchRadius * p.catchRadius;
    for (let i = 0; i < this.activeCount; i++) {
      if (this.phaseAt(i, ctx.t, this.spot) !== CometPhase.Resting) continue;
      const hy = this.spot.y + p.hover;
      for (let a = 0; a < actors.length; a++) {
        const actor = actors[a]!;
        if (actor.isGhost) continue;
        const dx = xyz[a * 3]! - this.spot.x;
        const dz = xyz[a * 3 + 2]! - this.spot.z;
        if (dx * dx + dz * dz > r2 || Math.abs(xyz[a * 3 + 1]! - hy) > p.catchHeight) continue;
        this.caught[i] = cometHop(i, ctx.t, p, this.build.speedScale);
        const points = cometPoints(i, p);
        const total = (this.tally.get(actor.id) ?? 0) + points;
        this.tally.set(actor.id, total);
        ctx.events.push({ type: 'score', team: -1, player: actor.id, delta: points, total });
        this.cue(ctx.events, i < p.bonusSlots ? 'golden' : 'catch', this.spot.x, hy, this.spot.z);
        break;
      }
    }
  }

  /**
   * The nearest comet to the asking bot's hint that is resting, or will land
   * within a second (worth running toward while it streaks in).
   */
  botSafeSpot(t: number, out: Vec3): boolean {
    const p = this.params;
    const hint = toLocalPoint(this.frame, out, this.local);
    let best = Infinity;
    let bx = 0;
    let by = 0;
    let bz = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const phase = this.phaseAt(i, t, this.spot);
      if (phase === CometPhase.Caught || phase === CometPhase.Inactive) continue;
      if (phase === CometPhase.Flying && cometHopTime(i, t, p, this.build.speedScale) < p.flight - 1)
        continue;
      const d = (this.spot.x - hint.x) ** 2 + ((this.spot.y - hint.y) * 2) ** 2 + (this.spot.z - hint.z) ** 2;
      if (d < best) {
        best = d;
        bx = this.spot.x;
        by = this.spot.y;
        bz = this.spot.z;
      }
    }
    if (best === Infinity) return false;
    this.spot.x = bx;
    this.spot.y = by;
    this.spot.z = bz;
    toWorldPoint(this.frame, this.spot, out);
    return true;
  }

  /** `[caught hop per slot]`. */
  getNetState(): number[] {
    return Array.from(this.caught);
  }

  setNetState(state: readonly number[]): void {
    for (let i = 0; i < this.caught.length; i++) this.caught[i] = state[i] ?? NO_HOP;
  }
}

/** Comet Field obstacle module. */
export const cometField: ObstacleModule<CometFieldParams> = {
  type: 'cometField',
  displayName: 'Comet Field',
  schema: CometFieldSchema,
  create: (instance, ctx) => new CometFieldRuntime(instance, ctx, CometFieldSchema.parse(instance.params)),
  audioCues: ['catch', 'golden'],
};
