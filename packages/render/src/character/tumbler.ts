/**
 * The Tumbler visual: implements the `TumblerVisual` contract.
 *
 * Responsibilities:
 * - Owns the rig, the skinned body + outline meshes (sharing one merged
 *   geometry and the shared materials), the LOD 2 static mesh and the dizzy
 *   star ring.
 * - Runs the animator, face, accessory chains and ragdoll blending each frame.
 * - Applies loadouts (colours, pattern, face style, accessory geometry).
 *
 * Draw calls per Tumbler: LOD 0/1 = body + outline (+1 shadow); LOD 2 = 1 (+1 shadow).
 */
import {
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  SkinnedMesh,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AnimClipId } from '@tumble/content/cosmetics';
import { CharacterState } from '@tumble/sim';
import { starGeometry } from './accessories.ts';
import { Animator } from './animator.ts';
import { TUMBLER_BOUNDS, acquireAssembly, releaseAssembly, type Assembly } from './assembly.ts';
import { ChainRuntime, SecondOrder } from './dynamics.ts';
import { FaceController } from './face.ts';
import type { Lod } from './geometry.ts';
import { TumblerShaderState, getTumblerMaterials } from './material.ts';
import { CH } from './pose.ts';
import { RagdollManager, type RagdollHost, type RagdollWorld, TumblerRagdoll } from './ragdoll.ts';
import { resolveClip, resolveLoadout, type ResolvedLoadout } from './resolve.ts';
import { BONE_PARENT, Bone, CORE_BONE_COUNT, POOL_BONE_COUNT, createRig, type TumblerRig } from './rig.ts';
import type { CreateTumblerVisual, TumblerAnimInput, TumblerLoadout, TumblerVisual } from './types.ts';

const S = CharacterState;

// -----------------------------------------------------------------------------
// Shared dizzy-star ring
// -----------------------------------------------------------------------------

let starRing: { geometry: BufferGeometry; material: MeshBasicNodeMaterial } | null = null;

function getStarRing(): { geometry: BufferGeometry; material: MeshBasicNodeMaterial } {
  if (starRing) return starRing;
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const g = starGeometry(0.075, 0.036, 0.03);
    g.rotateY(-a);
    g.translate(Math.sin(a) * 0.34, Math.sin(a * 2) * 0.04, Math.cos(a) * 0.34);
    parts.push(g);
  }
  const geometry = mergeGeometries(parts, false);
  if (!geometry) throw new Error('star ring merge failed');
  for (const p of parts) p.dispose();
  starRing = { geometry, material: new MeshBasicNodeMaterial({ color: '#ffe14d' }) };
  return starRing;
}

// -----------------------------------------------------------------------------
// Scratch
// -----------------------------------------------------------------------------

const tmpEuler = new Euler();
const tmpV = new Vector3();
const tmpV2 = new Vector3();
const IDENTITY = new Matrix4();
const BODY_SPHERES = [
  { bone: Bone.hips, y: 0.07, r: 0.47 },
  { bone: Bone.chest, y: -0.02, r: 0.42 },
  { bone: Bone.head, y: 0.1, r: 0.36 },
] as const;

const NO_RAGDOLL_STATES = new Set<number>([S.Spectating, S.Respawning, S.Eliminated]);
const NO_HEAD_LOOK = new Set<number>([S.Stunned, S.Dive, S.DiveSlide, S.Fall, S.GetUp]);

let seedCounter = 1;

/** Options for {@link Tumbler}. */
export interface TumblerOptions {
  /** Request a cosmetic ragdoll automatically while Stunned (if a manager is installed). Default true. */
  autoRagdoll?: boolean;
  /** Cast shadows. Default true. */
  castShadow?: boolean;
}

/** A renderable Tumbler. Prefer {@link createTumblerVisual}. */
export class Tumbler implements TumblerVisual, RagdollHost {
  readonly object = new Group();
  /** Per-instance shader inputs (exposed for hit flashes / debug). */
  readonly shader = new TumblerShaderState();
  /** Auto ragdoll on stun. */
  autoRagdoll: boolean;

  private readonly pivot = new Group();
  private readonly lod2Group = new Group();
  private readonly rig: TumblerRig;
  private readonly body: SkinnedMesh;
  private readonly outline: SkinnedMesh;
  private readonly lod2: Mesh;
  private readonly stars: Mesh;
  private readonly animator: Animator;
  private readonly face: FaceController;
  private assembly: Assembly;
  private lod2Assembly: Assembly | null = null;
  private chains: ChainRuntime[] = [];
  private resolved: ResolvedLoadout;
  private lod: Lod = 0;
  private time = 0;
  private hidden = false;
  private popT = 1;
  private flash = 0;
  private opacity = 1;
  private lastState = -1;

  private ragdoll: TumblerRagdoll | null = null;
  private ragdollMgr: RagdollManager | null = null;
  private ragdollWanted = false;
  private manualRagdoll = false;
  private ragdollBlend = 0;
  private readonly snapPos = Array.from({ length: CORE_BONE_COUNT }, () => new Vector3());
  private readonly snapQuat = Array.from({ length: CORE_BONE_COUNT }, () => new Quaternion());
  private readonly velocity = new Vector3();
  private readonly lastWorld = new Vector3();
  private hasLastWorld = false;

  private readonly headYaw = new SecondOrder(2.5, 0.85, 0);
  private readonly headPitch = new SecondOrder(2.5, 0.85, 0);
  private readonly look = { x: 0, y: 0 };
  private lookActive = false;
  private readonly spheres = new Float32Array(BODY_SPHERES.length * 4);
  private readonly pivotInv = new Matrix4();
  private readonly rnd: () => number;

  /**
   * @param loadout - Initial look.
   * @param opts - Behaviour options.
   */
  constructor(loadout: TumblerLoadout, opts: TumblerOptions = {}) {
    const seed = seedCounter++;
    let s = seed * 2654435761;
    this.rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    this.autoRagdoll = opts.autoRagdoll ?? true;
    this.object.name = 'Tumbler';
    this.object.add(this.pivot);
    this.rig = createRig(this.pivot);

    this.resolved = resolveLoadout(loadout);
    this.assembly = acquireAssembly(0, this.resolved.accessories);
    const mats = getTumblerMaterials();

    this.body = new SkinnedMesh(this.assembly.geometry, mats.body);
    this.body.bind(this.rig.skeleton, IDENTITY);
    this.body.castShadow = opts.castShadow ?? true;
    this.body.receiveShadow = true;
    this.body.boundingSphere = TUMBLER_BOUNDS.clone();
    this.body.userData.tumbler = this.shader;

    this.outline = new SkinnedMesh(this.assembly.geometry, mats.outline);
    this.outline.bind(this.rig.skeleton, IDENTITY);
    this.outline.boundingSphere = TUMBLER_BOUNDS.clone();
    this.outline.userData.tumbler = this.shader;
    this.pivot.add(this.body, this.outline);

    this.lod2 = new Mesh(undefined, mats.body);
    this.lod2.castShadow = opts.castShadow ?? true;
    this.lod2.position.y = -0.55;
    this.lod2.userData.tumbler = this.shader;
    this.lod2Group.add(this.lod2);
    this.lod2Group.visible = false;
    this.pivot.add(this.lod2Group);

    const ring = getStarRing();
    this.stars = new Mesh(ring.geometry, ring.material);
    this.stars.visible = false;
    this.pivot.add(this.stars);

    this.animator = new Animator(seed);
    this.face = new FaceController(this.rnd);
    this.applyResolved(true);
  }

  // ---------------------------------------------------------------------------
  // Loadout & LOD
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  setLoadout(loadout: TumblerLoadout): void {
    const prevKey = this.resolved.accessoryKey;
    this.resolved = resolveLoadout(loadout);
    this.applyResolved(prevKey !== this.resolved.accessoryKey);
  }

  private applyResolved(rebuild: boolean): void {
    const r = this.resolved;
    const sh = this.shader;
    sh.primary.set(r.colors[0]);
    sh.secondary.set(r.colors[1]);
    sh.tertiary.set(r.colors[2]);
    sh.plate.set(r.plate);
    sh.iris.set(r.iris);
    sh.pattern.set(r.patternIndex, r.patternScale, r.patternAngle, 0);
    this.face.style = r.face;
    if (rebuild) this.rebuildGeometry(this.lod === 2 ? 1 : this.lod);
  }

  private rebuildGeometry(lod: 0 | 1): void {
    const next = acquireAssembly(lod, this.resolved.accessories);
    if (next !== this.assembly) {
      releaseAssembly(this.assembly);
      this.assembly = next;
    } else {
      // acquire bumped the refcount of the assembly we already hold.
      releaseAssembly(next);
    }
    this.body.geometry = next.geometry;
    this.outline.geometry = next.geometry;

    const inv = this.rig.skeleton.boneInverses;
    for (let k = 0; k < POOL_BONE_COUNT; k++) {
      const m = inv[CORE_BONE_COUNT + k]!;
      m.makeTranslation(-next.poolRest[k * 3]!, -next.poolRest[k * 3 + 1]!, -next.poolRest[k * 3 + 2]!);
      const b = this.rig.bones[CORE_BONE_COUNT + k]!;
      b.position.set(next.poolRest[k * 3]!, next.poolRest[k * 3 + 1]!, next.poolRest[k * 3 + 2]!);
      b.quaternion.identity();
      b.scale.set(1, 1, 1);
    }
    const rest = this.rig.rest;
    this.chains = next.chains.map(
      (c) => new ChainRuntime(c, new Vector3(rest[c.attach * 3], rest[c.attach * 3 + 1], rest[c.attach * 3 + 2])),
    );
  }

  /** @inheritdoc */
  setLod(level: 0 | 1 | 2): void {
    if (level === this.lod) return;
    const prev = this.lod;
    this.lod = level;
    if (level === 2) {
      this.lod2Assembly ??= acquireAssembly(2, []);
      this.lod2.geometry = this.lod2Assembly.geometry;
      this.body.visible = false;
      this.outline.visible = false;
      this.lod2Group.visible = true;
      this.stars.visible = false;
      this.syncRagdollWant();
      return;
    }
    this.body.visible = true;
    this.outline.visible = true;
    this.lod2Group.visible = false;
    if (prev === 2 || this.assembly.lod !== level) this.rebuildGeometry(level);
    this.syncRagdollWant();
  }

  /** Current level of detail. */
  get currentLod(): Lod {
    return this.lod;
  }

  // ---------------------------------------------------------------------------
  // Ragdoll
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  setRagdoll(active: boolean): void {
    this.manualRagdoll = active;
    this.syncRagdollWant();
  }

  /** True while a physics ragdoll drives the bones. */
  get ragdollActive(): boolean {
    return this.ragdoll !== null;
  }

  private syncRagdollWant(): void {
    const mgr = RagdollManager.current;
    if (mgr !== this.ragdollMgr) {
      // Manager swapped or uninstalled: re-register from scratch with the new one.
      this.ragdollMgr?.unwant(this);
      this.ragdollMgr = mgr;
      this.ragdollWanted = false;
    }
    const autoWant = this.autoRagdoll && this.lastState === S.Stunned;
    const want = !!mgr && this.lod < 2 && !NO_RAGDOLL_STATES.has(this.lastState) && (this.manualRagdoll || autoWant);
    if (want === this.ragdollWanted) return;
    this.ragdollWanted = want;
    if (!mgr) return;
    if (want) mgr.want(this);
    else mgr.unwant(this);
  }

  /** @internal RagdollHost */
  ragdollAnchor(out: Vector3): Vector3 {
    return this.object.getWorldPosition(out).add(tmpV2.set(0, 0.8, 0));
  }

  /** @internal RagdollHost */
  ragdollCreate(world: RagdollWorld): TumblerRagdoll {
    this.object.updateWorldMatrix(true, true);
    return new TumblerRagdoll(world, this.rig.bones, this.velocity);
  }

  /** @internal RagdollHost */
  ragdollAttach(r: TumblerRagdoll | null): void {
    this.ragdoll = r;
    this.ragdollBlend = 1;
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  /** Triggers a short white hit flash. */
  hitFlash(strength = 0.6): void {
    this.flash = Math.max(this.flash, strength);
  }

  /** @inheritdoc */
  update(dtIn: number, anim: TumblerAnimInput): void {
    const dt = Math.min(Math.max(dtIn, 0), 0.1);
    this.time += dt;
    const state = anim.state;

    this.lastState = state;
    this.syncRagdollWant();

    const hide = state === S.Spectating || state === S.Respawning;
    if (hide !== this.hidden) {
      this.hidden = hide;
      this.pivot.visible = !hide;
      if (!hide) this.popT = 0;
    }
    if (hide) return;

    this.object.updateWorldMatrix(true, false);
    tmpV.setFromMatrixPosition(this.object.matrixWorld);
    if (this.hasLastWorld && dt > 0) this.velocity.subVectors(tmpV, this.lastWorld).divideScalar(dt).clampLength(0, 15);
    this.lastWorld.copy(tmpV);
    this.hasLastWorld = true;

    this.pivot.rotation.y = anim.facing;
    if (this.popT < 1) {
      this.popT = Math.min(1, this.popT + dt / 0.3);
      const k = this.popT - 1;
      const s = 1 + 2.2 * k * k * k + 1.2 * k * k;
      this.pivot.scale.setScalar(Math.max(0.01, s));
    } else this.pivot.scale.setScalar(1);
    this.pivot.updateWorldMatrix(false, false);
    this.pivotInv.copy(this.pivot.matrixWorld).invert();

    let clip: AnimClipId | null = null;
    if (anim.emote) clip = resolveClip(anim.emote);
    else if (state === S.Finished) clip = this.resolved.celebration;
    else if (state === S.Emote) clip = this.resolved.emotes[0] ?? null;
    this.animator.update(dt, anim, clip);
    // The contract makes impulse a one-shot: consume it so callers can leave the field set.
    anim.impulse = 0;

    this.updateLook(dt, anim, state);

    if (this.lod === 2) this.applyLod2();
    else this.applyBones(dt);

    this.updateFace(dt, anim, state);
  }

  private updateLook(dt: number, anim: TumblerAnimInput, state: number): void {
    let yawT = 0;
    let pitchT = 0;
    let has = false;
    if (anim.lookAt && !NO_HEAD_LOOK.has(state)) {
      tmpV.set(anim.lookAt.x, anim.lookAt.y, anim.lookAt.z).applyMatrix4(this.pivotInv).sub(tmpV2.set(0, 1.35, 0));
      const yaw = Math.atan2(tmpV.x, tmpV.z);
      const pitch = Math.atan2(tmpV.y, Math.hypot(tmpV.x, tmpV.z));
      if (Math.abs(yaw) < 2.3) {
        has = true;
        yawT = Math.max(-0.7, Math.min(0.7, yaw * 0.55));
        pitchT = Math.max(-0.35, Math.min(0.3, -pitch * 0.45));
        this.look.x = Math.max(-1, Math.min(1, (yaw - yawT) / 0.5));
        this.look.y = Math.max(-1, Math.min(1, (pitch + pitchT) / 0.4));
      }
    }
    const hy = this.headYaw.update(dt, yawT);
    const hp = this.headPitch.update(dt, pitchT);
    this.animator.out.rot(Bone.head, hp, hy, 0);
    this.lookActive = has;
  }

  private applyBones(dt: number): void {
    const v = this.animator.out.v;
    const bones = this.rig.bones;
    const rest = this.rig.rest;
    for (let i = 0; i < CORE_BONE_COUNT; i++) {
      const b = bones[i]!;
      b.quaternion.setFromEuler(tmpEuler.set(v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!));
      // Ragdolls overwrite local positions too, so restore the rest offsets every frame.
      const p = BONE_PARENT[i]!;
      if (p >= 0) b.position.set(rest[i * 3]! - rest[p * 3]!, rest[i * 3 + 1]! - rest[p * 3 + 1]!, rest[i * 3 + 2]! - rest[p * 3 + 2]!);
      b.scale.set(1, 1, 1);
    }
    const root = bones[Bone.root]!;
    root.position.set(rest[0]! + v[CH.pos]!, rest[1]! + v[CH.pos + 1]!, rest[2]! + v[CH.pos + 2]!);
    const st = v[CH.stretch]!;
    const xz = 1 / Math.sqrt(1 + st);
    root.scale.set(xz, 1 + st, xz);

    const needWorld = this.ragdoll !== null || this.ragdollBlend > 0 || this.chains.length > 0 || this.lastState === S.Stunned;
    if (!needWorld) return;

    if (this.ragdoll) {
      this.ragdoll.writeBones(bones, this.pivot.matrixWorld);
      for (let i = 0; i < CORE_BONE_COUNT; i++) {
        this.snapPos[i]!.copy(bones[i]!.position);
        this.snapQuat[i]!.copy(bones[i]!.quaternion);
      }
    } else if (this.ragdollBlend > 0) {
      this.ragdollBlend = Math.max(0, this.ragdollBlend - dt / 0.3);
      const w = this.ragdollBlend;
      for (let i = 0; i < CORE_BONE_COUNT; i++) {
        const b = bones[i]!;
        b.quaternion.slerp(this.snapQuat[i]!, w);
        b.position.lerp(this.snapPos[i]!, w);
      }
    }

    this.pivot.updateMatrixWorld(true);

    if (this.chains.length) {
      for (let s = 0; s < BODY_SPHERES.length; s++) {
        const def = BODY_SPHERES[s]!;
        tmpV.set(0, def.y, 0).applyMatrix4(bones[def.bone]!.matrixWorld);
        const o = s * 4;
        this.spheres[o] = tmpV.x;
        this.spheres[o + 1] = tmpV.y;
        this.spheres[o + 2] = tmpV.z;
        this.spheres[o + 3] = def.r;
      }
      const speed = this.velocity.length();
      for (const c of this.chains) {
        const attach = bones[c.def.attach]!.matrixWorld;
        c.update(dt, attach, this.spheres, BODY_SPHERES.length, this.time, speed, this.lod === 0);
        c.writeBones(bones, attach, this.pivotInv);
      }
    }
  }

  private applyLod2(): void {
    const v = this.animator.out.v;
    const g = this.lod2Group;
    g.position.set(v[CH.pos]!, 0.55 + v[CH.pos + 1]!, v[CH.pos + 2]!);
    g.rotation.set(v[Bone.hips * 3]! + v[Bone.spine * 3]!, v[1]! + v[Bone.hips * 3 + 1]!, v[Bone.hips * 3 + 2]!);
    const st = v[CH.stretch]!;
    const xz = 1 / Math.sqrt(1 + st);
    g.scale.set(xz, 1 + st, xz);
  }

  private updateFace(dt: number, anim: TumblerAnimInput, state: number): void {
    this.face.setExpression(this.animator.expression);
    this.face.dizzy = state === S.Stunned;
    this.face.update(dt, this.time, this.lookActive ? this.look : null, this.shader);

    const targetOpacity = anim.ghost ? 0.45 : 1;
    this.opacity += (targetOpacity - this.opacity) * Math.min(1, dt * 10);
    this.flash = Math.max(0, this.flash - dt * 4);
    this.shader.fx.x = this.opacity;
    this.shader.fx.y = this.flash;

    const stunned = state === S.Stunned && this.lod < 2;
    this.stars.visible = stunned;
    if (stunned) {
      tmpV.set(0, 0.2, 0).applyMatrix4(this.rig.bones[Bone.head]!.matrixWorld);
      tmpV.y += 0.45;
      tmpV.applyMatrix4(this.pivotInv);
      this.stars.position.copy(tmpV);
      this.stars.rotation.y += dt * 5;
    }
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  dispose(): void {
    this.ragdollMgr?.unwant(this);
    this.ragdollMgr = null;
    this.ragdoll = null;
    releaseAssembly(this.assembly);
    if (this.lod2Assembly) releaseAssembly(this.lod2Assembly);
    this.lod2Assembly = null;
    this.chains = [];
    this.rig.skeleton.dispose();
    this.object.removeFromParent();
  }
}

/**
 * Creates a Tumbler visual. The `TumblerVisual` factory from the render contract.
 *
 * @param loadout - Initial loadout (cosmetic ids from `@tumble/content/cosmetics`).
 * @returns A new visual; add `visual.object` to the scene and place it at the feet.
 * @example
 * const t = createTumblerVisual(defaultLoadout());
 * scene.add(t.object);
 * t.update(dt, { state: CharacterState.Run, stateTime, speed: 6, verticalSpeed: 0, facing, grounded: true, emote: null });
 */
export const createTumblerVisual: CreateTumblerVisual = (loadout) => new Tumbler(loadout);
