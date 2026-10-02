/**
 * Small, fast, seedable PRNG (sfc32). Used everywhere randomness must agree
 * between server and clients: door layouts, variations, bot decisions.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /**
   * @param seed - Any 32-bit integer. Equal seeds produce equal sequences on every platform.
   */
  constructor(seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    // sfc32 output is poorly mixed for the first handful of draws.
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  /** @returns A uniformly distributed unsigned 32-bit integer. */
  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** @returns A float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** @returns A float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** @returns An integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** @returns true with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** @returns A random element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Shuffles `items` in place (Fisher–Yates) and returns it. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Picks an index with probability proportional to its weight.
   *
   * @param weights - Non-negative weights; at least one must be positive.
   * @returns The chosen index.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) throw new Error('Rng.weightedIndex needs a positive total weight');
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i] as number;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Derives an independent child generator, e.g. one per obstacle instance. */
  fork(salt: number): Rng {
    return new Rng((this.nextU32() ^ Math.imul(salt, 0x85ebca6b)) >>> 0);
  }
}

/**
 * Hashes a string to a 32-bit seed (FNV-1a).
 *
 * @example
 * new Rng(hashString('gumdrop-gauntlet') ^ showSeed)
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Stateless integer hash → [0, 1). Handy for per-index pseudo-randomness inside
 * pure `pose(t)` functions where carrying an Rng would be awkward.
 */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x27d4eb2d, 0x165667b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
