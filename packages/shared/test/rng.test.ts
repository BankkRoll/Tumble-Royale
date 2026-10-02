import { describe, expect, it } from 'vitest';
import { Rng, hashString } from '../src/index.ts';

describe('Rng', () => {
  it('is reproducible for a given seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('diverges for different seeds', () => {
    expect(new Rng(1).nextU32()).not.toBe(new Rng(2).nextU32());
  });

  it('stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r.int(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(5);
      const f = r.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('respects weights', () => {
    const r = new Rng(99);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) counts[r.weightedIndex([1, 0, 3])]!++;
    expect(counts[1]).toBe(0);
    expect(counts[2]! / counts[0]!).toBeGreaterThan(2.5);
  });

  it('hashes strings stably', () => {
    expect(hashString('tumble')).toBe(hashString('tumble'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});
