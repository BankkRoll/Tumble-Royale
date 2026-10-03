import { describe, expect, it } from 'vitest';
import { Rng } from '@tumble/shared';
import { BitReader, BitWriter } from '../src/bits.ts';

type Op =
  | { k: 'bits'; n: number; v: number }
  | { k: 'int'; n: number; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'f32'; v: number }
  | { k: 'f64'; v: number }
  | { k: 'varu'; v: number }
  | { k: 'vari'; v: number }
  | { k: 'str'; v: string }
  | { k: 'q'; v: number; min: number; max: number; n: number };

function randomOp(rng: Rng): Op {
  switch (rng.int(0, 8)) {
    case 0: {
      const n = rng.int(1, 32);
      return { k: 'bits', n, v: n === 32 ? rng.nextU32() : rng.nextU32() % 2 ** n };
    }
    case 1: {
      const n = rng.int(2, 32);
      const half = 2 ** (n - 1);
      return { k: 'int', n, v: Math.floor(rng.range(-half, half)) };
    }
    case 2:
      return { k: 'bool', v: rng.chance(0.5) };
    case 3:
      return { k: 'f32', v: Math.fround(rng.range(-1e6, 1e6)) };
    case 4:
      return { k: 'f64', v: rng.range(-1e12, 1e12) };
    case 5:
      return { k: 'varu', v: Math.floor(rng.next() * 2 ** rng.int(0, 52)) };
    case 6:
      return { k: 'vari', v: Math.floor(rng.range(-1, 1) * 2 ** rng.int(0, 50)) };
    case 7:
      return { k: 'str', v: ['', 'a', 'Tumbler', 'ünïcødé ✓', 'x'.repeat(rng.int(0, 60))][rng.int(0, 4)]! };
    default: {
      const n = rng.int(2, 16);
      return { k: 'q', v: rng.range(-10, 10), min: -10, max: 10, n };
    }
  }
}

describe('BitWriter / BitReader', () => {
  it('round-trips random mixed sequences (fuzz)', () => {
    const rng = new Rng(42);
    const w = new BitWriter(8); // tiny start capacity exercises growth
    const r = new BitReader();
    for (let iter = 0; iter < 400; iter++) {
      const ops: Op[] = Array.from({ length: rng.int(1, 60) }, () => randomOp(rng));
      w.reset();
      for (const op of ops) {
        if (op.k === 'bits') w.writeBits(op.v, op.n);
        else if (op.k === 'int') w.writeInt(op.v, op.n);
        else if (op.k === 'bool') w.writeBool(op.v);
        else if (op.k === 'f32') w.writeFloat32(op.v);
        else if (op.k === 'f64') w.writeFloat64(op.v);
        else if (op.k === 'varu') w.writeVarUint(op.v);
        else if (op.k === 'vari') w.writeVarInt(op.v);
        else if (op.k === 'str') w.writeString(op.v);
        else w.writeQuantized(op.v, op.min, op.max, op.n);
      }
      r.reset(w.finish().slice());
      for (const op of ops) {
        if (op.k === 'bits') expect(r.readBits(op.n)).toBe(op.v);
        else if (op.k === 'int') expect(r.readInt(op.n)).toBe(op.v);
        else if (op.k === 'bool') expect(r.readBool()).toBe(op.v);
        else if (op.k === 'f32') expect(r.readFloat32()).toBe(op.v);
        else if (op.k === 'f64') expect(r.readFloat64()).toBe(op.v);
        else if (op.k === 'varu') expect(r.readVarUint()).toBe(op.v);
        else if (op.k === 'vari') expect(r.readVarInt()).toBe(op.v);
        else if (op.k === 'str') expect(r.readString()).toBe(op.v);
        else {
          const step = (op.max - op.min) / (2 ** op.n - 1);
          expect(Math.abs(r.readQuantized(op.min, op.max, op.n) - op.v)).toBeLessThanOrEqual(step / 2 + 1e-9);
        }
      }
      expect(r.overflow).toBe(false);
    }
  });

  it('packs tightly: 3 bits + 5 bits = 1 byte', () => {
    const w = new BitWriter();
    w.writeBits(5, 3);
    w.writeBits(17, 5);
    expect(w.finish().length).toBe(1);
  });

  it('flags overflow instead of throwing on truncated input', () => {
    const w = new BitWriter();
    w.writeBits(0xabcd, 16);
    const r = new BitReader(w.finish().slice(0, 1));
    r.readBits(16);
    expect(r.overflow).toBe(true);
  });

  it('rewind restores the stream to a mark', () => {
    const w = new BitWriter();
    w.writeBits(3, 3);
    const mark = w.mark();
    w.writeBits(0x3ff, 10);
    w.rewind(mark);
    w.writeBits(1, 2);
    const r = new BitReader(w.finish().slice());
    expect(r.readBits(3)).toBe(3);
    expect(r.readBits(2)).toBe(1);
    expect(r.remainingBits).toBeLessThan(8);
  });

  it('clamps out-of-range signed and unsigned writes', () => {
    const w = new BitWriter();
    w.writeInt(1000, 8);
    w.writeInt(-1000, 8);
    w.writeUint(999, 4);
    const r = new BitReader(w.finish().slice());
    expect(r.readInt(8)).toBe(127);
    expect(r.readInt(8)).toBe(-128);
    expect(r.readUint(4)).toBe(15);
  });
});
