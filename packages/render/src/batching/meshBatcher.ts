/**
 * Automatic instancing of render-equivalent meshes.
 *
 * Responsibilities:
 * - Finds meshes under the registered roots that would render identically
 *   apart from their transform: same geometry content and a structurally
 *   identical node material (same node graph, constants, textures and render
 *   state) whose uniforms currently hold equal values.
 * - Draws each such group as one `InstancedMesh` and hides the sources with an
 *   empty layer mask, so obstacle code keeps animating, showing and hiding its
 *   own meshes exactly as before.
 * - Every frame, re-validates each member (visibility, material/uniform state,
 *   shadow flags); members that diverge from their group's representative —
 *   e.g. one hammer's telegraph glow ramping up — are drawn individually until
 *   they match again.
 *
 * Conservative by construction: anything it cannot prove equivalent (opaque
 * per-material `Fn` closures, per-object uniforms, model-matrix accessors,
 * transparency, skinning, custom render hooks) stays an individual draw.
 */
import {
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Object3D,
} from 'three/webgpu';
import {
  instanceIndex,
  modelPosition,
  modelScale,
  modelWorldMatrix,
  normalLocal,
  positionLocal,
} from 'three/tsl';

// -----------------------------------------------------------------------------
// Identity helpers
// -----------------------------------------------------------------------------

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

/** Stable small integer per object identity (functions, textures, constructors). */
function idOf(o: object): number {
  let id = objectIds.get(o);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(o, id);
  }
  return id;
}

/** FNV-1a over 32-bit words. */
function hashWords(h: number, words: Uint32Array): number {
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i]!, 16777619) >>> 0;
  return Math.imul(h ^ words.length, 16777619) >>> 0;
}

function wordsOf(arr: ArrayBufferView): Uint32Array {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}

const geometryKeys = new WeakMap<BufferGeometry, string>();

/** Content key: two geometries built by the same code with the same parameters share it. */
function geometryKey(g: BufferGeometry): string {
  const cached = geometryKeys.get(g);
  if (cached) return cached;
  const parts: string[] = [];
  let h = 2166136261;
  let h2 = 5381;
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name]!;
    if ((a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute)
      return `uuid:${g.uuid}`;
    const w = wordsOf(a.array as ArrayBufferView);
    h = hashWords(h, w);
    h2 = hashWords(h2 ^ 0x9e3779b9, w);
    parts.push(
      `${name}:${a.itemSize}:${a.count}:${a.normalized ? 1 : 0}:${(a.array as object).constructor.name}`,
    );
  }
  if (g.index) {
    const w = wordsOf(g.index.array as ArrayBufferView);
    h = hashWords(h, w);
    h2 = hashWords(h2 ^ 0x85ebca6b, w);
    parts.push(`i:${g.index.count}`);
  }
  if (Object.keys(g.morphAttributes).length > 0) return `uuid:${g.uuid}`;
  parts.push(`g:${g.groups.map((x) => `${x.start},${x.count},${x.materialIndex}`).join(';')}`);
  parts.push(`r:${g.drawRange.start},${g.drawRange.count}`);
  const key = `${h.toString(36)}.${h2.toString(36)}|${parts.join('|')}`;
  geometryKeys.set(g, key);
  return key;
}

// -----------------------------------------------------------------------------
// Material analysis
// -----------------------------------------------------------------------------

type AnyNode = {
  isNode: true;
  type: string;
  updateType?: string;
  isUniformNode?: boolean;
  value?: unknown;
} & Record<string, unknown>;

/** Nodes whose meaning changes when the mesh becomes one instance of many. */
const OBJECT_SPACE_NODES = new Set<unknown>([positionLocal, normalLocal]);
const MODEL_NODES = new Set<unknown>([modelWorldMatrix, modelPosition, modelScale, instanceIndex]);
const SKIP_KEYS = new Set(['id', 'uuid', 'version', 'stackTrace', 'parents', 'isNode']);

/** Result of analysing one material. */
interface MaterialInfo {
  /** Null when the material can't be proven instancing-safe. */
  sig: string | null;
  /** Uniform nodes in graph order; their values must match across a group every frame. */
  uniforms: AnyNode[];
  /** Material own-property keys holding dynamic numbers/colours/vectors. */
  stateKeys: string[];
  /** Why `sig` is null (diagnostics). */
  reason: string;
}

const materialInfos = new WeakMap<Material, MaterialInfo>();

function isNode(v: unknown): v is AnyNode {
  return typeof v === 'object' && v !== null && (v as { isNode?: boolean }).isNode === true;
}

function valueSig(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return String(v);
  if (typeof v === 'function') return `f${idOf(v)}`;
  if (typeof v === 'object') {
    const o = v as { toArray?: () => number[]; isTexture?: boolean; isColor?: boolean };
    if (o.isTexture) return `t${idOf(v)}`;
    if (typeof o.toArray === 'function') return `[${o.toArray().join(',')}]`;
    if (Array.isArray(v)) return `[${v.map(valueSig).join(',')}]`;
    return `o${idOf(v)}`;
  }
  return '?';
}

/**
 * Structural signature of a node graph. Uniform values are recorded (in
 * order) for per-frame comparison rather than hashed, constants are hashed by
 * value, and anything opaque (functions, foreign objects) by identity.
 */
function graphSig(
  root: AnyNode,
  slot: string,
  info: MaterialInfo,
  memo: Map<AnyNode, string>,
  budget: { n: number },
): string | null {
  const fail = (why: string): null => {
    info.reason = why;
    return null;
  };
  const visit = (node: AnyNode): string | null => {
    const hit = memo.get(node);
    if (hit !== undefined) return hit;
    if (--budget.n < 0) return fail('graph too large');
    if (MODEL_NODES.has(node) || node.type === 'ModelNode' || node.type === 'Object3DNode')
      return fail(`${slot}: model accessor`);
    if (OBJECT_SPACE_NODES.has(node) && slot !== 'positionNode')
      return fail(`${slot}: object-space accessor`);
    memo.set(node, `#${memo.size}`);
    let out = node.type ?? 'Node';
    if (node.isUniformNode) {
      // Per-object / per-frame update callbacks may compute per-mesh values: only identical nodes match.
      if (node.updateType && node.updateType !== 'none') out += `@${idOf(node)}`;
      else info.uniforms.push(node);
      out += `:${valueSig(node.value)}`;
    }
    for (const key of Object.keys(node)) {
      if (key.startsWith('_') || SKIP_KEYS.has(key) || (node.isUniformNode && key === 'value')) continue;
      const v = node[key];
      if (isNode(v)) {
        const s = visit(v);
        if (s === null) return null;
        out += `,${key}=(${s})`;
      } else if (Array.isArray(v)) {
        const items: string[] = [];
        for (const item of v) {
          if (isNode(item)) {
            const s = visit(item);
            if (s === null) return null;
            items.push(`(${s})`);
          } else items.push(valueSig(item));
        }
        out += `,${key}=[${items.join(',')}]`;
      } else if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        const items: string[] = [];
        for (const k of Object.keys(v)) {
          const item = (v as Record<string, unknown>)[k];
          if (isNode(item)) {
            const s = visit(item);
            if (s === null) return null;
            items.push(`${k}:(${s})`);
          } else items.push(`${k}:${valueSig(item)}`);
        }
        out += `,${key}={${items.join(',')}}`;
      } else out += `,${key}=${valueSig(v)}`;
    }
    memo.set(node, out);
    return out;
  };
  return visit(root);
}

function analyzeMaterial(mat: Material): MaterialInfo {
  const cached = materialInfos.get(mat);
  if (cached) return cached;
  const info: MaterialInfo = { sig: null, uniforms: [], stateKeys: [], reason: '' };
  materialInfos.set(mat, info);
  const m = mat as Material & Record<string, unknown> & { isNodeMaterial?: boolean };
  if (!m.isNodeMaterial) return Object.assign(info, { reason: 'not a node material' });
  // Transparent instances of one material blend order-independently among themselves only when
  // they don't depth-test against each other's writes.
  if (m.transparent && m.depthWrite) return Object.assign(info, { reason: 'transparent with depth write' });
  if (mat.onBeforeRender !== Object.getPrototypeOf(mat).onBeforeRender)
    return Object.assign(info, { reason: 'material render hook' });

  const parts: string[] = [`${mat.type}#${idOf(mat.constructor)}`];
  const memo = new Map<AnyNode, string>();
  const budget = { n: 4000 };
  for (const key of Object.keys(m).sort()) {
    if (
      key.startsWith('_') ||
      key === 'uuid' ||
      key === 'id' ||
      key === 'name' ||
      key === 'userData' ||
      key === 'version'
    )
      continue;
    const v = m[key];
    if (isNode(v)) {
      const s = graphSig(v, key, info, memo, budget);
      if (s === null) return info;
      parts.push(`${key}=${s}`);
    } else if (
      v !== null &&
      typeof v === 'object' &&
      !(v as { isTexture?: boolean }).isTexture &&
      typeof (v as { toArray?: unknown }).toArray === 'function'
    ) {
      info.stateKeys.push(key);
      parts.push(`${key}=${valueSig(v)}`);
    } else {
      if (typeof v === 'number' || typeof v === 'boolean') info.stateKeys.push(key);
      parts.push(`${key}=${valueSig(v)}`);
    }
  }
  info.sig = parts.join('|');
  return info;
}

/** Appends a material's and its uniforms' current dynamic values to `out`. */
function readState(mat: Material, info: MaterialInfo, out: number[]): void {
  const m = mat as unknown as Record<string, unknown>;
  for (const key of info.stateKeys) pushValue(m[key], out);
  for (const u of info.uniforms) pushValue(u.value, out);
}

function pushValue(v: unknown, out: number[]): void {
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'boolean') out.push(v ? 1 : 0);
  else if (v !== null && typeof v === 'object') {
    const o = v as {
      isColor?: boolean;
      isVector2?: boolean;
      isVector3?: boolean;
      isVector4?: boolean;
      isQuaternion?: boolean;
      isEuler?: boolean;
      elements?: ArrayLike<number>;
    } & Record<string, number>;
    if (o.isColor) out.push(o.r!, o.g!, o.b!);
    else if (o.isVector2) out.push(o.x!, o.y!);
    else if (o.isVector3) out.push(o.x!, o.y!, o.z!);
    else if (o.isVector4 || o.isQuaternion) out.push(o.x!, o.y!, o.z!, o.w!);
    else if (o.isEuler) out.push(o.x!, o.y!, o.z!);
    else if (o.elements) for (let i = 0; i < o.elements.length; i++) out.push(o.elements[i]!);
    else if (typeof (o as { toArray?: unknown }).toArray === 'function') {
      // Euler and other value types: compare by value (rare, so the array allocation is fine).
      for (const x of (o as unknown as { toArray(): unknown[] }).toArray())
        out.push(typeof x === 'number' ? x : NaN);
    } else out.push(idOf(v));
  } else out.push(NaN);
}

// -----------------------------------------------------------------------------
// Batcher
// -----------------------------------------------------------------------------

interface Member {
  mesh: Mesh;
  /** Set when the source is itself an InstancedMesh: each of its instances becomes one of ours. */
  instanced: InstancedMesh | null;
  geometry: BufferGeometry;
  material: Material;
  info: MaterialInfo;
  layerMask: number;
  castShadow: boolean;
  receiveShadow: boolean;
  /** Drawn by the batch this frame (sources hidden via an empty layer mask). */
  batched: boolean;
}

interface Batch {
  mesh: InstancedMesh;
  members: Member[];
  repState: number[];
  scratch: number[];
}

/** Options for {@link MeshBatcher}. */
export interface MeshBatcherOptions {
  /** Smallest group worth an instanced draw. Default 2. */
  minGroup?: number;
}

const tmpInst = new Matrix4();
const tmpWorld = new Matrix4();

/**
 * Collects meshes from registered roots and draws render-equivalent ones as
 * instanced batches.
 *
 * @example
 * const batcher = new MeshBatcher();
 * for (const o of obstacleVisuals) batcher.add(o.object);
 * batcher.build();
 * scene.add(batcher.object);
 * // nothing per frame: the batches sync themselves while the scene renders.
 */
export class MeshBatcher {
  /** Holds the instanced batches; add it to the same scene as the roots. */
  readonly object = new Group();
  private readonly roots: Object3D[] = [];
  private readonly batches: Batch[] = [];
  private readonly minGroup: number;
  private built = false;
  private lastFrame = -1;
  private failed = false;

  constructor(opts: MeshBatcherOptions = {}) {
    this.minGroup = Math.max(2, opts.minGroup ?? 2);
    this.object.name = 'batches';
  }

  /** Registers a subtree whose meshes may be batched. Call before {@link build}. */
  add(root: Object3D): void {
    if (this.built) throw new Error('MeshBatcher: add() after build()');
    this.roots.push(root);
  }

  /** Sources drawn through batches when last updated, and the number of batch draws. */
  get stats(): { sources: number; batches: number; batchedNow: number } {
    let sources = 0;
    let now = 0;
    for (const b of this.batches) {
      sources += b.members.length;
      for (const m of b.members) if (m.batched) now++;
    }
    return { sources, batches: this.batches.length, batchedNow: now };
  }

  /** Groups the registered meshes and creates the instanced batches. */
  build(): void {
    if (this.built) return;
    this.built = true;
    const groups = new Map<string, Member[]>();
    for (const root of this.roots) {
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!isCandidate(mesh)) return;
        const material = mesh.material as Material;
        const info = analyzeMaterial(material);
        if (info.sig === null) return;
        if (mesh.matrixWorld.determinant() < 0) return;
        const instanced = (mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh
          ? (mesh as unknown as InstancedMesh)
          : null;
        const colored = instanced?.instanceColor ? 1 : 0;
        const key = `${geometryKey(mesh.geometry)}\n${info.sig}\n${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}|c${colored}`;
        let list = groups.get(key);
        if (!list) groups.set(key, (list = []));
        list.push({
          mesh,
          instanced,
          geometry: mesh.geometry,
          material,
          info,
          layerMask: mesh.layers.mask,
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
          batched: false,
        });
      });
    }
    // NOTE: the typings declare WebGLRenderer; WebGPURenderer passes itself (with `info.frame`).
    const sync = ((renderer: { info: { frame: number } }) => {
      try {
        this.sync(renderer.info.frame);
      } catch (err) {
        // A throw here would abort the whole scene render (blank frame) every frame; fail loudly once instead.
        if (!this.failed) console.error('[MeshBatcher] sync failed', err);
        this.failed = true;
      }
    }) as unknown as Mesh['onBeforeRender'];
    for (const members of groups.values()) {
      if (members.length < this.minGroup) continue;
      const rep = members[0]!;
      let capacity = 0;
      for (const m of members) capacity += m.instanced ? m.instanced.instanceMatrix.count : 1;
      const inst = new InstancedMesh(rep.geometry, rep.material, capacity);
      if (rep.instanced?.instanceColor) {
        inst.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        inst.instanceColor.setUsage(DynamicDrawUsage);
      }
      inst.name = `batch:${rep.mesh.name || rep.mesh.parent?.name || rep.material.type}`;
      inst.instanceMatrix.setUsage(DynamicDrawUsage);
      inst.castShadow = rep.castShadow;
      inst.receiveShadow = rep.receiveShadow;
      inst.renderOrder = rep.mesh.renderOrder;
      inst.matrixAutoUpdate = false;
      inst.count = 0;
      // Instances move every frame and the sync runs after culling, so bounds would always be stale.
      inst.frustumCulled = false;
      inst.onBeforeRender = sync;
      this.batches.push({ mesh: inst, members, repState: [], scratch: [] });
      this.object.add(inst);
    }
  }

  /**
   * Per-frame sync, run from the first batch the renderer draws (shadow or
   * main pass) — after the scene's world matrices were updated and after the
   * render list was built. A source's layer mask therefore only takes effect
   * next frame, so membership changes are staged:
   * - a batched source (not in this frame's list) that is visible is always
   *   drawn by the batch this frame; if it stopped matching, it gets its own
   *   draw back from the next frame;
   * - an individually drawn source that now matches keeps its own draw this
   *   frame and joins the batch next frame.
   * Nothing is ever drawn twice or skipped; a diverging member shows its
   * group's material state for at most one frame.
   */
  private sync(frame: number): void {
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    const sceneRoot = rootOf(this.object);
    for (const b of this.batches) {
      const rep = b.members[0]!;
      b.repState.length = 0;
      readState(rep.material, rep.info, b.repState);
      const arr = b.mesh.instanceMatrix.array as Float32Array;
      const colors = b.mesh.instanceColor?.array as Float32Array | undefined;
      let n = 0;
      let joining = 0;
      for (const m of b.members) {
        const visible = isShown(m.mesh, sceneRoot);
        const ok = visible && this.matches(m, b);
        if (m.batched) {
          if (visible) n = writeMember(m, arr, colors, n);
          if (visible && !ok) m.batched = false;
        } else if (ok) m.batched = true;
        if (m.batched && ok) joining++;
      }
      if (joining < this.minGroup) for (const m of b.members) m.batched = false;
      for (const m of b.members) m.mesh.layers.mask = m.batched ? 0 : m.layerMask;
      b.mesh.count = n;
      if (n > 0) {
        b.mesh.instanceMatrix.clearUpdateRanges();
        b.mesh.instanceMatrix.addUpdateRange(0, n * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) {
          b.mesh.instanceColor.clearUpdateRanges();
          b.mesh.instanceColor.addUpdateRange(0, n * 3);
          b.mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  private matches(m: Member, b: Batch): boolean {
    const mesh = m.mesh;
    if (mesh.geometry !== m.geometry || mesh.material !== m.material) return false;
    if (mesh.castShadow !== m.castShadow || mesh.receiveShadow !== m.receiveShadow) return false;
    // The source's own layer mask is ours while batched; a change by obstacle code means "leave me alone".
    if (!m.batched && mesh.layers.mask !== m.layerMask) return false;
    if (m !== b.members[0]) {
      b.scratch.length = 0;
      readState(m.material, m.info, b.scratch);
      const r = b.repState;
      if (b.scratch.length !== r.length) return false;
      for (let i = 0; i < r.length; i++)
        if (b.scratch[i] !== r[i] && !(Number.isNaN(r[i]) && Number.isNaN(b.scratch[i]))) return false;
    }
    return true;
  }

  /** Removes the batches and gives every source back its own draw. */
  dispose(): void {
    for (const b of this.batches) {
      for (const m of b.members) m.mesh.layers.mask = m.layerMask;
      b.mesh.dispose();
    }
    this.batches.length = 0;
    this.roots.length = 0;
    this.object.removeFromParent();
  }
}

/**
 * Explains whether a mesh can join a batch (diagnostics and tests).
 *
 * @returns `ok` or the reason it always draws on its own.
 */
export function batchability(mesh: Mesh): string {
  if (!isCandidate(mesh)) return 'not a plain mesh';
  const info = analyzeMaterial(mesh.material as Material);
  return info.sig === null ? info.reason : 'ok';
}

function isCandidate(mesh: Mesh): boolean {
  const m = mesh as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean };
  if (!m.isMesh || m.isSkinnedMesh || m.isBatchedMesh) return false;
  // Instanced sources need their transforms in a plain instance matrix we can read back.
  if (m.isInstancedMesh && (m as unknown as InstancedMesh).instanceMatrix.itemSize !== 16) return false;
  if (Array.isArray(m.material) || !m.geometry.getAttribute('position')) return false;
  if (m.onBeforeRender !== Object.getPrototypeOf(m).onBeforeRender) return false;
  if (m.morphTargetInfluences && m.morphTargetInfluences.length > 0) return false;
  return true;
}

/** Writes a member's transform(s) (all instances of an instanced source); returns the next free slot. */
function writeMember(m: Member, out: Float32Array, colors: Float32Array | undefined, n: number): number {
  const src = m.instanced;
  if (!src) {
    m.mesh.matrixWorld.toArray(out, n * 16);
    return n + 1;
  }
  const srcArr = src.instanceMatrix.array as Float32Array;
  const srcCol = src.instanceColor?.array as Float32Array | undefined;
  for (let i = 0; i < src.count; i++, n++) {
    tmpInst.fromArray(srcArr, i * 16);
    tmpWorld.multiplyMatrices(src.matrixWorld, tmpInst);
    tmpWorld.toArray(out, n * 16);
    if (colors && srcCol) {
      colors[n * 3] = srcCol[i * 3]!;
      colors[n * 3 + 1] = srcCol[i * 3 + 1]!;
      colors[n * 3 + 2] = srcCol[i * 3 + 2]!;
    }
  }
  return n;
}

/** True when the mesh and every ancestor are visible and it hangs under `sceneRoot`. */
function isShown(mesh: Object3D, sceneRoot: Object3D): boolean {
  let o: Object3D = mesh;
  for (;;) {
    if (!o.visible) return false;
    if (!o.parent) return o === sceneRoot;
    o = o.parent;
  }
}

function rootOf(o: Object3D): Object3D {
  let r = o;
  while (r.parent) r = r.parent;
  return r;
}
