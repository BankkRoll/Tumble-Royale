/**
 * @tumble/render/character — the Tumbler: procedural skinned mesh, TSL
 * face/pattern material, procedural animation, accessories with verlet
 * chains, cosmetic ragdolls, LODs and nameplates.
 *
 * Entry points: {@link createTumblerVisual}, {@link RagdollManager},
 * {@link NameplateLayer}, {@link loadTumblerGLTF}.
 */
export * from './types.ts';
export { createTumblerVisual, Tumbler, type TumblerOptions } from './tumbler.ts';
export { RagdollManager, RagdollWorld, TumblerRagdoll, type RagdollHost } from './ragdoll.ts';
export { NameplateLayer, Nameplate, type NameplateOptions, type NameplateStyle } from './nameplate.ts';
export { loadTumblerGLTF, applyTumblerGLTF, TUMBLER_BONE_PARENTS, type GltfBoneMap, type TumblerGLTFBody } from './gltf.ts';
export {
  TumblerShaderState,
  SHADER_PATTERNS,
  SHADER_PUPILS,
  disposeTumblerMaterials,
  getTumblerMaterials,
  outlineThickness,
  setTumblerLighting,
  type TumblerMaterials,
} from './material.ts';
export { EXPRESSIONS, type Expression, type ExpressionId } from './face.ts';
export { CLIPS, kf, type ClipDef } from './clips.ts';
export { resolveClip, resolveLoadout, type ResolvedLoadout } from './resolve.ts';
export { Bone, BONE_NAMES, CORE_BONE_COUNT, POOL_BONE_COUNT, RIG, type BoneId } from './rig.ts';
export { Kind, bodyRadiusAt, type Lod } from './geometry.ts';
export { BUILT_ACCESSORIES } from './accessories.ts';
export { assemblyCacheSize } from './assembly.ts';
export { SecondOrder } from './dynamics.ts';
