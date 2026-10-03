/**
 * Pose buffer: Euler rotation offsets for every core bone, a root offset and a
 * squash/stretch scalar. Poses are blended linearly (procedural offsets stay
 * well inside the range where that looks right) and written to bones once.
 */
import { CORE_BONE_COUNT } from './rig.ts';

/** Short bone names used by pose and clip authoring, index-aligned with `Bone`. */
export const SHORT_BONE = [
  'root',
  'hips',
  'spine',
  'chest',
  'head',
  'uArmL',
  'lArmL',
  'handL',
  'uArmR',
  'lArmR',
  'handR',
  'uLegL',
  'lLegL',
  'footL',
  'uLegR',
  'lLegR',
  'footR',
] as const;

/** A short bone name. */
export type ShortBone = (typeof SHORT_BONE)[number];

/** Pose channel offsets. */
export const CH = {
  /** Root position offset x/y/z. */
  pos: CORE_BONE_COUNT * 3,
  /** Squash (−) / stretch (+) around the feet. */
  stretch: CORE_BONE_COUNT * 3 + 3,
  /** Total channel count. */
  count: CORE_BONE_COUNT * 3 + 4,
} as const;

const boneIndex = new Map<string, number>(SHORT_BONE.map((n, i) => [n, i]));

/**
 * Resolves a channel name (`uArmL.z`, `pos.y`, `stretch`) to an index.
 *
 * @param name - Channel name.
 * @returns Channel index, or -1 when unknown.
 */
export function channelIndex(name: string): number {
  if (name === 'stretch') return CH.stretch;
  const [b, a] = name.split('.');
  const axis = a === 'x' ? 0 : a === 'y' ? 1 : a === 'z' ? 2 : -1;
  if (axis < 0) return -1;
  if (b === 'pos') return CH.pos + axis;
  const i = boneIndex.get(b ?? '');
  return i === undefined ? -1 : i * 3 + axis;
}

/** A full-body pose. */
export class Pose {
  readonly v = new Float32Array(CH.count);

  /** Zeroes every channel (rest pose). */
  clear(): this {
    this.v.fill(0);
    return this;
  }

  /** Copies every channel from `o`. */
  copy(o: Pose): this {
    this.v.set(o.v);
    return this;
  }

  /** `this += o * w` */
  addScaled(o: Pose, w: number): this {
    const a = this.v;
    const b = o.v;
    for (let i = 0; i < a.length; i++) a[i] = a[i]! + b[i]! * w;
    return this;
  }

  /** `this = lerp(this, o, t)` */
  lerp(o: Pose, t: number): this {
    const a = this.v;
    const b = o.v;
    for (let i = 0; i < a.length; i++) a[i] = a[i]! + (b[i]! - a[i]!) * t;
    return this;
  }

  /** Adds to a bone rotation. */
  rot(bone: number, x: number, y: number, z: number): this {
    const o = bone * 3;
    this.v[o] = this.v[o]! + x;
    this.v[o + 1] = this.v[o + 1]! + y;
    this.v[o + 2] = this.v[o + 2]! + z;
    return this;
  }

  /**
   * Adds a symmetric rotation to a left/right bone pair: X is shared, Y and Z
   * mirror, so positive Z always means "away from the body".
   */
  sym(left: number, right: number, x: number, y: number, z: number): this {
    this.rot(left, x, y, z);
    return this.rot(right, x, -y, -z);
  }

  /** Adds to the root position offset. */
  move(x: number, y: number, z: number): this {
    this.v[CH.pos] = this.v[CH.pos]! + x;
    this.v[CH.pos + 1] = this.v[CH.pos + 1]! + y;
    this.v[CH.pos + 2] = this.v[CH.pos + 2]! + z;
    return this;
  }

  /** Adds squash/stretch. */
  stretch(s: number): this {
    this.v[CH.stretch] = this.v[CH.stretch]! + s;
    return this;
  }
}

/**
 * Smooth 1D value noise in [-1, 1], allocation-free. Used for idle sway and
 * look-around so crowds don't move in lockstep.
 *
 * @param x - Coordinate.
 * @param seed - Per-instance seed.
 * @returns Noise value.
 */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lattice(i, seed) * (1 - u) + lattice(i + 1, seed) * u;
}

function lattice(n: number, seed: number): number {
  const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}
