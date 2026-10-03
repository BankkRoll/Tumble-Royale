/**
 * Client-only cosmetic ragdolls.
 *
 * Responsibilities:
 * - {@link RagdollWorld}: a private Rapier world (never the sim world) with the
 *   static/kinematic geometry ragdolls may bump into.
 * - {@link TumblerRagdoll}: rigid bodies per limb placed exactly at the bone
 *   transforms, spherical joints (with a soft pose spring) at shoulders, hips,
 *   waist and neck, limited revolute joints at elbows and knees. The pelvis is
 *   pulled towards the authoritative capsule with spring impulses.
 * - {@link RagdollManager}: caps simultaneous ragdolls (default 8) to the
 *   requesters nearest the camera; the rest keep the canned tumble animation.
 */
import { Matrix4, Quaternion, Vector3, type Bone as ThreeBone } from 'three/webgpu';
import { InteractionGroups } from '@tumble/shared';
import type { Rapier, RigidBody, World } from '@tumble/sim';
import { Bone, BONE_PARENT, CORE_BONE_COUNT, RIG } from './rig.ts';

type ImpulseJoint = InstanceType<Rapier['ImpulseJoint']>;

const STEP = 1 / 60;

/** A private physics world for cosmetic ragdolls. */
export class RagdollWorld {
  readonly world: World;
  private acc = 0;

  /**
   * @param R - Initialised Rapier namespace (`await loadRapier()`).
   * @param gravityY - Gravity; slightly lighter than gameplay so flops read longer.
   */
  constructor(
    readonly R: Rapier,
    gravityY = -18,
  ) {
    this.world = new R.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = STEP;
  }

  /** Adds a static ground slab with its top at `y`. */
  addGround(y = 0, halfExtent = 200): void {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(0, y - 0.5, 0));
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(halfExtent, 0.5, halfExtent).setFriction(0.9).setCollisionGroups(InteractionGroups.static),
      body,
    );
  }

  /** Adds a static box (level geometry the ragdolls should land on). */
  addBox(center: Vector3, halfExtents: Vector3, rotation?: Quaternion): void {
    const desc = this.R.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z);
    if (rotation) desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    const body = this.world.createRigidBody(desc);
    this.world.createCollider(
      this.R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setFriction(0.9).setCollisionGroups(InteractionGroups.static),
      body,
    );
  }

  /**
   * Steps at a fixed 60 Hz.
   *
   * @param dt - Frame delta (s).
   * @param beforeStep - Called before each fixed step (pins, pose springs).
   */
  step(dt: number, beforeStep: () => void): void {
    this.acc = Math.min(this.acc + dt, STEP * 3);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      beforeStep();
      this.world.step();
    }
  }

  dispose(): void {
    this.world.free();
  }
}

interface PartDef {
  bone: number;
  /** Parent part index, -1 for the pelvis. */
  parent: number;
  shape: 'ball' | 'capsule';
  radius: number;
  halfHeight: number;
  /** Collider centre in bone-local space. */
  center: [number, number, number];
  /** Capsule axis in bone-local space. */
  axis: [number, number, number];
  joint: 'spherical' | 'revolute' | 'none';
  limits?: [number, number];
}

const ad = RIG.armDir;
const midArm = (len: number): [number, number, number] => [ad.x * len * 0.5, ad.y * len * 0.5, 0];
const midArmR = (len: number): [number, number, number] => [-ad.x * len * 0.5, ad.y * len * 0.5, 0];

/** Ragdoll parts. Hands, feet and the spine follow their parents' animated locals. */
const PARTS: PartDef[] = [
  { bone: Bone.hips, parent: -1, shape: 'ball', radius: 0.47, halfHeight: 0, center: [0, 0.0, 0], axis: [0, 1, 0], joint: 'none' },
  { bone: Bone.chest, parent: 0, shape: 'capsule', radius: 0.42, halfHeight: 0.06, center: [0, 0.0, 0], axis: [0, 1, 0], joint: 'spherical' },
  { bone: Bone.head, parent: 1, shape: 'ball', radius: 0.34, halfHeight: 0, center: [0, 0.12, 0], axis: [0, 1, 0], joint: 'spherical' },
  { bone: Bone.upperArmL, parent: 1, shape: 'capsule', radius: 0.08, halfHeight: 0.05, center: midArm(RIG.upperArm), axis: [ad.x, ad.y, 0], joint: 'spherical' },
  { bone: Bone.lowerArmL, parent: 3, shape: 'capsule', radius: 0.1, halfHeight: 0.07, center: midArm(RIG.lowerArm + 0.12), axis: [ad.x, ad.y, 0], joint: 'revolute', limits: [-2.3, 0.15] },
  { bone: Bone.upperArmR, parent: 1, shape: 'capsule', radius: 0.08, halfHeight: 0.05, center: midArmR(RIG.upperArm), axis: [-ad.x, ad.y, 0], joint: 'spherical' },
  { bone: Bone.lowerArmR, parent: 5, shape: 'capsule', radius: 0.1, halfHeight: 0.07, center: midArmR(RIG.lowerArm + 0.12), axis: [-ad.x, ad.y, 0], joint: 'revolute', limits: [-2.3, 0.15] },
  { bone: Bone.upperLegL, parent: 0, shape: 'capsule', radius: 0.075, halfHeight: 0.04, center: [0, -0.085, 0], axis: [0, 1, 0], joint: 'spherical' },
  { bone: Bone.lowerLegL, parent: 7, shape: 'ball', radius: 0.11, halfHeight: 0, center: [0, -0.12, 0.03], axis: [0, 1, 0], joint: 'revolute', limits: [-0.15, 2.3] },
  { bone: Bone.upperLegR, parent: 0, shape: 'capsule', radius: 0.075, halfHeight: 0.04, center: [0, -0.085, 0], axis: [0, 1, 0], joint: 'spherical' },
  { bone: Bone.lowerLegR, parent: 9, shape: 'ball', radius: 0.11, halfHeight: 0, center: [0, -0.12, 0.03], axis: [0, 1, 0], joint: 'revolute', limits: [-0.15, 2.3] },
];

const PART_OF_BONE = new Int8Array(CORE_BONE_COUNT).fill(-1);
PARTS.forEach((p, i) => (PART_OF_BONE[p.bone] = i));

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpS = new Vector3();
const UP = new Vector3(0, 1, 0);
/** Reused impulse vector; Rapier copies it on every call. */
const imp = { x: 0, y: 0, z: 0 };
const byDistance = (a: { dist: number }, b: { dist: number }): number => a.dist - b.dist;

/** One Tumbler's ragdoll bodies. */
export class TumblerRagdoll {
  private readonly bodies: RigidBody[] = [];
  private readonly joints: ImpulseJoint[] = [];
  private readonly world: RagdollWorld;
  private readonly worlds: Matrix4[] = Array.from({ length: CORE_BONE_COUNT }, () => new Matrix4());
  private readonly local = new Matrix4();
  private readonly inv = new Matrix4();

  /**
   * Builds bodies at the bones' current world transforms.
   *
   * @param world - Ragdoll world.
   * @param bones - Rig bones with up-to-date world matrices.
   * @param velocity - Initial linear velocity (carries the hit's momentum).
   */
  constructor(world: RagdollWorld, bones: readonly ThreeBone[], velocity: Vector3) {
    this.world = world;
    const R = world.R;
    const w = world.world;
    for (const part of PARTS) {
      const bone = bones[part.bone]!;
      bone.matrixWorld.decompose(tmpV, tmpQ, tmpS);
      const body = w.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(tmpV.x, tmpV.y, tmpV.z)
          .setRotation({ x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w })
          .setLinvel(velocity.x, velocity.y, velocity.z)
          .setLinearDamping(0.25)
          .setAngularDamping(1.6),
      );
      const desc = part.shape === 'ball' ? R.ColliderDesc.ball(part.radius) : R.ColliderDesc.capsule(part.halfHeight, part.radius);
      tmpQ2.setFromUnitVectors(UP, tmpV2.set(...part.axis).normalize());
      desc
        .setTranslation(...part.center)
        .setRotation({ x: tmpQ2.x, y: tmpQ2.y, z: tmpQ2.z, w: tmpQ2.w })
        .setDensity(part.parent < 0 ? 1.2 : 0.8)
        .setFriction(0.8)
        .setRestitution(0.25)
        .setCollisionGroups(InteractionGroups.ragdoll);
      w.createCollider(desc, body);
      this.bodies.push(body);
    }
    PARTS.forEach((part, i) => {
      if (part.parent < 0 || part.joint === 'none') return;
      const parent = this.bodies[part.parent]!;
      const child = this.bodies[i]!;
      // Anchor at the child bone origin, expressed in the parent body's frame.
      const pt = child.translation();
      const pp = parent.translation();
      const pr = parent.rotation();
      tmpQ.set(pr.x, pr.y, pr.z, pr.w).invert();
      tmpV.set(pt.x - pp.x, pt.y - pp.y, pt.z - pp.z).applyQuaternion(tmpQ);
      const a1 = { x: tmpV.x, y: tmpV.y, z: tmpV.z };
      const a2 = { x: 0, y: 0, z: 0 };
      const data = part.joint === 'revolute' ? R.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 }) : R.JointData.spherical(a1, a2);
      if (part.limits) {
        data.limitsEnabled = true;
        data.limits = part.limits;
      }
      this.joints.push(w.createImpulseJoint(data, parent, child, true));
    });
  }

  /**
   * Pre-step forces: pelvis spring towards the anchor, soft pose springs on
   * spherical joints so limbs flop instead of spinning freely.
   *
   * @param anchor - World-space target for the pelvis (capsule centre).
   */
  prestep(anchor: Vector3): void {
    const pelvis = this.bodies[0]!;
    const p = pelvis.translation();
    const v = pelvis.linvel();
    const m = pelvis.mass();
    const k = 70;
    const c = 9;
    imp.x = ((anchor.x - p.x) * k - v.x * c) * STEP * m;
    imp.y = ((anchor.y - p.y) * k * 0.6 - v.y * c * 0.5) * STEP * m;
    imp.z = ((anchor.z - p.z) * k - v.z * c) * STEP * m;
    pelvis.applyImpulse(imp, true);
    for (let i = 1; i < PARTS.length; i++) {
      const part = PARTS[i]!;
      if (part.joint !== 'spherical') continue;
      const child = this.bodies[i]!;
      const parent = this.bodies[part.parent]!;
      const cr = child.rotation();
      const pr = parent.rotation();
      // Error rotation from the parent's frame to the child's (rest is aligned frames).
      tmpQ.set(cr.x, cr.y, cr.z, cr.w).multiply(tmpQ2.set(pr.x, pr.y, pr.z, pr.w).invert());
      if (tmpQ.w < 0) tmpQ.set(-tmpQ.x, -tmpQ.y, -tmpQ.z, -tmpQ.w);
      const s = Math.sqrt(1 - Math.min(1, tmpQ.w * tmpQ.w));
      const angle = 2 * Math.acos(Math.min(1, tmpQ.w));
      if (s < 1e-4) continue;
      tmpV.set(tmpQ.x / s, tmpQ.y / s, tmpQ.z / s).multiplyScalar(angle);
      const wc = child.angvel();
      const wp = parent.angvel();
      const stiff = i === 2 ? 6 : 2.5;
      const damp = 0.25;
      const mass = child.mass();
      tmpV2.set(
        (-tmpV.x * stiff - (wc.x - wp.x) * damp) * STEP * mass,
        (-tmpV.y * stiff - (wc.y - wp.y) * damp) * STEP * mass,
        (-tmpV.z * stiff - (wc.z - wp.z) * damp) * STEP * mass,
      );
      imp.x = tmpV2.x;
      imp.y = tmpV2.y;
      imp.z = tmpV2.z;
      child.applyTorqueImpulse(imp, true);
      imp.x = -tmpV2.x;
      imp.y = -tmpV2.y;
      imp.z = -tmpV2.z;
      parent.applyTorqueImpulse(imp, true);
    }
  }

  /**
   * Writes simulated transforms into bone locals. Unsimulated bones (spine,
   * hands, feet) keep their animated locals and ride along.
   *
   * @param bones - Rig bones; their current locals are the animated pose.
   * @param parentWorld - World matrix of the root bone's parent.
   */
  writeBones(bones: readonly ThreeBone[], parentWorld: Matrix4): void {
    const W = this.worlds;
    for (let i = 0; i < CORE_BONE_COUNT; i++) {
      const bone = bones[i]!;
      const pi = BONE_PARENT[i] ?? -1;
      const pw = pi >= 0 ? W[pi]! : parentWorld;
      const part = PART_OF_BONE[i]!;
      if (part >= 0) {
        const body = this.bodies[part]!;
        const t = body.translation();
        const r = body.rotation();
        W[i]!.compose(tmpV.set(t.x, t.y, t.z), tmpQ.set(r.x, r.y, r.z, r.w), tmpS.set(1, 1, 1));
        this.inv.copy(pw).invert();
        this.local.multiplyMatrices(this.inv, W[i]!);
        this.local.decompose(bone.position, bone.quaternion, tmpS);
        bone.scale.set(1, 1, 1);
      } else {
        bone.updateMatrix();
        W[i]!.multiplyMatrices(pw, bone.matrix);
      }
    }
  }

  /** World position of the pelvis body. */
  pelvisPosition(out: Vector3): Vector3 {
    const t = this.bodies[0]!.translation();
    return out.set(t.x, t.y, t.z);
  }

  dispose(): void {
    const w = this.world.world;
    for (const j of this.joints) w.removeImpulseJoint(j, false);
    for (const b of this.bodies) w.removeRigidBody(b);
    this.joints.length = 0;
    this.bodies.length = 0;
  }
}

/** What the manager needs from a Tumbler. */
export interface RagdollHost {
  /** World-space anchor for the pelvis (capsule centre). */
  ragdollAnchor(out: Vector3): Vector3;
  /** Builds a ragdoll from the host's current pose. */
  ragdollCreate(world: RagdollWorld): TumblerRagdoll;
  /** Hands the host its ragdoll, or `null` when revoked/ended. */
  ragdollAttach(r: TumblerRagdoll | null): void;
}

interface Entry {
  host: RagdollHost;
  ragdoll: TumblerRagdoll | null;
  dist: number;
}

let installed: RagdollManager | null = null;

/** Budgets and steps cosmetic ragdolls. */
export class RagdollManager {
  readonly world: RagdollWorld;
  /** Maximum simultaneous ragdolls. */
  maxActive: number;
  private readonly entries: Entry[] = [];
  private readonly anchor = new Vector3();
  private readonly prestepAll = (): void => {
    for (const e of this.entries) if (e.ragdoll) e.ragdoll.prestep(e.host.ragdollAnchor(this.anchor));
  };

  /**
   * @param world - The cosmetic physics world.
   * @param maxActive - Budget; SPEC §5 says 8 near the camera.
   */
  constructor(world: RagdollWorld, maxActive = 8) {
    this.world = world;
    this.maxActive = maxActive;
  }

  /** @returns The manager Tumblers use, or null (ragdolls disabled). */
  static get current(): RagdollManager | null {
    return installed;
  }

  /** Makes this the manager every Tumbler uses. */
  install(): this {
    installed = this;
    return this;
  }

  /** Uninstalls (if installed) and releases every ragdoll. */
  uninstall(): void {
    if (installed === this) installed = null;
    for (const e of this.entries) this.drop(e);
    this.entries.length = 0;
  }

  /** Registers interest in a ragdoll; granted on the next {@link update} if within budget. */
  want(host: RagdollHost): void {
    if (!this.entries.some((e) => e.host === host)) this.entries.push({ host, ragdoll: null, dist: 0 });
  }

  /** Withdraws interest; any active ragdoll is released. */
  unwant(host: RagdollHost): void {
    const i = this.entries.findIndex((e) => e.host === host);
    if (i < 0) return;
    this.drop(this.entries[i]!);
    this.entries.splice(i, 1);
  }

  /** Number of live ragdolls. */
  get activeCount(): number {
    let n = 0;
    for (const e of this.entries) if (e.ragdoll) n++;
    return n;
  }

  private drop(e: Entry): void {
    if (!e.ragdoll) return;
    e.ragdoll.dispose();
    e.ragdoll = null;
    e.host.ragdollAttach(null);
  }

  /**
   * Re-evaluates the budget (nearest requesters win) and steps the world.
   *
   * @param dt - Frame delta (s).
   * @param cameraPosition - Camera world position.
   */
  update(dt: number, cameraPosition: Vector3): void {
    for (const e of this.entries) e.dist = e.host.ragdollAnchor(this.anchor).distanceToSquared(cameraPosition);
    this.entries.sort(byDistance);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (i >= this.maxActive) this.drop(e);
      else if (!e.ragdoll) {
        e.ragdoll = e.host.ragdollCreate(this.world);
        e.host.ragdollAttach(e.ragdoll);
      }
    }
    this.world.step(dt, this.prestepAll);
  }
}
