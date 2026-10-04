import { RoundPhase, ShowPhase, type RoundPhaseId } from '@tumble/shared';
import {
  PlayerRoundStatus,
  createMatchSim,
  createSimpleController,
  testObstacleModules,
} from '@tumble/sim/match';
import { ShowDirector, type ShowParticipant } from '@tumble/sim/show';
import { describe, expect, it } from 'vitest';
import { loadRapier } from '@tumble/sim';
import { ROUNDS, getRound, roundCatalog, showRoundCatalog } from '../src/rounds/index.ts';
import { MUTATOR_IDS } from '@tumble/sim/mutators';
import { ShowPlaylistSchema } from '@tumble/sim/show/schema';
import { DUOS, PLANNED_ROUND_IDS, PLANNED_ROUNDS, PLAYLISTS, getPlaylist } from '../src/shows/index.ts';

describe('playlist schedules', () => {
  it('bundle only well-formed windows (end after start)', () => {
    for (const p of PLAYLISTS) {
      if (p.startsAt && p.endsAt) expect(Date.parse(p.endsAt), p.id).toBeGreaterThan(Date.parse(p.startsAt));
      expect(typeof p.featured).toBe('boolean');
    }
  });

  it('accept ISO instants with offsets and reject anything else', () => {
    const base = { id: 'x', name: 'X', pool: [{ roundId: 'tilt-town' }] };
    expect(ShowPlaylistSchema.safeParse({ ...base, endsAt: '2026-12-01T00:00:00Z' }).success).toBe(true);
    expect(ShowPlaylistSchema.safeParse({ ...base, startsAt: '2026-12-01T00:00:00+02:00' }).success).toBe(
      true,
    );
    expect(ShowPlaylistSchema.safeParse({ ...base, endsAt: 'next tuesday' }).success).toBe(false);
  });
});

describe('playlists', () => {
  it('validate and cover all 20 planned rounds', () => {
    expect(PLAYLISTS.map((p) => p.id)).toEqual([
      'main-show',
      'duos',
      'squads',
      'chaos-mode',
      'ranked',
      'first-show',
    ]);
    expect(PLANNED_ROUND_IDS).toHaveLength(20);
    const main = getPlaylist('main-show')!;
    expect(main.pool.map((r) => r.roundId).sort()).toEqual([...PLANNED_ROUND_IDS].sort());
    expect(getPlaylist('duos')!.partySize).toBe(DUOS.partySize);
    for (const p of PLAYLISTS) {
      for (const r of p.pool) expect(PLANNED_ROUND_IDS).toContain(r.roundId);
      expect(p.pool.some((r) => PLANNED_ROUND_IDS.indexOf(r.roundId) >= 16)).toBe(true);
    }
    const first = getPlaylist('first-show')!;
    expect(first.botSkillMix.clumsy).toBeGreaterThan(first.botSkillMix.sharp);
    expect(getPlaylist('ranked')!.botsAllowed).toBe(false);
  });

  it('ranked has no team rounds and needs 24 humans (SHOWS.md §4.5)', () => {
    const ranked = getPlaylist('ranked')!;
    expect(ranked.minPlayers).toBe(24);
    expect(ranked.mutators).toEqual([]);
    const ids = ranked.pool.map((r) => r.roundId);
    for (const team of PLANNED_ROUNDS.team) expect(ids).not.toContain(team);
    expect(ids).toContain('tail-chase');
    expect(ids).toContain('pattern-panic');
    for (const f of PLANNED_ROUNDS.final) expect(ids).toContain(f);
  });

  it('only Chaos Mode carries mutators, and every one is known to the sim', () => {
    for (const p of PLAYLISTS) {
      if (p.id === 'chaos-mode') expect(p.mutators.length).toBeGreaterThanOrEqual(5);
      else expect(p.mutators).toEqual([]);
    }
    for (const m of getPlaylist('chaos-mode')!.mutators) expect(MUTATOR_IDS).toContain(m.id);
  });

  it('ranked shows never select a team round', () => {
    const ranked = getPlaylist('ranked')!;
    const types = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const director = new ShowDirector({
        seed,
        playlist: ranked,
        rounds: roundCatalog(),
        participants: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `P${i}`, isBot: false })),
        host: {
          startRound(info) {
            types.add(info.round.type);
            expect(info.mutatorId).toBeNull();
            let phase: RoundPhaseId = RoundPhase.Loading;
            const target = info.qualifyTarget ?? Math.ceil(info.players.length / 2);
            const players = new Map(
              info.players.map((p, i) => [
                p.id,
                {
                  status: (i < target ? PlayerRoundStatus.Qualified : PlayerRoundStatus.Eliminated) as 1 | 2,
                  score: 0,
                  progress: 0,
                  place: i + 1,
                },
              ]),
            );
            return {
              setPhase: (p) => void (phase = p),
              getStatus: () => ({ phase, finished: phase >= RoundPhase.Playing, players }),
              dispose() {},
            };
          },
        },
      });
      director.on((e) => {
        if (e.type === 'roundSelected') for (let i = 0; i < 40; i++) director.onPlayerLoaded(i);
      });
      for (let i = 0; i < 5000 && director.current().showPhase !== ShowPhase.Ended; i++) director.tick(0.5);
    }
    expect(types.has('team')).toBe(false);
    expect(types.size).toBeGreaterThan(1);
  });
});

describe('round registry', () => {
  it('validates every round and exposes lookups', () => {
    expect(ROUNDS.length).toBeGreaterThan(0);
    const catalog = roundCatalog();
    expect(catalog.size).toBe(ROUNDS.length);
    expect(getRound('test-arena')?.botNav.length).toBeGreaterThan(0);
    expect(getRound('nope')).toBeUndefined();
    expect(showRoundCatalog().size).toBeGreaterThan(0);
  });

  it('runs a whole show over the registry with whatever rounds exist', () => {
    const participants: ShowParticipant[] = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `P${i}`,
      isBot: true,
    }));
    let finishedRounds = 0;
    const director = new ShowDirector({
      seed: 5,
      playlist: getPlaylist('main-show')!,
      rounds: showRoundCatalog(),
      participants,
      host: {
        startRound(info) {
          let phase: RoundPhaseId = RoundPhase.Loading;
          const players = new Map(
            info.players.map((p, i) => [
              p.id,
              { status: 0 as 0 | 1 | 2 | 3, score: 0, progress: 0, place: 0, idx: i },
            ]),
          );
          const target =
            info.qualifyTarget ?? Math.ceil(info.players.length * info.round.qualification.ratio);
          return {
            setPhase(p) {
              phase = p;
              if (p === RoundPhase.Playing) {
                for (const e of players.values()) {
                  e.status = e.idx < target ? PlayerRoundStatus.Qualified : PlayerRoundStatus.Eliminated;
                  e.place = e.idx + 1;
                }
                finishedRounds++;
              }
            },
            getStatus: () => ({ phase, finished: phase >= RoundPhase.Playing, players }),
            dispose() {},
          };
        },
      },
    });
    for (let i = 0; i < 5000 && director.current().showPhase !== ShowPhase.Ended; i++) director.tick(0.25);
    expect(director.current().showPhase).toBe(ShowPhase.Ended);
    expect(director.summary()?.winner).not.toBeNull();
    expect(finishedRounds).toBeGreaterThanOrEqual(2);
  });
});

describe('test arena', () => {
  it('builds in a match sim and bots finish it', async () => {
    const R = await loadRapier();
    const round = getRound('test-arena')!;
    const sim = createMatchSim(
      {
        R,
        round,
        seed: 3,
        stage: 0,
        players: Array.from({ length: 10 }, (_, i) => ({
          id: i,
          name: `B${i}`,
          isBot: true,
          team: -1,
          botSkill: 'sharp' as const,
        })),
        mode: 'offline',
        qualifyTarget: 8,
      },
      { createController: createSimpleController, obstacles: testObstacleModules() },
    );
    sim.setPhase(RoundPhase.Countdown);
    for (let i = 0; i < 180; i++) sim.step();
    sim.setPhase(RoundPhase.Playing, 0);
    for (let i = 0; i < round.duration.seconds * 60 && !sim.getStatus().finished; i++) sim.step();
    expect(sim.getStatus().qualifiedCount).toBe(8);
    sim.dispose();
  });
});
