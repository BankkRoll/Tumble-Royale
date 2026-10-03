/**
 * Tumbler skeleton definition.
 *
 * Responsibilities:
 * - Names, parents and rest positions of the 17 core bones.
 * - The pool of extra bones that verlet chains / spinners drive, so accessory
 *   geometry can be skinned into the body mesh (one draw call per Tumbler).
 * - Building a `Skeleton` instance with correct inverse bind matrices.
 *
 * Conventions: metres, +Y up, the Tumbler faces +Z, its left side is +X. Every
 * core bone has an identity rest rotation, so animation rotations are plain
 * offsets in the parent's axes and accessory geometry is authored in mesh space.
 */
import { Bone as ThreeBone, Matrix4, Object3D, Skeleton } from 'three/webgpu';

/** Core bone indices. Stable: geometry skin indices and glTF maps refer to them. */
export const Bone = {
  root: 0,
  hips: 1,
  spine: 2,
  chest: 3,
  head: 4,
  upperArmL: 5,
  lowerArmL: 6,
  handL: 7,
  upperArmR: 8,
  lowerArmR: 9,
  handR: 10,
  upperLegL: 11,
  lowerLegL: 12,
  footL: 13,
  upperLegR: 14,
  lowerLegR: 15,
  footR: 16,
} as const;

/** A core bone index. */
export type BoneId = (typeof Bone)[keyof typeof Bone];

/** Number of animated core bones. */
export const CORE_BONE_COUNT = 17;
/** Extra bones reserved for accessory chains (cape, tails, ears, propellers…). */
export const POOL_BONE_COUNT = 24;
/** Total skeleton size; identical for every Tumbler so materials share one shader. */
export const TOTAL_BONE_COUNT = CORE_BONE_COUNT + POOL_BONE_COUNT;

/** Bone names, index-aligned with {@link Bone}. Also the glTF override's default naming. */
export const BONE_NAMES: readonly string[] = [
  'root',
  'hips',
  'spine',
  'chest',
  'head',
  'upperArm.L',
  'lowerArm.L',
  'hand.L',
  'upperArm.R',
  'lowerArm.R',
  'hand.R',
  'upperLeg.L',
  'lowerLeg.L',
  'foot.L',
  'upperLeg.R',
  'lowerLeg.R',
  'foot.R',
];

/** Parent of each core bone; -1 for the root. */
export const BONE_PARENT: readonly number[] = [-1, 0, 1, 2, 3, 3, 5, 6, 3, 8, 9, 1, 11, 12, 1, 14, 15];

/** Arm hang direction (down and slightly out) for the left arm; the right mirrors X. */
const ARM_DIR = { x: Math.sin(0.44), y: -Math.cos(0.44) };
const SHOULDER = { x: 0.44, y: 0.98 };
const UPPER_ARM = 0.17;
const LOWER_ARM = 0.15;

/** Joint placement constants shared by geometry, rig and ragdoll. */
export const RIG = {
  /** Total height of the body (top of the dome). */
  height: 1.8,
  /** Lowest point of the body shell; legs show below it. */
  bodyBottom: 0.27,
  shoulder: SHOULDER,
  armDir: ARM_DIR,
  upperArm: UPPER_ARM,
  lowerArm: LOWER_ARM,
  hipX: 0.19,
  hipY: 0.42,
  kneeY: 0.25,
  ankleY: 0.1,
  /** Face plate centre height and half extents (arc-length metres). */
  faceY: 1.22,
  faceHalfW: 0.31,
  faceHalfH: 0.235,
  /** Reference radius used for the face plate's angular → metres mapping. */
  faceRadius: 0.4,
} as const;

const elbowL = { x: SHOULDER.x + ARM_DIR.x * UPPER_ARM, y: SHOULDER.y + ARM_DIR.y * UPPER_ARM };
const wristL = { x: elbowL.x + ARM_DIR.x * LOWER_ARM, y: elbowL.y + ARM_DIR.y * LOWER_ARM };

/** Default rest positions in mesh space, xyz per core bone. */
export const DEFAULT_BONE_REST: Float32Array = new Float32Array([
  0, 0, 0, // root
  0, 0.55, 0, // hips
  0, 0.85, 0, // spine
  0, 1.12, 0, // chest
  0, 1.36, 0, // head
  SHOULDER.x, SHOULDER.y, 0,
  elbowL.x, elbowL.y, 0,
  wristL.x, wristL.y, 0,
  -SHOULDER.x, SHOULDER.y, 0,
  -elbowL.x, elbowL.y, 0,
  -wristL.x, wristL.y, 0,
  RIG.hipX, RIG.hipY, 0,
  RIG.hipX, RIG.kneeY, 0,
  RIG.hipX, RIG.ankleY, 0,
  -RIG.hipX, RIG.hipY, 0,
  -RIG.hipX, RIG.kneeY, 0,
  -RIG.hipX, RIG.ankleY, 0,
]);

let activeRest: Float32Array = DEFAULT_BONE_REST;

/**
 * Rest positions every new Tumbler uses. Replaced by a glTF body override whose
 * joints sit elsewhere.
 *
 * @returns xyz per core bone, mesh space.
 */
export function boneRest(): Float32Array {
  return activeRest;
}

/**
 * Swaps the rest positions for subsequently created Tumblers.
 *
 * @param rest - xyz per core bone, or `null` to restore the procedural rig.
 */
export function setBoneRest(rest: Float32Array | null): void {
  if (rest && rest.length !== CORE_BONE_COUNT * 3) throw new Error('rest must hold 17 xyz triples');
  activeRest = rest ?? DEFAULT_BONE_REST;
}

/** A Tumbler's live bone hierarchy. */
export interface TumblerRig {
  /** Core bones followed by pool bones. */
  bones: ThreeBone[];
  skeleton: Skeleton;
  /** Rest positions (mesh space) this rig was built with. */
  rest: Float32Array;
}

/**
 * Builds the bone hierarchy under `parent`. Pool bones hang directly off
 * `parent` (not the root bone) so root squash doesn't shear chain physics.
 *
 * @param parent - Object the skinned meshes are siblings of (mesh space origin).
 * @returns The rig with inverse bind matrices for core bones; pool inverses are
 *   identity until an accessory set assigns them.
 */
export function createRig(parent: Object3D): TumblerRig {
  const rest = activeRest;
  const bones: ThreeBone[] = [];
  const inverses: Matrix4[] = [];
  for (let i = 0; i < CORE_BONE_COUNT; i++) {
    const b = new ThreeBone();
    b.name = BONE_NAMES[i] ?? `bone${i}`;
    const p = BONE_PARENT[i] ?? -1;
    const px = p >= 0 ? (rest[p * 3] ?? 0) : 0;
    const py = p >= 0 ? (rest[p * 3 + 1] ?? 0) : 0;
    const pz = p >= 0 ? (rest[p * 3 + 2] ?? 0) : 0;
    b.position.set((rest[i * 3] ?? 0) - px, (rest[i * 3 + 1] ?? 0) - py, (rest[i * 3 + 2] ?? 0) - pz);
    const parentBone = p >= 0 ? bones[p] : undefined;
    (parentBone ?? parent).add(b);
    bones.push(b);
    inverses.push(new Matrix4().makeTranslation(-(rest[i * 3] ?? 0), -(rest[i * 3 + 1] ?? 0), -(rest[i * 3 + 2] ?? 0)));
  }
  for (let i = 0; i < POOL_BONE_COUNT; i++) {
    const b = new ThreeBone();
    b.name = `pool${i}`;
    parent.add(b);
    bones.push(b);
    inverses.push(new Matrix4());
  }
  return { bones, skeleton: new Skeleton(bones, inverses), rest };
}

/**
 * Resets every core bone to its rest transform.
 *
 * @param rig - Rig to reset.
 */
export function resetRig(rig: TumblerRig): void {
  for (let i = 0; i < CORE_BONE_COUNT; i++) {
    const b = rig.bones[i];
    if (!b) continue;
    b.quaternion.identity();
    b.scale.set(1, 1, 1);
    const p = BONE_PARENT[i] ?? -1;
    const r = rig.rest;
    b.position.set(
      (r[i * 3] ?? 0) - (p >= 0 ? (r[p * 3] ?? 0) : 0),
      (r[i * 3 + 1] ?? 0) - (p >= 0 ? (r[p * 3 + 1] ?? 0) : 0),
      (r[i * 3 + 2] ?? 0) - (p >= 0 ? (r[p * 3 + 2] ?? 0) : 0),
    );
  }
}
