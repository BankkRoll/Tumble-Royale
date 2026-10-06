import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BitReader, BitWriter, MsgType, PROTOCOL_VERSION, readWelcome, writeHello } from '@tumble/netcode';
import { RoundPhase, ShowPhase } from '@tumble/shared';
import { LagCompensator } from '../src/lagcomp.ts';
import { TickScheduler } from '../src/scheduler.ts';
import { startGameServer } from '../src/server.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import { testDeps, type FakeMatchSim } from './helpers.ts';

describe('LagCompensator', () => {
  it('rewinds to interpolated past poses and clamps to the 150 ms window', () => {
    const lag = new LagCompensator();
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    for (let tick = 0; tick <= 40; tick += 2) {
      lag.begin(tick);
      lag.add(7, { x: tick, y: 0, z: 0 }, rot);
    }
    const p = { x: 0, y: 0, z: 0 };
    expect(lag.rewind(33, (v) => v.position(7, p) && p.x)).toBeCloseTo(33);
    expect(lag.rewind(36.5, (v) => v.position(7, p) && p.x)).toBeCloseTo(36.5);
    expect(lag.rewind(36, (v) => v.position(8, p))).toBe(false);
    // 150 ms at 60 Hz = 9 ticks: a 500 ms RTT can't rewind further than that.
    expect(lag.viewTickFor(40, 500, 100)).toBeCloseTo(31);
    // Requests older than the history clamp to the oldest record.
    expect(lag.rewind(-100, (v) => v.tick)).toBeGreaterThanOrEqual(40 - 2 * 16);
  });
});

describe('TickScheduler', () => {
  it('runs tick n at epoch + n × period', () => {
    // Without the setImmediate spin the fake clock lands exactly on each deadline.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
    try {
      const at: number[] = [];
      const s = new TickScheduler({ hz: 100, now: () => Date.now(), spinMs: 0 }, () => at.push(Date.now()));
      s.start();
      vi.advanceTimersByTime(500);
      s.stop();
      expect(at).toHaveLength(50);
      expect(at.map((t, n) => t - s.dueTime(n))).toEqual(at.map(() => 0));
      expect(s.skipped).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a fixed rate without drift on real timers', async () => {
    // A loaded runner may fire any timer late, so this bounds lateness per tick
    // instead of counting ticks inside a sleep that can itself overrun.
    const lateness: number[] = [];
    const s = new TickScheduler({ hz: 100 }, (n) => lateness.push(performance.now() - s.dueTime(n)));
    s.start();
    const epoch = s.epochMs;
    await new Promise((r) => setTimeout(r, 500));
    s.stop();
    expect(lateness.length).toBeGreaterThan(0);
    expect(Math.min(...lateness)).toBeGreaterThanOrEqual(0);
    // The grid only ever moves by whole skipped periods, so lateness never accumulates.
    expect(s.epochMs - epoch).toBeCloseTo(s.skipped * s.periodMs, 6);
    const sorted = [...lateness].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(s.periodMs);
  });
});

describe('SimpleShowController', () => {
  it('loops countdown → playing → round end → results', () => {
    const show = new SimpleShowController({ roundId: 'r', playSeconds: 2, loops: 1 });
    show.start([{ id: 0, name: 'a', isBot: false, team: -1 }], 1);
    const phases: number[] = [];
    let ended = false;
    for (let i = 0; i < 30 * 15; i++) {
      show.onTick(1 / 30, { status: null, presentPlayers: new Set([0]) });
      for (const e of show.drainEvents()) {
        if (e.type === 'roundPhase') phases.push(e.phase);
        if (e.type === 'showEnd') ended = true;
      }
    }
    expect(phases).toEqual([
      RoundPhase.Countdown,
      RoundPhase.Playing,
      RoundPhase.RoundEnd,
      RoundPhase.Results,
    ]);
    expect(ended).toBe(true);
    expect(show.showPhase).toBe(ShowPhase.Ended);
  });
});

describe('WebSocket transport', () => {
  it('serves /health and /metrics and completes a real WebSocket handshake', async () => {
    const sims: FakeMatchSim[] = [];
    const clock = { now: 0 };
    const deps = { ...testDeps(clock, sims), now: () => performance.now() };
    const server = await startGameServer({
      port: 0,
      host: '127.0.0.1',
      deps,
      config: { fillWaitMs: 50, capacity: 4 },
      profileLogMs: 0,
    });
    try {
      const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as {
        ok: boolean;
      };
      expect(health.ok).toBe(true);
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const types: number[] = [];
      const welcome = await new Promise<ReturnType<typeof readWelcome>>((resolve, reject) => {
        ws.on('open', () => {
          const w = new BitWriter();
          writeHello(w, { version: PROTOCOL_VERSION, name: 'ws', resumeToken: '', loadout: '' });
          ws.send(w.finish().slice());
        });
        ws.on('message', (d: Buffer) => {
          const r = new BitReader(new Uint8Array(d));
          const t = r.readBits(8);
          types.push(t);
          if (t === MsgType.Welcome) resolve(readWelcome(r));
        });
        ws.on('error', reject);
      });
      expect(welcome.version).toBe(PROTOCOL_VERSION);
      await new Promise((r) => setTimeout(r, 400));
      expect(types).toContain(MsgType.Snapshot);
      const metrics = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
      expect(metrics).toMatch(/tumble_tick_ms\{phase="total",stat="p95"\}/);
      expect(metrics).toMatch(/tumble_tick_ms\{phase="total",stat="p50"\}/);
      const rooms = (await (await fetch(`http://127.0.0.1:${server.port}/rooms`)).json()) as unknown[];
      expect(rooms.length).toBe(1);
      ws.close();
    } finally {
      await server.close();
    }
  });
});
