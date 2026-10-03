import { RoundPhase, ShowPhase, type RoundPhaseId } from '@tumble/shared';
import { PlayerRoundStatus, createMatchSim, createSimpleController, testObstacleModules } from '@tumble/sim/match';
import { ShowDirector, type ShowParticipant } from '@tumble/sim/show';
import { describe, expect, it } from 'vitest';
import { loadRapier } from '@tumble/sim';
import { ROUNDS, getRound, roundCatalog, showRoundCatalog } from '../src/rounds/index.ts';
import { DUOS, PLANNED_ROUND_IDS, PLAYLISTS, getPlaylist } from '../src/shows/index.ts';

describe('playlists', () => {
  it('validate and cover all 20 planned rounds', () => {
    expect(PLAYLISTS.map((p) => p.id)).toEqual(['main-show', 'duos', 'squads', 'chaos-mode', 'ranked', 'first-show']);
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
    const participants: ShowParticipant[] = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `P${i}`, isBot: true }));
    let finishedRounds = 0;
    const director = new ShowDirector({
      seed: 5,
      playlist: getPlaylist('main-show')!,
      rounds: showRoundCatalog(),
      participants,
      host: {
        startRound(info) {
          let phase: RoundPhaseId = RoundPhase.Loading;
          const players = new Map(info.players.map((p, i) => [p.id, { status: 0 as 0 | 1 | 2 | 3, score: 0, progress: 0, place: 0, idx: i }]));
          const target = info.qualifyTarget ?? Math.ceil(info.players.length * info.round.qualification.ratio);
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
        players: Array.from({ length: 10 }, (_, i) => ({ id: i, name: `B${i}`, isBot: true, team: -1, botSkill: 'sharp' as const })),
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
