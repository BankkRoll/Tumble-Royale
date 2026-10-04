/**
 * Sunbeam Zones — the scoring zones of a score-target hunt: round pools of
 * sunshine drifting over a plaza. Standing in one soaks up points; a crowded
 * beam shares its points between everyone inside, so shoving rivals out pays.
 *
 * Responsibilities:
 * - Motion (pure): each beam drifts on its own Lissajous path inside the
 *   authored area, so server, clients and bots agree on where every beam is.
 *   Beams flare (worth more) on a pure schedule when flares are enabled.
 * - Scaling: live beams grow with the round's entrants.
 * - Scoring (authoritative sims only): every step a beam hands out
 *   `rate × dt` points split between the players inside it; each whole point
 *   a player gathers becomes a `score` event (team -1).
 * - Bot hint: `botSafeSpot` names the beam best worth walking to (near, and
 *   not crowded), leading it slightly so bots meet it (`botObjective`).
 * - Replication: occupants per beam (the visual dims crowded beams).
 */
import { vec3, type Vec3 } from '@tumble/shared';
import { z } from 'zod';
import { RuntimeBase, actorLocal, toLocalPoint, toWorldPoint } from './helpers-a.ts';
import { hash3 } from './helpers-b.ts';
import type { ObstacleBuildContext, ObstacleInstance, ObstacleModule, ObstacleStepContext } from './types.ts';

/** Sunbeam Zones parameters. Metres, seconds. Origin = centre of the plaza floor. */
export const SunbeamZonesSchema = z.object({
  /** Beams built (the most that can ever be live). */
  beams: z.number().int().min(1).max(12).default(8),
  /** Live beams with no entrants; one more per `playersPerBeam` entrants. */
  base: z.number().int().min(1).default(1),
  playersPerBeam: z.number().positive().default(9),
  /** Beam radius on the floor (m). */
  radius: z.number().positive().default(2.6),
  /** Players count while their centre is this far above the floor at most (m). */
  height: z.number().positive().default(3),
  /** Half extents of the drift area (m); beam centres stay inside. */
  areaX: z.number().min(0).default(16),
  areaZ: z.number().min(0).default(16),
  /** Base angular rate of the drift (rad/s, × stage speed scale). */
  drift: z.number().min(0).default(0.16),
  /** Points per second each beam hands out, split between its occupants. */
  rate: z.number().positive().default(1),
  /** Seconds between a beam's flares (0 = never). */
  flareEvery: z.number().min(0).default(0),
  /** Seconds a flare lasts. */
  flareTime: z.number().positive().default(4),
  /** Rate multiplier while flaring. */
  flareMult: z.number().min(1).default(2),
});

/** Validated Sunbeam Zones parameters. */
export type SunbeamZonesParams = z.output<typeof SunbeamZonesSchema>;

/**
 * Live beams for a field size.
 *
 * @param p - Params.
 * @param entrants - Players starting the round (0 when unknown).
 * @returns Beams in play, between 1 and `p.beams`.
 */
export function sunbeamActiveCount(p: SunbeamZonesParams, entrants: number): number {
  return Math.max(1, Math.min(p.beams, p.base + Math.floor(Math.max(0, entrants) / p.playersPerBeam)));
}

/**
 * Centre of beam `i` at time `t` on the local floor (pure). Each beam has its
 * own frequencies and phases from a fixed hash of its index.
 */
export function sunbeamCentre(
  i: number,
  t: number,
  p: SunbeamZonesParams,
  speedScale: number,
  out: Vec3,
): Vec3 {
  const w = p.drift * speedScale;
  const fx = 0.7 + 0.6 * hash3(i, 11, 3);
  const fz = 0.7 + 0.6 * hash3(i, 13, 5);
  const px = hash3(i, 17, 7) * Math.PI * 2;
  const pz = hash3(i, 19, 9) * Math.PI * 2;
  out.x = p.areaX * Math.sin(w * fx * t + px);
  out.y = 0;
  out.z = p.areaZ * Math.sin(w * fz * t + pz);
  return out;
}

/** True while beam `i` flares at time `t` (pure). */
export function sunbeamFlaring(i: number, t: number, p: SunbeamZonesParams): boolean {
  if (p.flareEvery <= 0 || t < 0) return false;
  const offset = hash3(i, 23, 1) * p.flareEvery;
  const u = (((t + offset) % p.flareEvery) + p.flareEvery) % p.flareEvery;
  return u < p.flareTime;
}

/** What the visual reads from live beams. */
export interface SunbeamZonesView {
  readonly activeCount: number;
  /** Players standing in beam `i` at the last step. */
  occupants(i: number): number;
}

/** Live sunbeams. */
export class SunbeamZonesRuntime extends RuntimeBase implements SunbeamZonesView {
  readonly activeCount: number;
  readonly botObjective = true as const;
  private readonly occ: Int32Array;
  private readonly centres: Float64Array;
  private readonly soaked = new Map<number, number>();
  private readonly banked = new Map<number, number>();
  private readonly authoritative: boolean;
  private readonly local = vec3();
  private readonly c = vec3();
  /** Beam each actor stood in this step (-1 = none). */
  private inBeam = new Int32Array(0);

  constructor(
    instance: ObstacleInstance<SunbeamZonesParams>,
    ctx: ObstacleBuildContext,
    readonly params: SunbeamZonesParams,
  ) {
    super(instance, ctx);
    this.activeCount = sunbeamActiveCount(params, ctx.entrants ?? 0);
    this.occ = new Int32Array(params.beams);
    this.centres = new Float64Array(params.beams * 2);
    this.authoritative = ctx.authoritative ?? true;
  }

  occupants(i: number): number {
    return this.occ[i] ?? 0;
  }

  update(ctx: ObstacleStepContext): void {
    if (this.authoritative) this.soak(ctx);
    this.endStep(ctx);
  }

  private soak(ctx: ObstacleStepContext): void {
    const p = this.params;
    const n = this.activeCount;
    for (let b = 0; b < n; b++) {
      sunbeamCentre(b, ctx.t, p, this.build.speedScale, this.c);
      this.centres[b * 2] = this.c.x;
      this.centres[b * 2 + 1] = this.c.z;
      this.occ[b] = 0;
    }
    const actors = ctx.actors;
    if (this.inBeam.length < actors.length) this.inBeam = new Int32Array(actors.length);
    const r2 = p.radius * p.radius;
    for (let a = 0; a < actors.length; a++) {
      this.inBeam[a] = -1;
      const actor = actors[a]!;
      if (actor.isGhost) continue;
      const l = actorLocal(this.frame, actor, this.local);
      if (l.y < -0.5 || l.y > p.height) continue;
      let best = r2;
      for (let b = 0; b < n; b++) {
        const d = (l.x - this.centres[b * 2]!) ** 2 + (l.z - this.centres[b * 2 + 1]!) ** 2;
        if (d <= best) {
          best = d;
          this.inBeam[a] = b;
        }
      }
      const b = this.inBeam[a]!;
      if (b >= 0) this.occ[b] = this.occ[b]! + 1;
    }
    if (ctx.t < 0) return;
    for (let a = 0; a < actors.length; a++) {
      const b = this.inBeam[a]!;
      if (b < 0) continue;
      const id = actors[a]!.id;
      const mult = sunbeamFlaring(b, ctx.t, p) ? p.flareMult : 1;
      let soaked = (this.soaked.get(id) ?? 0) + (p.rate * mult * ctx.dt) / this.occ[b]!;
      if (soaked >= 1) {
        soaked -= 1;
        const total = (this.banked.get(id) ?? 0) + 1;
        this.banked.set(id, total);
        ctx.events.push({ type: 'score', team: -1, player: id, delta: 1, total });
      }
      this.soaked.set(id, soaked);
    }
    if (p.flareEvery > 0 && Number.isFinite(this.lastT)) {
      for (let b = 0; b < n; b++) {
        if (sunbeamFlaring(b, ctx.t, p) && !sunbeamFlaring(b, this.lastT, p))
          this.cue(ctx.events, 'flare', this.centres[b * 2]!, 0.2, this.centres[b * 2 + 1]!);
      }
    }
  }

  /**
   * The beam worth walking to: the one the bot already stands in, unless it is
   * crowded and an emptier one is close; otherwise near and uncrowded beams,
   * aimed half a second ahead along their drift.
   */
  botSafeSpot(t: number, out: Vec3): boolean {
    const p = this.params;
    const hint = toLocalPoint(this.frame, out, this.local);
    let best = Infinity;
    let pick = -1;
    for (let b = 0; b < this.activeCount; b++) {
      sunbeamCentre(b, t, p, this.build.speedScale, this.c);
      const d = Math.hypot(this.c.x - hint.x, this.c.z - hint.z);
      const inside = d <= p.radius;
      const crowd = Math.max(0, (this.occ[b] ?? 0) - (inside ? 1 : 0));
      const bonus = sunbeamFlaring(b, t, p) ? 4 : 0;
      const cost = d + crowd * 3.5 - bonus - (inside ? 2 : 0);
      if (cost < best) {
        best = cost;
        pick = b;
      }
    }
    if (pick < 0) return false;
    sunbeamCentre(pick, t + 0.5, p, this.build.speedScale, this.c);
    toWorldPoint(this.frame, this.c, out);
    return true;
  }

  /** `[occupants per beam]`. */
  getNetState(): number[] {
    return Array.from(this.occ);
  }

  setNetState(state: readonly number[]): void {
    for (let i = 0; i < this.occ.length; i++) this.occ[i] = state[i] ?? 0;
  }
}

/** Sunbeam Zones obstacle module. */
export const sunbeamZones: ObstacleModule<SunbeamZonesParams> = {
  type: 'sunbeamZones',
  displayName: 'Sunbeam Zones',
  schema: SunbeamZonesSchema,
  create: (instance, ctx) =>
    new SunbeamZonesRuntime(instance, ctx, SunbeamZonesSchema.parse(instance.params)),
  audioCues: ['flare'],
};
