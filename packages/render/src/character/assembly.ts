/**
 * Geometry assembly and caching.
 *
 * Responsibilities:
 * - Merges the base body with a loadout's accessories into a single geometry so
 *   a Tumbler costs one draw (+ one outline draw).
 * - Allocates pool bones to accessory chains and skins chained parts to them.
 * - Reference-counts assemblies by (LOD, accessory set) so Tumblers wearing the
 *   same items share GPU buffers.
 */
import { Sphere, Vector3, type BufferAttribute, type BufferGeometry } from 'three/webgpu';
import { buildAccessory, type ChainDef } from './accessories.ts';
import { buildBaseGeometry, mergeParts, setBlend, type Lod } from './geometry.ts';
import { CORE_BONE_COUNT, POOL_BONE_COUNT } from './rig.ts';

/** One accessory to include. */
export interface AccessorySpec {
  mesh: string;
  tint: readonly string[];
}

/** A chain with its pool bone range resolved. */
export interface AssembledChain extends ChainDef {
  /** Skeleton index of the chain's first pool bone. */
  firstBone: number;
}

/** A shared, merged Tumbler geometry. */
export interface Assembly {
  readonly key: string;
  readonly lod: Lod;
  readonly geometry: BufferGeometry;
  readonly chains: readonly AssembledChain[];
  /** Rest position (mesh space) per pool bone; inverse bind = translate(-rest). */
  readonly poolRest: Float32Array;
  refs: number;
}

/** Conservative bounds covering every pose and accessory; avoids per-frame skinned bounds. */
export const TUMBLER_BOUNDS = new Sphere(new Vector3(0, 1.0, 0), 1.75);

const cache = new Map<string, Assembly>();
const baseCache = new Map<Lod, BufferGeometry>();

let bodyOverride: BufferGeometry | null = null;

/**
 * Replaces the procedural body for subsequently assembled Tumblers (glTF hook).
 * Existing assemblies are kept until released.
 *
 * @param geometry - Geometry in the shared attribute layout, skinned to core bones, or `null`.
 */
export function setBodyGeometryOverride(geometry: BufferGeometry | null): void {
  bodyOverride = geometry;
  for (const [key, a] of cache) {
    if (a.refs <= 0) {
      a.geometry.dispose();
      cache.delete(key);
    }
  }
  for (const g of baseCache.values()) g.dispose();
  baseCache.clear();
}

function base(lod: Lod): BufferGeometry {
  if (bodyOverride && lod < 2) return bodyOverride;
  let g = baseCache.get(lod);
  if (!g) {
    g = buildBaseGeometry(lod);
    baseCache.set(lod, g);
  }
  return g;
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpP = new Vector3();

/** Skins a chained part to a verlet chain: nearest rest segment, linear blend along it. */
function skinToChain(geo: BufferGeometry, chain: AssembledChain): void {
  const pos = geo.getAttribute('position') as BufferAttribute;
  const pts = chain.points;
  for (let i = 0; i < pos.count; i++) {
    tmpP.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (chain.type !== 'verlet' || pts.length < 2) {
      setBlend(geo, i, chain.firstBone, chain.firstBone, 0);
      continue;
    }
    let bestSeg = 0;
    let bestT = 0;
    let bestD = Infinity;
    for (let s = 0; s < pts.length - 1; s++) {
      tmpA.copy(pts[s]!);
      tmpB.subVectors(pts[s + 1]!, tmpA);
      const len2 = tmpB.lengthSq();
      const t = len2 > 0 ? Math.max(0, Math.min(1, tmpP.clone().sub(tmpA).dot(tmpB) / len2)) : 0;
      const d = tmpA.addScaledVector(tmpB, t).distanceToSquared(tmpP);
      if (d < bestD) {
        bestD = d;
        bestSeg = s;
        bestT = t;
      }
    }
    setBlend(geo, i, chain.firstBone + bestSeg, chain.firstBone + bestSeg + 1, bestT);
  }
}

/**
 * Gets (or builds) the merged geometry for a LOD and accessory set. Call
 * {@link releaseAssembly} when done.
 *
 * @param lod - Level of detail. LOD 2 ignores accessories.
 * @param accessories - Accessories, in a stable order.
 * @returns A shared assembly with its reference count incremented.
 */
export function acquireAssembly(lod: Lod, accessories: readonly AccessorySpec[]): Assembly {
  const list = lod === 2 ? [] : accessories;
  const key = `${lod}|${bodyOverride ? 'gltf' : 'proc'}|${list.map((a) => `${a.mesh}:${a.tint.join(',')}`).join(';')}`;
  const hit = cache.get(key);
  if (hit) {
    hit.refs++;
    return hit;
  }

  const parts: BufferGeometry[] = [base(lod).clone()];
  const chains: AssembledChain[] = [];
  const poolRest = new Float32Array(POOL_BONE_COUNT * 3);
  let nextPool = 0;

  for (const spec of list) {
    const build = buildAccessory(spec.mesh, spec.tint, lod);
    if (!build) continue;
    const local: (AssembledChain | null)[] = build.chains.map((def) => {
      const need = def.type === 'verlet' ? def.points.length : 1;
      if (nextPool + need > POOL_BONE_COUNT) return null;
      const c: AssembledChain = { ...def, firstBone: CORE_BONE_COUNT + nextPool };
      for (let k = 0; k < need; k++) {
        const p = def.points[Math.min(k, def.points.length - 1)]!;
        poolRest.set([p.x, p.y, p.z], (nextPool + k) * 3);
      }
      nextPool += need;
      chains.push(c);
      return c;
    });
    for (const part of build.parts) {
      if ('chain' in part.bind) {
        const c = local[part.bind.chain];
        if (c) skinToChain(part.geo, c);
        else {
          // Pool exhausted: the part still renders, rigidly following its attach bone.
          const def = build.chains[part.bind.chain];
          const pos = part.geo.getAttribute('position');
          for (let i = 0; i < pos.count; i++) setBlend(part.geo, i, def?.attach ?? 0, def?.attach ?? 0, 0);
        }
      }
      parts.push(part.geo);
    }
  }

  const geometry = mergeParts(parts);
  for (const p of parts) p.dispose();
  geometry.boundingSphere = TUMBLER_BOUNDS.clone();
  const a: Assembly = { key, lod, geometry, chains, poolRest, refs: 1 };
  cache.set(key, a);
  return a;
}

/**
 * Releases an assembly; disposes its geometry when no Tumbler uses it.
 *
 * @param a - Assembly from {@link acquireAssembly}.
 */
export function releaseAssembly(a: Assembly): void {
  a.refs--;
  if (a.refs <= 0) {
    a.geometry.dispose();
    cache.delete(a.key);
  }
}

/** @returns Number of live cached assemblies (debug readout). */
export function assemblyCacheSize(): number {
  return cache.size;
}
