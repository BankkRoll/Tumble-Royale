/**
 * Automatic instancing of render-equivalent meshes.
 *
 * Responsibilities:
 * - Finds meshes under the registered roots that would render identically
 *   apart from their transform: same geometry content and a structurally
 *   identical node material (same node graph, constants, textures and render
 *   state) whose uniforms and material-referenced values currently match.
 * - Draws each such group as one `InstancedMesh` and hides the sources with an
 *   empty layer mask, so obstacle code keeps animating, showing and hiding its
 *   own meshes exactly as before.
 * - Every frame, re-validates each member (visibility, material/uniform state,
 *   shadow flags); members that diverge from their group's representative —
 *   e.g. one hammer's telegraph glow ramping up — are drawn individually until
 *   they match again.
 * - Keeps per-grid-cell bounds of each batch's instances and culls a batch
 *   from every render pass (view, shadow cascades) that sees none of them.
 *
 * Conservative by construction: anything it cannot prove equivalent (opaque
 * per-material `Fn` closures, per-object uniforms, model-matrix accessors,
 * transparency, skinning, custom render hooks) stays an individual draw.
 */
import {
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
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
  isMaterialReferenceNode?: boolean;
  value?: unknown;
} & Record<string, unknown>;

/** Nodes whose meaning changes when the mesh becomes one instance of many. */
const OBJECT_SPACE_NODES = new Set<unknown>([positionLocal, normalLocal]);
const MODEL_NODES = new Set<unknown>([modelWorldMatrix, modelPosition, modelScale, instanceIndex]);
const SKIP_KEYS = new Set(['id', 'uuid', 'version', 'stackTrace', 'parents', 'isNode']);
/** Node types that read a property off some object at draw time (three sets no flag on them). */
const REFERENCE_TYPES = /ReferenceNode$|^UserDataNode$/;

/** Result of analysing one material. */
interface MaterialInfo {
  /** Null when the material can't be proven instancing-safe. */
  sig: string | null;
  /** Uniform nodes in graph order; their values must match across a group every frame. */
  uniforms: AnyNode[];
  /** Material own-property keys three re-reads every frame (uniform-like values, `visible`). */
  stateKeys: string[];
  /**
   * The other numeric/colour/vector own-property keys: render state, which
   * three only picks up after `material.needsUpdate` (a `version` bump).
   */
  pipelineKeys: string[];
  /** Property paths material reference nodes read (`userData.uniforms.x.value`), split at dots. */
  refs: string[][];
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
    if (node.isMaterialReferenceNode === true || REFERENCE_TYPES.test(node.type)) {
      // A material reference reads the drawing material's own value: compared per frame like a uniform.
      // Other references read a fixed or per-object source, which a group of instances can't share.
      if (node.isMaterialReferenceNode !== true || node.material != null)
        return fail(`${slot}: object reference`);
      const sig = `Ref:${String(node.property)}:${String(node.uniformType)}`;
      info.refs.push(String(node.property).split('.'));
      memo.set(node, sig);
      return sig;
    }
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
  const info: MaterialInfo = {
    sig: null,
    uniforms: [],
    stateKeys: [],
    pipelineKeys: [],
    refs: [],
    reason: '',
  };
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
      (FRAME_KEYS.has(key) ? info.stateKeys : info.pipelineKeys).push(key);
      parts.push(`${key}=${valueSig(v)}`);
    } else {
      if ((typeof v === 'number' || typeof v === 'boolean') && !TYPE_FLAG.test(key))
        (FRAME_KEYS.has(key) ? info.stateKeys : info.pipelineKeys).push(key);
      parts.push(`${key}=${valueSig(v)}`);
    }
  }
  info.sig = parts.join('|');
  return info;
}

/** Constant type flags (`isMaterial`, `isMeshToonNodeMaterial`, …). */
const TYPE_FLAG = /^is[A-Z]/;

/**
 * Material properties three reads afresh every frame: its NodeMaterialObserver
 * refresh list, plus the ones render-list building and draw submission read
 * (`visible`, `transparent`, `side`, depth and colour writes, blending).
 * Changes to any other property only reach the GPU after
 * `material.needsUpdate`, so the batcher re-checks those only when a
 * material's `version` moved.
 */
const FRAME_KEYS = new Set([
  'blending',
  'colorWrite',
  'depthTest',
  'depthWrite',
  'forceSinglePass',
  'side',
  'transparent',
  'alphaTest',
  'anisotropy',
  'anisotropyRotation',
  'aoMapIntensity',
  'attenuationColor',
  'attenuationDistance',
  'bumpScale',
  'clearcoat',
  'clearcoatNormalScale',
  'clearcoatRoughness',
  'color',
  'dashOffset',
  'dashSize',
  'dispersion',
  'displacementBias',
  'displacementScale',
  'emissive',
  'emissiveIntensity',
  'envMapIntensity',
  'envMapRotation',
  'gapSize',
  'ior',
  'iridescence',
  'iridescenceIOR',
  'lightMapIntensity',
  'linewidth',
  'metalness',
  'normalScale',
  'opacity',
  'reflectivity',
  'retroreflectivity',
  'rotation',
  'roughness',
  'scale',
  'sheen',
  'sheenColor',
  'sheenRoughness',
  'shininess',
  'size',
  'specular',
  'specularColor',
  'specularIntensity',
  'steps',
  'thickness',
  'transmission',
  'visible',
  'wireframe',
]);

function readPath(mat: Material, path: readonly string[]): unknown {
  let v: unknown = mat;
  for (const key of path) v = v === null || v === undefined ? v : (v as Record<string, unknown>)[key];
  return v;
}

/**
 * Whether two materials with the same signature currently hold the same
 * dynamic values (own state keys, uniform values, material references).
 *
 * PERF: compares value objects in place. The previous version flattened both
 * materials into number arrays every frame, which cost ~3% of main-thread
 * time with 330 batched sources.
 */
function sameState(
  a: Material,
  ai: MaterialInfo,
  b: Material,
  bi: MaterialInfo,
  withPipeline: boolean,
): boolean {
  if (a === b) return true;
  const am = a as unknown as Record<string, unknown>;
  const bm = b as unknown as Record<string, unknown>;
  const keys = ai.stateKeys;
  for (let i = 0; i < keys.length; i++) if (!sameValue(am[keys[i]!], bm[keys[i]!])) return false;
  if (withPipeline) {
    const pk = ai.pipelineKeys;
    for (let i = 0; i < pk.length; i++) if (!sameValue(am[pk[i]!], bm[pk[i]!])) return false;
  }
  const au = ai.uniforms;
  const bu = bi.uniforms;
  if (au.length !== bu.length) return false;
  for (let i = 0; i < au.length; i++) if (!sameValue(au[i]!.value, bu[i]!.value)) return false;
  const refs = ai.refs;
  for (let i = 0; i < refs.length; i++)
    if (!sameValue(readPath(a, refs[i]!), readPath(b, refs[i]!))) return false;
  return true;
}

type ValueLike = {
  isColor?: boolean;
  isVector2?: boolean;
  isVector3?: boolean;
  isVector4?: boolean;
  isQuaternion?: boolean;
  isEuler?: boolean;
  elements?: ArrayLike<number>;
  toArray?: () => unknown[];
} & Record<string, number>;

function sameNumber(x: number, y: number): boolean {
  return x === y || (x !== x && y !== y);
}

/**
 * Value equality as the batcher needs it: numbers and booleans by value (NaN
 * equals NaN), colours, vectors, quaternions, Eulers and matrices by
 * component, anything else by identity. Two non-numeric primitives (strings,
 * undefined) count as equal: they never reach a shader.
 */
function sameValue(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  const tx = typeof x;
  const ty = typeof y;
  if ((tx === 'number' || tx === 'boolean') && (ty === 'number' || ty === 'boolean'))
    return sameNumber(Number(x), Number(y));
  const ox = x !== null && tx === 'object';
  const oy = y !== null && ty === 'object';
  if (!ox || !oy) return !ox && !oy && tx !== 'number' && ty !== 'number';
  const a = x as ValueLike;
  const b = y as ValueLike;
  if (a.isColor) return b.isColor === true && a.r === b.r && a.g === b.g && a.b === b.b;
  if (a.isVector2) return b.isVector2 === true && sameNumber(a.x!, b.x!) && sameNumber(a.y!, b.y!);
  if (a.isVector3 || a.isEuler)
    return (
      (b.isVector3 === true || b.isEuler === true) &&
      sameNumber(a.x!, b.x!) &&
      sameNumber(a.y!, b.y!) &&
      sameNumber(a.z!, b.z!) &&
      (!a.isEuler || a.order === b.order)
    );
  if (a.isVector4 || a.isQuaternion)
    return (
      sameNumber(a.x!, b.x!) && sameNumber(a.y!, b.y!) && sameNumber(a.z!, b.z!) && sameNumber(a.w!, b.w!)
    );
  if (a.elements && b.elements) {
    if (a.elements.length !== b.elements.length) return false;
    for (let i = 0; i < a.elements.length; i++) if (!sameNumber(a.elements[i]!, b.elements[i]!)) return false;
    return true;
  }
  if (typeof a.toArray === 'function' && typeof b.toArray === 'function') {
    const pa = a.toArray();
    const pb = b.toArray();
    if (pa.length !== pb.length) return false;
    for (let i = 0; i < pa.length; i++) if (!sameValue(pa[i], pb[i])) return false;
    return true;
  }
  return false;
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
  /** This member's and the representative's material `version` when their pipeline keys last matched. */
  checked: [number, number];
}

interface Batch {
  mesh: InstancedMesh;
  members: Member[];
  /** Layer mask the batch draws with whenever a pass does not cull it. */
  layerMask: number;
  /** Bounding sphere of the shared geometry (local space). */
  center: Vector3;
  radius: number;
  /** Ground-grid cell key → slot in {@link Batch.bounds}. */
  cells: Map<number, number>;
  /** Per cell: world AABB (min xyz, max xyz) of this frame's instances; empty while min > max. */
  bounds: Float32Array;
}

/** Options for {@link MeshBatcher}. */
export interface MeshBatcherOptions {
  /** Smallest group worth an instanced draw. Default 2. */
  minGroup?: number;
}

/**
 * Edge (m) of the ground-grid cells a batch's culling bounds are kept in:
 * about a quarter of the nearest shadow cascade's width at High, so a batch
 * whose members line a whole course is still culled from cascades and views
 * that only see one end of it.
 */
const CELL_M = 16;
/** Cell coordinates are packed into one number: x * CELL_STRIDE + z. */
const CELL_STRIDE = 1 << 16;

const tmpInst = new Matrix4();
const tmpWorld = new Matrix4();
const projScreen = new Matrix4();
const frustum = new Frustum();

/** The renderer surface the batcher reads (`info.frame`); typings declare WebGLRenderer. */
interface FrameSource {
  info: { frame: number };
}

/**
 * Collects meshes from registered roots and draws render-equivalent ones as
 * instanced batches.
 *
 * Attached to a scene ({@link MeshBatcher.attach}), the batches sync before
 * each frame's render lists are built and are culled per render pass (main
 * view and every shadow cascade) by the bounds of the grid cells their
 * instances occupy, so a batch only draws in passes that can see one of its
 * members.
 *
 * @example
 * const batcher = new MeshBatcher();
 * for (const o of obstacleVisuals) batcher.add(o.object);
 * batcher.build();
 * batcher.attach(scene);
 * // nothing per frame: the batches sync themselves while the scene renders.
 */
export class MeshBatcher {
  /** Holds the instanced batches; add it to the same scene as the roots (or use {@link attach}). */
  readonly object = new Group();
  private readonly roots: Object3D[] = [];
  private readonly batches: Batch[] = [];
  private readonly minGroup: number;
  private built = false;
  private lastFrame = -1;
  private failed = false;
  private scene: Scene | null = null;
  private hook: Scene['onBeforeRender'] | null = null;
  private prevHook: Scene['onBeforeRender'] | null = null;

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
          checked: [material.version, -1],
        });
      });
    }
    const sync = ((renderer: FrameSource) =>
      this.safeSync(renderer.info.frame)) as unknown as Mesh['onBeforeRender'];
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
      // Unattached, the sync runs after culling, so bounds would always be a frame stale: never cull then.
      inst.frustumCulled = this.scene !== null;
      inst.boundingSphere = new Sphere();
      // Fallback sync for an unattached batcher (a no-op once the scene hook ran this frame).
      inst.onBeforeRender = sync;
      if (!rep.geometry.boundingSphere) rep.geometry.computeBoundingSphere();
      const gs = rep.geometry.boundingSphere as Sphere | null;
      this.batches.push({
        mesh: inst,
        members,
        layerMask: inst.layers.mask,
        center: gs ? gs.center.clone() : new Vector3(),
        radius: gs ? gs.radius : 0,
        cells: new Map(),
        bounds: emptyBounds(8),
      });
      this.object.add(inst);
    }
  }

  /**
   * Adds the batches to `scene` and syncs them from its `onBeforeRender`,
   * i.e. before any render list of the frame is built. Every render (the
   * view, each shadow cascade) then hides the batches none of whose occupied
   * grid cells it can see.
   *
   * PERF: before, every batch drew in all three CSM cascades: 37 of the ~55
   * shadow draws per cascade on Tilt Town with 100 players.
   *
   * @param scene - The scene the registered roots render in.
   */
  attach(scene: Scene): void {
    if (this.scene) return;
    this.scene = scene;
    scene.add(this.object);
    const prev = scene.onBeforeRender;
    const before = (renderer: FrameSource, camera: Camera): void => this.beforeRender(renderer, camera);
    const hook = function (this: Scene, ...args: Parameters<Scene['onBeforeRender']>): void {
      prev.apply(this, args);
      before(args[0] as unknown as FrameSource, args[2]);
    };
    this.prevHook = prev;
    this.hook = hook;
    scene.onBeforeRender = hook;
    for (const b of this.batches) b.mesh.frustumCulled = true;
  }

  private beforeRender(renderer: FrameSource, camera: Camera): void {
    this.safeSync(renderer.info.frame);
    if (this.failed) return;
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(
      projScreen,
      camera.coordinateSystem,
      (camera as Camera & { reversedDepth?: boolean }).reversedDepth === true,
    );
    for (const b of this.batches) {
      // The warm-up turns culling off to reach every pipeline: draw everything then.
      const shown = !b.mesh.frustumCulled || anyCellVisible(b);
      b.mesh.layers.mask = shown ? b.layerMask : 0;
    }
  }

  private safeSync(frame: number): void {
    try {
      this.sync(frame);
    } catch (err) {
      // A throw here would abort the whole scene render (blank frame) every frame; fail loudly once instead.
      if (!this.failed) console.error('[MeshBatcher] sync failed', err);
      this.failed = true;
      for (const b of this.batches) b.mesh.layers.mask = b.layerMask;
    }
  }

  /**
   * Per-frame sync, run before the frame's first render list is built when
   * attached, else from the first batch the renderer draws (after culling).
   * A source's layer mask may then only take effect next frame, so
   * membership changes are staged:
   * - a batched source that is visible is always drawn by the batch this
   *   frame; if it stopped matching, it gets its own draw back from the next
   *   frame;
   * - an individually drawn source that now matches keeps its own draw this
   *   frame and joins the batch next frame.
   * Nothing is ever drawn twice or skipped; a diverging member shows its
   * group's material state for at most one frame.
   */
  private sync(frame: number): void {
    if (frame === this.lastFrame || this.failed) return;
    this.lastFrame = frame;
    const sceneRoot = rootOf(this.object);
    for (const b of this.batches) {
      const rep = b.members[0]!;
      const arr = b.mesh.instanceMatrix.array as Float32Array;
      const colors = b.mesh.instanceColor?.array as Float32Array | undefined;
      clearBounds(b.bounds);
      let n = 0;
      let joining = 0;
      for (const m of b.members) {
        const visible = isShown(m.mesh, sceneRoot);
        const ok = visible && this.matches(m, rep);
        if (m.batched) {
          if (visible) {
            const start = n;
            n = writeMember(m, arr, colors, n);
            for (let i = start; i < n; i++) growCell(b, arr, i * 16);
          }
          if (visible && !ok) m.batched = false;
        } else if (ok) m.batched = true;
        if (m.batched && ok) joining++;
      }
      if (joining < this.minGroup) for (const m of b.members) m.batched = false;
      for (const m of b.members) m.mesh.layers.mask = m.batched ? 0 : m.layerMask;
      b.mesh.count = n;
      fitSphere(b);
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

  private matches(m: Member, rep: Member): boolean {
    const mesh = m.mesh;
    if (mesh.geometry !== m.geometry || mesh.material !== m.material) return false;
    if (mesh.castShadow !== m.castShadow || mesh.receiveShadow !== m.receiveShadow) return false;
    // The source's own layer mask is ours while batched; a change by obstacle code means "leave me alone".
    if (!m.batched && mesh.layers.mask !== m.layerMask) return false;
    if (m === rep) return true;
    const c = m.checked;
    const v = m.material.version;
    const rv = rep.material.version;
    const fresh = c[0] !== v || c[1] !== rv;
    if (!sameState(m.material, m.info, rep.material, rep.info, fresh)) return false;
    c[0] = v;
    c[1] = rv;
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
    if (this.scene && this.prevHook && this.scene.onBeforeRender === this.hook)
      this.scene.onBeforeRender = this.prevHook;
    this.scene = null;
    this.hook = null;
    this.prevHook = null;
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

function emptyBounds(cells: number): Float32Array {
  return clearBounds(new Float32Array(cells * 6));
}

function clearBounds(s: Float32Array): Float32Array {
  for (let i = 0; i < s.length; i += 6) {
    s[i] = s[i + 1] = s[i + 2] = Infinity;
    s[i + 3] = s[i + 4] = s[i + 5] = -Infinity;
  }
  return s;
}

/** Grows the bounds of the grid cell holding the instance whose world matrix starts at `e[o]`. */
function growCell(b: Batch, e: Float32Array, o: number): void {
  const c = b.center;
  const x = e[o]! * c.x + e[o + 4]! * c.y + e[o + 8]! * c.z + e[o + 12]!;
  const y = e[o + 1]! * c.x + e[o + 5]! * c.y + e[o + 9]! * c.z + e[o + 13]!;
  const z = e[o + 2]! * c.x + e[o + 6]! * c.y + e[o + 10]! * c.z + e[o + 14]!;
  const sx = e[o]! * e[o]! + e[o + 1]! * e[o + 1]! + e[o + 2]! * e[o + 2]!;
  const sy = e[o + 4]! * e[o + 4]! + e[o + 5]! * e[o + 5]! + e[o + 6]! * e[o + 6]!;
  const sz = e[o + 8]! * e[o + 8]! + e[o + 9]! * e[o + 9]! + e[o + 10]! * e[o + 10]!;
  const r = b.radius * Math.sqrt(Math.max(sx, sy, sz));
  const key = Math.floor(x / CELL_M) * CELL_STRIDE + Math.floor(z / CELL_M);
  let slot = b.cells.get(key);
  if (slot === undefined) {
    slot = b.cells.size;
    b.cells.set(key, slot);
    if (slot * 6 >= b.bounds.length) {
      const grown = emptyBounds((b.bounds.length / 6) * 2);
      grown.set(b.bounds);
      b.bounds = grown;
    }
  }
  const s = b.bounds;
  const i = slot * 6;
  if (x - r < s[i]!) s[i] = x - r;
  if (y - r < s[i + 1]!) s[i + 1] = y - r;
  if (z - r < s[i + 2]!) s[i + 2] = z - r;
  if (x + r > s[i + 3]!) s[i + 3] = x + r;
  if (y + r > s[i + 4]!) s[i + 4] = y + r;
  if (z + r > s[i + 5]!) s[i + 5] = z + r;
}

/** Fits the batch's bounding sphere (three's own culling test) around every occupied cell. */
function fitSphere(b: Batch): void {
  const s = b.bounds;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < s.length; i += 6) {
    if (!(s[i]! <= s[i + 3]!)) continue;
    x0 = Math.min(x0, s[i]!);
    y0 = Math.min(y0, s[i + 1]!);
    z0 = Math.min(z0, s[i + 2]!);
    x1 = Math.max(x1, s[i + 3]!);
    y1 = Math.max(y1, s[i + 4]!);
    z1 = Math.max(z1, s[i + 5]!);
  }
  const sphere = b.mesh.boundingSphere as Sphere;
  if (x0 > x1) {
    sphere.makeEmpty();
    return;
  }
  sphere.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  sphere.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
}

/** True when the current {@link frustum} intersects any occupied cell's box. */
function anyCellVisible(b: Batch): boolean {
  const s = b.bounds;
  const planes = frustum.planes;
  for (let i = 0; i < s.length; i += 6) {
    if (!(s[i]! <= s[i + 3]!)) continue;
    let inside = true;
    for (let p = 0; p < 6; p++) {
      const { normal: nrm, constant } = planes[p]!;
      const px = nrm.x > 0 ? s[i + 3]! : s[i]!;
      const py = nrm.y > 0 ? s[i + 4]! : s[i + 1]!;
      const pz = nrm.z > 0 ? s[i + 5]! : s[i + 2]!;
      if (nrm.x * px + nrm.y * py + nrm.z * pz + constant < 0) {
        inside = false;
        break;
      }
    }
    if (inside) return true;
  }
  return false;
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
