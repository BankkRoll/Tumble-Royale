/**
 * The live pre-show platform end to end: real NetClients + NetGameSessions
 * (prediction, interpolation, lobby proxies) talking to an in-process game
 * server room running the real Tumbler controller on the lobby round, on a
 * virtual clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCharacterFullState, type JoinRoundMsg, type MatchSim } from '@tumble/netcode';
import { Button, CharacterState, loadRapier, type CharacterInput, type SimEvent } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { createMatchSim, createTestArenaRound, testObstacleModules } from '@tumble/sim/match';
import { PRE_SHOW_LOBBY_ROUND } from '@tumble/sim/show';
import { RoundPhase } from '@tumble/shared';
import { ServerMetrics } from '../../game-server/src/metrics.ts';
import { RoomManager } from '../../game-server/src/room/RoomManager.ts';
import { ShowDirectorController } from '../../game-server/src/show/ShowDirectorController.ts';
import { FakeConnection } from '../../game-server/test/helpers.ts';
import { NetClient, type WebSocketLike } from '../src/net/NetClient.ts';
import { NetGameSession } from '../src/net/NetGameSession.ts';

const R = await loadRapier();
const deps = { createController: createTumblerController, obstacles: testObstacleModules() };
const ROUND = createTestArenaRound();
const TICK_MS = 1000 / 30;

/** Client-side socket wired straight into a server FakeConnection. */
class LoopSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly server = new FakeConnection();

  constructor(accept: (c: FakeConnection) => void) {
    this.server.send = (data: Uint8Array): boolean => {
      if (!this.server.open) return false;
      const copy = data.slice();
      this.onmessage?.({ data: copy.buffer });
      return true;
    };
    const close = this.server.close.bind(this.server);
    this.server.close = (code?: number, reason?: string): void => {
      close(code, reason);
      this.readyState = 3;
      this.onclose?.({ code: code ?? 1000 });
    };
    accept(this.server);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: Uint8Array): void {
    if (this.readyState === 1) this.server.receive(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.close(1000, 'client');
  }
}

interface Player {
  net: NetClient;
  session: NetGameSession;
  socket: LoopSocket | null;
  input: CharacterInput;
  events: SimEvent[];
  joins: JoinRoundMsg[];
}

function world() {
  const clock = { now: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  const manager = new RoomManager(
    {
      R,
      createMatchSim: (o) => createMatchSim(o, deps),
      loadRound: () => ROUND,
      createShowController: () =>
        new ShowDirectorController({
          rounds: [ROUND],
          playlist: {
            id: 'lobby',
            name: 'Lobby',
            maxPlayers: 4,
            minRounds: 1,
            maxRounds: 1,
            pool: [{ roundId: ROUND.id, weight: 1 }],
          },
          timings: { preShow: 3 },
        }),
      createBot: null,
      lobbyRound: PRE_SHOW_LOBBY_ROUND,
      now: () => clock.now,
      randomSeed: () => 5,
    },
    new ServerMetrics(),
    null,
    {
      config: { capacity: 4, fillWaitMs: 60_000, startAtHumans: 4, resumeWindowMs: 2000 },
      profileLogMs: 0,
    },
  );
  const players: Player[] = [];
  const connect = (name: string): Player => {
    const p: Player = {
      socket: null,
      input: { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 },
      events: [],
      joins: [],
    } as unknown as Player;
    p.net = new NetClient({
      url: 'ws://test',
      name,
      conditioner: null,
      now: () => clock.now,
      createSocket: () => (p.socket = new LoopSocket((c) => manager.accept(c))),
    });
    p.session = new NetGameSession(
      p.net,
      (join, localId): MatchSim => {
        p.joins.push(join);
        return createMatchSim(
          {
            R,
            round: join.lobby ? PRE_SHOW_LOBBY_ROUND : ROUND,
            seed: join.seed,
            stage: join.stage,
            players: join.players,
            mode: 'predict',
            localPlayerId: localId,
            ...(join.lobby ? { lobby: true } : {}),
          },
          deps,
        );
      },
      { onEvent: (e) => p.events.push(e) },
    );
    p.net.on('simEvent', ({ event }) => p.events.push(event));
    p.net.connect();
    players.push(p);
    return p;
  };
  const step = async (ticks: number): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
      clock.now += TICK_MS;
      manager.tick();
      for (const p of players) p.session.frame(clock.now, () => p.input);
    }
  };
  return { clock, manager, connect, step };
}

afterEach(() => vi.restoreAllMocks());

describe('live pre-show lobby (client ↔ in-process server)', () => {
  it('replicates movement, grabs and emotes, and syncs joins and leaves', async () => {
    const w = world();
    const a = w.connect('Alice');
    const b = w.connect('Bob');
    await w.step(60);
    const ia = a.net.playerId;
    const ib = b.net.playerId;
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(a.joins.at(-1)?.lobby).toBe(true);
    // Each predicts itself and interpolates the other, with a proxy to bump into.
    expect(a.session.prediction).not.toBeNull();
    expect(b.session.remotes.get(ia)).toBeDefined();
    expect(b.session.sim!.getPlayerState(ia, createCharacterFullState())).toBe(true);
    const start = { ...b.session.remotes.get(ia)!.pos };

    // A walks to B holding Grab; B's client sees A move and the grab land.
    let grabbed = false;
    for (let i = 0; i < 300 && !grabbed; i++) {
      const pa = a.session.local.pos;
      const pb = a.session.remotes.get(ib)!.pos;
      const dx = pb.x - pa.x;
      const dz = pb.z - pa.z;
      const d = Math.hypot(dx, dz);
      a.input = {
        moveX: 0,
        moveZ: d > 1.2 ? 1 : 0,
        yaw: Math.atan2(dx, dz),
        buttons: d < 2 ? Button.Grab : 0,
        emote: 0,
      };
      await w.step(1);
      grabbed = b.events.some((e) => e.type === 'grabStart' && e.player === ia && e.target === ib);
    }
    expect(grabbed).toBe(true);
    const moved = b.session.remotes.get(ia)!.pos;
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(0.5);
    await w.step(8);
    expect(a.session.remotes.get(ib)!.state).toBe(CharacterState.Grabbed);

    // A lets go and emotes; B sees it.
    a.input = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
    await w.step(60);
    a.input = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 3 };
    await w.step(2);
    a.input = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
    await w.step(10);
    expect(b.events.some((e) => e.type === 'emote' && e.player === ia && e.emote === 3)).toBe(true);
    expect(b.session.remotes.get(ia)!.state).toBe(CharacterState.Emote);

    // Carol joins: both see her appear (with a proxy) at the same server tick.
    const c = w.connect('Carol');
    await w.step(10);
    const ic = c.net.playerId;
    expect(a.session.remotes.get(ic)).toBeDefined();
    expect(b.session.remotes.get(ic)).toBeDefined();
    expect(a.session.lobbyLeft[ic]).toBe(0);

    // Carol drops for good: after the resume window both despawn her and drop her proxy.
    c.net.close();
    await w.step(10);
    expect(a.session.remotes.get(ic)).toBeDefined();
    await w.step(70);
    expect(a.session.lobbyLeft[ic]).toBe(1);
    expect(b.session.lobbyLeft[ic]).toBe(1);
    expect(a.session.remotes.get(ic)).toBeUndefined();
    expect(a.session.sim!.getPlayerState(ic, createCharacterFullState())).toBe(false);
  }, 60_000);

  it('moves everyone from the platform into round 1 on the same tick', async () => {
    const w = world();
    const a = w.connect('Alice');
    const b = w.connect('Bob');
    await w.step(10);
    // Fill the show: two more humans start it.
    w.connect('Carol');
    w.connect('Dan');
    await w.step(30 * 5);
    const ra = a.joins.filter((j) => !j.lobby);
    const rb = b.joins.filter((j) => !j.lobby);
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(ra[0]!.startTick).toBe(rb[0]!.startTick);
    expect(a.session.sim?.round.id).toBe(ROUND.id);
    expect(a.session.sim?.phase).not.toBe(RoundPhase.Playing);
  }, 60_000);
});
