/**
 * Shared building blocks for set-B obstacle visuals.
 *
 * Responsibilities:
 * - Resource tracking ({@link Disposer}) so every visual frees what it made.
 * - Placing visuals at the designer transform and copying pure pose samples.
 * - The set-B material kit: candy stripes, ice sparkle, bubbling goo, additive
 *   glow, swirling portals, per-instance telegraph glow, checker banners.
 * - Small cosmetic systems (sparkles, puffs) and canvas text labels.
 *
 * Everything that animates gameplay-relevant parts mirrors the sim's pure
 * functions; purely cosmetic motion uses TSL `time` or frame `dt`.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type ColorRepresentation,
  type Material,
  type MeshToonNodeMaterial,
  type Node,
  type Object3D,
  type UniformNode,
} from 'three/webgpu';

/** A float uniform node (telegraph / flash intensity). */
export type FloatUniform = UniformNode<'float', number>;
import {
  abs,
  atan,
  color,
  float,
  floor,
  fract,
  hash,
  instancedDynamicBufferAttribute,
  length,
  mix,
  mx_noise_float,
  normalLocal,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { ObstacleInstance, ObstacleRuntime, PoseSample } from '@tumble/sim';
import { createOutlineMaterial } from '../materials/outline.ts';
import { createToonMaterial, type ToonMaterialOptions } from '../materials/toon.ts';

/** Degrees → radians. */
export const DEG = Math.PI / 180;

/** Set-B palette (art direction: danger magenta/orange, safe cyan/mint, interactable yellow). */
export const PAL = {
  pink: '#ff6fb5',
  magenta: '#ff2a8a',
  orange: '#ff8a3d',
  yellow: '#ffd23f',
  cream: '#fff4dc',
  mint: '#6ee7a8',
  cyan: '#5ce1e6',
  sky: '#8fd3ff',
  violet: '#7c5cff',
  lilac: '#c7a6ff',
  ink: '#2b1d3a',
  white: '#ffffff',
  gold: '#ffc83d',
  ice: '#c9f4ff',
  gooPurple: '#7a2bd6',
  gooGreen: '#7dff6b',
} as const;

// -----------------------------------------------------------------------------
// Resource tracking & transforms
// -----------------------------------------------------------------------------

/** Anything with a dispose(). */
export interface Disposable {
  dispose(): void;
}

/** Collects GPU resources created by one visual and frees them together. */
export class Disposer {
  private readonly items: Disposable[] = [];

  /** Registers a resource and returns it, for inline use. */
  track<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  /** Disposes every tracked resource once. */
  dispose(): void {
    for (const i of this.items) i.dispose();
    this.items.length = 0;
  }
}

/** Places `obj` at the instance's designer transform (degrees, intrinsic Y-X-Z like the sim). */
export function applyInstanceTransform(obj: Object3D, instance: ObstacleInstance): void {
  const r = instance.rotation;
  obj.position.set(instance.position.x, instance.position.y, instance.position.z);
  obj.rotation.set((r?.pitch ?? 0) * DEG, (r?.yaw ?? 0) * DEG, (r?.roll ?? 0) * DEG, 'YXZ');
}

/** World matrix of an instance transform (for visuals that draw in world space). */
export function instanceMatrix(instance: ObstacleInstance, out: Matrix4): Matrix4 {
  const r = instance.rotation;
  _e.set((r?.pitch ?? 0) * DEG, (r?.yaw ?? 0) * DEG, (r?.roll ?? 0) * DEG, 'YXZ');
  _q.setFromEuler(_e);
  _v.set(instance.position.x, instance.position.y, instance.position.z);
  return out.compose(_v, _q, _one);
}
const _e = new Euler();
const _q = new Quaternion();
const _v = new Vector3();
const _one = new Vector3(1, 1, 1);

/** Copies a pure pose sample into an object's local transform. */
export function applyPose(obj: Object3D, s: PoseSample): void {
  obj.position.set(s.pos.x, s.pos.y, s.pos.z);
  obj.quaternion.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
}

const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3();
const _r = new Quaternion();

/** Writes a pose sample (optionally scaled) into instance `i` of an InstancedMesh. */
export function setInstancePose(
  mesh: InstancedMesh,
  i: number,
  s: PoseSample,
  sx = 1,
  sy = sx,
  sz = sx,
): void {
  _p.set(s.pos.x, s.pos.y, s.pos.z);
  _r.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
  _s.set(sx, sy, sz);
  mesh.setMatrixAt(i, _m.compose(_p, _r, _s));
}

/** Writes a raw transform into instance `i`. */
export function setInstanceTRS(
  mesh: InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  q: { x: number; y: number; z: number; w: number } | null,
  sx: number,
  sy = sx,
  sz = sx,
): void {
  _p.set(x, y, z);
  if (q) _r.set(q.x, q.y, q.z, q.w);
  else _r.identity();
  _s.set(sx, sy, sz);
  mesh.setMatrixAt(i, _m.compose(_p, _r, _s));
}

/**
 * Parses an instance's params with the sim module's schema so visuals and sim
 * see identical defaults.
 */
export function parseParams<P>(schema: { parse(v: unknown): P }, instance: ObstacleInstance): P {
  return schema.parse(instance.params);
}

// -----------------------------------------------------------------------------
// Meshes
// -----------------------------------------------------------------------------

/** Chunky rounded box from half extents. */
export function roundedBox(
  d: Disposer,
  hx: number,
  hy: number,
  hz: number,
  radius = 0.12,
  segments = 3,
): BufferGeometry {
  const r = Math.min(radius, hx * 0.95, hy * 0.95, hz * 0.95);
  return d.track(new RoundedBoxGeometry(hx * 2, hy * 2, hz * 2, segments, Math.max(0.001, r)));
}

/** Mesh that casts and receives shadows. */
export function solid(geo: BufferGeometry, mat: Material): Mesh {
  const m = new Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Adds an inverted-hull outline child sharing the mesh's geometry (smooth meshes only). */
export function addOutline(d: Disposer, mesh: Mesh, thickness = 0.035): Mesh {
  const o = new Mesh(mesh.geometry, d.track(createOutlineMaterial(thickness)));
  o.castShadow = false;
  o.receiveShadow = false;
  mesh.add(o);
  return o;
}

// -----------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------

type EmissiveCapable = MeshToonNodeMaterial & { emissiveNode: Node | null };

/** Adds a node to a toon material's existing emissive (rim + telegraph) term. */
export function addEmissive(mat: MeshToonNodeMaterial, node: Node): void {
  const m = mat as EmissiveCapable;
  m.emissiveNode = m.emissiveNode ? (m.emissiveNode as Node<'vec3'>).add(node as Node<'vec3'>) : node;
}

/** Tracked toon material. */
export function toon(d: Disposer, opts: ToonMaterialOptions): MeshToonNodeMaterial {
  return d.track(createToonMaterial(opts));
}

/** Sets the telegraph glow (emissiveIntensity uniform) on a toon material. */
export function setGlow(mat: MeshToonNodeMaterial, intensity: number): void {
  const u = (mat.userData.uniforms as { emissiveIntensity?: { value: number } } | undefined)
    ?.emissiveIntensity;
  if (u) u.value = intensity;
}

/** Stripe axis in object space. */
export type StripeAxis = 'x' | 'y' | 'z' | 'diagXZ' | 'diagXY' | 'spiralX' | 'aroundY';

/**
 * Which object space patterns are evaluated in. `geometry` is the mesh's own
 * vertex space; on plain meshes it equals `local`, and unlike `local` it
 * survives automatic instancing (MeshBatcher). On an InstancedMesh, `local`
 * is the instancer's space (stripes stay put while instances move).
 */
export type PatternSpace = 'geometry' | 'local';

function stripeCoord(axis: StripeAxis, freq: number, space: PatternSpace): Node<'float'> {
  const p = space === 'local' ? positionLocal : positionGeometry;
  switch (axis) {
    case 'x':
      return p.x.mul(freq);
    case 'y':
      return p.y.mul(freq);
    case 'z':
      return p.z.mul(freq);
    case 'diagXZ':
      return p.x.add(p.z).mul(freq);
    case 'diagXY':
      return p.x.add(p.y).mul(freq);
    case 'spiralX':
      // Candy-cane spiral around the X axis: angle around X plus distance along it.
      return atan(p.z, p.y)
        .div(Math.PI * 2)
        .mul(freq)
        .add(p.x.mul(freq * 0.18));
    default:
      return atan(p.z, p.x)
        .div(Math.PI * 2)
        .mul(freq);
  }
}

/**
 * Two-colour candy-stripe toon material (stripes in object space, so they move
 * with the mesh — rolling drums visibly roll).
 */
export function stripedToon(
  d: Disposer,
  a: ColorRepresentation,
  b: ColorRepresentation,
  freq: number,
  axis: StripeAxis,
  opts: Partial<ToonMaterialOptions> = {},
  space: PatternSpace = 'geometry',
): MeshToonNodeMaterial {
  const mat = toon(d, { color: '#ffffff', rimStrength: 0.5, ...opts });
  const s = step(float(0.5), fract(stripeCoord(axis, freq, space)));
  mat.colorNode = mix(color(new Color(a)), color(new Color(b)), s);
  return mat;
}

/** Checkerboard toon material in object space (finish banners, start flags). */
export function checkerToon(
  d: Disposer,
  a: ColorRepresentation,
  b: ColorRepresentation,
  cell: number,
  plane: 'xy' | 'xz' = 'xy',
): MeshToonNodeMaterial {
  const mat = toon(d, { color: '#ffffff', rimStrength: 0.3 });
  const p = positionGeometry;
  const u = floor(p.x.div(cell));
  const v = floor((plane === 'xy' ? p.y : p.z).div(cell));
  const k = fract(u.add(v).mul(0.5)).mul(2);
  mat.colorNode = mix(color(new Color(a)), color(new Color(b)), k);
  return mat;
}

/**
 * Glossy pale-cyan ice: brighter facing highlight, deep tint in creases, and
 * world-space twinkling sparkles in the emissive term.
 */
export function iceMaterial(d: Disposer, tint: ColorRepresentation = PAL.ice): MeshToonNodeMaterial {
  const mat = toon(d, { color: tint, rimColor: '#ffffff', rimStrength: 0.9 });
  const cell = floor(positionWorld.mul(7));
  const h = hash(cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)));
  const twinkle = sin(time.mul(3.1).add(h.mul(40)))
    .mul(0.5)
    .add(0.5);
  const sparkle = step(float(0.965), h).mul(twinkle.pow(6)).mul(2.2);
  const veins = smoothstep(float(0.45), float(0.5), abs(mx_noise_float(positionWorld.mul(0.6)))).mul(0.18);
  addEmissive(mat, vec3(sparkle.add(veins)).mul(color(new Color('#e8fbff'))));
  return mat;
}

/**
 * Bubbling purple-green goo: scrolling noise colour, popping bubble
 * highlights, and a gentle vertex swell.
 */
export function gooMaterial(
  d: Disposer,
  a: ColorRepresentation = PAL.gooPurple,
  b: ColorRepresentation = PAL.gooGreen,
): MeshToonNodeMaterial {
  const mat = toon(d, { color: '#ffffff', rimColor: '#e9ffd8', rimStrength: 0.7 });
  const flow = vec3(positionLocal.x.mul(0.7), time.mul(0.35), positionLocal.z.mul(0.7));
  const n = mx_noise_float(flow).mul(0.5).add(0.5);
  mat.colorNode = mix(color(new Color(a)), color(new Color(b)), smoothstep(float(0.3), float(0.75), n));
  const bubbles = mx_noise_float(vec3(positionLocal.x.mul(2.4), positionLocal.z.mul(2.4), time.mul(0.9)));
  const pop = smoothstep(float(0.55), float(0.7), bubbles);
  addEmissive(mat, color(new Color(b)).mul(pop.mul(0.55)));
  const swell = mx_noise_float(vec3(positionLocal.x.mul(1.3), positionLocal.z.mul(1.3), time.mul(0.6))).mul(
    0.06,
  );
  // Only the top surface swells; side walls stay put so the puddle edge doesn't tear.
  mat.positionNode = positionLocal.add(normalLocal.mul(swell.mul(normalLocal.y.max(0))));
  return mat;
}

/** Options for {@link glowMaterial}. */
export interface GlowOptions {
  opacity?: number;
  additive?: boolean;
  doubleSide?: boolean;
}

/**
 * Unlit emissive-looking material for beams, rings and flashes. Returns the
 * material plus an `intensity` uniform (0 hides it) for telegraph / flashes.
 */
export function glowMaterial(
  d: Disposer,
  tint: ColorRepresentation,
  opts: GlowOptions = {},
): { mat: MeshBasicNodeMaterial; intensity: FloatUniform } {
  const mat = d.track(new MeshBasicNodeMaterial());
  const intensity = uniform(1);
  const base = color(new Color(tint));
  mat.colorNode = base;
  mat.opacityNode = intensity.mul(opts.opacity ?? 1);
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = opts.additive === false ? NormalBlending : AdditiveBlending;
  if (opts.doubleSide) mat.side = DoubleSide;
  return { mat, intensity };
}

/**
 * Soft beam: brightest along the cylinder's core line (uv.x wraps around a
 * CylinderGeometry, so the view-facing falloff comes from the normal), with a
 * fast shimmer.
 */
export function beamMaterial(
  d: Disposer,
  tint: ColorRepresentation,
  core: number,
): { mat: MeshBasicNodeMaterial; intensity: FloatUniform } {
  const { mat, intensity } = glowMaterial(d, tint, { additive: true });
  const shimmer = sin(time.mul(38).add(positionLocal.y.mul(9)))
    .mul(0.12)
    .add(0.88);
  mat.opacityNode = intensity.mul(core).mul(shimmer);
  return { mat, intensity };
}

/**
 * Swirling portal disc (map onto a CircleGeometry): spiral arms + inward
 * rippling rings, fading at the rim.
 */
export function portalMaterial(
  d: Disposer,
  a: ColorRepresentation,
  b: ColorRepresentation,
): { mat: MeshBasicNodeMaterial; intensity: FloatUniform } {
  const { mat, intensity } = glowMaterial(d, a, { additive: true, doubleSide: true });
  const c = uv().sub(vec2(0.5, 0.5));
  const r = length(c).mul(2);
  const ang = atan(c.y, c.x);
  const swirl = sin(ang.mul(3).add(r.mul(14)).sub(time.mul(5)))
    .mul(0.5)
    .add(0.5);
  const rings = smoothstep(
    float(0.55),
    float(1),
    sin(r.mul(26).add(time.mul(9)))
      .mul(0.5)
      .add(0.5),
  );
  const k = swirl.mul(0.7).add(rings.mul(0.5));
  mat.colorNode = mix(color(new Color(a)), color(new Color(b)), swirl).mul(k.add(0.35));
  const rim = float(1).sub(smoothstep(float(0.82), float(1), r));
  mat.opacityNode = intensity.mul(rim).mul(k.add(0.25));
  return { mat, intensity };
}

/**
 * Per-instance telegraph glow for InstancedMeshes: returns a 0–1 float per
 * instance that adds `glowColor` to the emissive term. Write values into
 * `attr.array` and set `attr.needsUpdate = true` when they change; `node` lets
 * callers drive other effects (cracks) from the same value.
 */
export function instanceGlow(
  mat: MeshToonNodeMaterial,
  count: number,
  glowColor: ColorRepresentation,
): { attr: InstancedBufferAttribute; node: Node<'float'> } {
  const attr = new InstancedBufferAttribute(new Float32Array(count), 1);
  const node = instancedDynamicBufferAttribute(attr, 'float') as Node<'float'>;
  addEmissive(mat, color(new Color(glowColor)).mul(node));
  return { attr, node };
}

/**
 * Soft fog-sheet material for the void: drifting noise wisps, transparent,
 * never writes depth.
 */
export function fogSheetMaterial(d: Disposer, tint: ColorRepresentation): MeshBasicNodeMaterial {
  const mat = d.track(new MeshBasicNodeMaterial());
  const p = positionWorld;
  const n = mx_noise_float(vec3(p.x.mul(0.035), p.z.mul(0.035), time.mul(0.05)))
    .mul(0.5)
    .add(0.5);
  const n2 = mx_noise_float(vec3(p.x.mul(0.11).add(time.mul(0.04)), p.z.mul(0.11), time.mul(0.08)))
    .mul(0.5)
    .add(0.5);
  mat.colorNode = color(new Color(tint));
  mat.opacityNode = smoothstep(float(0.35), float(0.9), n.mul(0.7).add(n2.mul(0.3))).mul(0.55);
  mat.transparent = true;
  mat.depthWrite = false;
  return mat;
}

/**
 * Waving cloth (flags, banners): sways along local X, pinned at x = 0.
 */
export function wavingToon(d: Disposer, opts: ToonMaterialOptions, amplitude = 0.18): MeshToonNodeMaterial {
  const mat = toon(d, opts);
  mat.side = DoubleSide;
  const x = positionLocal.x.max(0);
  const wave = sin(positionLocal.x.mul(3.2).sub(time.mul(6.5)))
    .mul(x)
    .mul(amplitude);
  mat.positionNode = positionLocal.add(vec3(0, wave.mul(0.35), wave));
  return mat;
}

// -----------------------------------------------------------------------------
// Cosmetic systems
// -----------------------------------------------------------------------------

/**
 * A fixed budget of tiny additive sparkles, one InstancedMesh. Callers write
 * positions/scales each frame via `set`; `commit` uploads once.
 */
export class Sparkles {
  readonly mesh: InstancedMesh;

  constructor(d: Disposer, count: number, tint: ColorRepresentation, size = 0.08, geo?: BufferGeometry) {
    const g = geo ?? d.track(new BufferGeometry().copy(octahedron));
    const { mat } = glowMaterial(d, tint, { additive: true });
    this.mesh = new InstancedMesh(g, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.userData.size = size;
    for (let i = 0; i < count; i++) setInstanceTRS(this.mesh, i, 0, -1e4, 0, null, 0);
  }

  /** Places sparkle `i` (scale 0 hides it). */
  set(i: number, x: number, y: number, z: number, scale: number): void {
    setInstanceTRS(this.mesh, i, x, y, z, null, scale * (this.mesh.userData.size as number));
  }

  /** Flags the instance buffer for upload. */
  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Unit octahedron-ish sparkle shape, built once and copied per Sparkles owner. */
const octahedron = (() => {
  const g = new BufferGeometry();
  const v = [0, 1, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1, 0, -1, 0];
  const idx = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1];
  g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
})();

/** Smooth 0→1→0 pulse, `rate` pulses per second (matches the sim's telegraph pulse). */
export function pulse(t: number, rate: number): number {
  const s = 0.5 - 0.5 * Math.cos(t * rate * Math.PI * 2);
  return s * s;
}

/** Deterministic cosmetic pseudo-random in [0, 1) for particle layouts. */
export function rand01(i: number, salt = 0): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// -----------------------------------------------------------------------------
// Text
// -----------------------------------------------------------------------------

/** Options for {@link labelTexture}. */
export interface LabelOptions {
  width?: number;
  height?: number;
  fill?: string;
  stroke?: string;
  background?: string | null;
  font?: string;
}

/**
 * Renders chunky outlined text into a CanvasTexture for signage.
 *
 * NOTE: troika-three-text patches classic WebGL shaders via onBeforeCompile,
 * which node materials (and the WebGPU backend) do not support; a canvas
 * texture on a plane renders identically on both backends.
 *
 * @returns The texture, or null when no canvas implementation exists (headless).
 */
export function labelTexture(
  d: Disposer,
  text: string,
  opts: LabelOptions = {},
): CanvasTexture<HTMLCanvasElement | OffscreenCanvas> | null {
  const w = opts.width ?? 1024;
  const h = opts.height ?? 256;
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  } else if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  else return null;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g) return null;
  if (opts.background) {
    g.fillStyle = opts.background;
    const r = h * 0.28;
    g.beginPath();
    g.roundRect(8, 8, w - 16, h - 16, r);
    g.fill();
  }
  g.font =
    opts.font ??
    `900 ${Math.round(h * 0.62)}px "Baloo 2", "Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = h * 0.12;
  g.strokeStyle = opts.stroke ?? PAL.ink;
  g.strokeText(text, w / 2, h / 2 + h * 0.04);
  g.fillStyle = opts.fill ?? PAL.white;
  g.fillText(text, w / 2, h / 2 + h * 0.04);
  const tex = d.track(new CanvasTexture<HTMLCanvasElement | OffscreenCanvas>(canvas));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// -----------------------------------------------------------------------------
// Runtime access
// -----------------------------------------------------------------------------

/**
 * Reads an extra runtime field defensively: visuals may run without a runtime
 * (gallery) or against a runtime from another build.
 */
export function runtimeNumber(runtime: ObstacleRuntime | undefined, key: string): number {
  if (!runtime) return Number.NaN;
  const v = (runtime as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : Number.NaN;
}

/** Shared unit vectors to avoid allocating in hot paths. */
export const UP = new Vector3(0, 1, 0);
