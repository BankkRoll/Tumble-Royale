import { Color, Quaternion, type Material, type Object3D, type Texture } from 'three/webgpu';
import { quatFromEulerYXZ, type Quat } from '@tumble/shared';

/**
 * Small helpers shared by the level, environment, VFX and scene modules:
 * disposal, rotation conversion and deterministic decor randomness.
 */

const DEG = Math.PI / 180;
const scratchQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Converts a round-data rotation (degrees, intrinsic Y-X-Z) into a three quaternion,
 * using the exact same convention the sim uses for colliders.
 *
 * @param rot - Yaw/pitch/roll in degrees; missing fields are 0.
 * @param out - Target quaternion.
 * @returns `out`.
 */
export function quaternionFromRotation(
  rot: { yaw?: number; pitch?: number; roll?: number } | undefined,
  out: Quaternion,
): Quaternion {
  quatFromEulerYXZ((rot?.yaw ?? 0) * DEG, (rot?.pitch ?? 0) * DEG, (rot?.roll ?? 0) * DEG, scratchQuat);
  return out.set(scratchQuat.x, scratchQuat.y, scratchQuat.z, scratchQuat.w);
}

/**
 * Disposes every geometry, material and material texture under `root`.
 * Shared resources (e.g. the toon ramp) survive because three only frees GPU
 * memory for textures whose `dispose()` is called, and we never call it on
 * textures flagged `userData.shared`.
 *
 * @param root - Subtree to free.
 */
export function disposeObject(root: Object3D): void {
  const seenMaterials = new Set<Material>();
  root.traverse((o) => {
    const node = o as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] };
    node.geometry?.dispose();
    const mats = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
    for (const m of mats) {
      if (seenMaterials.has(m)) continue;
      seenMaterials.add(m);
      for (const value of Object.values(m)) {
        const tex = value as Texture | null;
        if (tex && (tex as { isTexture?: boolean }).isTexture && !tex.userData.shared) tex.dispose();
      }
      m.dispose();
    }
  });
}

/**
 * Tiny deterministic PRNG (mulberry32) for decor layout. Render-side only; the
 * sim uses `Rng` from `@tumble/shared`, and decor never has to match it.
 */
export class DecorRandom {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  /** @returns Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** @returns Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** @returns Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** @returns A random element of `arr`. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length] as T;
  }
}

/**
 * Parses a hex colour into a reusable `Color` (linear working space).
 *
 * @param hex - `#rrggbb`.
 * @param out - Optional target.
 */
export function color(hex: string, out = new Color()): Color {
  return out.set(hex);
}

/** Exponential approach factor, frame-rate independent. */
export function approach(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}
