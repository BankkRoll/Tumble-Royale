/**
 * Duos and squads: the whole winning party shares the Crown. Runs real duo
 * shows through the simulation's ShowDirector (with a scripted round driver)
 * and checks every teammate of the Crown grabber counts as a winner on the
 * client — victory screen, Crown, stats and rewards all read `wonShow`.
 */
import { Rng, RoundPhase, type RoundDefinition, type RoundPhaseId } from '@tumble/shared';
import { PlayerRoundStatus, createTestArenaRound, type RoundStatus } from '@tumble/sim/match';
import { computeQualifyTarget } from '@tumble/sim/rounds';
import {
  ShowDirector,
  type RoundDriver,
  type RoundStartInfo,
  type ShowPlaylistInput,
  type ShowSummary,
} from '@tumble/sim/show';
import { ShowPhase } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { crownedIds, sessionSummaryFromShow, wonShow } from '../src/game/show/crown.ts';

const ROUNDS: RoundDefinition[] = [
  ['gumdrop-gauntlet', 'race', 'finish'],
  ['tilt-town', 'race', 'finish'],
  ['spin-cycle', 'survival', 'survive'],
  ['crown-climb', 'final', 'crownGrab'],
].map(([id, type, mode]) =>
  createTestArenaRound({
    id,
    name: id,
    type: type as RoundDefinition['type'],
    players: { min: 2, max: 60, ideal: 20 },
    qualification: {
      mode: mode as RoundDefinition['qualification']['mode'],
      ratio: 0.6,
      teams: 0,
      teamsEliminated: 1,
    },
  }),
);

/** Qualifies a seeded random quota a few seconds into each round. */
class ScriptedDriver implements RoundDriver {
  phase: RoundPhaseId = RoundPhase.Loading;
  private elapsed = 0;
  private finished = false;
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
    if (this.phase !== RoundPhase.Playing || this.finished) return;
    this.elapsed += dt;
    if (this.elapsed < 3) return;
    const ids = this.info.players.map((p) => p.id);
    this.rng.shuffle(ids);
    const target = computeQualifyTarget(this.info.round, ids.length, this.info.qualifyTarget);
    let out = ids.length;
    ids.forEach((id, i) => {
      const e = this.players.get(id)!;
      if (i < target) Object.assign(e, { status: PlayerRoundStatus.Qualified, place: i + 1 });
      else Object.assign(e, { status: PlayerRoundStatus.Eliminated, place: out-- });
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

  dispose(): void {}
}

function runShow(seed: number, partySize: number): ShowSummary {
  const playlist: ShowPlaylistInput = {
    id: partySize > 1 ? 'duos' : 'solo',
    name: partySize > 1 ? 'Duos' : 'Solo',
    partySize,
    pool: ROUNDS.map((r) => ({ roundId: r.id, weight: 1 })),
  };
  const rng = new Rng(seed);
  let driver: ScriptedDriver | null = null;
  const director = new ShowDirector({
    seed,
    playlist,
    rounds: ROUNDS,
    participants: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `P${i}`,
      isBot: i > 0,
      partyId: Math.floor(i / partySize),
    })),
    host: {
      startRound(info) {
        driver = new ScriptedDriver(info, rng);
        return driver;
      },
    },
  });
  director.on((e) => {
    if (e.type === 'roundSelected') director.onPlayerLoaded(0);
  });
  for (let i = 0; i < 20000 && director.current().showPhase !== ShowPhase.Ended; i++) {
    director.tick(0.1);
    (driver as ScriptedDriver | null)?.advance(0.1);
  }
  return director.summary() as ShowSummary;
}

const mateOf = (id: number): number => (id % 2 === 0 ? id + 1 : id - 1);

describe('duo and squad crowns', () => {
  it('crowns both partners of a duo show on the client', () => {
    let checked = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const summary = sessionSummaryFromShow(runShow(seed, 2));
      if (summary.winnerId === null) continue;
      const grabber = summary.winnerId;
      const partner = mateOf(grabber);
      expect([...crownedIds(summary)].sort((a, b) => a - b)).toEqual(
        [grabber, partner].sort((a, b) => a - b),
      );
      expect(wonShow(summary, grabber)).toBe(true);
      // The partner who did not grab the Crown still wins: victory screen, Crown, stats, rewards.
      expect(wonShow(summary, partner)).toBe(true);
      expect(summary.placements.get(partner)).toBe(1);
      const stranger = [...summary.placements.keys()].find((id) => id !== grabber && id !== partner)!;
      expect(wonShow(summary, stranger)).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keeps a single winner in solo shows', () => {
    const summary = sessionSummaryFromShow(runShow(3, 1));
    expect(summary.winnerId).not.toBeNull();
    expect(crownedIds(summary)).toEqual([summary.winnerId]);
  });

  it('falls back to the headline winner when a producer sends no list', () => {
    const base = { rounds: [], placements: new Map<number, number>() };
    expect(wonShow({ ...base, winnerId: 7, winnerIds: [] }, 7)).toBe(true);
    expect(wonShow({ ...base, winnerId: null, winnerIds: [] }, 7)).toBe(false);
    expect(crownedIds({ winnerId: 2, winnerIds: [2, 3] })).toEqual([2, 3]);
  });
});
