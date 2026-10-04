/**
 * Live ops on the game server: during maintenance no new match room opens,
 * while running shows keep their players and rejoins; the mutators.chaos kill
 * switch plays mutator playlists without their twist.
 */
import type { Rapier } from '@tumble/sim';
import { describe, expect, it, vi } from 'vitest';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, TEST_SECRETS, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const captured: Record<string, unknown>[] = [];
vi.mock('../src/show/ShowDirectorController.ts', () => ({
  ShowDirectorController: class {
    constructor(opts: Record<string, unknown>) {
      captured.push(opts);
    }
  },
}));

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const WALL = Date.parse('2026-10-04T12:00:00Z');

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_live_ops_1',
    sid: 'gs-test',
    pid: `party-${sub}`,
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'casual',
    region: 'eu',
    size: 4,
    humans: 2,
    bots: 2,
    teamSize: 1,
    ...over,
  };
}

function setup(allowUnticketed = false) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  let open = true;
  const deps = {
    ...testDeps(clock, sims),
    createShowController: () =>
      new SimpleShowController({
        roundId: 'test-round',
        playSeconds: 30,
        countdownSeconds: 0.2,
        roundEndSeconds: 0.2,
        resultsSeconds: 0.2,
      }),
    results: null,
  };
  const manager = new RoomManager(deps, new ServerMetrics(), null, {
    config: { capacity: 40, fillWaitMs: 60_000, startAtHumans: 40, ticketedFillWaitMs: 5000 },
    profileLogMs: 0,
    tickets: { secret: SECRET, allowUnticketed, now: () => WALL },
    acceptNewMatches: () => open,
  });
  const connect = (ticket: string): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello('client-name', '', ticket);
    c.pump(clock.now);
    return c;
  };
  return { manager, connect, setOpen: (v: boolean) => void (open = v) };
}

describe('maintenance on the game server', () => {
  it('refuses a ticket that would open a new match room', () => {
    const { manager, connect, setOpen } = setup();
    setOpen(false);
    const c = connect(signJoinTicket(SECRET, claims('u1'), WALL));
    expect(c.kicked).toBe(true);
    expect(c.welcome).toBeNull();
    expect(manager.list()).toHaveLength(0);
  });

  it('keeps seating players of a match that was already running, and their rejoins', () => {
    const { manager, connect, setOpen } = setup();
    const first = connect(signJoinTicket(SECRET, claims('u1'), WALL));
    expect(first.welcome).not.toBeNull();
    setOpen(false);
    const second = connect(signJoinTicket(SECRET, claims('u2'), WALL));
    expect(second.welcome).not.toBeNull();
    first.conn.close();
    const back = connect(signJoinTicket(SECRET, claims('u1', { rejoin: true }), WALL));
    expect(back.welcome?.playerId).toBe(first.welcome?.playerId);
    // A different match is new: refused.
    const other = connect(signJoinTicket(SECRET, claims('u3', { mid: 'm_other' }), WALL));
    expect(other.kicked).toBe(true);
    expect(manager.list()).toHaveLength(1);
    setOpen(true);
    expect(connect(signJoinTicket(SECRET, claims('u3', { mid: 'm_other' }), WALL)).welcome).not.toBeNull();
    expect(manager.list()).toHaveLength(2);
  });

  it('refuses unticketed dev rooms too', () => {
    const { manager, connect, setOpen } = setup(true);
    setOpen(false);
    expect(connect('').kicked).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });
});

describe('mutators.chaos kill switch', () => {
  it('forces no mutator while the flag is off and lets the director pick otherwise', async () => {
    const { createRealRoomDeps } = await import('../src/realDeps.ts');
    let enabled = true;
    const deps = createRealRoomDeps({} as Rapier, { mutatorsEnabled: () => enabled });
    const match = {
      matchId: 'm1',
      playlistId: 'chaos-mode',
      queue: 'casual' as const,
      region: 'eu',
      humans: 1,
      bots: 3,
      teamSize: 1,
      custom: null,
    };
    deps.createShowController({ match } as never);
    enabled = false;
    deps.createShowController({ match } as never);
    expect(captured).toHaveLength(2);
    expect('mutatorId' in captured[0]!).toBe(false);
    expect(captured[1]!.mutatorId).toBeNull();
    expect((captured[1]!.playlist as { id: string }).id).toBe('chaos-mode');
  });
});
