/**
 * Round voting on the game server: the ballot offered between rounds, its
 * validation (eligibility, stale and malformed ballots, changes, rate limit),
 * reconnects mid-vote, the winner becoming the next round with the
 * all-loaded gate intact, the kill switch and the private-lobby setting —
 * through real RoomManager → Room → ShowDirectorController wiring with fake
 * sims.
 */
import { describe, expect, it } from 'vitest';
import type { LowFreqMessage, MatchSimOptions, RoundStatus } from '@tumble/netcode';
import { PlayerRoundStatus, createTestArenaRound } from '@tumble/sim/match';
import { RoundPhase, type RoundDefinition } from '@tumble/shared';
import { ServerMetrics } from '../src/metrics.ts';
import { playlistForMatch } from '../src/realDeps.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import type { MatchSettings } from '../src/room/types.ts';
import { ShowDirectorController } from '../src/show/ShowDirectorController.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, FakeMatchSim, TEST_SECRETS, TestClient, testDeps } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const TICK_MS = 1000 / 30;
const WALL = Date.parse('2026-10-02T12:00:00Z');

type Msg<T extends LowFreqMessage['t']> = Extract<LowFreqMessage, { t: T }>;

const arena = (id: string, type: RoundDefinition['type']): RoundDefinition =>
  createTestArenaRound({
    id,
    name: id,
    type,
    players: { min: 1, max: 40, ideal: 4 },
    ...(type === 'final'
      ? { qualification: { mode: 'lastStanding', ratio: 0, teamsEliminated: 0, teams: 0 } }
      : {}),
  });

const ROUNDS = [
  arena('race-1', 'race'),
  arena('surv-1', 'survival'),
  arena('surv-2', 'survival'),
  arena('surv-3', 'survival'),
  arena('final-1', 'final'),
];

/** Everyone qualifies except `knockedOut`, half a second into PLAYING; finals crown entrant 0. */
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

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_vote',
    sid: 'gs-test',
    pid: `solo:${sub}`,
    team: null,
    role: 'player',
    playlistId: 'vote',
    queue: 'casual',
    region: 'eu',
    size: 4,
    humans: 2,
    bots: 2,
    teamSize: 1,
    ...over,
  };
}

interface HarnessOptions {
  voting?: boolean;
  /** Players knocked out of round 1. */
  knockedOut?: ReadonlySet<number>;
}

function harness(opts: HarnessOptions = {}) {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const metrics = new ServerMetrics();
  const manager = new RoomManager(
    {
      ...testDeps(clock, sims),
      createBot: null,
      createMatchSim: (o) => {
        const s = new FateSim(o, opts.knockedOut ?? new Set([1]));
        sims.push(s);
        return s;
      },
      createShowController: () =>
        new ShowDirectorController({
          rounds: ROUNDS,
          playlist: {
            id: 'vote',
            name: 'Vote',
            maxPlayers: 4,
            minRounds: 3,
            maxRounds: 3,
            finalAtOrBelow: 2,
            pool: ROUNDS.map((r) => ({ roundId: r.id })),
            voting: { seconds: 6 },
          },
          timings: {
            preShow: 0.5,
            introFlyover: 0.2,
            rulesCard: 0.1,
            countdown: 0.1,
            roundEnd: 0.1,
            results: 3,
            transition: 3,
            victory: 0.2,
          },
          voting: opts.voting ?? true,
        }),
    },
    metrics,
    null,
    {
      config: { capacity: 4, fillWaitMs: 60_000, startAtHumans: 4, ticketedFillWaitMs: 2000 },
      profileLogMs: 0,
      tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL },
    },
  );
  const connect = (ticket: string): TestClient => {
    const conn = new FakeConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello('client', '', ticket);
    c.pump(clock.now);
    return c;
  };
  let autoLoad = true;
  const acked = new Map<TestClient, number>();
  const tick = (clients: TestClient[], n = 1): void => {
    for (let i = 0; i < n; i++) {
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) {
        c.pump(clock.now);
        if (!autoLoad) continue;
        const joins = c.lowFreq('joinRound') as Msg<'joinRound'>[];
        for (const j of joins.slice(acked.get(c) ?? 0))
          if (!j.lobby) c.send({ t: 'loaded', roundId: j.roundId });
        acked.set(c, joins.length);
      }
    }
  };
  const until = (clients: TestClient[], done: () => boolean, max = 30 * 60): void => {
    for (let i = 0; i < max && !done(); i++) tick(clients);
    expect(done()).toBe(true);
  };
  const ticketA = signJoinTicket(SECRET, claims('u-a'), WALL);
  const ticketB = signJoinTicket(SECRET, claims('u-b'), WALL);
  const a = connect(ticketA);
  const b = connect(ticketB);
  return {
    clock,
    sims,
    metrics,
    a,
    b,
    ticketA,
    connect,
    tick,
    until,
    setAutoLoad: (on: boolean) => {
      autoLoad = on;
    },
  };
}

const options = (c: TestClient) => c.lowFreq('voteOptions') as Msg<'voteOptions'>[];
const tallies = (c: TestClient) => c.lowFreq('voteTally') as Msg<'voteTally'>[];
const results = (c: TestClient) => c.lowFreq('voteResult') as Msg<'voteResult'>[];
const showJoins = (c: TestClient) => (c.lowFreq('joinRound') as Msg<'joinRound'>[]).filter((j) => !j.lobby);

describe('round voting online', () => {
  it('offers the ballot to everyone but only lets players still in the show vote', () => {
    const h = harness();
    h.until([h.a, h.b], () => options(h.a).length > 0);
    const [oa] = options(h.a);
    const [ob] = options(h.b);
    expect(h.a.welcome!.playerId).toBe(0);
    expect(oa!.roundIndex).toBe(1);
    expect(oa!.options).toHaveLength(3);
    expect(oa!.options.every((id) => id.startsWith('surv-'))).toBe(true);
    expect(oa!.canVote).toBe(true);
    expect(oa!.yourVote).toBe(-1);
    expect(oa!.closesInMs).toBeGreaterThan(5000);
    // Player 1 was knocked out in round 1: they see the ballot but cannot vote.
    expect(ob!.options).toEqual(oa!.options);
    expect(ob!.canVote).toBe(false);
    expect(oa!.eligible).toBe(3);
  });

  it('validates ballots: eliminated voter, bad option, wrong round, changes and repeats', () => {
    const h = harness();
    h.until([h.a, h.b], () => options(h.a).length > 0);
    const round = options(h.a)[0]!.roundIndex;
    const total = (t: Msg<'voteTally'> | undefined) => (t ? t.counts.reduce((x, y) => x + y, 0) : 0);

    h.b.send({ t: 'castVote', roundIndex: round, option: 0 });
    h.a.send({ t: 'castVote', roundIndex: round, option: 7 });
    h.a.send({ t: 'castVote', roundIndex: round + 1, option: 0 });
    h.a.send({ t: 'castVote', roundIndex: round, option: Number.NaN });
    h.a.send({ t: 'castVote', roundIndex: 'x', option: 0 } as unknown as LowFreqMessage);
    h.tick([h.a, h.b], 30);
    // Bots may have voted meanwhile; none of the bad ballots counted.
    const afterBad = tallies(h.a).at(-1);
    expect(total(afterBad)).toBeLessThanOrEqual(2);
    expect(h.a.kicked || h.b.kicked).toBe(false);

    h.a.send({ t: 'castVote', roundIndex: round, option: 2 });
    h.tick([h.a, h.b], 10);
    const voted = tallies(h.a).at(-1)!;
    expect(voted.counts[2]).toBeGreaterThanOrEqual(1);
    h.a.send({ t: 'castVote', roundIndex: round, option: 1 });
    h.a.send({ t: 'castVote', roundIndex: round, option: 1 });
    h.tick([h.a, h.b], 10);
    const changed = tallies(h.a).at(-1)!;
    expect(total(changed)).toBe(total(voted) + (changed.voted - voted.voted));
    expect(changed.voted).toBeLessThanOrEqual(3);

    h.until([h.a, h.b], () => results(h.a).length > 0);
    const res = results(h.a)[0]!;
    // One human against two bots: the human's ballot decides.
    expect(res.winner).toBe(1);
    expect(res.roundId).toBe(options(h.a)[0]!.options[1]);
    expect(res.counts.reduce((x, y) => x + y, 0)).toBe(3);
    expect(results(h.b)[0]).toEqual(res);

    // A late ballot changes nothing; the voted round is the one that loads.
    h.a.send({ t: 'castVote', roundIndex: round, option: 0 });
    h.until([h.a, h.b], () => showJoins(h.a).length >= 2);
    expect(showJoins(h.a)[1]!.roundId).toBe(res.roundId);
    expect(results(h.a)).toHaveLength(1);
  });

  it('rate-limits ballot spam without kicking', () => {
    const h = harness();
    h.until([h.a, h.b], () => options(h.a).length > 0);
    const round = options(h.a)[0]!.roundIndex;
    for (let i = 0; i < 30; i++) h.a.send({ t: 'castVote', roundIndex: round, option: i % 3 });
    h.tick([h.a, h.b], 2);
    expect(h.metrics.rateLimited).toBeGreaterThanOrEqual(20);
    expect(h.a.kicked).toBe(false);
    // The tally is throttled: one broadcast per 250 ms at most.
    const before = tallies(h.a).length;
    h.tick([h.a, h.b], 15);
    expect(tallies(h.a).length - before).toBeLessThanOrEqual(3);
  });

  it('keeps the ballot across a reconnect and re-offers it with the player’s own pick', () => {
    const h = harness();
    h.until([h.a, h.b], () => options(h.a).length > 0);
    const round = options(h.a)[0]!.roundIndex;
    h.a.send({ t: 'castVote', roundIndex: round, option: 0 });
    h.tick([h.a, h.b], 3);
    h.a.conn.close();
    h.tick([h.b], 5);
    const back = h.connect(h.ticketA);
    h.tick([back, h.b], 3);
    expect(back.welcome!.playerId).toBe(0);
    const again = options(back).at(-1)!;
    expect(again.roundIndex).toBe(round);
    expect(again.canVote).toBe(true);
    expect(again.yourVote).toBe(0);
    expect(again.options).toEqual(options(h.a)[0]!.options);
    back.send({ t: 'castVote', roundIndex: round, option: 2 });
    h.until([back, h.b], () => results(back).length > 0);
    expect(results(back)[0]!.winner).toBe(2);
  });

  it('still waits for every connected human to load the voted round', () => {
    const h = harness();
    h.until([h.a, h.b], () => options(h.a).length > 0);
    h.setAutoLoad(false);
    h.until([h.a, h.b], () => showJoins(h.a).length >= 2);
    const roundId = showJoins(h.a)[1]!.roundId;
    const phases = () => (h.a.lowFreq('roundPhase') as Msg<'roundPhase'>[]).map((p) => p.phase).slice(-1)[0];
    h.tick([h.a, h.b], 30);
    expect(phases()).toBe(RoundPhase.Loading);
    h.a.send({ t: 'loaded', roundId });
    h.tick([h.a, h.b], 3);
    expect(phases()).toBe(RoundPhase.IntroFlyover);
  });

  it('plays the seeded selection with the kill switch off', () => {
    const h = harness({ voting: false });
    h.until([h.a, h.b], () => showJoins(h.a).length >= 2);
    expect(options(h.a)).toHaveLength(0);
    expect(results(h.a)).toHaveLength(0);
  });

  it('does not let a spectator-seat client vote', () => {
    const h = harness();
    h.until([h.a, h.b], () => options(h.a).length > 0);
    const spec = h.connect(signJoinTicket(SECRET, claims('u-s', { role: 'spectator' }), WALL));
    h.tick([h.a, h.b, spec], 2);
    const offer = options(spec).at(-1);
    expect(offer?.canVote).toBe(false);
    spec.send({ t: 'castVote', roundIndex: offer!.roundIndex, option: 0 });
    h.tick([h.a, h.b, spec], 2);
    expect(spec.kicked).toBe(false);
  });
});

describe('private lobby round voting', () => {
  const match = (custom: Partial<NonNullable<MatchSettings['custom']>>): MatchSettings => ({
    matchId: 'm',
    playlistId: 'main-show',
    queue: 'custom',
    region: 'eu',
    humans: 2,
    bots: 0,
    custom: {
      playlistId: 'main-show',
      rounds: [],
      maxPlayers: 10,
      bots: true,
      roundTimeScale: 1,
      lobbyCountdownSec: 10,
      spectatorSlots: 2,
      ...custom,
    },
  });

  it('votes unless the host turned it off or picked the rounds', () => {
    expect(playlistForMatch('main-show', null).voting.enabled).toBe(true);
    expect(playlistForMatch('main-show', match({})).voting.enabled).toBe(true);
    expect(playlistForMatch('main-show', match({ roundVoting: true })).voting.enabled).toBe(true);
    expect(playlistForMatch('main-show', match({ roundVoting: false })).voting.enabled).toBe(false);
    const picked = playlistForMatch(
      'main-show',
      match({ rounds: ['tilt-town', 'tile-panic'], roundVoting: true }),
    );
    expect(picked.voting.enabled).toBe(false);
    expect(picked.pool.map((e) => e.roundId)).toContain('tilt-town');
  });
});
