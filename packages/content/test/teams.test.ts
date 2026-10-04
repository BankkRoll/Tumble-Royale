/**
 * Team balance in every team round at every field size it can be played
 * with (its `players.min` up to 100), for solo shows, duos and squads, with
 * full lobbies and with the ragged parties a show leaves after eliminations:
 *
 * - every team gets players and sizes differ by at most one;
 * - parties stay on one team unless whole parties cannot be balanced, and
 *   then only as many seats move as the imbalance needs;
 * - the match sim keeps the director's assignment.
 */
import { MAX_PLAYERS, Rng, ShowPhase, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createMatchSim, createSimpleController, type MatchPlayerInfo } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { ShowDirector, type ShowParticipant } from '@tumble/sim/show';
import { beforeAll, describe, expect, it } from 'vitest';
import { showRoundCatalog } from '../src/rounds/index.ts';

const teamRounds = [...showRoundCatalog().values()].filter((r) => r.qualification.mode === 'teamScore');

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

/** The first round's match players when `round` opens a show for `seats`. */
function firstRoundPlayers(
  round: RoundDefinition,
  seats: readonly ShowParticipant[],
  partySize: number,
  seed: number,
): MatchPlayerInfo[] {
  let players: MatchPlayerInfo[] | null = null;
  const director = new ShowDirector({
    seed,
    playlist: {
      id: 'teams',
      name: 'Teams',
      partySize,
      firstRoundType: 'team',
      minRounds: 3,
      maxRounds: 5,
      pool: [{ roundId: round.id }],
    },
    rounds: [round],
    participants: [...seats],
    host: {
      startRound(info) {
        players ??= info.players;
        return {
          setPhase() {},
          getStatus: () => ({ phase: 0, finished: false, players: new Map() }),
          dispose() {},
        };
      },
    },
  });
  for (let i = 0; i < 100 && !players && director.current().showPhase !== ShowPhase.Ended; i++)
    director.tick(1);
  expect(players, `${round.id}: the show never started its first round`).not.toBeNull();
  return players!;
}

/** `n` seats from a full lobby of parties, as the survivors of earlier rounds. */
function seats(n: number, partySize: number, ragged: boolean, seed: number): ShowParticipant[] {
  const lobby = Array.from({ length: MAX_PLAYERS }, (_, id) => ({
    id,
    name: `P${id}`,
    isBot: id % 5 !== 0,
    partyId: Math.floor(id / partySize),
  }));
  if (!ragged) return lobby.slice(0, n);
  new Rng(seed).shuffle(lobby);
  return lobby.slice(0, n).sort((a, b) => a.id - b.id);
}

/** Team sizes with whole parties placed largest first on the smallest team. */
function intactSizes(partySizes: number[], teamCount: number): number[] {
  const counts = new Array<number>(teamCount).fill(0);
  for (const size of [...partySizes].sort((a, b) => b - a)) {
    let best = 0;
    for (let t = 1; t < teamCount; t++) if (counts[t]! < counts[best]!) best = t;
    counts[best]! += size;
  }
  return counts;
}

function checkTeams(
  round: RoundDefinition,
  players: MatchPlayerInfo[],
  partySize: number,
  where: string,
): void {
  const teamCount = Math.max(2, Math.min(4, round.qualification.teams || 2));
  const sizes = new Array<number>(teamCount).fill(0);
  for (const p of players) {
    expect(p.team, `${where}: seat ${p.id} has no team`).toBeGreaterThanOrEqual(0);
    expect(p.team).toBeLessThan(teamCount);
    sizes[p.team]!++;
  }
  expect(Math.min(...sizes), `${where}: empty team ${sizes}`).toBeGreaterThan(0);
  expect(Math.max(...sizes) - Math.min(...sizes), `${where}: sizes ${sizes}`).toBeLessThanOrEqual(1);
  if (partySize <= 1) return;

  const byParty = new Map<number, number[]>();
  for (const p of players) {
    const list = byParty.get(p.partyId!) ?? new Array<number>(teamCount).fill(0);
    list[p.team]!++;
    byParty.set(p.partyId!, list);
  }
  // Seats sitting away from their party's main team.
  let moved = 0;
  for (const perTeam of byParty.values()) moved += perTeam.reduce((a, b) => a + b, 0) - Math.max(...perTeam);
  const intact = intactSizes(
    [...byParty.values()].map((perTeam) => perTeam.reduce((a, b) => a + b, 0)),
    teamCount,
  );
  // Fewest single-seat moves that bring whole-party teams within one of each other.
  const ceil = Math.ceil(players.length / teamCount);
  const floor = Math.floor(players.length / teamCount);
  const needed = Math.max(
    intact.reduce((s, c) => s + Math.max(0, c - ceil), 0),
    intact.reduce((s, c) => s + Math.max(0, floor - c), 0),
  );
  if (Math.max(...intact) - Math.min(...intact) <= 1)
    expect(moved, `${where}: split a party needlessly`).toBe(0);
  else expect(moved, `${where}: moved ${moved} seats where ${needed} would do`).toBeLessThanOrEqual(needed);
}

describe('uneven team rounds', () => {
  for (const round of teamRounds) {
    for (const partySize of [1, 2, 4]) {
      it(`${round.id}: ${round.players.min}–${MAX_PLAYERS} players, party size ${partySize}`, () => {
        for (let n = round.players.min; n <= MAX_PLAYERS; n++) {
          for (const ragged of partySize > 1 ? [false, true] : [false]) {
            const where = `${round.id} n=${n} party ${partySize}${ragged ? ' ragged' : ''}`;
            const players = firstRoundPlayers(round, seats(n, partySize, ragged, n), partySize, n);
            expect(players).toHaveLength(n);
            checkTeams(round, players, partySize, where);
          }
        }
      });
    }
  }

  it('the match sim keeps the balanced assignment (fullest and smallest squads fields)', () => {
    for (const round of teamRounds) {
      for (const n of [round.players.min, MAX_PLAYERS]) {
        const players = firstRoundPlayers(round, seats(n, 4, true, 3), 4, 3);
        const sim = createMatchSim(
          { R, round, seed: 3, stage: 0, players, mode: 'offline' },
          { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
        );
        const st = sim.getStatus();
        for (const p of players) expect(st.players.get(p.id)?.team, `${round.id} n=${n}`).toBe(p.team);
        sim.dispose();
      }
    }
  });
});
