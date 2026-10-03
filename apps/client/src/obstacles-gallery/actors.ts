/**
 * Demo "players" for the gallery: dynamic balls that implement the
 * ObstacleActor contract, plus a contact/trigger router that feeds obstacle
 * runtimes the same onContact/onTrigger calls the match sim makes. Balls also
 * fake the bits the real character controller would do (ride conveyors,
 * respawn after touching lethal surfaces).
 */
import type { Collider, RigidBody, World } from '@tumble/sim';
import type { ObstacleActor, ObstacleRuntime, ObstacleStepContext, Rapier, SurfaceRegistry } from '@tumble/sim';
import { InteractionGroups, type Vec3 } from '@tumble/shared';

/** Radius of a demo ball (roughly a Tumbler's capsule radius). */
export const BALL_RADIUS = 0.45;

/** A demo ball standing in for a player. */
export class BallActor implements ObstacleActor {
  readonly body: RigidBody;
  readonly collider: Collider;
  isGhost = false;
  /** Seconds since the last (re)spawn. */
  age = 0;
  /** Set when the ball touched something lethal; the gallery respawns it. */
  doomed = false;
  private readonly tmp = { x: 0, y: 0, z: 0 };

  constructor(
    R: Rapier,
    world: World,
    readonly id: number,
  ) {
    this.body = world.createRigidBody(R.RigidBodyDesc.dynamic().setCanSleep(false).setLinearDamping(0.15).setAngularDamping(0.6));
    this.collider = world.createCollider(
      R.ColliderDesc.ball(BALL_RADIUS).setRestitution(0.3).setFriction(0.8).setCollisionGroups(InteractionGroups.player),
      this.body,
    );
  }

  knock(impulse: Vec3): void {
    this.body.applyImpulse(impulse, true);
  }

  push(dv: Vec3): void {
    const v = this.body.linvel();
    this.tmp.x = v.x + dv.x;
    this.tmp.y = v.y + dv.y;
    this.tmp.z = v.z + dv.z;
    this.body.setLinvel(this.tmp, true);
  }

  teleport(pos: Vec3): void {
    this.body.setTranslation(pos, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Respawns at `pos` with an initial velocity. */
  spawn(pos: Vec3, vel: Vec3, spin: Vec3): void {
    this.body.setTranslation(pos, true);
    this.body.setLinvel(vel, true);
    this.body.setAngvel(spin, true);
    this.age = 0;
    this.doomed = false;
  }
}

/**
 * Routes narrow-phase contacts and sensor overlaps between one runtime's
 * colliders and the gallery balls. Callbacks are created once so stepping
 * doesn't allocate closures.
 *
 * Only balls in the runtime's own step actors are routed: each exhibit stays
 * self-contained, so one obstacle with a world-sized volume (e.g. a void
 * trigger) can't doom every ball on the island.
 */
export class ContactRouter {
  private readonly ballByCollider = new Map<number, BallActor>();
  private readonly ballById = new Map<number, BallActor>();
  private readonly dv = { x: 0, y: 0, z: 0 };
  /** key = colliderHandle * 4096 + ballId → last tick seen overlapping. */
  private readonly overlaps = new Map<number, number>();
  private rt: ObstacleRuntime | null = null;
  private col: Collider | null = null;
  private step: ObstacleStepContext | null = null;
  private touching = false;

  constructor(
    private readonly world: World,
    private readonly surfaces: SurfaceRegistry,
  ) {}

  /** Registers a ball so contacts with it are routed. */
  addBall(ball: BallActor): void {
    this.ballByCollider.set(ball.collider.handle, ball);
    this.ballById.set(ball.id, ball);
  }

  private readonly onManifold = (m: { numContacts(): number }): void => {
    if (m.numContacts() > 0) this.touching = true;
  };

  private readonly onContactPair = (other: Collider): void => {
    const ball = this.ballByCollider.get(other.handle);
    if (!ball || !this.col || !this.rt || !this.step || !this.step.actors.includes(ball)) return;
    this.touching = false;
    this.world.contactPair(this.col, other, this.onManifold);
    if (!this.touching) return;
    this.applySurface(ball, this.col);
    this.rt.onContact?.(ball, this.col, this.step);
  };

  private readonly onIntersection = (other: Collider): void => {
    const ball = this.ballByCollider.get(other.handle);
    if (!ball || !this.col || !this.rt || !this.step || !this.step.actors.includes(ball)) return;
    const key = this.col.handle * 4096 + ball.id;
    const prev = this.overlaps.get(key);
    this.overlaps.set(key, this.step.tick);
    this.applySurface(ball, this.col);
    if (prev === undefined) this.rt.onTrigger?.(ball, this.col, true, this.step);
  };

  /** Mimics the character controller's reaction to surface info. */
  private applySurface(ball: BallActor, col: Collider): void {
    const info = this.surfaces.get(col.handle);
    if (!info) return;
    if (info.lethal) ball.doomed = true;
    if (info.conveyorVelocity) {
      const v = ball.body.linvel();
      const cv = info.conveyorVelocity;
      this.dv.x = (cv.x - v.x) * 0.15;
      this.dv.z = (cv.z - v.z) * 0.15;
      ball.push(this.dv);
    }
  }

  /** Routes one runtime's pairs for the step that just ran. */
  route(rt: ObstacleRuntime, step: ObstacleStepContext): void {
    this.rt = rt;
    this.step = step;
    for (const c of rt.colliders) {
      if (!this.world.colliders.contains(c.handle) || !c.isEnabled()) continue;
      this.col = c;
      if (c.isSensor()) this.world.intersectionPairsWith(c, this.onIntersection);
      else this.world.contactPairsWith(c, this.onContactPair);
    }
    this.col = null;
  }

  /** Emits trigger exits for overlaps not refreshed this tick. Call once per step after all routes. */
  flushExits(tick: number, runtimeByCollider: Map<number, ObstacleRuntime>, step: ObstacleStepContext): void {
    for (const [key, seen] of this.overlaps) {
      if (seen === tick) continue;
      this.overlaps.delete(key);
      const handle = Math.floor(key / 4096);
      const rt = runtimeByCollider.get(handle);
      const col = this.world.colliders.get(handle);
      const ball = this.ballById.get(key % 4096);
      if (rt && col && ball) rt.onTrigger?.(ball, col, false, step);
    }
  }
}
