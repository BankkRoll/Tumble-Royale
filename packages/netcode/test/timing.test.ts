import { describe, expect, it } from 'vitest';
import { Rng } from '@tumble/shared';
import type { CharacterInput } from '@tumble/sim';
import { BitReader, BitWriter } from '../src/bits.ts';
import { ClockSync } from '../src/clock.ts';
import { InputHistory } from '../src/history.ts';
import {
  readInputBatch,
  writeInputBatch,
  quantizeInputInPlace,
  type InputBatchHeader,
} from '../src/input.ts';
import { InputJitterBuffer } from '../src/jitter.ts';
import { InterpolationClock, SnapshotInterpolator, createRenderEntityState } from '../src/interpolation.ts';
import { createNetEntityState } from '../src/snapshot.ts';

const input = (moveX = 0, buttons = 0): CharacterInput => ({ moveX, moveZ: 0, yaw: 0, buttons, emote: 0 });

describe('ClockSync', () => {
  it('converges to the true offset within 3 ms under jitter and asymmetric spikes', () => {
    const rng = new Rng(4);
    let local = 1000;
    const trueOffset = 123456.7; // server = local + offset
    const clock = new ClockSync(() => local);
    for (let i = 0; i < 40; i++) {
      local += 2000;
      const t0 = local;
      const up = 40 + rng.next() * 30 + (rng.chance(0.15) ? 300 : 0);
      const down = 40 + rng.next() * 30 + (rng.chance(0.15) ? 300 : 0);
      const t1 = t0 + up + trueOffset;
      const t2 = t1 + 0.2;
      const t3 = t0 + up + down + 0.2;
      clock.addSample(t0, t1, t2, t3);
    }
    expect(Math.abs(clock.offset - trueOffset)).toBeLessThan(3);
    expect(clock.rtt).toBeGreaterThan(60);
    expect(clock.rtt).toBeLessThan(250);
    expect(clock.rejected).toBeGreaterThan(0);
    expect(Math.abs(clock.serverTimeNow() - (local + trueOffset))).toBeLessThan(3);
  });

  it('extrapolates match time from an anchor', () => {
    let local = 0;
    const clock = new ClockSync(() => local);
    clock.addSample(0, 500, 500, 0);
    clock.setMatchAnchor(500, 10);
    local = 1000;
    expect(clock.matchTime()).toBeCloseTo(11, 5);
  });
});

describe('InputJitterBuffer', () => {
  it('paces bursty arrivals into one input per step, without misses', () => {
    const buf = new InputJitterBuffer();
    const out = input();
    const consumed: number[] = [];
    let seq = 0;
    for (let tick = 0; tick < 300; tick++) {
      const now = tick * 33.33;
      // Two inputs arrive per server tick, but every 4th tick the burst is late by one tick.
      if (tick % 4 !== 1) {
        const n = tick % 4 === 2 ? 4 : 2;
        for (let k = 0; k < n; k++, seq++) buf.push(seq, input(seq / 1000), now);
      }
      for (let s = 0; s < 2; s++) {
        const c = buf.next(out);
        if (c >= 0) consumed.push(c);
      }
    }
    for (let i = 1; i < consumed.length; i++) expect(consumed[i]).toBe(consumed[i - 1]! + 1);
    expect(buf.missed).toBe(0);
    expect(buf.targetDepth).toBeGreaterThanOrEqual(2);
    expect(buf.targetDepth).toBeLessThanOrEqual(6);
  });

  it('repeats the last input when one is lost, and drops late/duplicate inputs', () => {
    const buf = new InputJitterBuffer({ minDepth: 2 });
    const out = input();
    buf.push(0, input(0.1), 0);
    buf.push(1, input(0.2, 1), 16);
    expect(buf.next(out)).toBe(0);
    expect(buf.next(out)).toBe(1);
    buf.push(3, input(0.4), 50); // seq 2 lost
    expect(buf.next(out)).toBe(2);
    expect(out.moveX).toBeCloseTo(0.2);
    expect(out.buttons).toBe(1);
    expect(buf.missed).toBe(1);
    expect(buf.push(2, input(0.3), 60)).toBe(false); // late
    expect(buf.push(3, input(0.4), 60)).toBe(false); // duplicate
    expect(buf.next(out)).toBe(3);
    expect(out.moveX).toBeCloseTo(0.4);
    // Underrun: nothing newer — repeat without consuming a sequence.
    expect(buf.next(out)).toBe(-1);
    expect(buf.underruns).toBe(1);
    buf.push(4, input(0.5), 80);
    expect(buf.next(out)).toBe(4);
  });

  it('grows the target under jitter', () => {
    const rng = new Rng(8);
    const buf = new InputJitterBuffer();
    const out = input();
    for (let seq = 0; seq < 600; seq++) {
      buf.push(seq, input(), seq * 16.67 + rng.next() * 60);
      buf.next(out);
    }
    expect(buf.targetDepth).toBeGreaterThan(2);
  });
});

describe('InputBatch', () => {
  it('round-trips the newest input plus redundant copies', () => {
    const w = new BitWriter();
    const inputs = [
      quantizeInputInPlace({ moveX: 0.5, moveZ: -1, yaw: 2.1, buttons: 5, emote: 2 }),
      quantizeInputInPlace({ moveX: 0.5, moveZ: -1, yaw: 2.1, buttons: 5, emote: 2 }),
      quantizeInputInPlace({ moveX: -0.25, moveZ: 0.1, yaw: -3, buttons: 0, emote: 0 }),
    ];
    const header: InputBatchHeader = { newestSeq: 77, clientTick: 9999, ackSnapshotId: 65535, count: 3 };
    writeInputBatch(w, header, inputs);
    const bytes = w.finish().slice();
    expect(bytes.length).toBeLessThanOrEqual(23);
    const r = new BitReader(bytes);
    r.readBits(8);
    const out = [input(), input(), input()];
    const h: InputBatchHeader = { newestSeq: 0, clientTick: 0, ackSnapshotId: 0, count: 0 };
    readInputBatch(r, out, h);
    expect(h).toEqual(header);
    expect(out).toEqual(inputs);
  });

  it('InputHistory collects the most recent inputs newest-first', () => {
    const h = new InputHistory(8);
    for (let i = 0; i < 20; i++) h.push(input(i / 100));
    const out = [input(), input(), input()];
    expect(h.collectRecent(19, 3, out)).toBe(3);
    expect(out.map((o) => Math.round(o.moveX * 100))).toEqual([19, 18, 17]);
    expect(h.get(5)).toBeUndefined();
  });
});

describe('SnapshotInterpolator', () => {
  it('produces a smooth path (bounded acceleration) from jittery, lossy 30 Hz samples of a circle', () => {
    const rng = new Rng(12);
    const interp = new SnapshotInterpolator();
    const clock = new InterpolationClock();
    const s = createNetEntityState();
    const out = createRenderEntityState();
    const R = 6;
    const w = 1.2; // rad/s → 7.2 m/s
    const pos = (t: number): { x: number; z: number } => ({ x: R * Math.cos(w * t), z: R * Math.sin(w * t) });
    // Arrival events: (localTime, snapshotTime)
    const arrivals: { local: number; snap: number }[] = [];
    for (let k = 0; k < 300; k++) {
      if (rng.chance(0.03)) continue; // loss
      const snap = k * (1000 / 30);
      arrivals.push({ local: snap + 60 + rng.next() * 25, snap });
    }
    arrivals.sort((a, b) => a.local - b.local);
    let ai = 0;
    let prev: { x: number; z: number; vx: number; vz: number } | null = null;
    let maxAccel = 0;
    let maxErr = 0;
    let extrapolatedFrames = 0;
    for (let local = 0; local < 10000; local += 1000 / 144) {
      while (ai < arrivals.length && arrivals[ai]!.local <= local) {
        const a = arrivals[ai++]!;
        const t = a.snap / 1000;
        const p = pos(t);
        s.pos.x = p.x;
        s.pos.z = p.z;
        s.vel.x = -R * w * Math.sin(w * t);
        s.vel.z = R * w * Math.cos(w * t);
        interp.push(a.snap, s);
        clock.onSnapshot(local, a.snap);
      }
      if (interp.size < 2) continue;
      const rt = clock.renderTime(local);
      interp.sample(rt, out);
      if (out.extrapolated) extrapolatedFrames++;
      if (local > 1500) {
        const truth = pos(rt / 1000);
        maxErr = Math.max(maxErr, Math.hypot(out.pos.x - truth.x, out.pos.z - truth.z));
        if (prev) {
          const dt = 1 / 144;
          const ax = (out.vel.x - prev.vx) / dt;
          const az = (out.vel.z - prev.vz) / dt;
          maxAccel = Math.max(maxAccel, Math.hypot(ax, az));
        }
      }
      prev = { x: out.pos.x, z: out.pos.z, vx: out.vel.x, vz: out.vel.z };
    }
    // Centripetal acceleration is R·w² ≈ 8.6 m/s²; allow headroom for render-clock slewing.
    expect(maxAccel).toBeLessThan(40);
    expect(maxErr).toBeLessThan(0.05);
    expect(extrapolatedFrames).toBeLessThan(50);
    expect(clock.delayMs).toBeGreaterThanOrEqual(100);
    expect(clock.delayMs).toBeLessThanOrEqual(250);
  });

  it('extrapolates briefly then holds', () => {
    const interp = new SnapshotInterpolator({ maxExtrapolationMs: 250 });
    const s = createNetEntityState();
    const out = createRenderEntityState();
    s.vel.x = 10;
    interp.push(0, s);
    s.pos.x = 1;
    interp.push(100, s);
    interp.sample(200, out);
    expect(out.pos.x).toBeCloseTo(2);
    expect(out.extrapolated).toBe(true);
    interp.sample(1000, out);
    expect(out.pos.x).toBeCloseTo(3.5);
  });

  it('does not blend across teleports', () => {
    const interp = new SnapshotInterpolator();
    const s = createNetEntityState();
    const out = createRenderEntityState();
    interp.push(0, s);
    s.pos.x = 50; // respawn far away
    interp.push(33, s);
    interp.sample(20, out);
    expect(out.pos.x).toBe(0);
  });
});
