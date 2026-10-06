/**
 * Regression tests for the matchmade room review: team voice keyed by match
 * id, one seat per account, held seats that can chat, partial results when a
 * show is cut off, and pre-show rooms only spectators are in.
 */
import { describe, expect, it, vi } from 'vitest';
import { LEAVE_CLOSE_REASON, type LowFreqMessage } from '@tumble/netcode';
import { ServerMetrics } from '../src/metrics.ts';
import type { MatchResultPayload } from '../src/results.ts';
import { Room } from '../src/room/Room.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import type { RoomConfig, RoomDeps, ShowController } from '../src/room/types.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import type { VoiceTeamEntry } from '../src/voiceTeams.ts';
import type { FakeMatchSim } from './helpers.ts';
import { FakeConnection, TEST_SECRETS, TestClient, testDeps } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const TICK_MS = 1000 / 30;
const WALL = Date.parse('2026-10-06T12:00:00Z');

type Msg<T extends LowFreqMessage['t']> = Extract<LowFreqMessage, { t: T }>;

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_review',
    sid: 'gs-test',
    pid: `solo:${sub}`,
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'casual',
    region: 'eu',
    size: 5,
    humans: 3,
    bots: 2,
    teamSize: 1,
    ...over,
  };
}

/** One round, then the show ends: short enough to reach results in a test. */
const shortShow = (): ShowController =>
  new SimpleShowController({
    roundId: 'test-round',
    playSeconds: 1,
    countdownSeconds: 0.5,
    roundEndSeconds: 0.1,
    resultsSeconds: 0.1,
    loops: 1,
  });

/** A long show whose round plans put every player on team `id % 2` (team voice). */
const teamShow = (): ShowController => {
  const c = new SimpleShowController({ roundId: 'test-round', playSeconds: 1000 });
  const drain = c.drainEvents.bind(c);
  c.drainEvents = () =>
    drain().map((e) =>
      e.type === 'roundStart'
        ? {
            ...e,
            plan: {
              ...e.plan,
              players: e.plan.playerIds.map((id) => ({ id, name: `p${id}`, isBot: false, team: id % 2 })),
            },
          }
        : e,
    );
  return c;
};

function harness(deps: Partial<RoomDeps>, config: Partial<RoomConfig> = {}) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const posted: MatchResultPayload[] = [];
  const metrics = new ServerMetrics();
  const manager = new RoomManager(
    {
      ...testDeps(clock, sims),
      createBot: null,
      createShowController: shortShow,
      results: {
        post: async (p) => {
          posted.push(p);
          return null;
        },
      },
      ...deps,
    },
    metrics,
    null,
    {
      config: {
        capacity: 40,
        fillWaitMs: 60_000,
        startAtHumans: 40,
        ticketedFillWaitMs: 2000,
        lateJoinGraceMs: 10_000,
        ...config,
      },
      profileLogMs: 0,
      tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL },
    },
  );
  const clients: TestClient[] = [];
  const connect = (c: JoinTicketClaims): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const client = new TestClient(conn);
    client.hello('client', '', signJoinTicket(SECRET, c, WALL));
    client.pump(clock.now);
    clients.push(client);
    return client;
  };
  const advance = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) c.pump(clock.now);
    }
  };
  return { clock, manager, metrics, posted, connect, advance };
}

describe('team voice reports', () => {
  it('uses the match id, so two servers whose rooms share a local id never collide', () => {
    const reports: { id: string; players: readonly VoiceTeamEntry[] }[] = [];
    const voiceTeams = {
      report: (id: string, _round: number, players: readonly VoiceTeamEntry[]) =>
        void reports.push({ id, players }),
    };
    const a = harness({ createShowController: teamShow, voiceTeams });
    const b = harness({ createShowController: teamShow, voiceTeams });
    a.connect(claims('u-a', { mid: 'm_server_a', humans: 1, bots: 1 }));
    b.connect(claims('u-b', { mid: 'm_server_b', humans: 1, bots: 1 }));
    expect(a.manager.list()[0]?.id).toBe(b.manager.list()[0]?.id);
    a.advance(30 * 3);
    b.advance(30 * 3);
    const ids = new Set(reports.map((r) => r.id));
    expect(ids).toEqual(new Set(['m_server_a', 'm_server_b']));
    expect(reports.find((r) => r.id === 'm_server_a')?.players.map((p) => p.userId)).toEqual(['u-a']);
  });

  it('never reports for an unticketed development room', () => {
    const reports: string[] = [];
    const clock = { now: 1000 };
    const manager = new RoomManager(
      {
        ...testDeps(clock, []),
        createShowController: teamShow,
        voiceTeams: { report: (id) => void reports.push(id) },
      },
      new ServerMetrics(),
      null,
      { config: { capacity: 2, fillWaitMs: 0, startAtHumans: 1 }, profileLogMs: 0 },
    );
    const conn = new FakeConnection();
    manager.accept(conn);
    new TestClient(conn).hello('dev');
    for (let i = 0; i < 90; i++) {
      clock.now += TICK_MS;
      manager.tick();
    }
    expect(manager.list()[0]?.state).toBe('show');
    expect(reports).toEqual([]);
  });
});

describe('one seat per account', () => {
  it('seats a returning leaver as a spectator, not in a held seat, and reports each account once', async () => {
    const h = harness({});
    const a = h.connect(claims('u-a'));
    h.connect(claims('u-c'));
    // u-b is late: the show starts with a seat held for them.
    h.advance(30 * 2 + 3);
    expect(h.manager.list()[0]?.state).toBe('show');
    a.conn.close(1000, LEAVE_CLOSE_REASON);
    h.advance(1);
    const back = h.connect(claims('u-a'));
    expect(back.welcome?.playerId).toBeGreaterThanOrEqual(64);
    const b = h.connect(claims('u-b'));
    expect(b.welcome?.playerId).toBeLessThan(64);
    h.advance(30 * 4);
    await Promise.resolve();
    expect(h.posted).toHaveLength(1);
    const users = h.posted[0]!.participants.flatMap((p) => (p.userId ? [p.userId] : []));
    expect(users.sort()).toEqual(['u-a', 'u-b', 'u-c']);
  });
});

describe('held seats', () => {
  function chatFrom(listener: TestClient, id: number): Msg<'chat'>[] {
    return (listener.lowFreq('chat') as Msg<'chat'>[]).filter((m) => m.from === id);
  }

  it('lets a late joiner in a held seat chat, and carries their queue party', () => {
    const h = harness({}, { lateJoinGraceMs: 60_000 });
    const a = h.connect(claims('u-a'));
    h.connect(claims('u-c'));
    h.advance(30 * 2 + 3);
    const b = h.connect(claims('u-b', { pid: 'party-1' }));
    const id = b.welcome!.playerId;
    b.chat('hello there');
    h.advance(3);
    expect(chatFrom(a, id).map((m) => m.text)).toEqual(['hello there']);
  });

  it('keeps the chat ban of a muted account that takes a held seat', () => {
    const h = harness({}, { lateJoinGraceMs: 60_000 });
    const a = h.connect(claims('u-a'));
    h.connect(claims('u-c'));
    h.advance(30 * 2 + 3);
    const b = h.connect(claims('u-b', { mute: true }));
    b.chat('hello there');
    h.advance(3);
    expect(chatFrom(a, b.welcome!.playerId)).toEqual([]);
  });

  it("does not let a reused lobby id inherit the previous holder's chat state", () => {
    const h = harness({}, { ticketedFillWaitMs: 60_000 });
    const listener = h.connect(claims('u-l', { humans: 5 }));
    const muted = h.connect(claims('u-m', { humans: 5, mute: true }));
    const id = muted.welcome!.playerId;
    muted.conn.close(1000, LEAVE_CLOSE_REASON);
    h.advance(1);
    const next = h.connect(claims('u-n', { humans: 5 }));
    expect(next.welcome?.playerId).toBe(id);
    next.chat('free to talk');
    h.advance(3);
    expect(chatFrom(listener, id).map((m) => m.text)).toEqual(['free to talk']);
  });
});

describe('shows cut off before their end', () => {
  it('reports the rounds played when the server stops mid-show (drain timeout)', async () => {
    const h = harness({
      createShowController: () =>
        new SimpleShowController({
          roundId: 'test-round',
          playSeconds: 1,
          countdownSeconds: 0.5,
          roundEndSeconds: 0.1,
          resultsSeconds: 0.1,
          loops: 5,
        }),
    });
    h.connect(claims('u-a', { humans: 1, bots: 1 }));
    h.advance(30 * 5);
    expect(h.posted).toHaveLength(0);
    await h.manager.stop();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.rounds.length).toBeGreaterThan(0);
    expect(h.posted[0]!.participants.find((p) => p.userId === 'u-a')).toBeDefined();
  });

  it('reports the rounds played when a room crashes', async () => {
    const h = harness({
      createShowController: () => {
        const c = new SimpleShowController({
          roundId: 'test-round',
          playSeconds: 1,
          countdownSeconds: 0.5,
          roundEndSeconds: 0.1,
          resultsSeconds: 0.1,
          loops: 5,
        });
        let ticks = 0;
        const onTick = c.onTick.bind(c);
        c.onTick = (dt, ctx) => {
          if (++ticks > 30 * 4) throw new Error('director bug');
          onTick(dt, ctx);
        };
        return c;
      },
    });
    h.connect(claims('u-a', { humans: 1, bots: 1 }));
    h.advance(30 * 5);
    await Promise.resolve();
    expect(h.manager.list()).toEqual([]);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.rounds.length).toBeGreaterThan(0);
  });
});

describe('capacity report', () => {
  it('counts connected spectators on top of the planned show size', () => {
    const h = harness({}, { ticketedFillWaitMs: 600_000 });
    h.connect(claims('u-a', { humans: 2, bots: 3 }));
    expect(h.manager.capacityReport().load).toBe(5);
    h.connect(claims('u-s', { role: 'spectator', humans: 2, bots: 3 }));
    expect(h.manager.capacityReport().load).toBe(6);
  });
});

describe('message handling errors', () => {
  it('close only the connection whose message threw', () => {
    const h = harness({}, { ticketedFillWaitMs: 600_000 });
    const a = h.connect(claims('u-a'));
    const b = h.connect(claims('u-b'));
    const spy = vi.spyOn(Room.prototype, 'onMessage').mockImplementationOnce(() => {
      throw new Error('decoder bug');
    });
    try {
      a.input({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(a.conn.open).toBe(false);
    expect(b.conn.open).toBe(true);
    expect(h.metrics.messageErrors).toBe(1);
    expect(() => h.advance(3)).not.toThrow();
  });
});

describe('pre-show rooms with only spectators', () => {
  it('close instead of holding their seats forever', () => {
    const h = harness({}, { ticketedFillWaitMs: 600_000, idleCloseMs: 5000 });
    const s = h.connect(claims('u-s', { role: 'spectator' }));
    expect(s.welcome?.playerId).toBeGreaterThanOrEqual(64);
    h.advance(30 * 30);
    expect(h.manager.list()[0]?.state).toBe('lobby');
    h.advance(30 * 35);
    expect(h.manager.list()).toEqual([]);
    expect(s.kicked).toBe(true);
  });
});
