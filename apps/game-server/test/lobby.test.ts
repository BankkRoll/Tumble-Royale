/**
 * The live pre-show platform: several in-process clients on one room running
 * the real match sim (Tumbler controller) on the lobby round. Everything one
 * player does on the platform must reach the others through the normal
 * snapshot + reliable-event pipeline.
 */
import { describe, expect, it } from 'vitest';
import {
  LEAVE_CLOSE_REASON,
  type DecodedSnapshot,
  type LowFreqMessage,
  type NetEntityState,
} from '@tumble/netcode';
import { Button, CharacterState, loadRapier, type CharacterInput } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { createMatchSim, createTestArenaRound, testObstacleModules } from '@tumble/sim/match';
import { PRE_SHOW_LOBBY_ROUND } from '@tumble/sim/show';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { ShowDirectorController } from '../src/show/ShowDirectorController.ts';
import { FakeConnection, TestClient } from './helpers.ts';

const TICK_MS = 1000 / 30;
type Msg<T extends LowFreqMessage['t']> = Extract<LowFreqMessage, { t: T }>;
const R = await loadRapier();
const ROUND = createTestArenaRound();

function lobbyRoom(config: Record<string, number> = {}) {
  const clock = { now: 1000 };
  const metrics = new ServerMetrics();
  const manager = new RoomManager(
    {
      R,
      createMatchSim: (o) =>
        createMatchSim(o, { createController: createTumblerController, obstacles: testObstacleModules() }),
      loadRound: () => ROUND,
      createShowController: () =>
        new ShowDirectorController({
          rounds: [ROUND],
          playlist: {
            id: 'lobby-test',
            name: 'Lobby test',
            maxPlayers: 4,
            minRounds: 1,
            maxRounds: 1,
            pool: [{ roundId: ROUND.id, weight: 1 }],
          },
          timings: { preShow: 2 },
        }),
      createBot: null,
      lobbyRound: PRE_SHOW_LOBBY_ROUND,
      now: () => clock.now,
      randomSeed: () => 99,
    },
    metrics,
    null,
    {
      config: { capacity: 4, fillWaitMs: 60_000, startAtHumans: 4, resumeWindowMs: 3000, ...config },
      profileLogMs: 0,
    },
  );
  const inputs = new Map<TestClient, CharacterInput>();
  const clients: TestClient[] = [];
  const connect = (name: string, token = ''): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello(name, token);
    c.pump(clock.now);
    clients.push(c);
    inputs.set(c, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    return c;
  };
  /** One network tick: every connected client sends two 60 Hz inputs. */
  const tick = (): void => {
    for (const c of clients) {
      if (!c.conn.open) continue;
      const input = inputs.get(c)!;
      c.input(input);
      c.input(input);
    }
    clock.now += TICK_MS;
    manager.tick();
    for (const c of clients) if (c.conn.open) c.pump(clock.now);
  };
  const advance = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) tick();
  };
  return { clock, manager, metrics, connect, tick, advance, inputs };
}

/** Newest known state of entity `id` in a client's snapshot stream (delta-aware). */
function latest(c: TestClient, id: number): NetEntityState | null {
  for (let i = c.snapshots.length - 1; i >= 0; i--) {
    const s = c.snapshots[i]!;
    for (let k = 0; k < s.entityCount; k++) if (s.entities[k]!.id === id) return s.entities[k]!;
    for (let k = 0; k < s.removedCount; k++) if (s.removed[k] === id) return null;
  }
  return null;
}

const removedIn = (snaps: readonly DecodedSnapshot[], id: number): boolean =>
  snaps.some((s) => Array.from(s.removed.slice(0, s.removedCount)).includes(id));

describe('live pre-show platform', () => {
  it('replicates movement, grabs, break-free and emotes between two clients', () => {
    const room = lobbyRoom();
    const a = room.connect('Alice');
    const b = room.connect('Bob');
    const ia = a.welcome!.playerId;
    const ib = b.welcome!.playerId;
    room.advance(60);
    for (const c of [a, b]) {
      const join = c.lowFreq('joinRound').at(-1) as Msg<'joinRound'>;
      expect(join.lobby).toBe(true);
      expect(join.roundId).toBe(PRE_SHOW_LOBBY_ROUND.id);
    }
    // Both landed on the platform and each sees the other.
    const aFromB = latest(b, ia)!;
    expect(aFromB).not.toBeNull();
    expect(aFromB.pos.y).toBeLessThan(1.5);
    expect(latest(a, ib)).not.toBeNull();

    // A walks over to B with Grab held; B's client sees A move, then the grab land.
    const start = { ...aFromB.pos };
    let grabbed = false;
    for (let i = 0; i < 240 && !grabbed; i++) {
      const pa = latest(b, ia)!.pos;
      const pb = latest(a, ib)!.pos;
      const dx = pb.x - pa.x;
      const dz = pb.z - pa.z;
      const d = Math.hypot(dx, dz);
      room.inputs.set(a, {
        moveX: 0,
        moveZ: d > 1.3 ? 1 : 0,
        yaw: Math.atan2(dx, dz),
        buttons: d < 2 ? Button.Grab : 0,
        emote: 0,
      });
      room.tick();
      grabbed = b.simEvents().some((e) => e.type === 'grabStart' && e.player === ia && e.target === ib);
    }
    expect(grabbed).toBe(true);
    const moved = latest(b, ia)!.pos;
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(0.5);
    room.advance(3);
    expect(latest(a, ib)!.state).toBe(CharacterState.Grabbed);
    expect(latest(b, ib)!.state).toBe(CharacterState.Grabbed);

    // B mashes to break free; both clients see the grab end.
    let freed = false;
    for (let i = 0; i < 60 && !freed; i++) {
      room.inputs.set(b, { moveX: 0, moveZ: 0, yaw: 0, buttons: i % 2 === 0 ? Button.Jump : 0, emote: 0 });
      room.tick();
      freed = a.simEvents().some((e) => e.type === 'grabEnd' && e.player === ia);
    }
    expect(freed).toBe(true);

    // A lets go and emotes; B sees the emote event and the Emote state.
    room.inputs.set(a, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    room.inputs.set(b, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    room.advance(40);
    room.inputs.set(a, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 2 });
    room.advance(2);
    room.inputs.set(a, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    room.advance(4);
    expect(b.simEvents().some((e) => e.type === 'emote' && e.player === ia && e.emote === 2)).toBe(true);
    expect(latest(b, ia)!.state).toBe(CharacterState.Emote);
    // Platform antics never count toward challenge stats.
    expect(room.manager.list()[0]!.state).toBe('lobby');
  });

  it('spawns joiners for everyone, keeps resumers, and despawns leavers', () => {
    const room = lobbyRoom();
    const a = room.connect('Alice');
    room.advance(20);
    const c = room.connect('Carol');
    const ic = c.welcome!.playerId;
    const token = c.welcome!.resumeToken;
    const mark = a.snapshots.length;
    // The platform streams at 15 Hz: Carol shows up in Alice's very next snapshot…
    room.advance(2);
    const first = a.snapshots
      .slice(mark)
      .find((s) => s.entities.slice(0, s.entityCount).some((e) => e.id === ic));
    expect(first).toBeDefined();
    // …dropping in from above the platform.
    expect(first!.entities.find((e) => e.id === ic)!.pos.y).toBeGreaterThan(2);
    const list = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(list.map((p) => p.id)).toContain(ic);
    room.advance(60);
    expect(latest(a, ic)!.pos.y).toBeLessThan(1.5);

    // …a dropped connection keeps the same Tumbler on the platform (no despawn) and resumes it.
    const beforeDrop = a.snapshots.length;
    c.conn.close();
    room.advance(30);
    const back = room.connect('Carol', token);
    expect(back.welcome?.playerId).toBe(ic);
    expect(back.welcome?.resumed).toBe(true);
    room.advance(10);
    expect(removedIn(a.snapshots.slice(beforeDrop), ic)).toBe(false);
    expect(latest(back, ic)).not.toBeNull();

    // A real leave (resume window runs out) despawns Carol for Alice and drops her from the list.
    back.conn.close();
    room.advance(30 * 3 + 5);
    expect(removedIn(a.snapshots.slice(beforeDrop), ic)).toBe(true);
    expect(latest(a, ic)).toBeNull();
    const after = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(after.map((p) => p.id)).not.toContain(ic);
  });

  it('frees a deliberate leaver at once instead of holding the seat for a resume', () => {
    const room = lobbyRoom();
    const a = room.connect('Alice');
    const c = room.connect('Carol');
    const ic = c.welcome!.playerId;
    const token = c.welcome!.resumeToken;
    room.advance(20);
    const mark = a.snapshots.length;
    c.conn.close(1000, LEAVE_CLOSE_REASON);
    room.advance(2);
    expect(removedIn(a.snapshots.slice(mark), ic)).toBe(true);
    const list = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(list.map((p) => p.id)).not.toContain(ic);
    // The seat is gone: the old resume token no longer finds it.
    const back = room.connect('Carol', token);
    expect(back.welcome?.resumed).not.toBe(true);
  });

  it('holds the seat when the connection drops with any other close', () => {
    const room = lobbyRoom();
    const a = room.connect('Alice');
    const c = room.connect('Carol');
    const ic = c.welcome!.playerId;
    room.advance(20);
    c.conn.close(1001, 'going away');
    room.advance(2);
    const list = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(list.map((p) => p.id)).toContain(ic);
  });

  it('adds bots to the platform when the show starts and moves everyone to round 1 together', () => {
    const room = lobbyRoom({ fillWaitMs: 1000 });
    const a = room.connect('Alice');
    const b = room.connect('Bob');
    room.advance(40);
    // Show started: two bots dropped onto the platform and wander deterministically.
    const ids = [2, 3];
    for (const id of ids) expect(latest(a, id)).not.toBeNull();
    const p0 = ids.map((id) => ({ ...latest(a, id)!.pos }));
    room.advance(45);
    const pre = (a.lowFreq('showPhase') as Msg<'showPhase'>[]).find((m) => m.phase === 0);
    expect(pre?.startsInMs).toBeGreaterThan(0);
    const roundJoins = (c: TestClient) =>
      (c.lowFreq('joinRound') as Msg<'joinRound'>[]).filter((j) => !j.lobby);
    expect(roundJoins(a)).toHaveLength(0);
    const wandered = ids.some((id, i) => {
      const p = latest(a, id)!.pos;
      return Math.hypot(p.x - p0[i]!.x, p.z - p0[i]!.z) > 0.5;
    });
    expect(wandered).toBe(true);
    room.advance(30 * 2);
    const ja = roundJoins(a);
    const jb = roundJoins(b);
    expect(ja).toHaveLength(1);
    expect(jb).toHaveLength(1);
    expect(ja[0]!.startTick).toBe(jb[0]!.startTick);
    expect(ja[0]!.epoch).toBe(jb[0]!.epoch);
    expect(ja[0]!.roundId).toBe(ROUND.id);
  });
});
