/**
 * Shared visual toolkit for obstacle set A.
 *
 * Responsibilities:
 * - The set's colour language (danger = magenta/orange, safe = cyan/mint,
 *   interactable = yellow) and chunky geometry helpers.
 * - TSL procedural surface patterns (hazard stripes, checker, pie slices,
 *   bands) layered onto the shared toon material, so every obstacle keeps the
 *   same lighting model and telegraph-glow uniforms.
 * - Posing three objects from the sim's pure `pose()` samples.
 * - A base class that owns the root group and disposes everything under it.
 */
import type { BufferGeometry, Material } from 'three/webgpu';
import {
  Color,
  Group,
  Mesh,
  type MeshToonNodeMaterial,
  type Object3D,
  type ColorRepresentation,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { abs, atan, float, fract, mix, positionGeometry, smoothstep, step, uniform } from 'three/tsl';
import type { ObstacleInstance, ObstacleModule, ObstacleRuntime, PoseSample } from '@tumble/sim';
import { quatFromEulerYXZ } from '@tumble/shared';
import { createToonMaterial } from '../materials/toon.ts';
import { createOutlineMaterial } from '../materials/outline.ts';
import type { ObstacleVisual } from './types.ts';

// -----------------------------------------------------------------------------
// Palette
// -----------------------------------------------------------------------------

/** Set-A colour language. */
export const ObstacleColors = {
  danger: '#ff3d8b',
  dangerAlt: '#ff8a3d',
  safe: '#5ce1e6',
  mint: '#6ee7a8',
  interact: '#ffd23f',
  lilac: '#b9a7ff',
  grape: '#7c5cff',
  cream: '#fff4e0',
  white: '#ffffff',
  pink: '#ff9fd2',
  sky: '#8fd3ff',
  ink: '#2b1d3a',
  glowDanger: '#ff2a6d',
  glowWarn: '#ffb02e',
} as const;

/** Pattern overlay kinds understood by {@link createPatternMaterial}. */
export type PatternKind = 'stripes' | 'checker' | 'bands' | 'pie' | 'none';

/** Options for {@link createPatternMaterial}. */
export interface PatternMaterialOptions {
  /** Base colour. */
  a: ColorRepresentation;
  /** Pattern colour. */
  b?: ColorRepresentation;
  pattern?: PatternKind;
  /** Pattern repeats per metre (stripes/checker/bands) or slice count (pie). */
  scale?: number;
  /** Emissive colour used for telegraph glow. */
  emissive?: ColorRepresentation;
  rimStrength?: number;
}

/**
 * Toon material with a procedural pattern evaluated in geometry space (so it
 * sticks to moving and instanced parts). Keeps `userData.uniforms` from
 * {@link createToonMaterial} — drive `emissiveIntensity` for telegraphs.
 *
 * @example
 * const arm = createPatternMaterial({ a: ObstacleColors.danger, b: ObstacleColors.dangerAlt, pattern: 'stripes' });
 * setGlow(arm, 0.6);
 */
export function createPatternMaterial(opts: PatternMaterialOptions): MeshToonNodeMaterial {
  const mat = createToonMaterial({
    color: opts.a,
    emissive: opts.emissive ?? opts.a,
    emissiveIntensity: 0,
    rimStrength: opts.rimStrength ?? 0.5,
  });
  const kind = opts.pattern ?? 'none';
  if (kind === 'none' || opts.b === undefined) return mat;
  const ca = uniform(new Color(opts.a));
  const cb = uniform(new Color(opts.b));
  const scale = uniform(opts.scale ?? (kind === 'pie' ? 8 : 1.6));
  const p = positionGeometry;
  let mask;
  switch (kind) {
    case 'stripes':
      mask = step(0.5, fract(p.x.add(p.y).add(p.z).mul(scale)));
      break;
    case 'checker': {
      const cx = step(0.5, fract(p.x.mul(scale).mul(0.5)));
      const cz = step(0.5, fract(p.z.mul(scale).mul(0.5)));
      mask = abs(cx.sub(cz));
      break;
    }
    case 'bands':
      mask = step(0.5, fract(p.y.mul(scale)));
      break;
    case 'pie': {
      const ang = atan(p.z, p.x)
        .div(Math.PI * 2)
        .add(0.5);
      mask = step(0.5, fract(ang.mul(scale).mul(0.5)));
      break;
    }
  }
  mat.colorNode = mix(ca, cb, mask);
  mat.userData.uniforms = { ...mat.userData.uniforms, patternA: ca, patternB: cb, patternScale: scale };
  return mat;
}

/** Sets a toon material's telegraph glow (0..1 → emissive intensity). */
export function setGlow(mat: Material, intensity: number, max = 1.1): void {
  const u = (mat.userData.uniforms as { emissiveIntensity?: { value: number } } | undefined)
    ?.emissiveIntensity;
  if (u) u.value = Math.max(0, intensity) * max;
}

/** Soft "candy sheen" band: lighter top fading to base — used on big flat tops. */
export function createTopSheenMaterial(
  top: ColorRepresentation,
  side: ColorRepresentation,
): MeshToonNodeMaterial {
  const mat = createToonMaterial({ color: side, rimStrength: 0.4, emissive: top, emissiveIntensity: 0 });
  const k = smoothstep(float(-0.05), float(0.05), positionGeometry.y);
  mat.colorNode = mix(uniform(new Color(side)), uniform(new Color(top)), k);
  return mat;
}

// -----------------------------------------------------------------------------
// Geometry & meshes
// -----------------------------------------------------------------------------

/** Rounded box with sane segment counts for chunky toy edges. */
export function roundedBox(w: number, h: number, d: number, radius = 0.12): RoundedBoxGeometry {
  const r = Math.min(radius, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  return new RoundedBoxGeometry(w, h, d, 3, Math.max(0.005, r));
}

/** Creates a mesh that casts and receives shadows. */
export function shadedMesh(geo: BufferGeometry, mat: Material, cast = true, receive = true): Mesh {
  const m = new Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

/** Adds an inverted-hull outline child (smooth-normal meshes only). */
export function addOutline(mesh: Mesh, thickness = 0.035): Mesh {
  const o = new Mesh(mesh.geometry, createOutlineMaterial(thickness));
  o.castShadow = false;
  o.receiveShadow = false;
  mesh.add(o);
  return o;
}

// -----------------------------------------------------------------------------
// Transforms
// -----------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** Places `obj` at an instance's position/rotation (degrees, Y-X-Z) — same math as the sim. */
export function applyInstanceTransform(obj: Object3D, instance: ObstacleInstance): void {
  obj.position.set(instance.position.x, instance.position.y, instance.position.z);
  const r = instance.rotation ?? {};
  const q = quatFromEulerYXZ((r.yaw ?? 0) * DEG, (r.pitch ?? 0) * DEG, (r.roll ?? 0) * DEG);
  obj.quaternion.set(q.x, q.y, q.z, q.w);
}

/** Copies a pose sample into an object's local transform. */
export function applyPose(obj: Object3D, s: PoseSample): void {
  obj.position.set(s.pos.x, s.pos.y, s.pos.z);
  obj.quaternion.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
}

/** Allocates a pose buffer sized for a module + params. */
export function poseBufferFor<P>(module: ObstacleModule<P>, params: P, speedScale: number): PoseSample[] {
  const n = module.poseCount?.(params, speedScale) ?? 1;
  const out: PoseSample[] = [];
  for (let i = 0; i < n; i++) out.push({ pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } });
  return out;
}

// -----------------------------------------------------------------------------
// Lifetime
// -----------------------------------------------------------------------------

/** Disposes every geometry and material under `root` exactly once. */
export function disposeObject(root: Object3D): void {
  const geos = new Set<BufferGeometry>();
  const mats = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    geos.add(m.geometry);
    if (Array.isArray(m.material)) m.material.forEach((x) => mats.add(x));
    else mats.add(m.material);
    const inst = o as Mesh & { dispose?: () => void; isInstancedMesh?: boolean };
    if (inst.isInstancedMesh) inst.dispose?.();
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  root.removeFromParent();
}

/**
 * Base for set-A visuals: owns the root group placed at the instance
 * transform and disposes everything under it.
 */
export abstract class VisualBase<P> implements ObstacleVisual {
  readonly object = new Group();

  protected constructor(
    readonly instance: ObstacleInstance,
    protected readonly params: P,
  ) {
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
  }

  abstract update(t: number, dt: number, runtime?: ObstacleRuntime): void;

  /** Adds a child mesh to the root. */
  protected add<T extends Object3D>(o: T): T {
    this.object.add(o);
    return o;
  }

  dispose(): void {
    disposeObject(this.object);
  }
}

/**
 * Narrows an optional runtime to a module's richer view when it exposes the
 * given key (duck-typed: visuals never import runtime classes).
 */
export function runtimeView<V extends ObstacleRuntime>(
  runtime: ObstacleRuntime | undefined,
  key: keyof V,
): V | undefined {
  return runtime && key in runtime ? (runtime as V) : undefined;
}

/** Critically-damped-ish spring wobble after an impulse at `since` seconds ago. */
export function wobble(since: number, freq = 14, decay = 6): number {
  if (since < 0 || since > 2) return 0;
  return Math.sin(since * freq) * Math.exp(-since * decay);
}
