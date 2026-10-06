/**
 * Obstacle awareness for bots, built on live Rapier geometry plus each
 * obstacle module's pure `pose(t)`.
 *
 * Prediction trick: a rigid motion preserves distances, so the distance from
 * point P to a moving body at future time τ equals the distance from
 * `T_now · T_τ⁻¹ · P` to the body *as it is now*. We map P into the body's
 * current frame using the module's pose function and run an ordinary
 * point projection against the current colliders — exact for any collider
 * shape, with no knowledge of the module's internals.
 *
 * Pose samples are matched to bodies by comparing `frame ∘ pose(t)` with the
 * bodies' current transforms; bodies that cannot be matched (dynamic tilt
 * platforms, modules without `pose`) fall back to their current distance.
 *
 * What counts as obstacle geometry:
 * - Solid colliders on kinematic bodies (moving parts).
 * - Hazard sensors (membership in `CollisionGroup.Hazard`: lasers, goo
 *   surfaces): they never block, but touching them stuns or eliminates.
 * - Solid colliders on fixed bodies (door frames, hubs, posts), for
 *   present-time queries only: they never open, so in timing predictions they
 *   would only mask the moving parts.
 */
import type { Collider, Ray, RigidBody, World } from '@dimforge/rapier3d-compat';
import {
  CollisionGroup,
  InteractionGroups,
  groups,
  quatFromEulerYXZ,
  quatIdentity,
  quatMul,
  rotateVec,
  vec3,
  type Quat,
  type Vec3,
} from '@tumble/shared';
import type { ObstacleInstance, ObstacleRuntime, PoseSample } from '../obstacles/types.ts';
import type { Rapier } from '../physics/rapier.ts';
import type { AnyObstacleModule } from './deps.ts';

const DEG = Math.PI / 180;
const MATCH_POS_EPS = 0.05;
const MATCH_ROT_DOT = 0.999;
/** Vertical offsets weigh this much more than horizontal ones when ranking safe spots. */
const SAFE_SPOT_Y_WEIGHT = 2;

/** Optional runtime extension: obstacles that know where it is safe to stand. */
export interface BotSafeSpotProvider {
  /**
   * @param t - Match time.
   * @param out - On entry, the asking bot's hint point (its position nudged
   *   toward where it would like to go; location-aware providers read it).
   *   Receives the safe spot.
   * @returns True when a spot was written.
   */
  botSafeSpot(t: number, out: Vec3, key?: number): boolean;
  /** How hard the current question is to answer, 0–1 (logic floors). See `BotWorldView.logicDifficulty`. */
  botDifficulty?(t: number): number;
}

/**
 * Optional runtime extension: a safe-spot provider whose spot is the round's
 * objective (the nearest pickup, a scoring zone, a free seat) rather than mere
 * safe ground. Bots in such rounds race to it (see `BotBrainOptions.objective`).
 */
export interface BotObjectiveProvider extends BotSafeSpotProvider {
  readonly botObjective: true;
}

/**
 * @param r - A live obstacle runtime.
 * @returns True when it names the round's objective for bots.
 */
export function isBotObjective(r: ObstacleRuntime): r is ObstacleRuntime & BotObjectiveProvider {
  return hasSafeSpot(r) && (r as Partial<BotObjectiveProvider>).botObjective === true;
}

function hasSafeSpot(r: ObstacleRuntime): r is ObstacleRuntime & BotSafeSpotProvider {
  return typeof (r as Partial<BotSafeSpotProvider>).botSafeSpot === 'function';
}

/** @returns True for sensors that stun or eliminate on touch (lasers, goo). */
function isHazardSensor(c: Collider): boolean {
  return c.isSensor() && ((c.collisionGroups() >>> 16) & CollisionGroup.Hazard) !== 0;
}

/** Colliders bots treat as obstacle geometry: anything solid, plus hazard sensors. */
const isBotRelevant = (c: Collider): boolean => !c.isSensor() || isHazardSensor(c);

interface TrackedBody {
  body: RigidBody;
  /** Fixed parts never move, so timing predictions (`ahead > 0`) skip them. */
  fixed: boolean;
  /** Pose sample index driving this body, -1 if unmatched, -2 if not yet attempted. */
  sample: number;
}

interface TrackedObstacle {
  id: string;
  runtime: ObstacleRuntime;
  module: AnyObstacleModule;
  params: unknown;
  speedScale: number;
  framePos: Vec3;
  frameRot: Quat;
  bodies: TrackedBody[];
  samples: PoseSample[];
  /** Whether any body was matched to a pose sample. */
  matched: boolean;
  matchAttempts: number;
  lastMatchTime: number;
}

/** Predicts obstacle clearance for bots. One per match sim. */
export class ObstacleOracle {
  private readonly tracked: TrackedObstacle[] = [];
  private readonly byId = new Map<string, TrackedObstacle>();
  private readonly byBodyHandle = new Map<number, TrackedObstacle>();
  private readonly props: RigidBody[] = [];
  private readonly ray: Ray;
  private predicateBody = -1;
  private readonly onlyBody = (c: Collider): boolean =>
    c.parent()?.handle === this.predicateBody && isBotRelevant(c);
  private readonly hazardGroups = groups(0xffff, CollisionGroup.KinematicObstacle | CollisionGroup.Hazard);
  /** Match time the bodies' current transforms correspond to. */
  poseTime = 0;

  // Scratch, reused by every query.
  private readonly p = vec3();
  private readonly q = vec3();
  private readonly hint = vec3();
  private readonly cand = vec3();
  private readonly bodyPos = vec3();
  private readonly bodyRot = quatIdentity();
  private readonly futPos = vec3();
  private readonly futRot = quatIdentity();
  private readonly invRot = quatIdentity();
  private readonly curPos = vec3();
  private readonly curRot = quatIdentity();

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
  ) {
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  /** Registers a built obstacle. */
  add(
    instance: ObstacleInstance,
    runtime: ObstacleRuntime,
    module: AnyObstacleModule,
    params: unknown,
    speedScale: number,
  ): void {
    const r = instance.rotation;
    const entry: TrackedObstacle = {
      id: instance.id,
      runtime,
      module,
      params,
      speedScale,
      framePos: { ...instance.position },
      frameRot: quatFromEulerYXZ((r?.yaw ?? 0) * DEG, (r?.pitch ?? 0) * DEG, (r?.roll ?? 0) * DEG),
      bodies: [],
      samples: [],
      matched: false,
      matchAttempts: 0,
      lastMatchTime: -Infinity,
    };
    this.tracked.push(entry);
    this.byId.set(instance.id, entry);
    this.refreshBodies(entry);
  }

  /** Re-scans runtimes for bodies and props (obstacles may spawn props after build). */
  refresh(): void {
    this.props.length = 0;
    for (const t of this.tracked) this.refreshBodies(t);
  }

  private refreshBodies(t: TrackedObstacle): void {
    const seen = new Set(t.bodies.map((b) => b.body.handle));
    for (const c of t.runtime.colliders) {
      const b = c.parent();
      if (!b) continue;
      if (b.isDynamic()) {
        if (!c.isSensor() && !this.props.includes(b)) this.props.push(b);
        continue;
      }
      if (!isBotRelevant(c) || seen.has(b.handle)) continue;
      const fixed = !b.isKinematic();
      // Static hazard volumes (void triggers) sit under whole courses; as geometry they would drown everything else.
      if (fixed && c.isSensor()) continue;
      seen.add(b.handle);
      t.bodies.push({ body: b, fixed, sample: fixed ? -1 : -2 });
      if (!fixed) this.byBodyHandle.set(b.handle, t);
    }
  }

  /**
   * See `BotWorldView.obstacleClearance`. Present-time queries (`ahead <= 0`)
   * include the obstacle's fixed parts; predictions cover moving parts only.
   */
  obstacleClearance(obstacleId: string, point: Vec3, ahead: number): number {
    const t = this.byId.get(obstacleId);
    if (!t) return Infinity;
    let best = Infinity;
    for (const b of t.bodies) {
      if (b.fixed && ahead > 0) continue;
      const d = this.bodyDistance(t, b, point, ahead);
      if (d < best) best = d;
    }
    return best;
  }

  /** See `BotWorldView.hazardDistance`. Covers hazard sensors (lasers) as well as moving solids. */
  hazardDistance(point: Vec3, maxDist: number, ahead: number, outClosest?: Vec3): number {
    const hit = this.world.projectPoint(
      point,
      true,
      this.R.QueryFilterFlags.EXCLUDE_FIXED,
      this.hazardGroups,
      undefined,
      undefined,
      isBotRelevant,
    );
    if (!hit) return Infinity;
    const now = Math.hypot(hit.point.x - point.x, hit.point.y - point.y, hit.point.z - point.z);
    if (now > maxDist) return Infinity;
    if (outClosest) {
      outClosest.x = hit.point.x;
      outClosest.y = hit.point.y;
      outClosest.z = hit.point.z;
    }
    if (ahead <= 0) return now;
    const body = hit.collider.parent();
    const t = body ? this.byBodyHandle.get(body.handle) : undefined;
    if (!t || !body) return now;
    let best = now;
    for (const b of t.bodies) {
      if (b.fixed) continue;
      const d = this.bodyDistance(t, b, point, ahead);
      if (d < best) best = d;
    }
    return best;
  }

  /** See `BotWorldView.groundBelow`. */
  groundBelow(point: Vec3, depth: number): boolean {
    this.ray.origin.x = point.x;
    this.ray.origin.y = point.y;
    this.ray.origin.z = point.z;
    const hit = this.world.castRay(
      this.ray,
      depth,
      true,
      this.R.QueryFilterFlags.EXCLUDE_SENSORS,
      InteractionGroups.groundQuery,
    );
    return hit !== null;
  }

  /**
   * See `BotWorldView.safeSpot`. `out` carries the bot's hint in; when several
   * obstacles offer a spot (tile fields split into rows), the one nearest the
   * hint wins.
   */
  safeSpot(time: number, out: Vec3, key?: number): boolean {
    const hint = this.hint;
    hint.x = out.x;
    hint.y = out.y;
    hint.z = out.z;
    const hinted = Number.isFinite(hint.x) && Number.isFinite(hint.y) && Number.isFinite(hint.z);
    const c = this.cand;
    let best = Infinity;
    for (const t of this.tracked) {
      if (!hasSafeSpot(t.runtime)) continue;
      c.x = hint.x;
      c.y = hint.y;
      c.z = hint.z;
      if (!t.runtime.botSafeSpot(time, c, key)) continue;
      const d = hinted
        ? (c.x - hint.x) ** 2 + ((c.y - hint.y) * SAFE_SPOT_Y_WEIGHT) ** 2 + (c.z - hint.z) ** 2
        : 0;
      if (d < best) {
        best = d;
        out.x = c.x;
        out.y = c.y;
        out.z = c.z;
        if (!hinted) break;
      }
    }
    return best < Infinity;
  }

  /** See `BotWorldView.logicDifficulty`: the hardest rating any provider gives, or 1 when none rates. */
  logicDifficulty(time: number): number {
    let d = -1;
    for (const t of this.tracked) {
      if (hasSafeSpot(t.runtime) && t.runtime.botDifficulty) d = Math.max(d, t.runtime.botDifficulty(time));
    }
    return d < 0 ? 1 : Math.min(1, d);
  }

  /** Number of loose props. */
  propCount(): number {
    return this.props.length;
  }

  /** Writes prop `index`'s position. */
  propPosition(index: number, out: Vec3): void {
    const b = this.props[index];
    if (!b) return;
    const p = b.translation(this.curPos);
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
  }

  /**
   * Distance from `point` to one body at `poseTime + ahead`, via the pose
   * transfer described in the module docs.
   */
  private bodyDistance(t: TrackedObstacle, b: TrackedBody, point: Vec3, ahead: number): number {
    const P = this.p;
    P.x = point.x;
    P.y = point.y;
    P.z = point.z;
    if (ahead > 0 && !b.fixed && t.module.pose) {
      // Matching can fail before the first step positions the bodies, so retry a few times.
      if (!t.matched && t.matchAttempts < 4 && this.poseTime - t.lastMatchTime > 0.25) this.matchSamples(t);
      if (b.sample >= 0) {
        t.module.pose(this.poseTime + ahead, t.params, t.samples, t.speedScale);
        const s = t.samples[b.sample];
        if (s) {
          rotateVec(t.frameRot, s.pos, this.futPos);
          this.futPos.x += t.framePos.x;
          this.futPos.y += t.framePos.y;
          this.futPos.z += t.framePos.z;
          quatMul(t.frameRot, s.rot, this.futRot);
          const bp = b.body.translation(this.curPos);
          const br = b.body.rotation(this.curRot);
          // P' = T_now · T_fut⁻¹ · P
          this.invRot.x = -this.futRot.x;
          this.invRot.y = -this.futRot.y;
          this.invRot.z = -this.futRot.z;
          this.invRot.w = this.futRot.w;
          this.q.x = P.x - this.futPos.x;
          this.q.y = P.y - this.futPos.y;
          this.q.z = P.z - this.futPos.z;
          rotateVec(this.invRot, this.q, this.q);
          this.bodyRot.x = br.x;
          this.bodyRot.y = br.y;
          this.bodyRot.z = br.z;
          this.bodyRot.w = br.w;
          rotateVec(this.bodyRot, this.q, P);
          P.x += bp.x;
          P.y += bp.y;
          P.z += bp.z;
        }
      }
    }
    this.predicateBody = b.body.handle;
    const hit = this.world.projectPoint(P, true, undefined, undefined, undefined, undefined, this.onlyBody);
    if (!hit) return Infinity;
    return Math.hypot(hit.point.x - P.x, hit.point.y - P.y, hit.point.z - P.z);
  }

  private matchSamples(t: TrackedObstacle): void {
    const pose = t.module.pose;
    if (!pose) {
      for (const b of t.bodies) b.sample = -1;
      return;
    }
    if (t.samples.length === 0)
      for (let i = 0; i < 8; i++) t.samples.push({ pos: vec3(), rot: quatIdentity() });
    t.matchAttempts++;
    t.lastMatchTime = this.poseTime;
    pose(this.poseTime, t.params, t.samples, t.speedScale);
    const claimed = new Set<number>();
    for (const b of t.bodies) {
      if (b.fixed) continue;
      b.sample = -1;
      const bp = b.body.translation(this.curPos);
      const br = b.body.rotation(this.curRot);
      for (let j = 0; j < t.samples.length; j++) {
        if (claimed.has(j)) continue;
        const s = t.samples[j] as PoseSample;
        rotateVec(t.frameRot, s.pos, this.bodyPos);
        const dx = this.bodyPos.x + t.framePos.x - bp.x;
        const dy = this.bodyPos.y + t.framePos.y - bp.y;
        const dz = this.bodyPos.z + t.framePos.z - bp.z;
        if (dx * dx + dy * dy + dz * dz > MATCH_POS_EPS * MATCH_POS_EPS) continue;
        quatMul(t.frameRot, s.rot, this.bodyRot);
        const dot = Math.abs(
          this.bodyRot.x * br.x + this.bodyRot.y * br.y + this.bodyRot.z * br.z + this.bodyRot.w * br.w,
        );
        if (dot < MATCH_ROT_DOT) continue;
        b.sample = j;
        t.matched = true;
        claimed.add(j);
        break;
      }
    }
  }
}
