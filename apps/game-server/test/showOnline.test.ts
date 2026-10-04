/**
 * Online show fidelity: duos/squads parties, seeded bot skills, private-show
 * options and held seats for late ticketed players, through real
 * RoomManager â†’ Room â†’ ShowDirectorController wiring with fake sims.
 */
import { describe, expect, it } from 'vitest';
import type { LowFreqMessage, MatchSimOptions, RoundStatus } from '@tumble/netcode';
import { PlayerRoundStatus, createTestArenaRound } from '@tumble/sim/match';
import { assignBotSkills } from '@tumble/sim/show';
import { RoundPhase, ShowPhase } from '@tumble/shared';
import { ServerMetrics } from '../src/metrics.ts';
import { customShowOptions } from '../src/realDeps.ts';
import type { MatchResultPayload } from '../src/results.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import type { RoomDeps, ShowController } from '../src/room/types.ts';
import { ShowDirectorController } from '../src/show/ShowDirectorController.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, FakeMatchSim, TEST_SECRETS, TestClient, testDeps } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const TICK_MS = 1000 / 30;
const WALL = Date.parse('2026-10-02T12:00:00Z');

type Msg<T extends LowFreqMessage['t']> = Extract<LowFreqMessage, { t: T }>;

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_online_fidelity',
    sid: 'gs-test',
    pid: `solo:${sub}`,
    team: null,
    role: 'player',
    playlistId: 'duos',
    queue: 'casual',
    region: 'eu',
    size: 4,
    humans: 2,
    bots: 2,
    teamSize: 1,
    ...over,
  };
}

const RACE = createTestArenaRound({ id: 'duo-race', name: 'Duo race', type: 'race' });
const FINAL = createTestArenaRound({
  id: 'duo-final',
  name: 'Duo final',
  type: 'final',
  qualification: { mode: 'lastStanding', ratio: 0, teamsEliminated: 0, teams: 0 },
});

/** Fake round where everyone qualifies except `knockedOut`, decided half a second into PLAYING. */
class FateSim extends FakeMatchSim {
  constructor(
    opts: MatchSimOptions,
    private readonly knockedOut: ReadonlySet<number>,
  ) {
    super(opts);
  }

  override getStatus(): RoundStatus {
    const st = super.getStatus();
    const playing = this.phaseSet.some((p) => p.phase === RoundPhase.Playing);
    if (!playing || this.time < 0.5) return st;
    st.finished = true;
    // Finals report no fates: the director crowns the first undecided entrant (id 0).
    if (this.round.type === 'final') return st;
    for (const id of this.states.keys()) {
      const out = this.knockedOut.has(id);
      st.players.set(id, {
        status: out ? PlayerRoundStatus.Eliminated : PlayerRoundStatus.Qualified,
        score: 0,
        progress: 1,
        place: id + 1,
      });
    }
    return st;
  }
}

interface Harness {
  clock: { now: number };
  sims: FakeMatchSim[];
  manager: RoomManager;
  metrics: ServerMetrics;
  connect(ticket: string): TestClient;
  advance(ticks: number, clients: TestClient[]): void;
}

function harness(
  deps: Partial<RoomDeps> & { createShowController: RoomDeps['createShowController'] },
  config: Record<string, number> = {},
  knockedOut: ReadonlySet<number> = new Set(),
): Harness {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const metrics = new ServerMetrics();
  const base = testDeps(clock, sims);
  const manager = new RoomManager(
    {
      ...base,
      createBot: null,
      createMatchSim: (o) => {
        const s = new FateSim(o, knockedOut);
        sims.push(s);
        return s;
      },
      ...deps,
    },
    metrics,
    null,
    {
      config: { capacity: 40, fillWaitMs: 60_000, startAtHumans: 40, ticketedFillWaitMs: 2000, ...config },
      profileLogMs: 0,
      tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL },
    },
  );
  const loadedFor = new Map<TestClient, number>();
  const connect = (ticket: string): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello('client', '', ticket);
    c.pump(clock.now);
    return c;
  };
  const advance = (ticks: number, clients: TestClient[]): void => {
    for (let i = 0; i < ticks; i++) {
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) {
        c.pump(clock.now);
        // Like the real client: ack every round as loaded.
        const joins = c.lowFreq('joinRound') as Msg<'joinRound'>[];
        const done = loadedFor.get(c) ?? 0;
        for (const j of joins.slice(done)) if (!j.lobby) c.send({ t: 'loaded', roundId: j.roundId });
        loadedFor.set(c, joins.length);
      }
    }
  };
  return { clock, sims, manager, metrics, connect, advance };
}

const duoController = (extra: Partial<ConstructorParameters<typeof ShowDirectorController>[0]> = {}) =>
  new ShowDirectorController({
    rounds: [RACE, FINAL],
    playlist: {
      id: 'duos',
      name: 'Duos',
      partySize: 2,
      maxPlayers: 40,
      minRounds: 1,
      maxRounds: 2,
      finalAtOrBelow: 2,
      qualifyCurve: [0.75],
      pool: [
        { roundId: RACE.id, weight: 1 },
        { roundId: FINAL.id, weight: 1 },
      ],
    },
    timings: {
      preShow: 0.5,
      loadingStall: 1,
      introFlyover: 0.1,
      rulesCard: 0.1,
      countdown: 0.1,
      roundEnd: 0.1,
      results: 0.2,
      transition: 0.1,
      victory: 0.2,
    },
    ...extra,
  });

describe('online duos', () => {
  it('keeps a queued duo together, carries the eliminated partner and shares the crown', () => {
    const h = harness({ createShowController: () => duoController() }, {}, new Set([1]));
    const a = h.connect(signJoinTicket(SECRET, claims('u-a', { pid: 'duo-1' }), WALL));
    const b = h.connect(signJoinTicket(SECRET, claims('u-b', { pid: 'duo-1' }), WALL));
    expect([a.welcome?.playerId, b.welcome?.playerId]).toEqual([0, 1]);
    // Two rounds, each with the test arena's 7 s flyover.
    h.advance(30 * 25, [a, b]);

    const list = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    const party = new Map(list.map((p) => [p.id, p.partyId]));
    expect(party.get(0)).toBeDefined();
    expect(party.get(0)).toBe(party.get(1));
    expect(party.get(2)).toBe(party.get(3));
    expect(party.get(2)).not.toBe(party.get(0));

    const joins = (a.lowFreq('joinRound') as Msg<'joinRound'>[]).filter((j) => !j.lobby);
    expect(joins.length).toBe(2);
    expect(joins[0]!.players.find((p) => p.id === 1)?.partyId).toBe(party.get(0));
    // The race sim received party ids too.
    expect(h.sims[0]!.opts.players.map((p) => p.partyId)).toEqual([0, 1, 2, 3].map((id) => party.get(id)));

    const r1 = (a.lowFreq('roundResults') as Msg<'roundResults'>[])[0]!;
    const partner = r1.results.find((r) => r.id === 1)!;
    expect(partner.status).toBe(1);
    expect(partner.carried).toBe(true);
    expect(joins[1]!.players.map((p) => p.id)).toContain(1);

    const summary = b.lowFreq('showSummary').at(-1) as Msg<'showSummary'>;
    expect(summary.winners.sort()).toEqual([0, 1]);
  });

  it('reports who played alongside their queue party', async () => {
    const posted: MatchResultPayload[] = [];
    const results = {
      post: async (p: MatchResultPayload) => {
        posted.push(p);
        return null;
      },
    };
    const h = harness({ createShowController: () => duoController(), results });
    const a = h.connect(signJoinTicket(SECRET, claims('u-a', { pid: 'party-1', humans: 3 }), WALL));
    const b = h.connect(signJoinTicket(SECRET, claims('u-b', { pid: 'party-1', humans: 3 }), WALL));
    // Queued with a party whose other members never made it into this show.
    const c = h.connect(signJoinTicket(SECRET, claims('u-c', { pid: 'party-2', humans: 3 }), WALL));
    h.advance(30 * 25, [a, b, c]);
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    const party = new Map(posted[0]!.participants.map((p) => [p.userId, p.party]));
    expect(party.get('u-a')).toBe(true);
    expect(party.get('u-b')).toBe(true);
    expect(party.get('u-c')).toBeUndefined();
    expect(posted[0]!.participants.filter((p) => p.isBot).every((p) => p.party === undefined)).toBe(true);
  });

  it('uses the matchmaker team over the queue party', () => {
    const h = harness({ createShowController: () => duoController() });
    const a = h.connect(signJoinTicket(SECRET, claims('u-a', { team: 1 }), WALL));
    const b = h.connect(signJoinTicket(SECRET, claims('u-b', { team: 1 }), WALL));
    h.advance(30, [a, b]);
    const list = (b.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(list.find((p) => p.id === 0)?.partyId).toBe(list.find((p) => p.id === 1)?.partyId);
  });
});

describe('online bot skills', () => {
  it("seeds bot tiers from the playlist's skill mix like the offline runner", () => {
    const mix = { clumsy: 0, average: 1, sharp: 3 };
    const ctrl = (): ShowController =>
      Object.assign(new SimpleShowController({ roundId: 'test-round', playSeconds: 100 }), {
        botSkillMix: mix,
      });
    const h = harness({ createShowController: ctrl, randomSeed: () => 777 }, {});
    const a = h.connect(signJoinTicket(SECRET, claims('u-a', { humans: 1, size: 12, bots: 11 }), WALL));
    h.advance(30 * 3, [a]);
    const round = h.sims.find((s) => !s.opts.lobby)!;
    const bots = round.opts.players.filter((p) => p.isBot);
    expect(bots).toHaveLength(11);
    expect(bots.map((p) => p.botSkill)).toEqual(assignBotSkills(777, 11, mix));
    expect(bots.some((p) => p.botSkill === 'average')).toBe(true);
    expect(bots.every((p) => p.botSkill !== 'clumsy')).toBe(true);
  });
});

describe('private show options', () => {
  it('maps custom lobby settings onto director options', () => {
    const base = {
      matchId: 'm',
      playlistId: 'main-show',
      queue: 'custom' as const,
      region: 'eu',
      humans: 1,
      bots: 0,
    };
    expect(customShowOptions({ ...base, custom: null })).toEqual({});
    const custom = {
      playlistId: 'main-show',
      rounds: [],
      maxPlayers: 12,
      bots: true,
      roundTimeScale: 9,
      lobbyCountdownSec: 30.4,
      spectatorSlots: 0,
    };
    expect(customShowOptions({ ...base, custom })).toEqual({ roundTimeScale: 2, timings: { preShow: 30 } });
  });

  it('applies the round timer scale and the pre-show countdown', () => {
    const custom = {
      playlistId: 'duos',
      rounds: [],
      maxPlayers: 4,
      bots: true,
      roundTimeScale: 1.5,
      lobbyCountdownSec: 3,
      spectatorSlots: 0,
    };
    const h = harness({
      createShowController: ({ match }) => duoController(customShowOptions(match)),
    });
    const a = h.connect(signJoinTicket(SECRET, claims('u-a', { humans: 1, queue: 'custom', custom }), WALL));
    h.advance(30 * 2 + 5, [a]);
    const pre = (a.lowFreq('showPhase') as Msg<'showPhase'>[]).find((m) => m.phase === ShowPhase.PreShow);
    expect(pre?.startsInMs).toBeGreaterThan(2800);
    expect(pre?.startsInMs).toBeLessThanOrEqual(3000);
    expect(h.sims.filter((s) => !s.opts.lobby)).toHaveLength(0);
    h.advance(30 * 3, [a]);
    const round = h.sims.find((s) => !s.opts.lobby)!;
    expect(round).toBeDefined();
    // The sim scales its own timer from this (one mechanism on every peer).
    expect(round.opts.roundTimeScale).toBe(1.5);
    const join = (a.lowFreq('joinRound') as Msg<'joinRound'>[]).find((j) => !j.lobby);
    expect(join?.roundTimeScale).toBe(1.5);
  });
});

describe('late ticketed joiners', () => {
  function lateHarness() {
    const left: number[] = [];
    const ctrl = (): ShowController => {
      const c = new SimpleShowController({ roundId: 'test-round', playSeconds: 100, countdownSeconds: 5 });
      const onLeft = c.onPlayerLeft.bind(c);
      c.onPlayerLeft = (id) => {
        left.push(id);
        onLeft(id);
      };
      return c;
    };
    const h = harness({ createShowController: ctrl }, { lateJoinGraceMs: 3000 });
    return { h, left };
  }

  it('holds the seat of a ticketed player who arrives after the show started', () => {
    const { h, left } = lateHarness();
    const a = h.connect(signJoinTicket(SECRET, claims('u-a'), WALL));
    // The fill wait passes without u-b: the show starts with u-b's seat held, not botted.
    h.advance(30 * 2 + 3, [a]);
    const round = h.sims.find((s) => !s.opts.lobby)!;
    expect(round.opts.players.map((p) => p.isBot)).toEqual([false, false, true, true]);
    const b = h.connect(signJoinTicket(SECRET, claims('u-b'), WALL));
    expect(b.welcome?.playerId).toBe(1);
    h.advance(3, [a, b]);
    const join = b.lowFreq('joinRound').at(-1) as Msg<'joinRound'>;
    expect(join.players.map((p) => p.id)).toContain(1);
    const list = (a.lowFreq('playerList').at(-1) as Msg<'playerList'>).players;
    expect(list.find((p) => p.id === 1)).toMatchObject({ connected: true, isBot: false });
    // b plays: its inputs reach the round sim.
    b.input({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });
    h.advance(30 * 5, [a, b]);
    expect(left).toEqual([]);
  });

  it('releases a held seat after the grace window and seats latecomers as spectators', () => {
    const { h, left } = lateHarness();
    const a = h.connect(signJoinTicket(SECRET, claims('u-a'), WALL));
    h.advance(30 * 2 + 3, [a]);
    expect(left).toEqual([]);
    h.advance(30 * 4, [a]);
    expect(left).toEqual([1]);
    const b = h.connect(signJoinTicket(SECRET, claims('u-b'), WALL));
    expect(b.welcome?.playerId).toBeGreaterThanOrEqual(64);
  });
});
