/**
 * Spectators and private spectator (broadcast) seats on the game server:
 * seat limits from the host's settings and the room-wide cap, joining in the
 * middle of a show, chat permission, the free-camera focus hint and its rate
 * limit, and that watchers never reach the show (inputs, ballots, loading,
 * roster) — through real RoomManager → Room wiring with fake sims.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ENTITIES, type LowFreqMessage } from '@tumble/netcode';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import type { RoomConfig } from '../src/room/types.ts';
import { signJoinTicket, type JoinTicketClaims, type TicketCustomSettings } from '../src/tickets.ts';
import { FakeConnection, FakeMatchSim, TEST_SECRETS, TestClient, testDeps } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const TICK_MS = 1000 / 30;
const WALL = Date.parse('2026-10-06T12:00:00Z');

type Msg<T extends LowFreqMessage['t']> = Extract<LowFreqMessage, { t: T }>;

const CUSTOM: TicketCustomSettings = {
  playlistId: 'main-show',
  rounds: [],
  maxPlayers: 4,
  bots: true,
  roundTimeScale: 1,
  lobbyCountdownSec: 10,
  spectatorSlots: 2,
};

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_watch',
    sid: 'gs-test',
    pid: 'custom:ABCDEF',
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'custom',
    region: 'eu',
    size: 4,
    humans: 2,
    bots: 2,
    teamSize: 1,
    custom: CUSTOM,
    ...over,
  };
}

function harness(custom: Partial<TicketCustomSettings> = {}, config: Partial<RoomConfig> = {}) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const metrics = new ServerMetrics();
  const manager = new RoomManager({ ...testDeps(clock, sims), createBot: null }, metrics, null, {
    config: { capacity: 4, fillWaitMs: 60_000, startAtHumans: 4, ticketedFillWaitMs: 2000, ...config },
    profileLogMs: 0,
    tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL },
  });
  const settings = { ...CUSTOM, ...custom };
  const clients: TestClient[] = [];
  const connect = (sub: string, role: 'player' | 'spectator'): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello(sub, '', signJoinTicket(SECRET, claims(sub, { role, custom: settings }), WALL));
    clients.push(c);
    c.pump(clock.now);
    return c;
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) c.pump(clock.now);
    }
  };
  const showJoins = (c: TestClient) => (c.lowFreq('joinRound') as Msg<'joinRound'>[]).filter((j) => !j.lobby);
  const untilRound = (c: TestClient): void => {
    for (let i = 0; i < 30 * 30 && showJoins(c).length === 0; i++) tick();
    expect(showJoins(c).length).toBeGreaterThan(0);
  };
  const room = () => manager.room(manager.list()[0]!.id)!;
  return { clock, sims, metrics, manager, connect, tick, untilRound, showJoins, room };
}

const isSpectatorSeat = (c: TestClient): boolean => (c.welcome?.playerId ?? -1) >= MAX_ENTITIES;

describe('private spectator seats', () => {
  it('seats spectators who join in the middle of the show up to the host limit', () => {
    const h = harness({ spectatorSlots: 2 });
    const a = h.connect('u-a', 'player');
    const b = h.connect('u-b', 'player');
    h.untilRound(a);
    const s1 = h.connect('u-s1', 'spectator');
    const s2 = h.connect('u-s2', 'spectator');
    const s3 = h.connect('u-s3', 'spectator');
    h.tick(2);
    expect(isSpectatorSeat(s1)).toBe(true);
    expect(isSpectatorSeat(s2)).toBe(true);
    // The third seat is over the host's limit: refused, never welcomed.
    expect(s3.welcome).toBeNull();
    // A late spectator still gets the running round and its snapshots straight away.
    expect(h.showJoins(s1).length).toBe(1);
    h.tick(10);
    expect(s1.snapshotCount).toBeGreaterThan(0);
    expect(h.room().spectatorCount()).toEqual({ all: 2, seats: 2 });
    // Leaving frees the seat for someone else.
    s1.conn.close();
    h.tick(2);
    const s4 = h.connect('u-s4', 'spectator');
    h.tick(2);
    expect(isSpectatorSeat(s4)).toBe(true);
    expect(b.kicked).toBe(false);
  });

  it('refuses spectator seats when the host turned spectating off', () => {
    const h = harness({ spectatorSlots: 0 });
    const a = h.connect('u-a', 'player');
    h.connect('u-b', 'player');
    h.untilRound(a);
    const s = h.connect('u-s', 'spectator');
    h.tick(2);
    expect(s.welcome).toBeNull();
  });

  it('caps every room at maxSpectators, late players included', () => {
    const h = harness({ spectatorSlots: 4 }, { maxSpectators: 1 });
    const a = h.connect('u-a', 'player');
    h.connect('u-b', 'player');
    h.untilRound(a);
    const s1 = h.connect('u-s1', 'spectator');
    const late = h.connect('u-late', 'player');
    h.tick(2);
    expect(isSpectatorSeat(s1)).toBe(true);
    expect(late.welcome).toBeNull();
  });

  it('keeps spectator seats out of the show: no entity, inputs, ballots or loading gate', () => {
    const h = harness();
    const a = h.connect('u-a', 'player');
    const b = h.connect('u-b', 'player');
    h.untilRound(a);
    const s = h.connect('u-s', 'spectator');
    h.tick(2);
    const sim = h.sims.at(-1)!;
    const id = s.welcome!.playerId;
    expect(sim.states.has(id)).toBe(false);
    expect(h.showJoins(s)[0]!.players.map((p) => p.id)).not.toContain(id);
    // Inputs from a spectator never reach the round sim.
    for (let i = 0; i < 10; i++) s.input({ moveX: 1, moveZ: 1, yaw: 0, buttons: 1, emote: 0 });
    h.tick(5);
    expect(sim.applied.has(id)).toBe(false);
    expect(sim.inputs.has(id)).toBe(false);
    // The roster players see lists the spectator as nothing they can race against.
    const list = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(list.some((p) => p.id === id)).toBe(false);
    expect(h.room().humanCount).toBe(2);
    expect(s.kicked).toBe(false);
    expect(b.kicked).toBe(false);
  });
});

describe('spectator chat', () => {
  const lastInfo = (c: TestClient) => c.lowFreq('showInfo').at(-1) as Msg<'showInfo'> | undefined;
  const chatFrom = (c: TestClient, from: number) =>
    (c.lowFreq('chat') as Msg<'chat'>[]).filter((m) => m.from === from);

  it('mutes spectator seats unless the host allowed spectator chat, and says so in showInfo', () => {
    const h = harness({ spectatorChat: false });
    const a = h.connect('u-a', 'player');
    h.connect('u-b', 'player');
    h.untilRound(a);
    const s = h.connect('u-s', 'spectator');
    h.tick(2);
    expect(lastInfo(a)?.canChat).toBe(true);
    expect(lastInfo(s)?.canChat).toBe(false);
    s.chat('hello from the booth');
    h.tick(3);
    expect(chatFrom(a, s.welcome!.playerId)).toHaveLength(0);
    expect(s.kicked).toBe(false);
    a.chat('players still talk');
    h.tick(3);
    expect(chatFrom(s, a.welcome!.playerId)).toHaveLength(1);
  });

  it('relays spectator chat when the host allowed it', () => {
    const h = harness({ spectatorChat: true });
    const a = h.connect('u-a', 'player');
    h.connect('u-b', 'player');
    h.untilRound(a);
    const s = h.connect('u-s', 'spectator');
    h.tick(2);
    expect(lastInfo(s)?.canChat).toBe(true);
    s.chat('nice dive');
    h.tick(3);
    expect(chatFrom(a, s.welcome!.playerId)).toHaveLength(1);
  });
});

describe('spectator camera hints', () => {
  it('accepts a free-camera focus, ignores malformed ones and rate-limits floods without kicking', () => {
    const h = harness();
    const a = h.connect('u-a', 'player');
    h.connect('u-b', 'player');
    h.untilRound(a);
    const s = h.connect('u-s', 'spectator');
    h.tick(2);
    s.send({ t: 'spectate', target: -1, focus: [4, 2, 30] });
    s.send({ t: 'spectate', target: -1, focus: [Number.NaN, 0, 0] } as Msg<'spectate'>);
    s.send({ t: 'spectate', target: -1, focus: 'up' } as unknown as Msg<'spectate'>);
    h.tick(2);
    expect(s.kicked).toBe(false);
    const before = h.metrics.rateLimited;
    for (let i = 0; i < 40; i++) s.send({ t: 'spectate', target: -1, focus: [i, 0, i] });
    h.tick(3);
    expect(h.metrics.rateLimited).toBeGreaterThan(before);
    expect(s.kicked).toBe(false);
    h.tick(10);
    expect(s.snapshotCount).toBeGreaterThan(0);
  });
});
