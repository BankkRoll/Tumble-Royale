import { describe, expect, it } from 'vitest';
import { Rng, type Quat } from '@tumble/shared';
import {
  PositionQuantizer,
  dequantizeVelocity,
  dequantizeYaw,
  packQuat,
  quantizeVelocity,
  quantizeYaw,
  quatAngle,
  unpackQuat,
  VELOCITY_MAX,
} from '../src/quantize.ts';

function randomQuat(rng: Rng): Quat {
  // Marsaglia: uniform over SO(3).
  const u1 = rng.next();
  const u2 = rng.next() * Math.PI * 2;
  const u3 = rng.next() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return { x: a * Math.sin(u2), y: a * Math.cos(u2), z: b * Math.sin(u3), w: b * Math.cos(u3) };
}

describe('quaternion smallest-three (2 + 3 × 10 bits)', () => {
  it('stays under 0.25° error for uniformly random rotations', () => {
    const rng = new Rng(7);
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      const q = randomQuat(rng);
      unpackQuat(packQuat(q), out);
      worst = Math.max(worst, quatAngle(q, out));
    }
    // Documented bound in quantize.ts / PROTOCOL.md.
    expect((worst * 180) / Math.PI).toBeLessThan(0.25);
  });

  it('fits in 32 bits and treats q and -q identically', () => {
    const q = { x: 0.1, y: -0.7, z: 0.2, w: 0.676 };
    const neg = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
    expect(packQuat(q)).toBe(packQuat(neg));
    expect(packQuat(q)).toBeLessThan(2 ** 32);
  });

  it('round-trips identity exactly', () => {
    const out: Quat = { x: 1, y: 1, z: 1, w: 1 };
    unpackQuat(packQuat({ x: 0, y: 0, z: 0, w: 1 }), out);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

describe('position quantisation (16 bit/axis)', () => {
  it('error ≤ half a step inside the bounds; clamps outside', () => {
    const q = new PositionQuantizer({ min: { x: -100, y: -20, z: -50 }, max: { x: 100, y: 60, z: 250 } });
    const rng = new Rng(3);
    const out = { x: 0, y: 0, z: 0 };
    let worst = 0;
    for (let i = 0; i < 10000; i++) {
      const p = { x: rng.range(-100, 100), y: rng.range(-20, 60), z: rng.range(-50, 250) };
      q.dequantize(q.qx(p.x), q.qy(p.y), q.qz(p.z), out);
      worst = Math.max(worst, Math.abs(out.x - p.x), Math.abs(out.y - p.y), Math.abs(out.z - p.z));
    }
    expect(worst).toBeLessThanOrEqual(q.maxError + 1e-9);
    expect(q.maxError).toBeLessThan(0.0025); // 300 m axis → ~2.3 mm
    q.dequantize(q.qx(1e6), q.qy(-1e6), q.qz(0), out);
    expect(out.x).toBeCloseTo(100);
    expect(out.y).toBeCloseTo(-20);
  });
});

describe('velocity and yaw', () => {
  it('velocity: zero is exact, error ≤ 0.01 m/s, clamped to ±40', () => {
    expect(dequantizeVelocity(quantizeVelocity(0))).toBe(0);
    for (let v = -VELOCITY_MAX; v <= VELOCITY_MAX; v += 0.0731) {
      expect(Math.abs(dequantizeVelocity(quantizeVelocity(v)) - v)).toBeLessThan(0.01);
    }
    expect(dequantizeVelocity(quantizeVelocity(1000))).toBe(VELOCITY_MAX);
    expect(quantizeVelocity(1000)).toBeLessThan(4096);
  });

  it('yaw: 16 bits, wraps, error < 0.003°', () => {
    for (let a = -10; a < 10; a += 0.0137) {
      const d = dequantizeYaw(quantizeYaw(a));
      let diff = Math.abs(d - a) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      expect((diff * 180) / Math.PI).toBeLessThan(0.003);
    }
  });
});
