/**
 * Crowd renderer: draws every registered Tumbler with a handful of draw calls.
 *
 * Responsibilities:
 * - Packs each member's LOD 0/1/2 assembly geometry into one shared vertex
 *   buffer tagged with a per-vertex slot (`aSlot`), and keeps one index buffer
 *   per LOD listing the triangles of the members currently at that LOD.
 * - Every frame, writes each member's 41 world-space bone matrices and its
 *   shader inputs (colours, pattern, face, fx, origin) into two float data
 *   textures that the crowd materials read by slot (see
 *   `createTumblerCrowdMaterials`).
 * - Hides members that are invisible or detached by collapsing their bones.
 *
 * Cost: 3 body draws (one per LOD) + 2 outline draws + 3 shadow draws for any
 * number of Tumblers, against 2–3 draws per Tumbler when drawn individually.
 *
 * The animation, face, accessory chains and ragdolls stay on each
 * {@link Tumbler}; the crowd only replaces how its meshes reach the GPU, so
 * the look is identical.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  Matrix4,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Uint16BufferAttribute,
  type Object3D,
  type TypedArray,
  type WebGPURenderer,
} from 'three/webgpu';
import { acquireAssembly, releaseAssembly, type Assembly } from './assembly.ts';
import type { Lod } from './geometry.ts';
import { CROWD_PARAM_TEXELS, createTumblerCrowdMaterials, writeCrowdParams, type TumblerMaterials } from './material.ts';
import { TOTAL_BONE_COUNT } from './rig.ts';
import type { Tumbler } from './tumbler.ts';

/** Attributes every assembly carries, with their component counts. */
const LAYOUT = [
  ['position', 3],
  ['normal', 3],
  ['color', 3],
  ['aKind', 1],
  ['aFace', 2],
  ['skinIndex', 4],
  ['skinWeight', 4],
] as const;

const BONE_TEXELS = TOTAL_BONE_COUNT * 4;
const LODS: readonly Lod[] = [0, 1, 2];

/** One member's packed geometry and draw state. */
interface Slot {
  readonly tumbler: Tumbler;
  /** Row in the bone / parameter textures. */
  readonly row: number;
  /** Assemblies this slot's vertices were copied from, per LOD. */
  assemblies: [Assembly, Assembly, Assembly];
  accessoryKey: string;
  /** Triangle indices per LOD, already offset into the shared vertex buffer. */
  indices: [Uint32Array, Uint32Array, Uint32Array];
  /** LOD whose index list currently includes this slot (-1 before the first build). */
  drawnLod: Lod | -1;
  /** Whether the bone row holds a live pose (false: collapsed). */
  shown: boolean;
}

/** Options for {@link TumblerCrowd}. */
export interface TumblerCrowdOptions {
  /** Max members (texture rows). Extra Tumblers are rejected and keep drawing themselves. Default 64. */
  capacity?: number;
  /** Cast shadows. Default true. */
  castShadow?: boolean;
}

const tmpM = new Matrix4();

/**
 * Batches many {@link Tumbler}s into a few draws.
 *
 * @example
 * const crowd = new TumblerCrowd();
 * scene.add(crowd.object);
 * for (const t of tumblers) { scene.add(t.object); crowd.add(t); }
 * // per frame: update every tumbler as usual; the crowd syncs itself while rendering.
 */
export class TumblerCrowd {
  /** Add to the scene the members live in. */
  readonly object = new Group();
  readonly capacity: number;
  private readonly boneData: Float32Array;
  private readonly paramData: Float32Array;
  private readonly boneTex: DataTexture;
  private readonly paramTex: DataTexture;
  private readonly materials: TumblerMaterials;
  private readonly slots: (Slot | null)[];
  private readonly members = new Map<Tumbler, Slot>();
  private readonly bodies: Mesh[] = [];
  private readonly outlines: Mesh[] = [];
  private geometries: BufferGeometry[] = [];
  private indexArrays: Uint32Array[] = [new Uint32Array(0), new Uint32Array(0), new Uint32Array(0)];
  private vertexDirty = true;
  private readonly lodDirty = [true, true, true];
  private lastFrame = -1;
  private disposed = false;
  private failed = false;

  constructor(opts: TumblerCrowdOptions = {}) {
    this.capacity = opts.capacity ?? 64;
    this.object.name = 'TumblerCrowd';
    // Debug/automation handle (A/B checks against individually drawn Tumblers). A registered
    // symbol, not userData: Object3D.copy deep-clones userData through JSON.
    (this.object as unknown as Record<symbol, unknown>)[Symbol.for('tumble.crowd')] = this;
    this.slots = new Array<Slot | null>(this.capacity).fill(null);
    this.boneData = new Float32Array(BONE_TEXELS * this.capacity * 4);
    this.paramData = new Float32Array(CROWD_PARAM_TEXELS * this.capacity * 4);
    this.boneTex = makeTexture(this.boneData, BONE_TEXELS, this.capacity);
    this.paramTex = makeTexture(this.paramData, CROWD_PARAM_TEXELS, this.capacity);
    this.materials = createTumblerCrowdMaterials(this.boneTex, this.paramTex);

    const castShadow = opts.castShadow ?? true;
    // NOTE: the typings declare WebGLRenderer; WebGPURenderer passes itself here.
    const sync = ((renderer: unknown): void => {
      try {
        this.sync(renderer as WebGPURenderer);
      } catch (err) {
        // A throw here would abort the whole scene render (blank frame) every frame; fail loudly once instead.
        if (!this.failed) console.error('[TumblerCrowd] sync failed', err);
        this.failed = true;
      }
    }) as unknown as Mesh['onBeforeRender'];
    for (const lod of LODS) {
      const geo = new BufferGeometry();
      this.geometries.push(geo);
      const body = new Mesh(geo, this.materials.body);
      body.name = `crowd-body-lod${lod}`;
      body.castShadow = castShadow;
      body.receiveShadow = true;
      // Members spread over the whole course; per-member culling is not worth a bounds pass.
      body.frustumCulled = false;
      body.matrixAutoUpdate = false;
      body.onBeforeRender = sync;
      this.bodies.push(body);
      this.object.add(body);
      if (lod < 2) {
        const outline = new Mesh(geo, this.materials.outline);
        outline.name = `crowd-outline-lod${lod}`;
        outline.frustumCulled = false;
        outline.matrixAutoUpdate = false;
        outline.onBeforeRender = sync;
        this.outlines.push(outline);
        this.object.add(outline);
      }
    }
  }

  /** Number of registered Tumblers. */
  get size(): number {
    return this.members.size;
  }

  /** True when `t` is drawn by this crowd. */
  has(t: Tumbler): boolean {
    return this.members.has(t);
  }

  /**
   * Starts drawing a Tumbler through the crowd (its own meshes stop rendering).
   *
   * @returns False when the crowd is full; the Tumbler then keeps drawing itself.
   */
  add(t: Tumbler): boolean {
    if (this.members.has(t)) return true;
    const row = this.slots.indexOf(null);
    if (row < 0 || this.disposed) return false;
    const accessories = t.crowdAccessories();
    const slot: Slot = {
      tumbler: t,
      row,
      assemblies: [acquireAssembly(0, accessories), acquireAssembly(1, accessories), acquireAssembly(2, [])],
      accessoryKey: t.crowdAccessoryKey(),
      indices: [new Uint32Array(0), new Uint32Array(0), new Uint32Array(0)],
      drawnLod: -1,
      shown: false,
    };
    this.slots[row] = slot;
    this.members.set(t, slot);
    t.setCrowdOwner(this);
    this.vertexDirty = true;
    // Shown until the first sync knows which LOD lists are empty.
    for (const m of [...this.bodies, ...this.outlines]) m.visible = true;
    return true;
  }

  /** Stops drawing a Tumbler through the crowd; it draws itself again. */
  remove(t: Tumbler): void {
    const slot = this.members.get(t);
    if (!slot) return;
    this.members.delete(t);
    this.slots[slot.row] = null;
    for (const a of slot.assemblies) releaseAssembly(a);
    this.zeroRow(slot.row);
    t.setCrowdOwner(null);
    this.vertexDirty = true;
  }

  // ---------------------------------------------------------------------------
  // Per-frame sync
  // ---------------------------------------------------------------------------

  /**
   * Runs once per frame from the first crowd mesh the renderer draws (shadow
   * or main pass), after the scene's world matrices were updated, so bone
   * matrices are current without a second matrix pass.
   */
  private sync(renderer: WebGPURenderer): void {
    const frame = renderer.info.frame;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;

    const root = rootOf(this.object);
    let bonesChanged = false;
    for (const slot of this.members.values()) {
      const t = slot.tumbler;
      if (t.crowdAccessoryKey() !== slot.accessoryKey) this.refreshAssemblies(slot);
      const lod = t.currentLod;
      if (lod !== slot.drawnLod) {
        const target = this.bodies[lod]!;
        if (!target.visible && slot.drawnLod >= 0) {
          // That LOD's meshes missed this frame's render list: keep drawing the old LOD
          // one more frame instead of dropping the Tumbler for a frame.
          target.visible = true;
          if (lod < 2) this.outlines[lod]!.visible = true;
        } else {
          if (slot.drawnLod >= 0) this.lodDirty[slot.drawnLod] = true;
          this.lodDirty[lod] = true;
          slot.drawnLod = lod;
        }
      }
      const visible = t.crowdVisible() && rootOf(t.object) === root;
      if (!visible) {
        if (slot.shown) {
          this.zeroRow(slot.row);
          slot.shown = false;
          bonesChanged = true;
        }
        continue;
      }
      slot.shown = true;
      bonesChanged = true;
      this.writeBones(slot, lod);
      const m = t.object.matrixWorld.elements;
      writeCrowdParams(this.paramData, slot.row, t.shader, m[12]!, m[13]!, m[14]!);
    }
    if (bonesChanged) {
      this.boneTex.needsUpdate = true;
      this.paramTex.needsUpdate = true;
    }

    if (this.vertexDirty) this.rebuildVertices();
    for (const lod of LODS) if (this.lodDirty[lod]) this.rebuildIndex(lod);
  }

  private writeBones(slot: Slot, lod: Lod): void {
    const out = this.boneData;
    let o = slot.row * BONE_TEXELS * 4;
    if (lod === 2) {
      // LOD 2 is a rigid stand-in posed by its group transform: every bone gets that matrix.
      const e = slot.tumbler.crowdLod2Matrix().elements;
      for (let i = 0; i < TOTAL_BONE_COUNT; i++, o += 16) out.set(e, o);
      return;
    }
    const bones = slot.tumbler.crowdBones();
    const inverses = slot.tumbler.crowdBoneInverses();
    for (let i = 0; i < TOTAL_BONE_COUNT; i++, o += 16) {
      tmpM.multiplyMatrices(bones[i]!.matrixWorld, inverses[i]!);
      out.set(tmpM.elements, o);
    }
  }

  private zeroRow(row: number): void {
    this.boneData.fill(0, row * BONE_TEXELS * 4, (row + 1) * BONE_TEXELS * 4);
    this.boneTex.needsUpdate = true;
  }

  private refreshAssemblies(slot: Slot): void {
    const t = slot.tumbler;
    const accessories = t.crowdAccessories();
    const next: [Assembly, Assembly, Assembly] = [acquireAssembly(0, accessories), acquireAssembly(1, accessories), acquireAssembly(2, [])];
    for (const a of slot.assemblies) releaseAssembly(a);
    slot.assemblies = next;
    slot.accessoryKey = t.crowdAccessoryKey();
    this.vertexDirty = true;
  }

  // ---------------------------------------------------------------------------
  // Geometry packing
  // ---------------------------------------------------------------------------

  /** Repacks every member's LOD geometries into fresh shared vertex buffers. */
  private rebuildVertices(): void {
    this.vertexDirty = false;
    let total = 0;
    for (const slot of this.members.values()) for (const a of slot.assemblies) total += a.geometry.getAttribute('position').count;

    const arrays = LAYOUT.map(([name, size]) => (name === 'skinIndex' ? new Uint16Array(total * size) : new Float32Array(total * size)));
    const slotIds = new Float32Array(total);
    let base = 0;
    for (const slot of this.members.values()) {
      slot.assemblies.forEach((a, lod) => {
        const g = a.geometry;
        const count = g.getAttribute('position').count;
        LAYOUT.forEach(([name, size], k) => {
          const src = g.getAttribute(name);
          if (src) arrays[k]!.set(src.array as TypedArray as ArrayLike<number>, base * size);
        });
        slotIds.fill(slot.row, base, base + count);
        const index = g.getIndex();
        let idx: Uint32Array;
        if (index) {
          idx = new Uint32Array(index.count);
          const srcIdx = index.array;
          for (let i = 0; i < idx.length; i++) idx[i] = (srcIdx[i] as number) + base;
        } else {
          idx = new Uint32Array(count);
          for (let i = 0; i < count; i++) idx[i] = base + i;
        }
        slot.indices[lod] = idx;
        base += count;
      });
    }

    const old = this.geometries;
    this.geometries = LODS.map(() => new BufferGeometry());
    const attrs = LAYOUT.map(([name, size], k) => {
      const arr = arrays[k]!;
      return [name, name === 'skinIndex' ? new Uint16BufferAttribute(arr, size) : new BufferAttribute(arr, size)] as const;
    });
    const slotAttr = new BufferAttribute(slotIds, 1);
    for (const geo of this.geometries) {
      for (const [name, attr] of attrs) geo.setAttribute(name, attr);
      geo.setAttribute('aSlot', slotAttr);
    }
    for (const lod of LODS) {
      this.bodies[lod]!.geometry = this.geometries[lod]!;
      if (lod < 2) this.outlines[lod]!.geometry = this.geometries[lod]!;
      this.indexArrays[lod] = new Uint32Array(0);
      this.lodDirty[lod] = true;
    }
    for (const g of old) g.dispose();
  }

  /** Rewrites one LOD's index list from the members currently drawn at that LOD. */
  private rebuildIndex(lod: Lod): void {
    this.lodDirty[lod] = false;
    let count = 0;
    for (const slot of this.members.values()) if (slot.drawnLod === lod) count += slot.indices[lod].length;
    const geo = this.geometries[lod]!;
    let arr = this.indexArrays[lod]!;
    const grow = arr.length < count || !geo.index;
    if (grow) arr = this.indexArrays[lod] = new Uint32Array(Math.max(count, Math.ceil(arr.length * 1.5), 3));
    let o = 0;
    for (const slot of this.members.values()) {
      if (slot.drawnLod !== lod) continue;
      arr.set(slot.indices[lod], o);
      o += slot.indices[lod].length;
    }
    if (grow) geo.setIndex(new BufferAttribute(arr, 1));
    else {
      const attr = geo.index!;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(count, 1));
      attr.needsUpdate = true;
    }
    geo.setDrawRange(0, count);
    // Empty LODs stop rendering; sync still runs from whichever mesh is visible.
    const any = count > 0;
    this.bodies[lod]!.visible = any;
    if (lod < 2) this.outlines[lod]!.visible = any;
    // At least one mesh must stay in the render list, or the per-frame sync would never run again.
    if (!this.bodies.some((b) => b.visible)) this.bodies[0]!.visible = true;
  }

  /** Releases GPU resources and returns every member to individual rendering. */
  dispose(): void {
    if (this.disposed) return;
    for (const t of [...this.members.keys()]) this.remove(t);
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    this.materials.body.dispose();
    this.materials.outline.dispose();
    this.boneTex.dispose();
    this.paramTex.dispose();
    this.object.removeFromParent();
  }
}

function makeTexture(data: Float32Array, width: number, height: number): DataTexture {
  const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function rootOf(o: Object3D): Object3D {
  let r = o;
  while (r.parent) r = r.parent;
  return r;
}
