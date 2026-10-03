import { InstancedInterleavedBuffer, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import {
  cross,
  float,
  instancedBufferAttribute,
  normalize,
  positionGeometry,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GroundProbe } from './types.ts';
import { COLORS } from './palette.ts';

/**
 * Blob shadows: one soft dark disc under every character, one draw call.
 *
 * Responsibilities:
 * - CPU-written per frame (≤ budget), one contiguous upload.
 * - Probes the ground under each caster, aligns the disc to the ground normal
 *   and fades/grows it with height so jumps read clearly.
 * - Sits on the ground with a lift + polygon offset so it never z-fights,
 *   and is drawn without depth writes so it never hides anything.
 *
 * Layout (8 floats): 0 centre.xyz, radius | 4 normal.xyz, opacity.
 */

const STRIDE = 8;
/** Probe starts this far above the feet so a caster standing on a slope still hits. */
const PROBE_LIFT = 0.25;
/** Height (m) at which the shadow reaches its faintest/widest. */
const FADE_HEIGHT = 6;

const probeOut = { y: 0, nx: 0, ny: 1, nz: 0 };

/**
 * Pool of blob shadows.
 *
 * @example
 * shadows.setCount(players.length);
 * players.forEach((p, i) => shadows.set(i, p.x, p.y, p.z));
 */
export class BlobShadows {
  /** The single draw call. */
  readonly object: Mesh;
  private readonly data: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly material: MeshBasicNodeMaterial;
  private limit: number;
  private count = 0;
  private probe: GroundProbe | null = null;

  /**
   * @param capacity - Allocated shadow slots.
   * @param limit - Active budget (≤ capacity).
   */
  constructor(capacity: number, limit: number) {
    const cap = Math.max(1, capacity | 0);
    this.limit = Math.min(cap, Math.max(1, limit | 0));
    this.data = new Float32Array(cap * STRIDE);
    const material = new MeshBasicNodeMaterial();
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    const a0 = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 0) as Node<'vec4'>;
    const a1 = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 4) as Node<'vec4'>;

    const n = normalize(a1.xyz);
    // Any axis not parallel to a ground normal works; ground is never vertical enough to hit Z.
    const tangent = normalize(cross(vec3(0, 0, 1), n));
    const bitangent = cross(n, tangent);
    const local = tangent.mul(positionGeometry.x).add(bitangent.mul(positionGeometry.y)).mul(a0.w);
    material.positionNode = a0.xyz.add(local).add(n.mul(0.02));

    const c = uv().mul(2).sub(1);
    const r = c.length();
    const falloff = float(1).sub(smoothstep(0.25, 1, r));
    const shadowColor = uniform(COLORS.shadow.clone());
    material.colorNode = vec4(shadowColor, falloff.mul(falloff.add(0.35)).mul(a1.w).clamp(0, 1));
    material.transparent = true;
    material.depthWrite = false;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -4;
    material.fog = true;
    this.material = material;

    this.object = new Mesh(new PlaneGeometry(2, 2), material);
    this.object.name = 'vfx-blob-shadows';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    // Before other transparent VFX so sparkles and decals layer over the shadow.
    this.object.renderOrder = -10;
  }

  /** Active budget. */
  get capacity(): number {
    return this.limit;
  }

  /**
   * Changes the shadow budget (clamped to the allocation).
   *
   * @param n - Max shadows.
   */
  setCapacity(n: number): void {
    this.limit = Math.min(this.data.length / STRIDE, Math.max(1, n | 0));
    this.setCount(Math.min(this.count, this.limit));
  }

  /**
   * Sets the ground probe; null puts shadows at the casters' feet.
   *
   * @param probe - Downward ray/height query.
   */
  setProbe(probe: GroundProbe | null): void {
    this.probe = probe;
  }

  /**
   * Sets how many shadows are drawn this frame and schedules their upload.
   *
   * @param count - Active casters (clamped to the budget).
   */
  setCount(count: number): void {
    this.count = Math.max(0, Math.min(this.limit, count | 0));
    this.object.count = this.count;
    this.object.visible = this.count > 0;
    this.buffer.clearUpdateRanges();
    if (this.count > 0) {
      this.buffer.addUpdateRange(0, this.count * STRIDE);
      this.buffer.needsUpdate = true;
    }
  }

  /**
   * Places shadow `index` under feet position (x, y, z).
   *
   * @param index - Slot < current count.
   * @param x - Feet x.
   * @param y - Feet y.
   * @param z - Feet z.
   * @param radius - Shadow radius on the ground when touching it.
   */
  set(index: number, x: number, y: number, z: number, radius = 0.45): void {
    if (index < 0 || index >= this.count) return;
    const d = this.data;
    const o = index * STRIDE;
    let gy = y;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let opacity = 0.55;
    let size = radius;
    if (this.probe) {
      if (this.probe(x, y + PROBE_LIFT, z, probeOut)) {
        gy = probeOut.y;
        const len = Math.hypot(probeOut.nx, probeOut.ny, probeOut.nz) || 1;
        nx = probeOut.nx / len;
        ny = probeOut.ny / len;
        nz = probeOut.nz / len;
        const h = Math.max(0, y - gy);
        const f = Math.min(1, h / FADE_HEIGHT);
        opacity = 0.55 - 0.4 * f;
        size = radius * (0.92 + 0.6 * f);
      } else {
        opacity = 0;
      }
    }
    d[o] = x;
    d[o + 1] = gy;
    d[o + 2] = z;
    d[o + 3] = size;
    d[o + 4] = nx;
    d[o + 5] = ny;
    d[o + 6] = nz;
    d[o + 7] = opacity;
  }

  /** Hides every shadow. */
  clear(): void {
    this.setCount(0);
  }

  /** Frees GPU resources. */
  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}
