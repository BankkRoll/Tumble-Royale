/**
 * Full-room tick cost at the player cap, in process: the real RoomManager,
 * Room, show director, Rapier match sim and snapshot encoders, with
 * `MAX_PLAYERS` protocol clients on in-memory connections (or one human and
 * a lobby of sim bots). Only the server's work is timed; client decoding runs
 * between ticks and allocates nothing per snapshot.
 *
 * The smoke variant always runs (a few seconds of play) and checks that a full
 * room works: everyone is admitted with an id inside the entity range and
 * receives snapshots inside the byte budget. The timing variant is opt-in
 * because wall-clock budgets do not belong in shared CI:
 *
 *   TUMBLE_PERF=1 pnpm --filter @tumble/game-server exec vitest run test/tickBudget.test.ts
 *
 * `TUMBLE_PERF_P95_MS` sets the p95 budget (default 16 ms).
 *
 * Spectators (late joiners on free cameras, sending a moving `spectate.focus`)
 * are measured the same way: their snapshots must stay inside the byte
 * budget, and the show they watch must play out exactly as it does without
 * them.
 */
import { MAX_ENTITIES, SNAPSHOT_BYTE_BUDGET } from '@tumble/netcode';
import { MAX_PLAYERS, RoundPhase, SERVER_TICK_HZ } from '@tumble/shared';
import { loadRapier, type CharacterInput } from '@tumble/sim';
import { createCharacterFullState } from '@tumble/sim/character';
import { PRE_SHOW_LOBBY_ROUND_ID } from '@tumble/sim/show';
import { describe, expect, it } from 'vitest';
import { RollingWindow, ServerMetrics } from '../src/metrics.ts';
import { createRealRoomDeps } from '../src/realDeps.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { signJoinTicket } from '../src/tickets.ts';
import { FakeConnection, TEST_SECRETS, TestClient } from './helpers.ts';

const TICK_MS = 1000 / SERVER_TICK_HZ;
const WALL = Date.parse('2026-10-06T12:00:00Z');
const IDLE: CharacterInput = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
const PERF = process.env.TUMBLE_PERF === '1';
// Slower shared runners (the nightly CI job) raise it; 16 ms leaves half the tick spare.
const P95_BUDGET_MS = Number(process.env.TUMBLE_PERF_P95_MS ?? 16);

interface RunResult {
  roundId: string;
  playingTicks: number;
  /** PLAYING ticks that took longer than two tick periods (a visible hitch). */
  spikes: number;
  /** Server tick wall time over PLAYING, ms. */
  total: RollingWindow;
  sim: RollingWindow;
  snapshot: RollingWindow;
  send: RollingWindow;
  /** Snapshot bytes per client per second over PLAYING. */
  downKBps: number;
  clients: TestClient[];
  /** Spectators that joined once the show started. */
  spectators: TestClient[];
  /** Snapshot bytes per spectator per second over PLAYING. */
  spectatorKBps: number;
  /** Every round entrant's position (mm) when the run stopped: identical runs must match. */
  fingerprint: string;
}

/**
 * Runs one Main Show room (fixed seed) until `playSeconds` of round 1
 * PLAYING have been timed.
 *
 * @param humans - Protocol clients; bots fill the rest of the cap.
 * @param opts.spectators - Clients that join after the show started, as free cameras.
 * @param opts.ticketed - Join with matchmaker tickets (spectators need one: an unticketed
 *   late joiner opens a new dev room instead of watching).
 */
async function runRoom(
  humans: number,
  playSeconds: number,
  opts: { spectators?: number; ticketed?: boolean } = {},
): Promise<RunResult> {
  const spectators = opts.spectators ?? 0;
  const ticketed = opts.ticketed ?? spectators > 0;
  const ticket = (sub: string, role: 'player' | 'spectator'): string =>
    ticketed
      ? signJoinTicket(
          TEST_SECRETS.GAME_TICKET_SECRET,
          {
            sub,
            name: `${sub}#0001`,
            mid: 'm_perf01',
            sid: 'gs-perf',
            pid: `solo:${sub}`,
            team: null,
            role,
            playlistId: 'main-show',
            queue: 'casual',
            region: 'eu',
            size: MAX_PLAYERS,
            humans,
            bots: MAX_PLAYERS - humans,
            teamSize: 1,
          },
          WALL,
        )
      : '';
  const R = await loadRapier();
  const clock = { now: 1000 };
  const deps = {
    ...createRealRoomDeps(R, { playlistId: 'main-show' }),
    now: () => clock.now,
    randomSeed: () => 7,
  };
  const metrics = new ServerMetrics();
  const big = (): RollingWindow => new RollingWindow(1 << 16);
  const manager = new RoomManager(deps, metrics, null, {
    config: { capacity: MAX_PLAYERS, startAtHumans: humans, fillWaitMs: 500, resumeWindowMs: 30_000 },
    profileLogMs: 0,
    ...(ticketed
      ? { tickets: { secret: TEST_SECRETS.GAME_TICKET_SECRET, allowUnticketed: false, now: () => WALL } }
      : {}),
  });
  const clients: TestClient[] = [];
  for (let i = 0; i < humans; i++) {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    // The harness must not allocate per snapshot: its GC pauses would land inside the timed server tick.
    c.keepSnapshots = false;
    c.hello(`p${i}`, '', ticket(`p${i}`, 'player'));
    clients.push(c);
  }
  const watchers: TestClient[] = [];
  const loaded = new Set<TestClient>();
  const input: CharacterInput = { moveX: 0, moveZ: 1, yaw: 0, buttons: 0, emote: 0 };
  let roundId = '';
  let playing = false;
  let playingTicks = 0;
  let bytesAtPlay = 0;
  let watchBytesAtPlay = 0;
  let spikes = 0;
  for (let t = 0; t < SERVER_TICK_HZ * 600 && playingTicks < playSeconds * SERVER_TICK_HZ; t++) {
    clock.now += TICK_MS;
    for (const [i, c] of clients.entries()) {
      // Two 60 Hz inputs per 30 Hz tick, steering a little so the field spreads like a real race.
      input.moveX = Math.sin(t / 20 + i) * 0.4;
      input.buttons = (t + i) % 45 === 0 ? 1 : 0;
      c.input(input);
      c.input(input);
    }
    if (spectators > 0 && watchers.length === 0 && roundId !== '') {
      for (let i = 0; i < spectators; i++) {
        const conn = new FakeConnection();
        manager.accept(conn);
        const c = new TestClient(conn);
        c.keepSnapshots = false;
        c.hello(`watch${i}`, '', ticket(`watch${i}`, 'spectator'));
        watchers.push(c);
      }
    }
    for (const [i, c] of watchers.entries()) {
      // A free camera drifting down the course, re-aimed twice a second like the client does.
      if (t % 15 === 0)
        c.send({
          t: 'spectate',
          target: -1,
          focus: [Math.round(Math.sin(t / 90 + i) * 10), 2, Math.round((t % 900) / 10)],
        });
      c.input(IDLE);
    }
    const before = metrics.tick.total.count;
    const t0 = performance.now();
    manager.tick();
    if (playing && performance.now() - t0 > 2 * TICK_MS) spikes++;
    let nowPlaying: boolean = playing;
    for (const [i, c] of clients.entries()) {
      c.pump(clock.now);
      for (const m of c.messages) {
        if (m.kind !== 'msg') continue;
        if (m.msg.t === 'joinRound' && m.msg.roundId !== PRE_SHOW_LOBBY_ROUND_ID && !loaded.has(c)) {
          loaded.add(c);
          roundId = m.msg.roundId;
          c.send({ t: 'loaded', roundId });
        } else if (i === 0 && m.msg.t === 'roundPhase') {
          nowPlaying = m.msg.phase === RoundPhase.Playing && roundId !== '';
        }
      }
      // Scanned once; dropping them keeps a long run's heap (and GC) flat.
      c.messages.length = 0;
    }
    for (const c of watchers) {
      c.pump(clock.now);
      c.messages.length = 0;
    }
    if (nowPlaying && !playing) {
      // Only PLAYING ticks count: drop what the room recorded in the lobby and LOADING.
      metrics.tick.total = big();
      metrics.tick.sim = big();
      metrics.tick.snapshot = big();
      metrics.tick.send = big();
      bytesAtPlay = clients.reduce((s, c) => s + c.snapshotBytes, 0);
      watchBytesAtPlay = watchers.reduce((s, c) => s + c.snapshotBytes, 0);
    }
    playing = nowPlaying;
    if (playing && metrics.tick.total.count > before) playingTicks++;
  }
  const sim = manager.room(manager.list()[0]!.id)?.matchSim ?? null;
  const st = createCharacterFullState();
  const positions: string[] = [];
  const mm = (v: number): number => Math.round(v * 1000);
  for (let id = 0; id < MAX_PLAYERS; id++)
    if (sim?.getPlayerState(id, st)) positions.push(`${id}:${mm(st.pos.x)},${mm(st.pos.y)},${mm(st.pos.z)}`);
  manager.stop();
  const played = clients.reduce((s, c) => s + c.snapshotBytes, 0) - bytesAtPlay;
  const watched = watchers.reduce((s, c) => s + c.snapshotBytes, 0) - watchBytesAtPlay;
  const playedSeconds = Math.max(1e-6, playingTicks / SERVER_TICK_HZ);
  return {
    roundId,
    playingTicks,
    spikes,
    total: metrics.tick.total,
    sim: metrics.tick.sim,
    snapshot: metrics.tick.snapshot,
    send: metrics.tick.send,
    downKBps: played / Math.max(1, humans) / playedSeconds / 1024,
    clients,
    spectators: watchers,
    spectatorKBps: watched / Math.max(1, watchers.length) / playedSeconds / 1024,
    fingerprint: positions.join(';'),
  };
}

function describeRun(label: string, r: RunResult): string {
  const f = (v: number): string => v.toFixed(2);
  return (
    `${label} [${r.roundId}, ${(r.playingTicks / SERVER_TICK_HZ).toFixed(0)} s PLAYING]: ` +
    `tick p50 ${f(r.total.percentile(0.5))} / p95 ${f(r.total.percentile(0.95))} / p99 ${f(r.total.percentile(0.99))} / max ${f(r.total.max())} ms, ` +
    `${r.spikes} ticks > ${(2 * TICK_MS).toFixed(0)} ms; ` +
    `mean sim ${f(r.sim.mean())} + snapshot ${f(r.snapshot.mean())} + send ${f(r.send.mean())} ms; ` +
    `down ${r.downKBps.toFixed(1)} KB/s per client` +
    (r.spectators.length > 0 ? `, ${r.spectatorKBps.toFixed(1)} KB/s per spectator` : '')
  );
}

describe(`a full ${MAX_PLAYERS}-player room`, () => {
  it(`admits ${MAX_PLAYERS} protocol clients with ids in the entity range and snapshots in budget`, async () => {
    const r = await runRoom(MAX_PLAYERS, 3);
    expect(r.playingTicks).toBeGreaterThanOrEqual(3 * SERVER_TICK_HZ);
    const ids = r.clients.map((c) => c.welcome?.playerId ?? -1);
    expect(new Set(ids).size).toBe(MAX_PLAYERS);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(MAX_ENTITIES);
    }
    for (const c of r.clients) {
      expect(c.kicked).toBe(false);
      expect(c.snapshotCount).toBeGreaterThan(3 * SERVER_TICK_HZ);
      expect(c.snapshotMaxBytes).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    }
    expect(r.downKBps).toBeLessThan(40);
  }, 300_000);

  it('lets free-camera spectators watch inside the byte budget without changing the show', async () => {
    const alone = await runRoom(1, 3, { ticketed: true });
    const watched = await runRoom(1, 3, { spectators: 4 });
    expect(watched.spectators).toHaveLength(4);
    for (const c of watched.spectators) {
      expect(c.kicked).toBe(false);
      expect(c.welcome?.playerId ?? -1).toBeGreaterThanOrEqual(MAX_ENTITIES);
      expect(c.snapshotCount).toBeGreaterThan(3 * SERVER_TICK_HZ);
      expect(c.snapshotMaxBytes).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    }
    expect(watched.spectatorKBps).toBeLessThan(40);
    expect(watched.playingTicks).toBe(alone.playingTicks);
    expect(watched.fingerprint.length).toBeGreaterThan(0);
    expect(watched.fingerprint).toBe(alone.fingerprint);
  }, 300_000);

  it.runIf(PERF)(
    `keeps the 30 Hz tick p95 under ${P95_BUDGET_MS} ms with every seat a protocol client, and with one human and bots`,
    async () => {
      const humans = await runRoom(MAX_PLAYERS, 60);
      process.stderr.write(`\n${describeRun(`${MAX_PLAYERS} clients`, humans)}\n`);
      const bots = await runRoom(1, 60);
      process.stderr.write(`${describeRun(`1 client + ${MAX_PLAYERS - 1} bots`, bots)}\n`);
      expect(humans.total.percentile(0.95)).toBeLessThan(P95_BUDGET_MS);
      expect(bots.total.percentile(0.95)).toBeLessThan(P95_BUDGET_MS);
      expect(humans.downKBps).toBeLessThan(40);
      const watched = await runRoom(MAX_PLAYERS, 60, { spectators: 8 });
      process.stderr.write(`${describeRun(`${MAX_PLAYERS} clients + 8 spectators`, watched)}\n`);
      expect(watched.total.percentile(0.95)).toBeLessThan(P95_BUDGET_MS);
      expect(watched.spectatorKBps).toBeLessThan(40);
    },
    1_800_000,
  );
});
