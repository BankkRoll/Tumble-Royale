/**
 * Online fidelity of the netcode around the sim: spectator interest
 * management, lag-compensated grab/dive assists and anomaly telemetry.
 */
import { describe, expect, it } from 'vitest';
import { createCharacterFullState, type MatchPlayerInfo } from '@tumble/netcode';
import { Button, CharacterState, loadRapier, type CharacterInput } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { createMatchSim, testObstacleModules, type MatchSimHandle } from '@tumble/sim/match';
import { PRE_SHOW_LOBBY_ROUND } from '@tumble/sim/show';
import { RoundPhase, SIM_DT } from '@tumble/shared';
import { BodyMonitor, InputRateMonitor } from '../src/anomaly.ts';
import { HitAssist } from '../src/hitAssist.ts';
import { LagCompensator } from '../src/lagcomp.ts';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { FakeConnection, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const TICK_MS = 1000 / 30;
const idle = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

function room(config: Record<string, number> = {}) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const metrics = new ServerMetrics();
  const manager = new RoomManager(testDeps(clock, sims), metrics, null, {
    config: { capacity: 40, fillWaitMs: 0, startAtHumans: 40, ...config },
    profileLogMs: 0,
  });
  const connect = (name = 'p'): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello(name);
    c.pump(clock.now);
    return c;
  };
  const advance = (ticks: number, clients: TestClient[], each?: () => void): void => {
    for (let i = 0; i < ticks; i++) {
      each?.();
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) c.pump(clock.now);
    }
  };
  return { clock, sims, metrics, manager, connect, advance };
}

describe('online spectating', () => {
  it('gives the spectated player full-rate updates once the client says who it watches', () => {
    const { connect, advance } = room();
    const c = connect();
    advance(5, [c]);
    const target = 30;
    const rate = (from: number): number => {
      const snaps = c.snapshots.slice(from);
      const hits = snaps.filter((s) =>
        s.entities.slice(0, s.entityCount).some((e) => e.id === target),
      ).length;
      return hits / snaps.length;
    };
    // Every bot moves each tick; the target is ~60 m away, beyond the 20 m full-rate radius.
    let mark = c.snapshots.length;
    advance(60, [c], () => c.input(idle()));
    const before = rate(mark);
    expect(before).toBeLessThan(0.6);

    c.send({ t: 'spectate', target });
    advance(2, [c], () => c.input(idle()));
    mark = c.snapshots.length;
    advance(60, [c], () => c.input(idle()));
    expect(rate(mark)).toBe(1);

    // Back to normal interest when spectating stops (and unknown targets are ignored).
    c.send({ t: 'spectate', target: 99 });
    advance(2, [c], () => c.input(idle()));
    mark = c.snapshots.length;
    advance(60, [c], () => c.input(idle()));
    expect(rate(mark)).toBeLessThan(0.6);
  });
});

describe('lag-compensated hit assist', () => {
  async function lobbySim(): Promise<MatchSimHandle> {
    const R = await loadRapier();
    const players: MatchPlayerInfo[] = [0, 1].map((id) => ({ id, name: `p${id}`, isBot: false, team: -1 }));
    const sim = createMatchSim(
      { R, round: PRE_SHOW_LOBBY_ROUND, seed: 1, stage: 0, players, mode: 'authority', lobby: true },
      { createController: createTumblerController, obstacles: testObstacleModules() },
    );
    sim.setPhase(RoundPhase.Playing, 0);
    for (let i = 0; i < 90; i++) sim.step();
    return sim;
  }

  /** Places player `id` standing at (x, z), facing +Z. */
  function place(sim: MatchSimHandle, id: number, x: number, z: number): void {
    const s = createCharacterFullState();
    sim.getPlayerState(id, s);
    s.pos.x = x;
    s.pos.z = z;
    s.vel.x = s.vel.y = s.vel.z = 0;
    s.facing = 0;
    s.state = CharacterState.Idle;
    sim.setPlayerState(id, s);
  }

  /** Records `ticks` history frames with B at `bz` (A at the origin). */
  function history(sim: MatchSimHandle, lag: LagCompensator, fromTick: number, ticks: number): number {
    const s = createCharacterFullState();
    let tick = fromTick;
    for (let i = 0; i < ticks; i++) {
      tick += 2;
      lag.begin(tick);
      for (const id of [0, 1]) {
        sim.getPlayerState(id, s);
        lag.add(id, s.pos, s.rot);
      }
    }
    return tick;
  }

  it('grants a grab the client saw in reach 100 ms ago, but not one out of the window', async () => {
    const sim = await lobbySim();
    const lag = new LagCompensator();
    const assist = new HitAssist(lag, createCharacterFullState);
    place(sim, 0, 0, 0);
    place(sim, 1, 0, 1.2);
    let tick = history(sim, lag, 0, 6);
    // B steps away: now out of the server's grab reach, but the client still sees B in front.
    place(sim, 1, 0, 2.6);
    tick = history(sim, lag, tick, 2);
    const grab = { ...idle(), buttons: Button.Grab };
    sim.setInput(0, grab);
    sim.step();
    assist.afterStep(sim, 0, grab, [0, 1], tick, 150);
    expect(assist.counters.grabs).toBe(1);
    expect(sim.events.drain().some((e) => e.type === 'grabStart' && e.player === 0 && e.target === 1)).toBe(
      true,
    );
    sim.setInput(0, grab);
    sim.step();
    const b = createCharacterFullState();
    sim.getPlayerState(1, b);
    expect(b.state).toBe(CharacterState.Grabbed);
    sim.dispose();
  });

  it('refuses grabs the client could not have seen, or with nobody near now', async () => {
    const sim = await lobbySim();
    const lag = new LagCompensator();
    const assist = new HitAssist(lag, createCharacterFullState, { interpDelayMs: 0 });
    place(sim, 0, 0, 0);
    place(sim, 1, 0, 1.2);
    let tick = history(sim, lag, 0, 12);
    place(sim, 1, 0, 2.6);
    tick = history(sim, lag, tick, 12);
    const grab = { ...idle(), buttons: Button.Grab };
    sim.setInput(0, grab);
    sim.step();
    // Zero RTT and zero render delay: the client saw what the server sees, no rewind to grant.
    assist.afterStep(sim, 0, grab, [0, 1], tick, 0);
    expect(assist.counters.grabs).toBe(0);

    // In reach in the past, but B has since run 9 m away: never yanked across the platform.
    const far = new HitAssist(lag, createCharacterFullState);
    place(sim, 1, 0, 1.2);
    tick = history(sim, lag, tick, 6);
    place(sim, 1, 0, 9);
    sim.setInput(0, idle());
    sim.step();
    far.afterStep(sim, 0, idle(), [0, 1], tick, 150);
    sim.setInput(0, grab);
    sim.step();
    far.afterStep(sim, 0, grab, [0, 1], tick, 150);
    expect(far.counters.grabs).toBe(0);
    sim.dispose();
  });

  it('grants a dive tackle against the rewound target position once per dive', async () => {
    const sim = await lobbySim();
    const lag = new LagCompensator();
    const assist = new HitAssist(lag, createCharacterFullState);
    place(sim, 0, 0, 0);
    place(sim, 1, 0, 0.95);
    let tick = history(sim, lag, 0, 6);
    place(sim, 1, 0, 2.2);
    tick = history(sim, lag, tick, 2);
    const a = createCharacterFullState();
    sim.getPlayerState(0, a);
    a.state = CharacterState.Dive;
    a.vel.z = 7;
    sim.setPlayerState(0, a);
    assist.afterStep(sim, 0, idle(), [0, 1], tick, 150);
    assist.afterStep(sim, 0, idle(), [0, 1], tick + 1, 150);
    expect(assist.counters.tackles).toBe(1);
    sim.step();
    const b = createCharacterFullState();
    sim.getPlayerState(1, b);
    expect(b.state).toBe(CharacterState.Stunned);
    expect(b.vel.z).toBeGreaterThan(0);
    sim.dispose();
  });

  it('caps the rewind at 150 ms', () => {
    const lag = new LagCompensator();
    expect(lag.viewTickFor(1000, 2000, 100)).toBeCloseTo(1000 - 0.15 / SIM_DT);
  });
});

describe('anomaly telemetry', () => {
  it('flags impossible body moves unless the sim announced a teleport', () => {
    const m = new BodyMonitor();
    expect(m.observe(0, { x: 0, y: 0, z: 0 }, 1 / 30)).toBeNull();
    expect(m.observe(0, { x: 1, y: 0, z: 0 }, 1 / 30)).toBeNull();
    expect(m.observe(0, { x: 4, y: 0, z: 0 }, 1 / 30)).toBe('sim_speed');
    expect(m.observe(0, { x: 40, y: 0, z: 0 }, 1 / 30)).toBe('sim_teleport');
    m.exempt(0);
    expect(m.observe(0, { x: 0, y: 0, z: 0 }, 1 / 30)).toBeNull();
    expect(m.observe(0, { x: Number.NaN, y: 0, z: 0 }, 1 / 30)).toBe('sim_teleport');
  });

  it('counts input floods and rewinds without punishing a normal stream', () => {
    const r = new InputRateMonitor();
    let flagged = 0;
    for (let i = 0; i < 70; i++) if (r.note(i * 16)) flagged++;
    expect(flagged).toBe(0);
    for (let i = 0; i < 200; i++) if (r.note(2000 + i * 4)) flagged++;
    expect(flagged).toBe(1);
    expect(r.noteSeq(100)).toBe(false);
    expect(r.noteSeq(98)).toBe(false);
    expect(r.noteSeq(5000)).toBe(false);
    expect(r.noteSeq(3)).toBe(true);
  });

  it('exposes room anomalies on /metrics and never kicks for them', () => {
    const { connect, advance, sims, metrics } = room({ capacity: 2 });
    const c = connect();
    advance(3, [c], () => c.input(idle()));
    const sim = sims[0]!;

    // A sim bug: player 1 jumps 50 m in a tick with no teleport event.
    advance(1, [c], () => {
      sim.states.get(1)!.pos.x += 50;
    });
    advance(1, [c]);
    expect(metrics.anomalies.sim_teleport).toBe(1);
    // A real teleport obstacle announces itself and is not counted.
    advance(1, [c], () => {
      const s = sim.states.get(1)!;
      sim.events.push({ type: 'teleport', player: 1, from: { ...s.pos }, to: { ...s.pos, x: s.pos.x + 50 } });
      s.pos.x += 50;
    });
    advance(1, [c]);
    expect(metrics.anomalies.sim_teleport).toBe(1);

    c.input({ ...idle(), emote: 9 });
    advance(1, [c]);
    expect(metrics.anomalies.input_bad_emote).toBe(1);

    // ~210 batches a second (the client sends 60): a flood, counted once, not kicked.
    advance(40, [c], () => {
      for (let k = 0; k < 7; k++) c.input(idle());
    });
    expect(metrics.anomalies.input_flood).toBe(1);

    c.inputAt(20_000, idle());
    advance(1, [c]);
    c.inputAt(5, idle());
    advance(1, [c]);
    expect(metrics.anomalies.input_seq_rewind).toBeGreaterThanOrEqual(1);
    expect(c.kicked).toBe(false);

    const text = metrics.prometheus();
    expect(text).toContain('tumble_anomalies_total{kind="sim_teleport"} 1');
    expect(text).toContain('tumble_anomalies_total{kind="input_bad_emote"} 1');
    expect(text).toContain('tumble_lagcomp_assists_total{kind="grab"} 0');
  });
});
