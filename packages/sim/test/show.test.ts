import { Rng, RoundPhase, ShowPhase, type RoundDefinition, type RoundPhaseId, type RoundType } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { loadRapier } from '../src/index.ts';
import { PlayerRoundStatus, createSimpleController, createTestArenaRound, testObstacleModules, type RoundStatus } from '../src/match/index.ts';
import { computeQualifyTarget } from '../src/rounds/index.ts';
import {
  ShowDirector,
  createOfflineShow,
  selectRound,
  type RoundDriver,
  type RoundStartInfo,
  type ShowEvent,
  type ShowParticipant,
  type ShowPlaylistInput,
  type ShowSummary,
} from '../src/show/index.ts';

type Mode = RoundDefinition['qualification']['mode'];

const PLANNED: [string, RoundType, Mode, number, number, number][] = [
  ['gumdrop-gauntlet', 'race', 'finish', 10, 60, 40],
  ['conveyor-chaos', 'race', 'finish', 10, 60, 40],
  ['tilt-town', 'race', 'finish', 10, 60, 30],
  ['slip-n-spiral', 'race', 'finish', 10, 60, 30],
  ['hammer-highway', 'race', 'finish', 8, 60, 25],
  ['wind-tunnel-peaks', 'race', 'finish', 8, 40, 20],
  ['cannonball-canyon', 'race', 'finish', 8, 60, 30],
  ['spin-cycle', 'survival', 'survive', 6, 60, 25],
  ['tile-panic', 'survival', 'survive', 6, 60, 20],
  ['rising-goo-tower', 'survival', 'survive', 6, 40, 20],
  ['jump-rope-royale', 'survival', 'survive', 6, 40, 15],
  ['egg-heist', 'team', 'teamScore', 9, 40, 24],
  ['bounce-ball-blitz', 'team', 'teamScore', 8, 40, 20],
  ['paint-the-plaza', 'team', 'teamScore', 9, 40, 24],
  ['tail-chase', 'hunt', 'holdItem', 6, 40, 20],
  ['pattern-panic', 'logic', 'logicSurvive', 4, 40, 15],
  ['crown-climb', 'final', 'crownGrab', 2, 15, 8],
  ['last-tumbler-standing', 'final', 'lastStanding', 2, 15, 8],
  ['spin-cycle-finale', 'final', 'lastStanding', 2, 15, 8],
  ['goo-peak-final', 'final', 'lastStanding', 2, 15, 8],
];

const CATALOG: RoundDefinition[] = PLANNED.map(([id, type, mode, min, max, ideal]) =>
  createTestArenaRound({
    id,
    name: id,
    type,
    players: { min, max, ideal },
    qualification: { mode, ratio: type === 'race' ? 0.65 : 0.55, teams: mode === 'teamScore' ? 3 : 0, teamsEliminated: 1 },
  }),
);

const MAIN: ShowPlaylistInput = {
  id: 'main',
  name: 'Main Show',
  pool: PLANNED.map(([roundId]) => ({ roundId, weight: 1 })),
};

/** Decides fates instantly-ish with a seeded random subset of the computed quota. */
class FakeDriver implements RoundDriver {
  phase: RoundPhaseId = RoundPhase.Loading;
  private elapsed = 0;
  private readonly players = new Map<number, { status: 0 | 1 | 2 | 3; score: number; progress: number; place: number }>();
  private finished = false;

  constructor(
    private readonly info: RoundStartInfo,
    private readonly rng: Rng,
    readonly log: { phases: RoundPhaseId[]; disposed: boolean },
  ) {
    for (const p of info.players) this.players.set(p.id, { status: 0, score: 0, progress: 0, place: 0 });
  }

  setPhase(phase: RoundPhaseId): void {
    this.phase = phase;
    this.log.phases.push(phase);
  }

  /** Called by the test loop with the director's dt. */
  advance(dt: number): void {
    if (this.phase !== RoundPhase.Playing || this.finished) return;
    this.elapsed += dt;
    if (this.elapsed < 5) return;
    const ids = this.info.players.map((p) => p.id).filter((id) => this.players.get(id)!.status === 0);
    const target = computeQualifyTarget(this.info.round, this.info.players.length, this.info.qualifyTarget);
    this.rng.shuffle(ids);
    let q = 0;
    let e = this.info.players.length;
    ids.forEach((id, i) => {
      const entry = this.players.get(id)!;
      if (i < target) Object.assign(entry, { status: PlayerRoundStatus.Qualified, place: ++q });
      else Object.assign(entry, { status: PlayerRoundStatus.Eliminated, place: e-- });
    });
    this.finished = true;
  }

  forfeit(id: number): void {
    const e = this.players.get(id);
    if (e && e.status === 0) Object.assign(e, { status: PlayerRoundStatus.Eliminated, place: 999 });
  }

  getStatus(): Pick<RoundStatus, 'phase' | 'finished' | 'players'> {
    return { phase: this.phase, finished: this.finished, players: this.players };
  }

  dispose(): void {
    this.log.disposed = true;
  }
}

function participants(n: number, partySize = 1): ShowParticipant[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `P${i}`, isBot: i > 0, partyId: Math.floor(i / partySize) }));
}

function runShow(seed: number, opts: { playlist?: ShowPlaylistInput; rounds?: RoundDefinition[]; n?: number; partySize?: number } = {}) {
  const drivers: FakeDriver[] = [];
  const infos: RoundStartInfo[] = [];
  const events: ShowEvent[] = [];
  const rng = new Rng(seed ^ 0xfa4e);
  const director = new ShowDirector({
    seed,
    playlist: opts.playlist ?? MAIN,
    rounds: opts.rounds ?? CATALOG,
    participants: participants(opts.n ?? 40, opts.partySize),
    host: {
      startRound(info) {
        infos.push(info);
        const d = new FakeDriver(info, rng, { phases: [], disposed: false });
        drivers.push(d);
        return d;
      },
    },
  });
  director.on((e) => {
    events.push(e);
    if (e.type === 'roundSelected') director.onPlayerLoaded(0);
  });
  const dt = 0.1;
  for (let i = 0; i < 20000 && director.current().showPhase !== ShowPhase.Ended; i++) {
    director.tick(dt);
    drivers.at(-1)?.advance(dt);
  }
  return { director, drivers, infos, events, summary: director.summary() as ShowSummary };
}

describe('ShowDirector', () => {
  it('runs a full 40-player show from PreShow to Ended', () => {
    const { director, infos, events, summary, drivers } = runShow(1234);
    expect(director.current().showPhase).toBe(ShowPhase.Ended);
    const showPhases = events.filter((e) => e.type === 'showPhase').map((e) => (e as { phase: number }).phase);
    expect(showPhases).toContain(ShowPhase.InRound);
    expect(showPhases).toContain(ShowPhase.BetweenRounds);
    expect(showPhases.at(-2)).toBe(ShowPhase.Victory);
    expect(showPhases.at(-1)).toBe(ShowPhase.Ended);

    expect(infos.length).toBeGreaterThanOrEqual(3);
    expect(infos.length).toBeLessThanOrEqual(5);
    expect(infos[0]!.round.type).toBe('race');
    expect(infos.at(-1)!.round.type).toBe('final');
    expect(infos.at(-1)!.isFinal).toBe(true);
    const ids = infos.map((i) => i.round.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < infos.length; i++) expect(infos[i]!.round.type).not.toBe(infos[i - 1]!.round.type);

    // Survivors shrink round over round, roughly per the qualification curve.
    const counts = infos.map((i) => i.players.length);
    expect(counts[0]).toBe(40);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThan(counts[i - 1]!);
      expect(counts[i]!).toBeGreaterThanOrEqual(Math.floor(counts[i - 1]! * 0.4));
    }
    // Only survivors enter the next round.
    for (let i = 1; i < infos.length; i++) {
      const prev = new Set(summary.rounds[i - 1]!.qualified);
      for (const p of infos[i]!.players) expect(prev.has(p.id)).toBe(true);
    }
    // Every round driver went through the lifecycle in order and was disposed.
    for (const d of drivers) {
      expect(d.log.phases.slice(0, 6)).toEqual([
        RoundPhase.Loading,
        RoundPhase.IntroFlyover,
        RoundPhase.RulesCard,
        RoundPhase.Countdown,
        RoundPhase.Playing,
        RoundPhase.RoundEnd,
      ]);
      expect(d.log.disposed).toBe(true);
    }

    expect(summary.winner).not.toBeNull();
    expect(summary.winners).toEqual([summary.winner]);
    expect(summary.placements).toHaveLength(40);
    expect(summary.placements[0]!.playerId).toBe(summary.winner);
    expect(new Set(summary.placements.map((p) => p.place)).size).toBe(40);
    expect(summary.rounds).toHaveLength(infos.length);
    // Eliminated players placed by round: later rounds rank better.
    const byId = new Map(summary.placements.map((p) => [p.playerId, p]));
    const r0out = summary.rounds[0]!.eliminated;
    const r1out = summary.rounds[1]!.eliminated;
    expect(byId.get(r1out[0]!)!.place).toBeLessThan(byId.get(r0out[0]!)!.place);
  });

  it('is deterministic for a seed and varies across seeds', () => {
    const a = runShow(42).summary;
    const b = runShow(42).summary;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const roundsFor = (seed: number) => runShow(seed).infos.map((i) => i.round.id).join(',');
    const seen = new Set([1, 2, 3, 4, 5, 6].map(roundsFor));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never repeats rounds or types across many seeds', () => {
    for (let seed = 100; seed < 130; seed++) {
      const { infos } = runShow(seed);
      expect(infos[0]!.round.type).toBe('race');
      expect(infos.at(-1)!.round.type).toBe('final');
      const ids = infos.map((i) => i.round.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (let i = 1; i < infos.length; i++) expect(infos[i]!.round.type).not.toBe(infos[i - 1]!.round.type);
      for (const info of infos) {
        expect(info.players.length).toBeGreaterThanOrEqual(info.round.players.min);
        expect(info.players.length).toBeLessThanOrEqual(info.round.players.max);
      }
    }
  });

  it('keeps parties on one team in team rounds and shares the crown in duos', () => {
    const duos: ShowPlaylistInput = { ...MAIN, id: 'duos', name: 'Duos', partySize: 2 };
    for (let seed = 1; seed < 6; seed++) {
      const { infos, summary } = runShow(seed, { playlist: duos, partySize: 2 });
      for (const info of infos.filter((i) => i.round.qualification.mode === 'teamScore')) {
        const teamOf = new Map(info.players.map((p) => [p.id, p.team]));
        for (const p of info.players) {
          const mate = p.id % 2 === 0 ? p.id + 1 : p.id - 1;
          if (teamOf.has(mate)) expect(teamOf.get(mate)).toBe(p.team);
        }
      }
      if (summary.winner !== null) {
        const w = summary.winner;
        const mate = w % 2 === 0 ? w + 1 : w - 1;
        expect(summary.winners.sort()).toEqual([w, mate].sort());
        expect(summary.placements.filter((p) => p.place === 1)).toHaveLength(2);
      }
    }
  });

  it('works with whatever rounds exist (single race in the registry)', () => {
    const only = [createTestArenaRound({ id: 'gumdrop-gauntlet' })];
    const { infos, summary } = runShow(9, { rounds: only, n: 20 });
    expect(infos.length).toBeGreaterThanOrEqual(2);
    expect(infos.at(-1)!.qualifyTarget).toBe(1);
    expect(summary.winner).not.toBeNull();
  });

  it('eliminates players who leave and late loaders', () => {
    const drivers: FakeDriver[] = [];
    const director = new ShowDirector({
      seed: 3,
      playlist: MAIN,
      rounds: CATALOG,
      participants: [
        { id: 0, name: 'A', isBot: false },
        { id: 1, name: 'B', isBot: false },
        ...participants(12).slice(2),
      ],
      timings: { preShow: 1 },
      host: {
        startRound(info) {
          const d = new FakeDriver(info, new Rng(1), { phases: [], disposed: false });
          drivers.push(d);
          return d;
        },
      },
    });
    director.onPlayerLeft(5);
    expect(director.current().alive).not.toContain(5);
    director.tick(1.01);
    director.onPlayerLoaded(0);
    // Player 1 never acks: after the 12 s loading cap they are forfeited.
    director.tick(12.5);
    expect(director.current().roundPhase).toBe(RoundPhase.IntroFlyover);
    expect(drivers[0]!.getStatus().players.get(1)!.status).toBe(PlayerRoundStatus.Eliminated);
  });

  it('selector relaxes constraints instead of stalling', () => {
    const races = [createTestArenaRound({ id: 'a' }), createTestArenaRound({ id: 'b' })];
    const playlist = { ...MAIN, pool: [{ roundId: 'a', weight: 1 }, { roundId: 'b', weight: 1 }, { roundId: 'missing', weight: 5 }] };
    const parsed = new ShowDirector({ seed: 1, playlist, rounds: races, participants: participants(4), host: { startRound: () => { throw new Error('unused'); } } }).playlist;
    const catalog = new Map(races.map((r) => [r.id, r]));
    const rng = new Rng(1);
    const pick = selectRound(parsed, catalog, { roundIndex: 1, players: 10, isFinal: false, previousType: 'race', used: new Set(['a']) }, rng);
    expect(pick?.id).toBe('b');
    const final = selectRound(parsed, catalog, { roundIndex: 2, players: 4, isFinal: true, previousType: 'race', used: new Set(['a', 'b']) }, rng);
    expect(final).not.toBeNull();
  });
});

describe('offline show', () => {
  it('runs a real all-bot show end to end with match sims', async () => {
    const R = await loadRapier();
    const rounds = [
      createTestArenaRound({ id: 'gumdrop-gauntlet', duration: { seconds: 45, overtimeSeconds: 0 } }),
      createTestArenaRound({ id: 'conveyor-chaos', duration: { seconds: 45, overtimeSeconds: 0 } }),
    ];
    const show = createOfflineShow({
      R,
      deps: { createController: createSimpleController, obstacles: testObstacleModules() },
      playlist: { id: 'test', name: 'Test', minRounds: 2, maxRounds: 3, finalAtOrBelow: 6, pool: rounds.map((r) => ({ roundId: r.id })) },
      rounds,
      seed: 8,
      humanName: null,
      players: 12,
      timings: { preShow: 0.5, introFlyover: 0.5, rulesCard: 0.5, results: 0.5, transition: 0.5, victory: 0.5 },
    });
    expect(new Set(show.participants.map((p) => p.name)).size).toBe(12);
    const phases: number[] = [];
    show.director.on((e) => {
      if (e.type === 'showPhase') phases.push(e.phase);
    });
    for (let i = 0; i < 60 * 60 * 5 && show.director.current().showPhase !== ShowPhase.Ended; i++) show.advance(1 / 60);
    const summary = show.director.summary();
    expect(show.director.current().showPhase).toBe(ShowPhase.Ended);
    expect(summary?.winner).not.toBeNull();
    expect(summary?.rounds.length).toBeGreaterThanOrEqual(2);
    expect(summary!.rounds[0]!.qualified.length).toBe(8);
    expect(show.match).toBeNull();
    show.dispose();
  }, 60_000);
});
