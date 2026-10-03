import { describe, expect, it } from 'vitest';
import {
  BitReader,
  BitWriter,
  KickReason,
  MsgType,
  readKick,
  writeHello,
  writeInputBatch,
} from '@tumble/netcode';
import { RoundPhase } from '@tumble/shared';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { FakeConnection, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const TICK_MS = 1000 / 30;

function setup(config: { capacity?: number; fillWaitMs?: number; resumeWindowMs?: number } = {}) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const manager = new RoomManager(testDeps(clock, sims), new ServerMetrics(), null, {
    config: { capacity: 4, fillWaitMs: 500, startAtHumans: 4, resumeWindowMs: 30_000, ...config },
    profileLogMs: 0,
  });
  const connect = (name = 'p', token = ''): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello(name, token);
    c.pump(clock.now);
    return c;
  };
  const advance = (ticks: number, clients: TestClient[] = [], each?: () => void): void => {
    for (let i = 0; i < ticks; i++) {
      each?.();
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) c.pump(clock.now);
    }
  };
  return { clock, sims, manager, connect, advance };
}

describe('Room', () => {
  it('accepts a connection, fills with bots after the wait, and streams snapshots', () => {
    const { sims, connect, advance } = setup();
    const c = connect('alice');
    expect(c.welcome?.playerId).toBe(0);
    expect(c.welcome?.resumeToken.length).toBeGreaterThan(10);

    advance(10, [c]);
    expect(sims.length).toBe(0); // still waiting for players
    expect(c.lowFreq('lobby').length).toBeGreaterThan(0);

    advance(20, [c]);
    expect(sims.length).toBe(1);
    expect(sims[0]!.opts.players.map((p) => p.isBot)).toEqual([false, true, true, true]);
    const list = c.lowFreq('playerList').at(-1);
    expect(list && list.t === 'playerList' && list.players.length).toBe(4);
    expect(c.lowFreq('joinRound').length).toBe(1);
    expect(
      c.lowFreq('roundPhase').some((m) => m.t === 'roundPhase' && m.phase === RoundPhase.Countdown),
    ).toBe(true);

    // Human inputs flow through the jitter buffer into the sim; bots through their brains.
    advance(30, [c], () => {
      c.input({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
      c.input({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    });
    expect(c.snapshots.length).toBeGreaterThan(20);
    const last = c.snapshots.at(-1)!;
    expect(last.ackedInputSeq).toBeGreaterThan(30);
    expect(c.snapshots.filter((s) => s.baselineId >= 0).length).toBeGreaterThan(10);
    const sim = sims[0]!;
    expect(sim.applied.get(0)!.some((i) => i.moveX === 1)).toBe(true);
    expect(sim.applied.get(1)!.every((i) => i.moveX === 0.5)).toBe(true);
    // Two sim steps per network tick.
    const ticksBefore = sim.tick;
    advance(5, [c]);
    expect(sim.tick - ticksBefore).toBe(10);
  });

  it('forwards SimEvents on the reliable channel', () => {
    const { connect, advance } = setup({ fillWaitMs: 0 });
    const c = connect();
    advance(5, [c]);
    advance(10, [c], () => {
      c.input({ moveX: 0, moveZ: 0, yaw: 0, buttons: 1, emote: 0 });
      c.input({ moveX: 0, moveZ: 0, yaw: 0, buttons: 1, emote: 0 });
    });
    const jumps = c.messages.filter(
      (m) => m.kind === 'sim' && m.event.type === 'jump' && m.event.player === 0,
    );
    expect(jumps.length).toBe(1);
  });

  it('idles a disconnected player, resumes within the window with a full snapshot, and expires the token after', () => {
    const { sims, connect, advance, clock, manager } = setup({ fillWaitMs: 0 });
    const c = connect('bob');
    const token = c.welcome!.resumeToken;
    advance(10, [c], () => {
      c.input({ moveX: 1, moveZ: 0, yaw: 1, buttons: 0, emote: 0 });
      c.input({ moveX: 1, moveZ: 0, yaw: 1, buttons: 0, emote: 0 });
    });
    c.conn.close();
    const sim = sims[0]!;
    const before = sim.applied.get(0)!.length;
    advance(15);
    const idle = sim.applied.get(0)!.slice(before + 4);
    expect(idle.length).toBeGreaterThan(10);
    expect(idle.every((i) => i.moveX === 0 && i.buttons === 0)).toBe(true);

    const c2 = connect('bob', token);
    expect(c2.welcome?.resumed).toBe(true);
    expect(c2.welcome?.playerId).toBe(0);
    advance(3, [c2]);
    expect(c2.lowFreq('joinRound').length).toBe(1);
    expect(c2.snapshots[0]!.baselineId).toBe(-1);
    expect(manager.list()[0]!.connected).toBe(1);

    c2.conn.close();
    clock.now += 31_000;
    advance(2);
    const c3 = connect('bob', token);
    expect(c3.welcome?.resumed).toBe(false);
    // The show is running, so the expired player lands in a fresh lobby room.
    expect(c3.welcome?.roomId).not.toBe(c2.welcome?.roomId);
  });

  it('rejects mismatched protocol versions', () => {
    const { manager } = setup();
    const conn = new FakeConnection();
    manager.accept(conn);
    const w = new BitWriter();
    writeHello(w, { version: 999, name: 'x', resumeToken: '', loadout: '' });
    conn.receive(w.finish());
    const r = new BitReader(conn.sent[0]!);
    expect(r.readBits(8)).toBe(MsgType.Kick);
    expect(readKick(r).reason).toBe(KickReason.VersionMismatch);
    expect(conn.open).toBe(false);
  });

  it('drops impossible input sequence jumps', () => {
    const { connect, advance, sims } = setup({ fillWaitMs: 0 });
    const c = connect();
    advance(3, [c]);
    c.input({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    // Forge a far-future sequence: one input per step can't get 100k steps ahead in 100 ms.
    const w = new BitWriter();
    writeInputBatch(w, { newestSeq: 100_000, clientTick: 0, ackSnapshotId: -1, count: 1 }, [
      { moveX: 1, moveZ: 1, yaw: 0, buttons: 0, emote: 0 },
    ]);
    c.conn.receive(w.finish());
    advance(5, [c]);
    expect(sims[0]!.applied.get(0)!.some((i) => i.moveX === 1)).toBe(false);
  });
});
