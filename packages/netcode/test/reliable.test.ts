import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from '../src/bits.ts';
import { NetworkConditioner } from '../src/conditioner.ts';
import { decodeReliableMessage, encodeReliableMessage, type ReliableMessage } from '../src/events.ts';
import { MsgType } from '../src/protocol.ts';
import { ReliableEndpoint, seqNewer } from '../src/reliable.ts';

describe('ReliableEndpoint', () => {
  it('delivers every message exactly once, in order, under 20% loss + reorder + duplication', () => {
    let now = 0;
    const clock = (): number => now;
    const a = new ReliableEndpoint();
    const b = new ReliableEndpoint();
    const gotB: number[] = [];
    const gotA: number[] = [];
    const reader = new BitReader();
    const wa = new BitWriter();
    const wb = new BitWriter();
    const toB = new NetworkConditioner(
      { latencyMs: 40, jitterMs: 30, loss: 0.2, reorder: 0.1, duplicate: 0.05, seed: 1 },
      (d) => {
        reader.reset(d);
        expect(reader.readBits(8)).toBe(MsgType.Reliable);
        b.receive(reader, (p) => gotB.push(new DataView(p.buffer, p.byteOffset).getUint32(0, true)));
      },
      clock,
    );
    const toA = new NetworkConditioner(
      { latencyMs: 40, jitterMs: 30, loss: 0.2, reorder: 0.1, seed: 2 },
      (d) => {
        reader.reset(d);
        reader.readBits(8);
        a.receive(reader, (p) => gotA.push(new DataView(p.buffer, p.byteOffset).getUint32(0, true)));
      },
      clock,
    );
    const msg = (n: number): Uint8Array => {
      const u = new Uint8Array(4 + (n % 50));
      new DataView(u.buffer).setUint32(0, n, true);
      return u;
    };

    const N = 2000;
    let sentA = 0;
    let sentB = 0;
    for (let t = 0; t < 60000 && (gotB.length < N || gotA.length < N / 4); t += 16) {
      now = t;
      // Bursty application traffic both ways.
      for (let k = 0; k < 3 && sentA < N; k++) a.send(msg(sentA++));
      if (t % 64 === 0 && sentB < N / 4) b.send(msg(sentB++));
      if (a.flush(now, 100, wa.reset())) toB.send(wa.finish());
      if (b.flush(now, 100, wb.reset())) toA.send(wb.finish());
      toB.update();
      toA.update();
    }
    expect(gotB).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(gotA).toEqual(Array.from({ length: N / 4 }, (_, i) => i));
    expect(a.retransmits).toBeGreaterThan(0);
    // Everything acknowledged eventually.
    for (let t = 0; t < 3000; t += 16) {
      now += 16;
      if (a.flush(now, 100, wa.reset())) toB.send(wa.finish());
      if (b.flush(now, 100, wb.reset())) toA.send(wb.finish());
      toB.update();
      toA.update();
    }
    expect(a.pending).toBe(0);
  });

  describe('receive limits', () => {
    const w = new BitWriter(1 << 17);
    const r = new BitReader();
    /** Feeds one hand-made packet carrying `[seq, payload]` messages; returns receive()'s verdict. */
    const feed = (ep: ReliableEndpoint, msgs: [number, Uint8Array][], got: number[] = []): boolean => {
      w.reset();
      w.writeBits(MsgType.Reliable, 8);
      w.writeBool(false);
      w.writeVarUint(msgs.length);
      for (const [seq, data] of msgs) {
        w.writeBits(seq, 16);
        w.writeByteArray(data);
      }
      r.reset(w.finish());
      r.readBits(8);
      return ep.receive(r, (p) => got.push(p[0]!));
    };
    const one = (tag: number, size = 1): Uint8Array => new Uint8Array(size).fill(tag);

    it('refuses messages over the size cap and sequences implausibly far ahead', () => {
      const ep = new ReliableEndpoint({ maxMessageBytes: 2048 });
      expect(feed(ep, [[0, one(1, 2048)]])).toBe(true);
      expect(feed(ep, [[1, one(1, 2049)]])).toBe(false);
      expect(feed(ep, [[1 + 256, one(1)]])).toBe(true);
      expect(feed(ep, [[1 + 257, one(1)]])).toBe(false);
    });

    it('holds out-of-order messages within a count and byte budget, then recovers by retransmission', () => {
      const ep = new ReliableEndpoint({ maxEarly: 4, maxEarlyBytes: 1000 });
      const got: number[] = [];
      // Seq 0 is missing; 1..6 arrive early but only four fit, and 600 + 600 bytes would not.
      expect(feed(ep, [[1, one(1, 600)]], got)).toBe(true);
      expect(feed(ep, [[2, one(2, 600)]], got)).toBe(true);
      for (let s = 3; s <= 6; s++) expect(feed(ep, [[s, one(s)]], got)).toBe(true);
      expect(feed(ep, [[0, one(0)]], got)).toBe(true);
      expect(got).toEqual([0, 1]);
      // The dropped ones were never acked; the sender resends them and delivery completes in order.
      expect(feed(ep, [[2, one(2, 600)]], got)).toBe(true);
      expect(got).toEqual([0, 1, 2, 3, 4, 5]);
      expect(feed(ep, [[6, one(6)]], got)).toBe(true);
      expect(got).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });

  it('16-bit sequence comparison wraps', () => {
    expect(seqNewer(1, 65535)).toBe(true);
    expect(seqNewer(65535, 1)).toBe(false);
    expect(seqNewer(5, 5)).toBe(false);
  });
});

describe('reliable message codec', () => {
  it('round-trips SimEvents and low-frequency messages', () => {
    const msgs: ReliableMessage[] = [
      { kind: 'sim', tick: 1234, event: { type: 'jump', player: 3, pos: { x: 1.5, y: 2, z: -3.25 } } },
      {
        kind: 'sim',
        tick: 1,
        event: { type: 'bounce', player: 3, pos: { x: 0, y: 0, z: 0 }, obstacle: 'pad-1' },
      },
      { kind: 'sim', tick: 1, event: { type: 'bounce', player: 3, pos: { x: 0, y: 0, z: 0 } } },
      { kind: 'sim', tick: 9, event: { type: 'grabEnd', player: 1, target: -1, reason: 'stamina' } },
      { kind: 'sim', tick: 9, event: { type: 'score', team: 2, player: 7, delta: -1, total: 12 } },
      {
        kind: 'sim',
        tick: 9,
        event: { type: 'obstacleCue', obstacle: 'cannon-a', cue: 'fire', pos: { x: 1, y: 2, z: 3 } },
      },
      { kind: 'msg', msg: { t: 'chat', from: 4, text: 'gg ✓' } },
      { kind: 'msg', msg: { t: 'roundPhase', phase: 3, time: -2.5 } },
    ];
    for (const m of msgs) expect(decodeReliableMessage(encodeReliableMessage(m))).toEqual(m);
  });

  it('carries unknown future event types via the msgpack fallback', () => {
    // A SimEvent member added to the union after this table was written.
    const future = { type: 'futureThing', player: 1, extra: [1, 2] } as unknown as ReliableMessage & {
      kind: 'sim';
    };
    const m = { kind: 'sim', tick: 5, event: future } as unknown as ReliableMessage;
    expect(decodeReliableMessage(encodeReliableMessage(m))).toEqual(m);
  });
});
