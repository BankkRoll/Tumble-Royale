/**
 * Minimal headless match loop for character tests: fixed ground, scripted
 * kinematic platforms whose pose is a pure function of time, and controllers
 * stepped in the canonical order (obstacles → step → world.step → postStep).
 */
import { InteractionGroups, SIM_DT, quatFromYaw, type Quat, type Vec3 } from '@tumble/shared';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import { createWorld } from '../src/physics/world.ts';
import type { Rapier } from '../src/physics/rapier.ts';
import { SurfaceRegistry, type SurfaceInfo } from '../src/physics/surfaces.ts';
import { EventSink } from '../src/events.ts';
import { TumblerController, emptyInput, type CharacterInput, type CharacterStepContext, type CharacterTuning } from '../src/character/index.ts';

/** Kinematic body driven by a pure pose function. */
export interface Mover {
  body: RigidBody;
  pose(t: number, pos: Vec3, rot: Quat): void;
}

export class Harness {
  readonly world: World;
  readonly surfaces = new SurfaceRegistry();
  readonly events = new EventSink();
  readonly controllers: TumblerController[] = [];
  readonly movers: Mover[] = [];
  readonly ctx: CharacterStepContext;
  readonly inputs: CharacterInput[] = [];
  readonly log: string[] = [];
  tick = 0;
  private readonly byCollider = new Map<number, TumblerController>();
  private readonly p = { x: 0, y: 0, z: 0 };
  private readonly q = { x: 0, y: 0, z: 0, w: 1 };

  private readonly surfaceList: [number, SurfaceInfo][] = [];

  constructor(
    readonly R: Rapier,
    world?: World,
  ) {
    this.world = world ?? createWorld(R);
    this.ctx = {
      R,
      world: this.world,
      dt: SIM_DT,
      tick: 0,
      time: 0,
      surfaces: this.surfaces,
      events: this.events,
      controllerByCollider: (h) => this.byCollider.get(h),
    };
  }

  get time(): number {
    return this.tick * SIM_DT;
  }

  setSurface(handle: number, info: SurfaceInfo): void {
    this.surfaces.set(handle, info);
    this.surfaceList.push([handle, info]);
  }

  /**
   * A fresh, identical world rebuilt from a Rapier snapshot (bodies, contacts,
   * broad phase), with NEW controller instances adopting the restored bodies.
   * Controller state is not copied: callers restore it with setState.
   */
  cloneFromSnapshot(): Harness {
    const w = this.R.World.restoreSnapshot(this.world.takeSnapshot());
    const h = new Harness(this.R, w);
    h.tick = this.tick;
    for (const [handle, info] of this.surfaceList) h.setSurface(handle, info);
    for (const m of this.movers) h.movers.push({ body: w.getRigidBody(m.body.handle), pose: m.pose });
    for (const c of this.controllers) {
      const nc = new TumblerController({
        R: this.R,
        world: w,
        id: c.id,
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        attach: { body: w.getRigidBody(c.body.handle), collider: w.getCollider(c.collider.handle) },
      });
      h.controllers.push(nc);
      h.inputs.push(emptyInput());
      h.byCollider.set(nc.collider.handle, nc);
    }
    return h;
  }

  /** Fixed box; `top` is the y of its upper face. */
  box(x: number, top: number, z: number, hx: number, hy: number, hz: number, info?: SurfaceInfo, rot?: Quat): number {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    const desc = this.R.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, top - hy, z)
      .setCollisionGroups(InteractionGroups.static);
    if (rot) desc.setRotation(rot);
    const c = this.world.createCollider(desc, body);
    if (info) this.setSurface(c.handle, info);
    return c.handle;
  }

  /** Large floor with its top at y = 0. */
  floor(info?: SurfaceInfo): number {
    return this.box(0, 0, 0, 60, 0.5, 60, info);
  }

  /** Inclined plane rising toward +Z, `deg` degrees, starting at z0 with its base at y=0. */
  ramp(deg: number, z0: number, length = 12, width = 3, x = 0): void {
    const a = (deg * Math.PI) / 180;
    const hy = 0.25;
    // Rotate about X so the plane climbs toward +Z.
    const q = { x: -Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
    const cz = z0 + (Math.cos(a) * length) / 2 + Math.sin(a) * hy;
    const cy = (Math.sin(a) * length) / 2 - Math.cos(a) * hy;
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(width / 2, hy, length / 2)
        .setTranslation(x, cy, cz)
        .setRotation(q)
        .setCollisionGroups(InteractionGroups.static),
      body,
    );
  }

  mover(hx: number, hy: number, hz: number, pose: Mover['pose'], info?: SurfaceInfo): Mover {
    pose(0, this.p, this.q);
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(this.p.x, this.p.y, this.p.z).setRotation(this.q),
    );
    const c = this.world.createCollider(
      this.R.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(InteractionGroups.kinematic),
      body,
    );
    if (info) this.setSurface(c.handle, info);
    const m = { body, pose };
    this.movers.push(m);
    return m;
  }

  cylinderMover(radius: number, halfHeight: number, pose: Mover['pose']): Mover {
    pose(0, this.p, this.q);
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(this.p.x, this.p.y, this.p.z).setRotation(this.q),
    );
    this.world.createCollider(
      this.R.ColliderDesc.cylinder(halfHeight, radius).setCollisionGroups(InteractionGroups.kinematic),
      body,
    );
    const m = { body, pose };
    this.movers.push(m);
    return m;
  }

  tumbler(feet: Vec3, yaw = 0, tuning?: Partial<CharacterTuning>): TumblerController {
    const c = new TumblerController({ R: this.R, world: this.world, id: this.controllers.length, position: feet, yaw, tuning });
    this.controllers.push(c);
    this.inputs.push(emptyInput());
    this.byCollider.set(c.collider.handle, c);
    return c;
  }

  /** Places every mover at its pose for the current tick (used after building a fresh world for replay). */
  syncMovers(): void {
    for (const m of this.movers) {
      m.pose(this.time, this.p, this.q);
      m.body.setTranslation(this.p, true);
      m.body.setRotation(this.q, true);
    }
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      const tNext = (this.tick + 1) * SIM_DT;
      for (const m of this.movers) {
        m.pose(tNext, this.p, this.q);
        m.body.setNextKinematicTranslation(this.p);
        m.body.setNextKinematicRotation(this.q);
      }
      this.ctx.tick = this.tick;
      this.ctx.time = this.time;
      for (let k = 0; k < this.controllers.length; k++) {
        this.controllers[k]!.step(this.inputs[k]!, this.ctx);
      }
      this.world.step();
      for (const c of this.controllers) c.postStep(this.ctx);
      for (const e of this.events.drain()) this.log.push(e.type);
      this.tick++;
    }
  }

  /** Runs until `pred` holds or `maxSteps` elapse; returns steps taken or -1. */
  until(pred: () => boolean, maxSteps = 600): number {
    for (let i = 0; i < maxSteps; i++) {
      if (pred()) return i;
      this.step();
    }
    return pred() ? maxSteps : -1;
  }

  dispose(): void {
    this.world.free();
  }
}

/** Constant-velocity pose: p(t) = p0 + v·t. */
export const linearPose =
  (p0: Vec3, v: Vec3) =>
  (t: number, pos: Vec3, rot: Quat): void => {
    pos.x = p0.x + v.x * t;
    pos.y = p0.y + v.y * t;
    pos.z = p0.z + v.z * t;
    rot.x = 0;
    rot.y = 0;
    rot.z = 0;
    rot.w = 1;
  };

/** Spinning about +Y at `omega` rad/s around `c`. */
export const spinPose =
  (c: Vec3, omega: number) =>
  (t: number, pos: Vec3, rot: Quat): void => {
    pos.x = c.x;
    pos.y = c.y;
    pos.z = c.z;
    quatFromYaw(omega * t, rot);
  };
