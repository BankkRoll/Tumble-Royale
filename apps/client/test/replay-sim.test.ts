/**
 * End to end on the real sim: a 40-bot offline round is recorded through the
 * same path the show uses (OfflineRoundSource → LiveRecording → library),
 * saved and reloaded as a file, then played back through ReplayRoundSource on
 * its own replay sim. Checks positions and replicated obstacle states against
 * the live run, that the live sim is never touched, and measures real
 * recording sizes.
 */
import { describe, expect, it } from 'vitest';
import { getRound } from '@tumble/content/rounds';
import { RoundPhase, SIM_DT, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createTumblerController } from '@tumble/sim/character';
import { createMatchSim, type MatchDeps, type MatchPlayerInfo, type MatchSimHandle } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { decodeReplayFile, encodeReplayFile } from '../src/game/replay/format.ts';
import { ReplayLibrary } from '../src/game/replay/library.ts';
import { LiveRecording } from '../src/game/replay/live.ts';
import { ReplayRoundSource, createReplaySim } from '../src/game/replay/source.ts';
import { ReplayTimeline, createCursor } from '../src/game/replay/timeline.ts';
import { OfflineRoundSource, createPlayerSample } from '../src/game/round/source.ts';

const deps: MatchDeps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };
const SEED = 4242;

interface Recorded {
  sim: MatchSimHandle;
  round: RoundDefinition;
  tl: ReplayTimeline;
  fileBytes: number;
  seconds: number;
  /** Player positions around a few round times (keyed by ms of round time), from the live sim. */
  truth: Map<number, Map<number, { x: number; y: number; z: number }>>;
  /** Replicated obstacle states at those times. */
  netTruth: Map<number, Map<string, number[]>>;
}

async function recordRound(R: Rapier, roundId: string, seconds: number, checkAt: number[]): Promise<Recorded> {
  const round = getRound(roundId);
  if (!round) throw new Error(`no round ${roundId}`);
  const players: MatchPlayerInfo[] = Array.from({ length: 40 }, (_, id) => ({
    id,
    name: `Bot ${id}`,
    isBot: true,
    team: -1,
    botSkill: id % 3 === 0 ? 'sharp' : 'average',
  }));
  const sim = createMatchSim({ R, round, seed: SEED, stage: 1, players, mode: 'offline' }, deps);
  const library = new ReplayLibrary();
  const live = new LiveRecording(library, () => undefined);
  live.showStarted();
  const source = new OfflineRoundSource(sim, players, 0, () => true);
  sim.setPhase(RoundPhase.Countdown);
  source.capture();
  live.roundStarted(
    {
      showName: 'Test Show',
      online: false,
      roundIndex: 1,
      isFinal: false,
      round,
      seed: SEED,
      stage: 1,
      qualifyTarget: sim.qualifyTarget,
      localId: 0,
      players: players.map((p) => ({ ...p, loadout: { colors: ['#fff', '#000', '#f0f'], pattern: 'plain' } })),
    },
    source,
    { cameraMode: 'follow', cameraTarget: 0, rig: { yaw: 0.5, pitch: 0.3 } },
  );
  const truth = new Map<number, Map<number, { x: number; y: number; z: number }>>();
  const netTruth = new Map<number, Map<string, number[]>>();
  const sample = createPlayerSample();
  const steps = Math.round((seconds + 3) / SIM_DT);
  for (let i = 0; i < steps; i++) {
    if (sim.phase === RoundPhase.Countdown && sim.time >= 0) sim.setPhase(RoundPhase.Playing);
    sim.step();
    source.capture();
    source.alpha = 1;
    // One render frame per step (60 fps): sample exactly what would be drawn.
    live.frame();
    for (const e of sim.events.events) live.event(e);
    sim.events.events.length = 0;
    const t = source.renderTime();
    for (const at of checkAt) {
      if (Math.abs(t - at) < 0.1) {
        const m = new Map<number, { x: number; y: number; z: number }>();
        for (const p of players) if (source.sample(p.id, sample)) m.set(p.id, { x: sample.x, y: sample.y, z: sample.z });
        truth.set(Math.round(t * 1000), m);
        netTruth.set(Math.round(t * 1000), new Map([...sim.getObstacleNetStates()].map(([k, v]) => [k, v.slice()])));
      }
    }
  }
  live.roundEnded({ qualified: [], eliminated: [] });
  const entry = library.list()[0];
  if (!entry) throw new Error('nothing recorded');
  const file = encodeReplayFile(entry.data);
  return {
    sim,
    round,
    tl: new ReplayTimeline(decodeReplayFile(file)),
    fileBytes: file.length,
    seconds: seconds + 3,
    truth,
    netTruth,
  };
}

describe('replays on the real sim', () => {
  for (const [roundId, seconds] of [
    ['gumdrop-gauntlet', 30],
    ['egg-heist', 20],
    ['tile-panic', 20],
  ] as const) {
    it(`records ${roundId} and plays it back on a private sim`, async () => {
      const R = await loadRapier();
      const checkAt = [2, 9.5, seconds - 1];
      const rec = await recordRound(R, roundId, seconds, checkAt);
      const { sim, tl } = rec;
      const perMinute = (rec.fileBytes / rec.seconds) * 60;
      console.info(
        `[replay size] ${roundId}: ${(rec.fileBytes / 1024).toFixed(0)} KB for ${rec.seconds.toFixed(0)} s x 40 bots ` +
          `→ ~${((perMinute * 5) / 1024 / 1024).toFixed(2)} MB per 5 min; ${tl.header.obstacles.length} stateful obstacles, ` +
          `${tl.header.eventCount} events`,
      );
      expect(perMinute * 5).toBeLessThan(5 * 1024 * 1024);

      const liveTime = sim.time;
      const replaySim = createReplaySim(R, deps, rec.round, tl);
      expect(replaySim.world).not.toBe(sim.world);
      expect(replaySim.obstacleRuntimes.map((o) => o.instance.id)).toEqual(sim.obstacleRuntimes.map((o) => o.instance.id));
      const src = new ReplayRoundSource(replaySim, tl);
      const out = createPlayerSample();
      for (const at of checkAt) {
        // Seek to the recorded sample nearest `at`: obstacle states are exact there.
        const c = tl.locate(at - tl.header.startTime, createCursor());
        const rel = tl.times[c.a < 0.5 ? c.i : c.j] as number;
        const key = Math.round((tl.header.startTime + rel) * 1000);
        src.setTime(rel);
        expect(src.renderTime()).toBeCloseTo(key / 1000, 2);
        expect(replaySim.time).toBeCloseTo(key / 1000, 2);
        const want = rec.truth.get(key);
        expect(want?.size).toBeGreaterThan(0);
        let compared = 0;
        for (const [id, p] of want ?? []) {
          if (!src.sample(id, out)) continue;
          // Interpolation between 20 Hz samples of running Tumblers: within a few cm.
          expect(Math.hypot(out.x - p.x, out.y - p.y, out.z - p.z)).toBeLessThan(0.25);
          compared++;
        }
        expect(compared).toBeGreaterThan(30);
        const nets = rec.netTruth.get(key) ?? new Map<string, number[]>();
        const got = replaySim.getObstacleNetStates();
        for (const [id, values] of nets) {
          const replayed = got.get(id);
          expect(replayed?.length).toBe(values.length);
          // Props are floats (quantised to 1/100); everything else is exact integers.
          for (let i = 0; i < values.length; i++)
            expect(Math.abs((replayed?.[i] ?? NaN) - (values[i] as number)), `${id}[${i}]`).toBeLessThan(0.06);
        }
      }
      // Seeking backwards works too, and nothing reached the live sim.
      src.setTime(0);
      expect(replaySim.time).toBeCloseTo(tl.header.startTime, 6);
      expect(sim.time).toBe(liveTime);
      src.dispose();
      expect(src.alive).toBe(false);
      sim.dispose();
    });
  }
});
