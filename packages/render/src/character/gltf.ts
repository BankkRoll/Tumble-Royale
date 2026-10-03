/**
 * Optional glTF body override: lets artists replace the procedural gumdrop with
 * an authored skinned mesh while keeping the procedural animation, face shader,
 * accessories and ragdoll.
 *
 * The model must be in metres, +Y up, facing +Z, feet at the origin, skinned to
 * joints that can be mapped onto the 17 core bones. The face plate is still
 * projected procedurally around {@link RIG.faceY}.
 */
import { Float32BufferAttribute, Matrix4, Uint16BufferAttribute, Vector3, type BufferGeometry, type Object3D, type SkinnedMesh } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { setBodyGeometryOverride } from './assembly.ts';
import { Kind } from './geometry.ts';
import { BONE_NAMES, BONE_PARENT, CORE_BONE_COUNT, DEFAULT_BONE_REST, RIG, setBoneRest } from './rig.ts';

/** Our bone name (see `BONE_NAMES`) → joint name in the glTF. */
export type GltfBoneMap = Partial<Record<string, string>>;

/** A loaded body ready to apply. */
export interface TumblerGLTFBody {
  geometry: BufferGeometry;
  /** Rest positions (xyz per core bone) read from the glTF bind pose. */
  rest: Float32Array;
  /** Core bones that had no matching joint (they keep procedural rest positions). */
  unmapped: string[];
}

/** Normalises joint names so "mixamorig:LeftArm", "upperArm_L" etc. compare loosely. */
const norm = (s: string): string => s.toLowerCase().replace(/^.*[:|]/, '').replace(/[^a-z0-9]/g, '');

/**
 * Loads a skinned glTF and converts it into a Tumbler body override.
 *
 * @param url - glTF/GLB URL.
 * @param boneMap - Explicit joint names per core bone; unspecified bones match by name.
 * @param apply - Install the override immediately for Tumblers created afterwards (default true).
 * @returns The converted body.
 * @example
 * await loadTumblerGLTF('/models/tumbler.glb', { 'upperArm.L': 'shoulder_L' });
 */
export async function loadTumblerGLTF(url: string, boneMap: GltfBoneMap = {}, apply = true): Promise<TumblerGLTFBody> {
  const gltf = await new GLTFLoader().loadAsync(url);
  let skinned: SkinnedMesh | null = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o: Object3D) => {
    if (!skinned && (o as SkinnedMesh).isSkinnedMesh) skinned = o as SkinnedMesh;
  });
  const mesh = skinned as SkinnedMesh | null;
  if (!mesh) throw new Error(`loadTumblerGLTF: no skinned mesh in ${url}`);

  const joints = mesh.skeleton.bones;
  const ours = new Int16Array(joints.length).fill(-1);
  const unmapped: string[] = [];
  const rest = new Float32Array(DEFAULT_BONE_REST);
  const bindWorld = new Matrix4();
  const p = new Vector3();

  for (let i = 0; i < CORE_BONE_COUNT; i++) {
    const want = boneMap[BONE_NAMES[i]!] ?? BONE_NAMES[i]!;
    const j = joints.findIndex((b) => b.name === want || norm(b.name) === norm(want));
    if (j < 0) {
      unmapped.push(BONE_NAMES[i]!);
      continue;
    }
    ours[j] = i;
    const inv = mesh.skeleton.boneInverses[j];
    if (inv) {
      bindWorld.copy(inv).invert();
      p.setFromMatrixPosition(bindWorld);
      rest.set([p.x, p.y, p.z], i * 3);
    }
  }
  // Unmapped joints inherit the nearest mapped ancestor so their vertices still move.
  for (let j = 0; j < joints.length; j++) {
    if (ours[j]! >= 0) continue;
    let o: Object3D | null = joints[j]!.parent;
    while (o) {
      const k = joints.indexOf(o as (typeof joints)[number]);
      if (k >= 0 && ours[k]! >= 0) {
        ours[j] = ours[k]!;
        break;
      }
      o = o.parent;
    }
    if (ours[j]! < 0) ours[j] = 0;
  }

  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(geometry.attributes)) {
    if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(name)) geometry.deleteAttribute(name);
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const si = geometry.getAttribute('skinIndex');
  const n = si.count;
  const idx = new Uint16Array(n * 4);
  for (let v = 0; v < n; v++) {
    for (let c = 0; c < 4; c++) idx[v * 4 + c] = ours[si.getComponent(v, c)] ?? 0;
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(idx, 4));

  const pos = geometry.getAttribute('position');
  const col = new Float32Array(n * 3).fill(1);
  const kind = new Float32Array(n).fill(Kind.Pattern);
  const face = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    face[v * 2] = Math.atan2(pos.getX(v), pos.getZ(v)) * RIG.faceRadius;
    face[v * 2 + 1] = pos.getY(v) - RIG.faceY;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(col, 3));
  geometry.setAttribute('aKind', new Float32BufferAttribute(kind, 1));
  geometry.setAttribute('aFace', new Float32BufferAttribute(face, 2));
  if (!geometry.index) {
    const ix = new Uint32Array(n);
    for (let v = 0; v < n; v++) ix[v] = v;
    geometry.setIndex(Array.from(ix));
  }

  const body: TumblerGLTFBody = { geometry, rest, unmapped };
  if (apply) applyTumblerGLTF(body);
  return body;
}

/**
 * Installs (or with `null`, removes) a glTF body for Tumblers created afterwards.
 *
 * @param body - Body from {@link loadTumblerGLTF}, or null for the procedural body.
 */
export function applyTumblerGLTF(body: TumblerGLTFBody | null): void {
  setBoneRest(body ? body.rest : null);
  setBodyGeometryOverride(body ? body.geometry : null);
}

/** Parent table re-exported for tools that build compatible rigs. */
export const TUMBLER_BONE_PARENTS: readonly number[] = BONE_PARENT;
