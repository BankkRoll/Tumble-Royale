/**
 * 100-player capacity: every show round admits a full lobby where it can be
 * drawn, puts every spawn slot of its largest field on solid ground (in every
 * variation, with team grids), and the playlists' qualify curves walk a full
 * lobby down to a final whose field the chosen final can hold.
 */
import { MAX_PLAYERS, RoundPhase, ShowPhase, type RoundDefinition, type RoundPhaseId } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { PlayerRoundStatus, createMatchSim, createSimpleController, spawnSlots } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { computeQualifyTarget } from '@tumble/sim/rounds';
import { ShowDirector, type RoundStartInfo } from '@tumble/sim/show';
import { beforeAll, describe, expect, it } from 'vitest';
import { showRoundCatalog } from '../src/rounds/index.ts';
import { PLAYLISTS } from '../src/shows/index.ts';

const deps = { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY };
const rounds = [...showRoundCatalog().values()];

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

/** Team index per seat the way the director balances them, or -1 for solo rounds. */
function teamsFor(round: RoundDefinition, n: number): number[] {
  if (round.type !== 'team') return Array.from({ length: n }, () => -1);
  const teams = Math.max(2, Math.min(4, round.qualification.teams || 2));
  return Array.from({ length: n }, (_, i) => i % teams);
}

describe('100-player rounds', () => {
  it('every non-final round admits a full lobby', () => {
    for (const r of rounds) {
      if (r.type === 'final') continue;
      expect(r.players.max, r.id).toBe(MAX_PLAYERS);
      expect(r.players.ideal, r.id).toBeLessThanOrEqual(r.players.max);
      expect(r.players.min, r.id).toBeLessThanOrEqual(r.players.ideal);
    }
  });

  for (const round of rounds) {
    it(`${round.id}: all ${round.players.max} spawn slots stand clear, on ground, in every variation`, () => {
      const variations = round.variations.length > 0 ? round.variations.map((v) => v.id) : [undefined];
      const slots = spawnSlots(round, 3, teamsFor(round, round.players.max));
      for (const variationId of variations) {
        // An empty match so rays only hit level colliders, never spawned capsules.
        const empty = createMatchSim(
          {
            R,
            round,
            seed: 3,
            stage: 0,
            players: [],
            mode: 'offline',
            ...(variationId ? { variationId } : {}),
          },
          deps,
        );
        // Scene queries see the colliders only after one step.
        empty.step();
        for (const s of slots) {
          // Centre plus eight probes inside the capsule footprint: a ray can slip down a tile gap.
          let hits = 0;
          for (let k = -1; k < 8; k++) {
            const dx = k < 0 ? 0 : 0.3 * Math.cos((k * Math.PI) / 4);
            const dz = k < 0 ? 0 : 0.3 * Math.sin((k * Math.PI) / 4);
            const ray = new R.Ray(
              { x: s.pos.x + dx, y: s.pos.y + 0.5, z: s.pos.z + dz },
              { x: 0, y: -1, z: 0 },
            );
            // Reaches 1 m below the feet: team grids may spill off a raised pad onto the floor.
            if (empty.world.castRay(ray, 1.5, true) !== null) hits++;
          }
          const where = `${variationId ?? 'base'}: spawn ${JSON.stringify(s.pos)}`;
          expect(hits, `${where} has no ground`).toBeGreaterThanOrEqual(5);
          // A slightly slimmed Tumbler capsule must not start inside level geometry or an obstacle.
          const body = new R.Capsule(0.45, 0.4);
          const centre = { x: s.pos.x, y: s.pos.y + 0.95, z: s.pos.z };
          const hit = empty.world.intersectionWithShape(
            centre,
            { x: 0, y: 0, z: 0, w: 1 },
            body,
            undefined,
            undefined,
            undefined,
            undefined,
            (c) => !c.isSensor(),
          );
          expect(hit, `${where} starts inside a collider`).toBeNull();
        }
        empty.dispose();
      }
    });
  }
});

/**
 * Plays the director with a stand-in round driver that qualifies exactly the
 * round's target (the same quota the real rules enforce), so thousands of
 * shows run in milliseconds.
 */
function playShow(playlistIndex: number, seed: number): RoundStartInfo[] {
  const playlist = PLAYLISTS[playlistIndex]!;
  const n = playlist.maxPlayers;
  const infos: RoundStartInfo[] = [];
  const director = new ShowDirector({
    seed,
    playlist,
    rounds: showRoundCatalog(),
    participants: Array.from({ length: n }, (_, i) => ({
      id: i,
      name: `P${i}`,
      isBot: !playlist.ranked,
      partyId: Math.floor(i / playlist.partySize),
    })),
    host: {
      startRound(info) {
        infos.push(info);
        let phase: RoundPhaseId = RoundPhase.Loading;
        const target = computeQualifyTarget(info.round, info.players.length, info.qualifyTarget);
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
    if (e.type === 'roundSelected') for (let i = 0; i < n; i++) director.onPlayerLoaded(i);
  });
  for (let i = 0; i < 10_000 && director.current().showPhase !== ShowPhase.Ended; i++) director.tick(0.5);
  expect(director.current().showPhase, `${playlist.id} seed ${seed}`).toBe(ShowPhase.Ended);
  return infos;
}

describe('100-player shows', () => {
  PLAYLISTS.forEach((playlist, index) => {
    it(`${playlist.id}: every round's field fits the round across 200 seeds`, () => {
      const finals: number[] = [];
      for (let seed = 1; seed <= 200; seed++) {
        const infos = playShow(index, seed);
        expect(infos[0]!.players.length).toBe(playlist.maxPlayers);
        for (const info of infos) {
          const n = info.players.length;
          const where = `${playlist.id} seed ${seed} round ${info.roundIndex} ${info.round.id}`;
          expect(n, where).toBeGreaterThanOrEqual(info.round.players.min);
          expect(n, where).toBeLessThanOrEqual(info.round.players.max);
        }
        const last = infos[infos.length - 1]!;
        expect(last.isFinal).toBe(true);
        finals.push(last.players.length);
      }
      // A final is a crowd you can read: never the whole lobby, never a lone Tumbler.
      expect(Math.max(...finals)).toBeLessThanOrEqual(
        Math.min(...rounds.filter((r) => r.type === 'final').map((r) => r.players.max)),
      );
      expect(Math.min(...finals)).toBeGreaterThanOrEqual(2);
    });
  });
});
