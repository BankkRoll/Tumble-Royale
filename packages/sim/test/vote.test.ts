import { Rng, RoundPhase, ShowPhase, type RoundDefinition, type RoundPhaseId } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { loadRapier } from '../src/index.ts';
import {
  PlayerRoundStatus,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
  type RoundStatus,
} from '../src/match/index.ts';
import {
  RoundVote,
  ShowDirector,
  ShowPlaylistSchema,
  VOTE_MIN_OPEN_SECONDS,
  createOfflineShow,
  selectRound,
  selectRoundCandidates,
  type RoundCandidate,
  type RoundDriver,
  type RoundStartInfo,
  type ShowEvent,
  type ShowPlaylistInput,
  type ShowTimings,
} from '../src/show/index.ts';

const ROUNDS: RoundDefinition[] = [
  ['race-a', 'race'],
  ['race-b', 'race'],
  ['race-c', 'race'],
  ['surv-a', 'survival'],
  ['surv-b', 'survival'],
  ['logic-a', 'logic'],
  ['hunt-a', 'hunt'],
  ['final-a', 'final'],
  ['final-b', 'final'],
].map(([id, type]) =>
  createTestArenaRound({
    id: id as string,
    name: (id as string).toUpperCase(),
    type: type as RoundDefinition['type'],
    players: { min: 2, max: 60, ideal: type === 'final' ? 8 : 30 },
    qualification: {
      mode: type === 'final' ? 'lastStanding' : 'finish',
      ratio: 0.6,
      teams: 0,
      teamsEliminated: 0,
    },
  }),
);
const CATALOG = new Map(ROUNDS.map((r) => [r.id, r]));

const PLAYLIST: ShowPlaylistInput = {
  id: 'vote-test',
  name: 'Vote test',
  minRounds: 3,
  maxRounds: 4,
  finalAtOrBelow: 4,
  pool: ROUNDS.map((r) => ({ roundId: r.id })),
};

/** Finishes every round half a second into PLAYING, qualifying ~60% (id order shuffled by seed). */
class QuickDriver implements RoundDriver {
  phase: RoundPhaseId = RoundPhase.Loading;
  private t = 0;
  private done = false;
  private readonly players = new Map<
    number,
    { status: 0 | 1 | 2 | 3; score: number; progress: number; place: number }
  >();

  constructor(
    private readonly info: RoundStartInfo,
    private readonly rng: Rng,
  ) {
    for (const p of info.players) this.players.set(p.id, { status: 0, score: 0, progress: 0, place: 0 });
  }

  setPhase(phase: RoundPhaseId): void {
    this.phase = phase;
  }

  advance(dt: number): void {
    if (this.phase !== RoundPhase.Playing || this.done) return;
    this.t += dt;
    if (this.t < 0.5) return;
    const ids = this.rng.shuffle(this.info.players.map((p) => p.id));
    const keep = this.info.isFinal ? 1 : Math.max(1, Math.round(ids.length * 0.6));
    ids.forEach((id, i) =>
      Object.assign(this.players.get(id)!, {
        status: i < keep ? PlayerRoundStatus.Qualified : PlayerRoundStatus.Eliminated,
        place: i + 1,
      }),
    );
    this.done = true;
  }

  forfeit(id: number): void {
    const e = this.players.get(id);
    if (e && e.status === 0) Object.assign(e, { status: PlayerRoundStatus.Eliminated, place: 999 });
  }

  getStatus(): Pick<RoundStatus, 'phase' | 'finished' | 'players'> {
    return { phase: this.phase, finished: this.done, players: this.players };
  }

  dispose(): void {}
}

const FAST: Partial<ShowTimings> = {
  preShow: 0,
  introFlyover: 0.5,
  rulesCard: 0.5,
  countdown: 0.5,
  roundEnd: 0.5,
  results: 6,
  transition: 2,
  victory: 0.5,
};

interface RunOptions {
  seed: number;
  voting?: boolean;
  n?: number;
  humans?: number;
  playlist?: ShowPlaylistInput;
  timings?: Partial<ShowTimings>;
  /** Called on every voteOpen; may cast ballots. */
  onVote?: (director: ShowDirector, e: Extract<ShowEvent, { type: 'voteOpen' }>, now: number) => void;
  /** Called every tick with the show clock. */
  onTick?: (director: ShowDirector, now: number) => void;
}

function run(opts: RunOptions) {
  const n = opts.n ?? 30;
  const humans = opts.humans ?? 1;
  const rng = new Rng(opts.seed ^ 0x51);
  let driver: QuickDriver | null = null;
  const infos: RoundStartInfo[] = [];
  const events: { at: number; e: ShowEvent }[] = [];
  const director = new ShowDirector({
    seed: opts.seed,
    playlist: opts.playlist ?? PLAYLIST,
    rounds: ROUNDS,
    participants: Array.from({ length: n }, (_, i) => ({ id: i, name: `P${i}`, isBot: i >= humans })),
    timings: { ...FAST, ...opts.timings },
    ...(opts.voting !== undefined ? { voting: opts.voting } : {}),
    host: {
      startRound(info) {
        infos.push(info);
        driver = new QuickDriver(info, rng);
        return driver;
      },
    },
  });
  let now = 0;
  director.on((e) => {
    events.push({ at: now, e });
    if (e.type === 'roundSelected') for (let h = 0; h < humans; h++) director.onPlayerLoaded(h);
    if (e.type === 'voteOpen') opts.onVote?.(director, e, now);
  });
  const dt = 0.05;
  for (let i = 0; i < 40_000 && director.current().showPhase !== ShowPhase.Ended; i++) {
    now += dt;
    director.tick(dt);
    (driver as QuickDriver | null)?.advance(dt);
    opts.onTick?.(director, now);
  }
  return { director, infos, events, summary: director.summary() };
}

const ofType = <T extends ShowEvent['type']>(events: { at: number; e: ShowEvent }[], t: T) =>
  events.filter((x) => x.e.type === t) as { at: number; e: Extract<ShowEvent, { type: T }> }[];

function candidates(ids: string[], weight = 1): RoundCandidate[] {
  return ids.map((id) => ({ round: CATALOG.get(id)!, weight }));
}

describe('selectRoundCandidates', () => {
  const playlist = ShowPlaylistSchema.parse(PLAYLIST);
  const ctx = {
    roundIndex: 1,
    players: 20,
    isFinal: false,
    previousType: 'race' as const,
    used: new Set(['race-a']),
  };

  it('draws the selector pick first, then distinct rounds from the same tier', () => {
    for (let seed = 1; seed < 40; seed++) {
      const pick = selectRound(playlist, CATALOG, ctx, new Rng(seed));
      const ballot = selectRoundCandidates(playlist, CATALOG, ctx, new Rng(seed), 3);
      expect(ballot[0]!.round.id).toBe(pick!.id);
      expect(ballot).toHaveLength(3);
      expect(new Set(ballot.map((c) => c.round.id)).size).toBe(3);
      for (const c of ballot) {
        expect(c.round.type).not.toBe('race');
        expect(c.round.type).not.toBe('final');
      }
    }
  });

  it('never pads the ballot from a looser tier', () => {
    const finals = selectRoundCandidates(playlist, CATALOG, { ...ctx, isFinal: true }, new Rng(3), 3);
    expect(finals.map((c) => c.round.type)).toEqual(['final', 'final']);
    const firstRound = selectRoundCandidates(
      playlist,
      CATALOG,
      { ...ctx, roundIndex: 0, previousType: null, used: new Set() },
      new Rng(3),
      4,
    );
    expect(firstRound.every((c) => c.round.type === 'race')).toBe(true);
    expect(firstRound).toHaveLength(3);
  });
});

describe('RoundVote', () => {
  const base = {
    seed: 77,
    roundIndex: 1,
    isFinal: false,
    candidates: candidates(['surv-a', 'logic-a', 'hunt-a']),
    seconds: 8,
    baseGap: 8,
  };

  it('accepts one ballot per voter, allows changes and ignores bad ballots', () => {
    const v = new RoundVote({ ...base, voters: [{ id: 0, isBot: false }] });
    expect(v.cast(0, 1)).toBe('accepted');
    expect(v.cast(0, 1)).toBe('unchanged');
    expect(v.cast(0, 2)).toBe('changed');
    expect(v.counts()).toEqual([0, 0, 1]);
    expect(v.cast(9, 0)).toBe('ineligible');
    expect(v.cast(0, 3)).toBe('invalid');
    expect(v.cast(0, -1)).toBe('invalid');
    expect(v.cast(0, 0.5)).toBe('invalid');
    expect(v.ballotOf(0)).toBe(2);
    v.close();
    expect(v.cast(0, 0)).toBe('closed');
    expect(v.result!.roundId).toBe(v.options[2]!.round.id);
    expect(v.result!.reason).toBe('votes');
  });

  it('breaks ties with the seed, the same way every time', () => {
    const voters = [
      { id: 0, isBot: false },
      { id: 1, isBot: false },
    ];
    const winners = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      const decide = () => {
        const v = new RoundVote({ ...base, seed, voters });
        v.cast(0, 0);
        v.cast(1, 1);
        v.close();
        return v.result!;
      };
      const a = decide();
      expect(a.reason).toBe('tie');
      expect([0, 1]).toContain(a.winner);
      expect(decide()).toEqual(a);
      winners.add(a.roundId);
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  it('falls back to a seeded pick when nobody votes', () => {
    const picks = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      const v = new RoundVote({ ...base, seed, voters: [{ id: 0, isBot: false }] });
      v.close();
      expect(v.result!.reason).toBe('noVotes');
      expect(v.result!.counts).toEqual([0, 0, 0]);
      const again = new RoundVote({ ...base, seed, voters: [{ id: 0, isBot: false }] });
      again.close();
      expect(again.result).toEqual(v.result);
      picks.add(v.result!.roundId);
    }
    expect(picks.size).toBe(3);
  });

  it('bots vote on a seeded schedule, but a human vote outweighs all of them', () => {
    const voters = [
      { id: 0, isBot: false },
      ...Array.from({ length: 39 }, (_, i) => ({ id: i + 1, isBot: true })),
    ];
    const v = new RoundVote({ ...base, voters });
    expect(v.snapshot().botsDiscounted).toBe(true);
    v.advance(base.baseGap * 0.05);
    expect(v.snapshot().voted).toBe(0);
    v.advance(base.baseGap * 0.6);
    expect(v.snapshot().voted).toBe(39);
    // Whatever the bots liked, the human's pick wins.
    const least = v.counts().indexOf(Math.min(...v.counts()));
    v.cast(0, least);
    v.close();
    expect(v.result!.winner).toBe(least);
    // Same seed, same bot ballots.
    const w = new RoundVote({ ...base, voters });
    w.advance(10);
    expect(w.result!.counts.slice()).toEqual(
      (() => {
        const c = v.result!.counts.slice();
        c[least] = c[least]! - 1;
        return c;
      })(),
    );
  });

  it('lets bots decide an all-bot show, weighted by the candidates', () => {
    const voters = Array.from({ length: 200 }, (_, i) => ({ id: i, isBot: true }));
    const v = new RoundVote({
      ...base,
      candidates: [
        { round: CATALOG.get('surv-a')!, weight: 8 },
        { round: CATALOG.get('logic-a')!, weight: 1 },
      ],
      voters,
    });
    expect(v.snapshot().botsDiscounted).toBe(false);
    v.close();
    const heavy = v.options.findIndex((c) => c.round.id === 'surv-a');
    expect(v.result!.counts[heavy]!).toBeGreaterThan(150);
    expect(v.result!.roundId).toBe('surv-a');
  });

  it('closes early once every connected human voted, never before the minimum', () => {
    const v = new RoundVote({
      ...base,
      voters: [
        { id: 0, isBot: false },
        { id: 1, isBot: false },
        { id: 2, isBot: true },
      ],
    });
    v.cast(0, 0);
    v.setConnected(1, false);
    expect(v.advance(1).overshoot).toBe(-1);
    expect(v.closed).toBe(false);
    v.advance(VOTE_MIN_OPEN_SECONDS - 1);
    expect(v.closed).toBe(true);
    // The disconnected human kept no ballot; the bot cast its pre-rolled one at the close.
    expect(v.result!.counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('waits the full window for a connected human, and only the base gap with none', () => {
    const waiting = new RoundVote({ ...base, seconds: 12, voters: [{ id: 0, isBot: false }] });
    waiting.advance(11.9);
    expect(waiting.closed).toBe(false);
    waiting.advance(0.2);
    expect(waiting.closed).toBe(true);

    const idle = new RoundVote({ ...base, seconds: 12, baseGap: 5, voters: [{ id: 0, isBot: false }] });
    idle.setConnected(0, false);
    idle.advance(4.9);
    expect(idle.closed).toBe(false);
    idle.advance(0.2);
    expect(idle.closed).toBe(true);
  });

  it('forgets voters who leave the show', () => {
    const v = new RoundVote({
      ...base,
      voters: [
        { id: 0, isBot: false },
        { id: 1, isBot: false },
      ],
    });
    v.cast(0, 0);
    v.cast(1, 1);
    expect(v.remove(1)).toBe(true);
    expect(v.cast(1, 1)).toBe('ineligible');
    v.close();
    expect(v.result!.winner).toBe(0);
  });
});

describe('ShowDirector voting', () => {
  it('changes nothing when voting is off', () => {
    const plain = run({ seed: 9 });
    const off = run({ seed: 9, voting: false });
    const flagOffPlaylist = run({
      seed: 9,
      voting: true,
      playlist: { ...PLAYLIST, voting: { enabled: false } },
    });
    expect(JSON.stringify(off.summary)).toBe(JSON.stringify(plain.summary));
    expect(JSON.stringify(flagOffPlaylist.summary)).toBe(JSON.stringify(plain.summary));
    expect(ofType(plain.events, 'voteOpen')).toHaveLength(0);
    expect(ofType(plain.events, 'roundSelected').every((x) => !x.e.byVote)).toBe(true);
  });

  it('votes on every round but the first and the final, and plays the winner', () => {
    const { events, infos, summary } = run({
      seed: 11,
      voting: true,
      onVote: (d, e) => {
        expect(d.canVote(0)).toBe(true);
        expect(d.castVote(0, e.vote.roundIndex, e.vote.options.length - 1)).toBe('accepted');
      },
    });
    expect(summary).not.toBeNull();
    const opens = ofType(events, 'voteOpen');
    const closes = ofType(events, 'voteClosed');
    expect(opens.length).toBe(infos.length - 2);
    expect(opens.map((o) => o.e.vote.roundIndex)).toEqual(infos.slice(1, -1).map((i) => i.roundIndex));
    for (const o of opens) {
      expect(o.e.vote.isFinal).toBe(false);
      expect(o.e.vote.options).toHaveLength(3);
    }
    for (const [k, c] of closes.entries()) {
      const open = opens[k]!.e.vote;
      expect(c.e.result!.roundId).toBe(open.options[open.options.length - 1]);
      expect(infos[open.roundIndex]!.round.id).toBe(c.e.result!.roundId);
    }
    const selected = ofType(events, 'roundSelected');
    expect(selected.map((s) => s.e.byVote)).toEqual(infos.map((_, i) => i > 0 && i < infos.length - 1));
    expect(infos.at(-1)!.round.type).toBe('final');
  });

  it('votes on the final only when the playlist opts in', () => {
    const { events, infos } = run({
      seed: 11,
      voting: true,
      playlist: { ...PLAYLIST, voting: { finals: true } },
    });
    const opens = ofType(events, 'voteOpen');
    expect(opens.at(-1)!.e.vote.isFinal).toBe(true);
    expect(opens.at(-1)!.e.vote.options.every((id) => id.startsWith('final'))).toBe(true);
    expect(ofType(events, 'roundSelected').at(-1)!.e.byVote).toBe(true);
    expect(infos.at(-1)!.isFinal).toBe(true);
  });

  it('is deterministic for a seed and the same ballots', () => {
    const vote = (d: ShowDirector, e: Extract<ShowEvent, { type: 'voteOpen' }>) =>
      d.castVote(0, e.vote.roundIndex, e.vote.roundIndex % e.vote.options.length);
    const a = run({ seed: 21, voting: true, humans: 3, onVote: vote });
    const b = run({ seed: 21, voting: true, humans: 3, onVote: vote });
    expect(JSON.stringify(a.events.map((x) => x.e))).toBe(JSON.stringify(b.events.map((x) => x.e)));
    expect(JSON.stringify(a.summary)).toBe(JSON.stringify(b.summary));
  });

  it('never lets eliminated players or spectators vote', () => {
    const { events, summary } = run({
      seed: 5,
      voting: true,
      humans: 30,
      onVote: (d, e) => {
        const alive = new Set(d.current().alive);
        for (let id = 0; id < 30; id++) {
          const r = d.castVote(id, e.vote.roundIndex, 0);
          expect(r).toBe(alive.has(id) ? 'accepted' : 'ineligible');
        }
        expect(d.castVote(0, e.vote.roundIndex + 1, 0)).toBe('closed');
      },
    });
    expect(summary).not.toBeNull();
    expect(ofType(events, 'voteOpen').length).toBeGreaterThan(0);
  });

  it('folds the vote into RESULTS + TRANSITION, stretching only for a longer ballot', () => {
    const gaps = (r: ReturnType<typeof run>) => {
      const out: number[] = [];
      let resultsAt = -1;
      for (const { at, e } of r.events) {
        if (e.type === 'roundPhase' && e.phase === RoundPhase.Results) resultsAt = at;
        if (e.type === 'roundSelected' && resultsAt >= 0) out.push(at - resultsAt);
      }
      return out;
    };
    const humans = 4;
    const voteNow = (d: ShowDirector, e: Extract<ShowEvent, { type: 'voteOpen' }>) => {
      for (let id = 0; id < humans; id++) d.castVote(id, e.vote.roundIndex, 0);
    };
    const anyHuman = (d: ShowDirector) => [0, 1, 2, 3].some((id) => d.canVote(id));
    const plain = gaps(run({ seed: 3, humans }));
    const voted = gaps(run({ seed: 3, humans, voting: true, onVote: voteNow }));
    const silent = gaps(run({ seed: 3, humans, voting: true }));
    for (const g of [...plain, ...voted, ...silent]) expect(g).toBeCloseTo(8, 0);

    const long = { ...PLAYLIST, voting: { seconds: 12 } };
    const humanCanVote: boolean[] = [];
    const longSilent = gaps(
      run({ seed: 3, humans, voting: true, playlist: long, onVote: (d) => humanCanVote.push(anyHuman(d)) }),
    );
    const longVoted = gaps(run({ seed: 3, humans, voting: true, playlist: long, onVote: voteNow }));
    // A ballot waits the full 12 s for humans who never vote, but not for an
    // all-bot electorate (every human was knocked out); the final has no ballot.
    expect(humanCanVote).toContain(true);
    humanCanVote.forEach((can, i) => expect(longSilent[i]!).toBeCloseTo(can ? 12 : 8, 0));
    expect(longSilent.at(-1)!).toBeCloseTo(8, 0);
    // Voting promptly gives the time back.
    for (const g of longVoted) expect(g).toBeCloseTo(8, 0);
  });

  it('keeps a disconnected voter’s ballot and drops a leaver’s', () => {
    const tallies: number[] = [];
    const r = run({
      seed: 13,
      voting: true,
      humans: 2,
      onVote: (d, e) => {
        if (e.vote.roundIndex !== 1) return;
        const alive = d.current().alive;
        const voters = [0, 1].filter((id) => alive.includes(id));
        for (const id of voters) d.castVote(id, 1, 0);
        const before = d.currentVote()!.counts[0]!;
        d.onPlayerConnection(voters[0]!, false);
        expect(d.currentVote()!.counts[0]).toBe(before);
        d.onPlayerConnection(voters[0]!, true);
        expect(d.ballotOf(voters[0]!)).toBe(0);
        d.onPlayerLeft(voters[0]!);
        tallies.push(before, d.currentVote()!.counts[0]!);
      },
    });
    expect(r.summary).not.toBeNull();
    expect(tallies[1]).toBe(tallies[0]! - 1);
  });

  it('calls off the ballot when the show ends during it', () => {
    const r = run({
      seed: 17,
      n: 6,
      humans: 6,
      voting: true,
      playlist: { ...PLAYLIST, minRounds: 4, maxRounds: 5, finalAtOrBelow: 2 },
      onVote: (d) => {
        for (const id of d.current().alive.slice(1)) d.onPlayerLeft(id);
      },
    });
    const closed = ofType(r.events, 'voteClosed');
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[0]!.e.result).toBeNull();
    expect(r.director.current().showPhase).toBe(ShowPhase.Ended);
  });
});

describe('offline show voting', () => {
  it('runs a real offline show where the local player votes every ballot', async () => {
    const R = await loadRapier();
    const rounds = ['race-a', 'surv-a', 'logic-a', 'hunt-a', 'final-a'].map((id) =>
      createTestArenaRound({
        ...CATALOG.get(id)!,
        id,
        duration: { seconds: 20, overtimeSeconds: 0 },
      }),
    );
    const show = createOfflineShow({
      R,
      deps: { createController: createSimpleController, obstacles: testObstacleModules() },
      playlist: {
        id: 'offline-vote',
        name: 'Offline vote',
        minRounds: 3,
        maxRounds: 4,
        finalAtOrBelow: 3,
        pool: rounds.map((r) => ({ roundId: r.id })),
      },
      rounds,
      seed: 31,
      humanName: 'You',
      players: 10,
      voting: true,
      timings: { preShow: 0.5, introFlyover: 0.5, rulesCard: 0.5, results: 1, transition: 0.5, victory: 0.5 },
    });
    const picks: string[] = [];
    const played: string[] = [];
    show.director.on((e) => {
      if (e.type === 'voteOpen' && show.director.canVote(show.humanId)) {
        const last = e.vote.options.length - 1;
        expect(show.director.castVote(show.humanId, e.vote.roundIndex, last)).toBe('accepted');
        picks.push(e.vote.options[last]!);
      }
      if (e.type === 'roundSelected' && e.byVote) played.push(e.roundId);
    });
    for (let i = 0; i < 60 * 60 * 5 && show.director.current().showPhase !== ShowPhase.Ended; i++)
      show.advance(1 / 60);
    expect(show.director.current().showPhase).toBe(ShowPhase.Ended);
    expect(played.length).toBeGreaterThan(0);
    // Each ballot the human cast decided the next round (offline the human outweighs the bots).
    expect(played.slice(0, picks.length)).toEqual(picks.slice(0, played.length));
    show.dispose();
  }, 60_000);
});
