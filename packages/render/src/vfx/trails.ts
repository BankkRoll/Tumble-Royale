import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
  type Camera,
  type Group,
} from 'three/webgpu';
import { attribute, float, fract, mix, pow, select, sin, smoothstep, step, vec3, vec4 } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import type { TrailHandle, TrailStyle } from './types.ts';
import { COLORS, GOLD_COLORS, RAINBOW_COLORS, hexColor } from './palette.ts';

/**
 * Cosmetic trail ribbons.
 *
 * Responsibilities:
 * - A fixed pool of ribbons, each its own mesh (one draw call per active trail)
 *   sharing a single node material so they compile once.
 * - Per trail, a ring of timestamped points; the head follows the emitter and
 *   a new point is committed every few centimetres.
 * - Each frame, active ribbons are rebuilt as camera-facing strips into
 *   preallocated arrays: width taper, alpha fade along length, per-style colour.
 * - Styles: rainbow, sparkle (+ emitted glints), bubbles (+ emitted bubbles),
 *   flame (flicker), candy (stripes), plain.
 * - Released trails fade out, then return to the pool.
 */

/** Every trail style, for UI and lab pages. */
export const TRAIL_STYLES: readonly TrailStyle[] = ['rainbow', 'sparkle', 'bubbles', 'flame', 'candy', 'plain'];

/** Points per ribbon (ring size). */
const POINTS = 28;
/** Commit a new point after the head has moved this far (m). */
const SEGMENT = 0.14;
/** Commit a new point at least this often, so slow motion still renders. */
const SEGMENT_TIME = 0.06;

const STYLE_ID: Record<TrailStyle, number> = { rainbow: 0, sparkle: 1, bubbles: 2, flame: 3, candy: 4, plain: 5 };

interface StyleLook {
  /** Seconds a point survives. */
  life: number;
  /** Ribbon width at the head (m). */
  width: number;
  /** Head opacity. */
  alpha: number;
}

const LOOKS: readonly StyleLook[] = [
  { life: 0.55, width: 0.3, alpha: 0.9 },
  { life: 0.45, width: 0.18, alpha: 0.85 },
  { life: 0.5, width: 0.16, alpha: 0.45 },
  { life: 0.35, width: 0.34, alpha: 0.9 },
  { life: 0.5, width: 0.26, alpha: 0.95 },
  { life: 0.45, width: 0.22, alpha: 0.75 },
];

const FLAME = [hexColor('#fff3b0'), hexColor('#ffb12e'), hexColor('#ff5a3d'), hexColor('#d8336f')] as const;
const BUBBLE = hexColor('#bff4ff');

/**
 * Extra particles a trail asks the system to spawn (sparkle glints, bubbles).
 * Implementations must not allocate.
 */
export type TrailEmitter = (style: number, x: number, y: number, z: number, color: Color) => void;

const tmpColor = new Color();
const camPos = new Vector3();
const tangent = new Vector3();
const toCam = new Vector3();
const side = new Vector3();
const lastSide = new Vector3();

function samplePalette(stops: readonly Color[], t: number, out: Color): Color {
  const n = stops.length - 1;
  const x = Math.min(n, Math.max(0, t * n));
  const i = Math.min(n - 1, Math.floor(x));
  const a = stops[i];
  const b = stops[i + 1];
  if (!a || !b) return out.set(1, 1, 1);
  return out.copy(a).lerp(b, x - i);
}

class Trail {
  readonly mesh: Mesh;
  readonly points = new Float32Array(POINTS * 4);
  readonly dist = new Float32Array(POINTS);
  readonly baseColor = new Color(1, 1, 1);
  private readonly positions: BufferAttribute;
  private readonly colors: BufferAttribute;
  private readonly data: BufferAttribute;
  head = 0;
  count = 0;
  style = 0;
  emitting = false;
  active = false;
  generation = 0;
  lastCommit = 0;
  emitClock = 0;
  ex = 0;
  ey = 0;
  ez = 0;

  constructor(material: MeshBasicNodeMaterial, index: BufferAttribute) {
    const geo = new BufferGeometry();
    this.positions = new BufferAttribute(new Float32Array(POINTS * 2 * 3), 3).setUsage(DynamicDrawUsage);
    this.colors = new BufferAttribute(new Float32Array(POINTS * 2 * 4), 4).setUsage(DynamicDrawUsage);
    this.data = new BufferAttribute(new Float32Array(POINTS * 2 * 4), 4).setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.positions);
    geo.setAttribute('aTrailColor', this.colors);
    geo.setAttribute('aTrail', this.data);
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'vfx-trail';
  }

  start(style: number, color: Color | null, now: number): void {
    this.style = style;
    this.baseColor.copy(color ?? COLORS.white);
    this.head = 0;
    this.count = 0;
    this.emitting = true;
    this.active = true;
    this.generation++;
    this.lastCommit = now;
    this.emitClock = 0;
  }

  /** Records the emitter; commits a point when it has moved or time has passed. */
  push(x: number, y: number, z: number, now: number): void {
    this.ex = x;
    this.ey = y;
    this.ez = z;
    const p = this.points;
    if (this.count === 0) {
      this.commit(x, y, z, now, 0);
      this.commit(x, y, z, now, 0);
      return;
    }
    const prev = ((this.head - 1 + POINTS) % POINTS) * 4;
    const dx = x - (p[prev] ?? 0);
    const dy = y - (p[prev + 1] ?? 0);
    const dz = z - (p[prev + 2] ?? 0);
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (moved > SEGMENT || now - this.lastCommit > SEGMENT_TIME) {
      this.commit(x, y, z, now, moved);
    } else {
      const h = this.head * 4;
      p[h] = x;
      p[h + 1] = y;
      p[h + 2] = z;
      p[h + 3] = now;
      this.dist[this.head] = (this.dist[(this.head - 1 + POINTS) % POINTS] ?? 0) + moved;
    }
  }

  private commit(x: number, y: number, z: number, now: number, moved: number): void {
    const prevDist = this.count > 0 ? (this.dist[this.head] ?? 0) : 0;
    this.head = (this.head + 1) % POINTS;
    const h = this.head * 4;
    this.points[h] = x;
    this.points[h + 1] = y;
    this.points[h + 2] = z;
    this.points[h + 3] = now;
    this.dist[this.head] = prevDist + moved;
    if (this.count < POINTS) this.count++;
    this.lastCommit = now;
  }

  /** Rebuilds the strip. Returns false once fully faded after release. */
  build(now: number, emit: TrailEmitter): boolean {
    const look = LOOKS[this.style] ?? LOOKS[5]!;
    const p = this.points;
    if (this.emitting) {
      const h = this.head * 4;
      p[h + 3] = now;
    }
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - i + POINTS) % POINTS;
      if (now - (p[idx * 4 + 3] ?? 0) > look.life) break;
      m++;
    }
    if (m < 2) {
      this.mesh.visible = false;
      this.mesh.geometry.setDrawRange(0, 0);
      return this.emitting;
    }

    const pos = this.positions.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const dat = this.data.array as Float32Array;
    lastSide.set(0, 1, 0);
    for (let i = 0; i < m; i++) {
      const idx = (this.head - i + POINTS) % POINTS;
      const o = idx * 4;
      const px = p[o] ?? 0;
      const py = p[o + 1] ?? 0;
      const pz = p[o + 2] ?? 0;
      const a = ((this.head - Math.max(0, i - 1) + POINTS) % POINTS) * 4;
      const b = ((this.head - Math.min(m - 1, i + 1) + POINTS) % POINTS) * 4;
      tangent.set((p[a] ?? 0) - (p[b] ?? 0), (p[a + 1] ?? 0) - (p[b + 1] ?? 0), (p[a + 2] ?? 0) - (p[b + 2] ?? 0));
      toCam.set(camPos.x - px, camPos.y - py, camPos.z - pz);
      side.crossVectors(tangent, toCam);
      const len = side.length();
      if (len > 1e-6) side.multiplyScalar(1 / len);
      else side.copy(lastSide);
      lastSide.copy(side);

      const u = Math.min(1, (now - (p[o + 3] ?? 0)) / look.life);
      const taper = Math.pow(1 - u, 0.7);
      const flare = this.style === 3 ? 0.6 + 0.8 * Math.sin(Math.min(1, u * 2.2) * Math.PI * 0.5) : 1;
      const halfWidth = look.width * 0.5 * taper * flare;
      // The head point sits inside the emitter; a softer head hides the seam.
      const alpha = look.alpha * Math.pow(1 - u, 1.25) * (i === 0 ? 0.6 : 1);

      this.styleColor(u, tmpColor);
      const v = i * 2;
      const dist = this.dist[idx] ?? 0;
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const vo = (v + s) * 3;
        pos[vo] = px + side.x * halfWidth * sign;
        pos[vo + 1] = py + side.y * halfWidth * sign;
        pos[vo + 2] = pz + side.z * halfWidth * sign;
        const co = (v + s) * 4;
        col[co] = tmpColor.r;
        col[co + 1] = tmpColor.g;
        col[co + 2] = tmpColor.b;
        col[co + 3] = alpha;
        dat[co] = u;
        dat[co + 1] = sign;
        dat[co + 2] = dist;
        dat[co + 3] = this.style;
      }
    }
    const verts = m * 2;
    this.positions.clearUpdateRanges();
    this.positions.addUpdateRange(0, verts * 3);
    this.positions.needsUpdate = true;
    this.colors.clearUpdateRanges();
    this.colors.addUpdateRange(0, verts * 4);
    this.colors.needsUpdate = true;
    this.data.clearUpdateRanges();
    this.data.addUpdateRange(0, verts * 4);
    this.data.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (m - 1) * 6);
    this.mesh.visible = true;

    if (this.emitting && (this.style === 1 || this.style === 2)) {
      this.emitClock += 1;
      const every = this.style === 1 ? 3 : 5;
      if (this.emitClock % every === 0) {
        const c = this.style === 1 ? (GOLD_COLORS[(this.emitClock / every) % GOLD_COLORS.length | 0] ?? COLORS.gold) : BUBBLE;
        emit(this.style, this.ex, this.ey, this.ez, c);
      }
    }
    return true;
  }

  private styleColor(u: number, out: Color): Color {
    switch (this.style) {
      case 0:
        return samplePalette(RAINBOW_COLORS, u, out);
      case 1:
        return out.copy(COLORS.gold).lerp(COLORS.white, 0.5 * (1 - u));
      case 2:
        return out.copy(BUBBLE).lerp(this.baseColor, 0.25);
      case 3:
        return samplePalette(FLAME, u, out);
      default:
        return out.copy(this.baseColor);
    }
  }
}

/**
 * Pool of trail ribbons.
 *
 * @example
 * const handle = trails.acquire('rainbow', null, now);
 * handle?.update(x, y, z, dt); // each frame
 * handle?.release();
 */
export class TrailPool {
  private readonly trails: Trail[] = [];
  private readonly material: MeshBasicNodeMaterial;
  private readonly index: BufferAttribute;
  private limit: number;
  private now = 0;

  /**
   * @param parent - Group the ribbon meshes are added to.
   * @param capacity - Ribbons to allocate.
   * @param limit - Active budget (≤ capacity).
   * @param time - Shared effect-time uniform (flame flicker).
   * @param emit - Receives sparkle/bubble spawn requests.
   */
  constructor(
    private readonly parent: Group,
    capacity: number,
    limit: number,
    time: UniformNode<'float', number>,
    private readonly emit: TrailEmitter,
  ) {
    this.limit = Math.min(capacity, limit);
    const idx = new Uint16Array((POINTS - 1) * 6);
    for (let i = 0; i < POINTS - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    this.index = new BufferAttribute(idx, 1);
    this.material = buildMaterial(time);
    for (let i = 0; i < capacity; i++) {
      const t = new Trail(this.material, this.index);
      this.trails.push(t);
      parent.add(t.mesh);
    }
  }

  /**
   * Sets how many trails may be live (clamped to the allocation).
   *
   * @param n - Max simultaneous trails.
   */
  setCapacity(n: number): void {
    this.limit = Math.max(0, Math.min(this.trails.length, n | 0));
  }

  /**
   * Takes a free ribbon.
   *
   * @param style - Look.
   * @param color - Tint for `candy`/`plain` (hex).
   * @returns A handle, or null when the budget is exhausted.
   */
  acquire(style: TrailStyle, color?: string): TrailHandle | null {
    let live = 0;
    let free: Trail | null = null;
    for (const t of this.trails) {
      if (t.active) live++;
      else if (!free) free = t;
    }
    if (!free || live >= this.limit) return null;
    const trail = free;
    trail.start(STYLE_ID[style] ?? 5, color ? hexColor(color) : style === 'candy' ? COLORS.danger : null, this.now);
    const generation = trail.generation;
    return {
      update: (x: number, y: number, z: number) => {
        if (trail.generation === generation && trail.emitting) trail.push(x, y, z, this.now);
      },
      release: () => {
        if (trail.generation === generation) trail.emitting = false;
      },
    };
  }

  /**
   * Rebuilds every active ribbon facing `camera`.
   *
   * @param now - Current effect time.
   * @param camera - View camera.
   */
  update(now: number, camera: Camera): void {
    this.now = now;
    camPos.setFromMatrixPosition(camera.matrixWorld);
    for (const t of this.trails) {
      if (!t.active) continue;
      if (!t.build(now, this.emit)) {
        t.active = false;
        t.mesh.visible = false;
      }
    }
  }

  /** Ends every trail immediately (outstanding handles become inert). */
  clear(): void {
    for (const t of this.trails) {
      t.active = false;
      t.emitting = false;
      t.generation++;
      t.mesh.visible = false;
    }
  }

  /** Frees GPU resources. */
  dispose(): void {
    for (const t of this.trails) {
      t.mesh.geometry.dispose();
      this.parent.remove(t.mesh);
    }
    this.material.dispose();
  }
}

function buildMaterial(time: UniformNode<'float', number>): MeshBasicNodeMaterial {
  const color = attribute('aTrailColor', 'vec4') as Node<'vec4'>;
  const data = attribute('aTrail', 'vec4') as Node<'vec4'>;
  const u = data.x;
  const across = data.y.abs();
  const dist = data.z;
  const style = data.w;

  const edge = float(1).sub(smoothstep(0.55, 1, across));
  const core = pow(float(1).sub(across), float(3));
  const isCandy = style.greaterThan(3.5).and(style.lessThan(4.5));
  const isFlame = style.greaterThan(2.5).and(style.lessThan(3.5));
  const stripe = step(0.5, fract(dist.mul(2.4)));
  const candy = mix(color.xyz, vec3(1, 1, 1), stripe.mul(0.85));
  const flicker = sin(time.mul(31).add(dist.mul(9))).mul(0.18).add(0.82);
  const flame = mix(color.xyz, vec3(1, 0.97, 0.8), core.mul(float(1).sub(u)));
  const rgb = select(isCandy, candy, select(isFlame, flame, mix(color.xyz, vec3(1, 1, 1), core.mul(0.35))));
  const alpha = color.w.mul(edge).mul(select(isFlame, flicker, float(1)));

  const material = new MeshBasicNodeMaterial({ side: DoubleSide });
  material.colorNode = vec4(rgb, alpha);
  material.transparent = true;
  material.depthWrite = false;
  material.fog = true;
  return material;
}
