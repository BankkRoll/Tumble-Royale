import { describe, expect, it } from 'vitest';
import { Rng, quatFromAxisAngle, quatFromYaw } from '@tumble/shared';
import { BitReader, BitWriter } from '../src/bits.ts';
import { MsgType } from '../src/protocol.ts';
import { PositionQuantizer } from '../src/quantize.ts';
import {
  EntityTable,
  ObstacleTable,
  SnapshotDecoder,
  SnapshotEncoder,
  createDecodedSnapshot,
  createNetEntityState,
  createNetRoundStatus,
  simTickOf,
  type NetEntitySource,
  type NetEntityState,
  type SnapshotFrame,
} from '../src/snapshot.ts';

const bounds = { min: { x: -100, y: -30, z: -100 }, max: { x: 100, y: 50, z: 300 } };
const q = new PositionQuantizer(bounds);

interface Sim {
  states: NetEntitySource[];
}

function makeSim(n: number, rng: Rng): Sim {
  return {
    states: Array.from({ length: n }, () => ({
      pos: { x: rng.range(-80, 80), y: 1, z: rng.range(-80, 250) },
      rot: quatFromYaw(rng.range(-3, 3)),
      vel: { x: 0, y: 0, z: 0 },
      state: 0 as NetEntitySource['state'],
      stateTime: 0,
      facing: 0,
      flags: 0,
      grabTarget: -1,
    })),
  };
}

function stepSim(sim: Sim, rng: Rng, t: number): void {
  sim.states.forEach((s, i) => {
    // Some players idle (unchanged), most run, a few tumble (full quaternion).
    if (i % 7 === 0) {
      s.stateTime += 1 / 30;
      return;
    }
    s.vel.x = Math.sin(t + i) * 8;
    s.vel.z = Math.cos(t * 0.7 + i) * 8;
    s.pos.x = Math.max(-99, Math.min(99, s.pos.x + s.vel.x / 30));
    s.pos.z = Math.max(-99, Math.min(299, s.pos.z + s.vel.z / 30));
    s.facing = Math.atan2(s.vel.x, s.vel.z);
    if (i % 11 === 0) quatFromAxisAngle(1, 0.3, 0.2, t * 3 + i, s.rot);
    else quatFromYaw(s.facing, s.rot);
    if (rng.chance(0.05)) {
      s.state = ((s.state + 1) % 15) as NetEntitySource['state'];
      s.stateTime = 0;
    } else s.stateTime += 1 / 30;
    if (rng.chance(0.02)) s.flags ^= 1;
    if (rng.chance(0.01)) s.grabTarget = s.grabTarget < 0 ? (i + 1) % sim.states.length : -1;
  });
}

function frameFor(sim: Sim, table: EntityTable, snapshotId: number, serverTick: number, obstacles: ObstacleTable): SnapshotFrame {
  table.clear();
  sim.states.forEach((s, id) => table.set(id, s, q, simTickOf(serverTick)));
  return {
    snapshotId,
    serverTick,
    epoch: 1,
    matchTime: serverTick / 30,
    entities: table,
    obstacles,
    status: createNetRoundStatus(),
    leaders: [0, 1, 2],
    quantizer: q,
  };
}

function expectStateClose(a: NetEntityState, b: NetEntityState): void {
  expect(a.id).toBe(b.id);
  expect(a.pos).toEqual(b.pos);
  expect(a.rot).toEqual(b.rot);
  expect(a.vel).toEqual(b.vel);
  expect(a.state).toBe(b.state);
  expect(a.stateTime).toBeCloseTo(b.stateTime, 6);
  expect(a.facing).toBe(b.facing);
  expect(a.flags).toBe(b.flags);
  expect(a.grabTarget).toBe(b.grabTarget);
}

describe('snapshot delta compression', () => {
  it('delta-decoded world equals the full quantised world every tick, with acks lagging and packets lost', () => {
    const rng = new Rng(11);
    const sim = makeSim(40, rng);
    const table = new EntityTable();
    const obstacles = new ObstacleTable(['tiles', 'tilt']);
    const enc = new SnapshotEncoder({ obstacleCount: 2, byteBudget: 100000, nearRadius: 1e9 });
    const dec = new SnapshotDecoder();
    const w = new BitWriter(2048);
    const r = new BitReader();
    const out = createDecodedSnapshot();
    const view = Array.from({ length: 64 }, createNetEntityState);
    const truth = createNetEntityState();
    const pendingAcks: { at: number; id: number }[] = [];
    let deltas = 0;

    for (let tick = 1; tick <= 300; tick++) {
      stepSim(sim, rng, tick / 30);
      obstacles.update(
        new Map([
          ['tiles', [Math.floor(tick / 40), 3, 7]],
          ['tilt', [Math.sin(tick / 10) * 0.2, 0.5]],
        ]),
      );
      const frame = frameFor(sim, table, tick % 65536, tick, obstacles);
      enc.encode(w.reset(), frame, { playerId: 5, spectateTarget: -1, ackedInputSeq: tick * 2 });
      // 10% loss; acks arrive 5 ticks later.
      if (rng.chance(0.1)) continue;
      r.reset(w.finish().slice());
      expect(r.readBits(8)).toBe(MsgType.Snapshot);
      expect(dec.decode(r, q, out)).toBe('ok');
      if (out.baselineId >= 0) deltas++;
      expect(out.ackedInputSeq).toBe(tick * 2);
      pendingAcks.push({ at: tick + 5, id: out.snapshotId });
      while (pendingAcks.length && pendingAcks[0]!.at <= tick) enc.ack(pendingAcks.shift()!.id);

      // With an unlimited budget nothing is deferred, so the reconstructed view must match the truth exactly.
      const n = dec.readView(out.snapshotId, out.serverTick, q, view);
      expect(n).toBe(40);
      for (let i = 0; i < n; i++) expectStateClose(view[i]!, table.get(view[i]!.id, q, simTickOf(tick), truth));
    }
    expect(deltas).toBeGreaterThan(200);
  });

  it('skips unchanged entities entirely', () => {
    const rng = new Rng(1);
    const sim = makeSim(40, rng);
    const table = new EntityTable();
    const obstacles = new ObstacleTable([]);
    const enc = new SnapshotEncoder();
    const w = new BitWriter();
    const viewer = { playerId: 0, spectateTarget: -1, ackedInputSeq: -1 };
    enc.encode(w.reset(), frameFor(sim, table, 1, 1, obstacles), viewer);
    const full = enc.stats.bytes;
    enc.ack(1);
    for (const st of sim.states) st.stateTime += 1 / 30;
    enc.encode(w.reset(), frameFor(sim, table, 2, 2, obstacles), viewer);
    expect(enc.stats.entitiesWritten).toBe(0);
    expect(enc.stats.bytes).toBeLessThan(20);
    expect(full).toBeGreaterThan(400);
  });

  it('keeps 40 moving players within the 1.2 KB budget and still converges', () => {
    const rng = new Rng(5);
    const sim = makeSim(40, rng);
    // Cluster everyone near the viewer so interest management can't help: worst case.
    sim.states.forEach((s) => {
      s.pos.x = rng.range(-10, 10);
      s.pos.z = rng.range(-10, 10);
    });
    const table = new EntityTable();
    const obstacles = new ObstacleTable([]);
    const enc = new SnapshotEncoder();
    const dec = new SnapshotDecoder();
    const w = new BitWriter();
    const r = new BitReader();
    const out = createDecodedSnapshot();
    let maxBytes = 0;
    let total = 0;
    for (let tick = 1; tick <= 120; tick++) {
      stepSim(sim, rng, tick / 30);
      enc.encode(w.reset(), frameFor(sim, table, tick, tick, obstacles), { playerId: 3, spectateTarget: -1, ackedInputSeq: -1 });
      maxBytes = Math.max(maxBytes, enc.stats.bytes);
      if (tick > 1) total += enc.stats.bytes;
      r.reset(w.finish().slice());
      r.readBits(8);
      expect(dec.decode(r, q, out)).toBe('ok');
      enc.ack(out.snapshotId);
      // The viewer's own entity must be in every snapshot it changed in.
      expect(Array.from({ length: out.entityCount }, (_, i) => out.entities[i]!.id)).toContain(3);
    }
    expect(maxBytes).toBeLessThanOrEqual(1200);
    // Average delta snapshot for 40 running players.
    expect(total / 119).toBeLessThan(1000);
  });

  it('sends distant entities at a reduced rate', () => {
    const rng = new Rng(9);
    const sim = makeSim(2, rng);
    sim.states[0]!.pos = { x: 0, y: 1, z: 0 };
    sim.states[1]!.pos = { x: 0, y: 1, z: 200 };
    const table = new EntityTable();
    const obstacles = new ObstacleTable([]);
    const enc = new SnapshotEncoder();
    const w = new BitWriter();
    let farSent = 0;
    for (let tick = 1; tick <= 60; tick++) {
      sim.states[1]!.pos.x = Math.sin(tick) * 3; // always changing
      sim.states[1]!.vel.x = tick % 5;
      for (const st of sim.states) st.stateTime += 1 / 30;
      const frame = { ...frameFor(sim, table, tick, tick, obstacles), leaders: [] };
      enc.encode(w.reset(), frame, { playerId: 0, spectateTarget: -1, ackedInputSeq: -1 });
      enc.ack(tick);
      if (enc.stats.entitiesWritten > 0) farSent++;
    }
    expect(farSent).toBeGreaterThan(5);
    expect(farSent).toBeLessThan(30);
  });

  it('new epochs need a full snapshot; deltas against an unknown baseline are rejected', () => {
    const rng = new Rng(2);
    const sim = makeSim(4, rng);
    const table = new EntityTable();
    const obstacles = new ObstacleTable([]);
    const enc = new SnapshotEncoder();
    const dec = new SnapshotDecoder();
    const w = new BitWriter();
    const r = new BitReader();
    const out = createDecodedSnapshot();
    const viewer = { playerId: 0, spectateTarget: -1, ackedInputSeq: -1 };
    enc.encode(w.reset(), frameFor(sim, table, 1, 1, obstacles), viewer);
    enc.ack(1); // ack a snapshot the decoder will never receive
    stepSim(sim, rng, 1);
    enc.encode(w.reset(), frameFor(sim, table, 2, 2, obstacles), viewer);
    r.reset(w.finish().slice());
    r.readBits(8);
    expect(dec.decode(r, q, out)).toBe('staleEpoch');

    enc.reset();
    enc.encode(w.reset(), frameFor(sim, table, 3, 3, obstacles), viewer);
    r.reset(w.finish().slice());
    r.readBits(8);
    expect(dec.decode(r, q, out)).toBe('ok');
    enc.ack(3);
    stepSim(sim, rng, 2);
    enc.encode(w.reset(), frameFor(sim, table, 4, 4, obstacles), viewer); // lost
    enc.ack(4); // a forged/garbled ack the decoder cannot honour
    stepSim(sim, rng, 3);
    enc.encode(w.reset(), frameFor(sim, table, 5, 5, obstacles), viewer);
    r.reset(w.finish().slice());
    r.readBits(8);
    expect(dec.decode(r, q, out)).toBe('missingBaseline');
  });
});
