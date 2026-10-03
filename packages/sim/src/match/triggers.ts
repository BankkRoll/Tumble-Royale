import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { InteractionGroups, quatFromEulerYXZ, rotateVec, type Quat, type RoundDefinition, type TriggerDef, type Vec3 } from '@tumble/shared';
import type { Rapier } from '../physics/rapier.ts';

const DEG = Math.PI / 180;

/** Round trigger volumes (checkpoints, finish, voids, zones, goals, nests, crown) as sensors. */
export class RoundTriggers {
  readonly body: RigidBody;
  readonly defs: readonly TriggerDef[];
  readonly colliders: Collider[] = [];
  /** Collider handle → index into {@link defs}. */
  private readonly byHandle = new Map<number, number>();
  /** Inverse rotation per trigger, for local-space tests. */
  private readonly invRot: Quat[] = [];

  constructor(R: Rapier, world: World, round: RoundDefinition) {
    this.defs = round.triggers;
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed());
    for (let i = 0; i < round.triggers.length; i++) {
      const t = round.triggers[i] as TriggerDef;
      const q = quatFromEulerYXZ(
        (t.rotation?.yaw ?? 0) * DEG,
        (t.rotation?.pitch ?? 0) * DEG,
        (t.rotation?.roll ?? 0) * DEG,
      );
      this.invRot.push({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
      const desc = R.ColliderDesc.cuboid(
        Math.max(t.size.x / 2, 0.05),
        Math.max(t.size.y / 2, 0.05),
        Math.max(t.size.z / 2, 0.05),
      )
        .setTranslation(t.position.x, t.position.y, t.position.z)
        .setRotation(q)
        .setSensor(true)
        .setCollisionGroups(InteractionGroups.trigger)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT | R.ActiveCollisionTypes.KINEMATIC_FIXED);
      const c = world.createCollider(desc, this.body);
      this.colliders.push(c);
      this.byHandle.set(c.handle, i);
    }
  }

  /** @returns The trigger index owning `handle`, or -1. */
  indexOf(handle: number): number {
    return this.byHandle.get(handle) ?? -1;
  }

  /**
   * Fraction [0, 1) of the step at which the segment `from → to` first enters
   * trigger `index` (slab test in the trigger's local frame). Used to order
   * finishes that land on the same tick.
   */
  entryFraction(index: number, from: Vec3, to: Vec3): number {
    const t = this.defs[index];
    const q = this.invRot[index];
    if (!t || !q) return 0;
    const a = localPoint(q, from, t.position, sa);
    const b = localPoint(q, to, t.position, sb);
    let tmin = 0;
    let tmax = 1;
    const axes: [number, number, number][] = [
      [a.x, b.x, t.size.x / 2],
      [a.y, b.y, t.size.y / 2],
      [a.z, b.z, t.size.z / 2],
    ];
    for (let k = 0; k < 3; k++) {
      const ax = axes[k] as [number, number, number];
      const d = ax[1] - ax[0];
      const h = ax[2];
      if (Math.abs(d) < 1e-9) {
        if (ax[0] < -h || ax[0] > h) return 0.999;
        continue;
      }
      let t0 = (-h - ax[0]) / d;
      let t1 = (h - ax[0]) / d;
      if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
      }
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
    }
    if (tmin > tmax) return 0.999;
    return Math.min(Math.max(tmin, 0), 0.999);
  }

  /** @returns True if `p` lies inside trigger `index`. */
  contains(index: number, p: Vec3): boolean {
    const t = this.defs[index];
    const q = this.invRot[index];
    if (!t || !q) return false;
    const l = localPoint(q, p, t.position, sa);
    return Math.abs(l.x) <= t.size.x / 2 && Math.abs(l.y) <= t.size.y / 2 && Math.abs(l.z) <= t.size.z / 2;
  }
}

const sa: Vec3 = { x: 0, y: 0, z: 0 };
const sb: Vec3 = { x: 0, y: 0, z: 0 };

function localPoint(inv: Quat, p: Vec3, origin: Vec3, out: Vec3): Vec3 {
  out.x = p.x - origin.x;
  out.y = p.y - origin.y;
  out.z = p.z - origin.z;
  return rotateVec(inv, out, out);
}
