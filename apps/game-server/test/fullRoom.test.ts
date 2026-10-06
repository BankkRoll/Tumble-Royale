/**
 * Seat and id edge cases at the player cap: exactly `MAX_PLAYERS` joins,
 * the one after, churn in the pre-show lobby, resumes, and a full room's
 * spectator range. RoomManager → Room with fake sims and in-memory clients.
 */
import { KickReason, MAX_ENTITIES } from '@tumble/netcode';
import { MAX_PLAYERS } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, TEST_SECRETS, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const TICK_MS = 1000 / 30;
const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const WALL = Date.parse('2026-10-02T12:00:00Z');
/** Ids 0-254 fit the 8-bit Welcome id; 255 is never handed out. */
const LAST_ID = 254;

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_full_room',
    sid: 'gs-test',
    pid: `solo:${sub}`,
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'casual',
    region: 'eu',
    size: MAX_PLAYERS,
    humans: MAX_PLAYERS,
    bots: 0,
    teamSize: 1,
    ...over,
  };
}

function setup(
  opts: { ticketed?: boolean; maxRooms?: number; resumeWindowMs?: number; maxSpectators?: number } = {},
) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const manager = new RoomManager(testDeps(clock, sims), new ServerMetrics(), null, {
    config: {
      capacity: MAX_PLAYERS,
      startAtHumans: MAX_PLAYERS,
      fillWaitMs: 3_600_000,
      ticketedFillWaitMs: 3_600_000,
      resumeWindowMs: opts.resumeWindowMs ?? 30_000,
      ...(opts.maxSpectators !== undefined ? { maxSpectators: opts.maxSpectators } : {}),
    },
    maxRooms: opts.maxRooms ?? 1,
    profileLogMs: 0,
    ...(opts.ticketed ? { tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL } } : {}),
  });
  const connect = (name: string, ticket = '', token = ''): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.keepSnapshots = false;
    c.hello(name, token, ticket);
    c.pump(clock.now);
    return c;
  };
  const advance = (ticks: number, clients: readonly TestClient[] = []): void => {
    for (let i = 0; i < ticks; i++) {
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) c.pump(clock.now);
    }
  };
  return { manager, sims, connect, advance };
}

/** The kick reason a refused client was closed with, or null when it is still connected. */
const kickReason = (c: TestClient): number | null => (c.kicked ? c.conn.closeCode - 4000 : null);

describe(`seats at the ${MAX_PLAYERS}-player cap`, () => {
  it(`seats exactly ${MAX_PLAYERS} players with ids 0-${MAX_PLAYERS - 1} and refuses the next one`, () => {
    const { manager, connect } = setup();
    const clients = Array.from({ length: MAX_PLAYERS }, (_, i) => connect(`p${i}`));
    const ids = clients.map((c) => c.welcome?.playerId);
    expect(ids).toEqual(Array.from({ length: MAX_PLAYERS }, (_, i) => i));
    expect(manager.list()[0]!.humans).toBe(MAX_PLAYERS);

    const extra = connect('one-too-many');
    expect(extra.welcome).toBeNull();
    expect(kickReason(extra)).toBe(KickReason.ServerFull);
    expect(manager.list()).toHaveLength(1);
  });

  it('opens a second room for the next player when the process has room for one', () => {
    const { manager, connect } = setup({ maxRooms: 2 });
    for (let i = 0; i < MAX_PLAYERS; i++) connect(`p${i}`);
    const next = connect('next');
    expect(next.welcome?.playerId).toBe(0);
    expect(manager.list()).toHaveLength(2);
  });

  it('reuses freed ids after heavy lobby churn and fills to exactly the cap without a duplicate', () => {
    const { manager, connect, advance } = setup({ resumeWindowMs: 1000 });
    // One short of full: a full lobby starts the show at once, and churn happens while it fills.
    let live = Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => connect(`p${i}`));
    for (let wave = 0; wave < 5; wave++) {
      // A third of the lobby drops, waits out the resume window, and new players take the seats.
      const leaving = live.filter((_, i) => (i + wave) % 3 === 0);
      for (const c of leaving) c.conn.close();
      advance(45);
      live = live.filter((c) => !leaving.includes(c));
      for (let k = 0; k < leaving.length; k++) live.push(connect(`w${wave}-${k}`));
      const ids = live.map((c) => c.welcome?.playerId ?? -1);
      expect(new Set(ids).size).toBe(MAX_PLAYERS - 1);
      for (const id of ids) {
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(MAX_PLAYERS);
      }
      expect(manager.list()[0]!.humans).toBe(MAX_PLAYERS - 1);
    }
    live.push(connect('last'));
    const ids = live.map((c) => c.welcome?.playerId ?? -1).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: MAX_PLAYERS }, (_, i) => i));
    expect(connect('after-full').welcome).toBeNull();
  });

  it('gives a resuming player the same id even in a full room', () => {
    const { connect, advance } = setup();
    const clients = Array.from({ length: MAX_PLAYERS }, (_, i) => connect(`p${i}`));
    const leaver = clients[37]!;
    const token = leaver.welcome!.resumeToken;
    leaver.conn.close();
    advance(10);
    // The seat is held for the resume window, so a stranger cannot take it…
    expect(connect('stranger').welcome).toBeNull();
    // …but its owner gets it back.
    const back = connect('p37', '', token);
    expect(back.welcome?.playerId).toBe(37);
    expect(back.welcome?.resumed).toBe(true);
  });

  it(`refuses a ${MAX_PLAYERS + 1}th ticketed player in a full matchmade lobby`, () => {
    const { manager, connect } = setup({ ticketed: true });
    const players = Array.from({ length: MAX_PLAYERS }, (_, i) =>
      connect(`u${i}`, signJoinTicket(SECRET, claims(`u${i}`), WALL)),
    );
    expect(new Set(players.map((c) => c.welcome?.playerId)).size).toBe(MAX_PLAYERS);
    const extra = connect('u-extra', signJoinTicket(SECRET, claims('u-extra'), WALL));
    expect(extra.welcome).toBeNull();
    expect(kickReason(extra)).toBe(KickReason.ServerFull);
    expect(manager.list()[0]!.humans).toBe(MAX_PLAYERS);
  });

  it('seats spectators of a full show above the entity range, up to the 8-bit id limit', () => {
    // The id range is the limit under test here, not the room's spectator cap.
    const { manager, connect, advance, sims } = setup({ ticketed: true, maxSpectators: 255 });
    const players = Array.from({ length: MAX_PLAYERS }, (_, i) =>
      connect(`u${i}`, signJoinTicket(SECRET, claims(`u${i}`), WALL)),
    );
    // Every ticketed human is in: the show starts.
    advance(5, players);
    expect(sims.length).toBeGreaterThan(0);
    const spectatorSeats = LAST_ID - MAX_ENTITIES + 1;
    const spectators = Array.from({ length: spectatorSeats }, (_, i) =>
      connect(`s${i}`, signJoinTicket(SECRET, claims(`s${i}`, { role: 'spectator' }), WALL)),
    );
    const ids = spectators.map((c) => c.welcome?.playerId ?? -1);
    expect(new Set(ids).size).toBe(spectatorSeats);
    expect(Math.min(...ids)).toBe(MAX_ENTITIES);
    expect(Math.max(...ids)).toBe(LAST_ID);
    const late = connect('s-late', signJoinTicket(SECRET, claims('s-late', { role: 'spectator' }), WALL));
    expect(late.welcome).toBeNull();
    expect(kickReason(late)).toBe(KickReason.ServerFull);
    // Freeing one spectator seat makes room for exactly one more.
    spectators[0]!.conn.close();
    const again = connect('s-again', signJoinTicket(SECRET, claims('s-again', { role: 'spectator' }), WALL));
    expect(again.welcome?.playerId).toBe(MAX_ENTITIES);
    expect(manager.list()[0]!.humans).toBe(MAX_PLAYERS);
  });
});
