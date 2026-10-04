/**
 * Every show round played to its end by a full field of seeded bots under the
 * real Rapier match sim and Tumbler controller (offline authority mode: the
 * rules, character and bot brains the server runs):
 *
 * - the round decides every fate on its own, before its timer plus overtime
 *   runs out (the director's safety grace never has to rescue it);
 * - qualification counts match the round's target: races fill their quota,
 *   survival rounds stop at (or survive above) theirs, hunts qualify exactly
 *   the holders (or exactly the quota by score), team rounds knock out whole
 *   teams, finals crown exactly one;
 * - in races no bot is stuck for good: everyone still running moves more
 *   than a couple of metres over the last stretch (bots that keep falling
 *   back to a checkpoint are logged, since they are still trying).
 *
 * A full field is 100 bots (15 in finals) for up to 270 s of match time per
 * round, a few minutes in all, so the suite is opt-in:
 *
 *   TUMBLE_SLOW=1 pnpm --filter @tumble/content exec vitest run test/rounds-complete.test.ts
 *
 * The default run plays every final (15 bots), and the team rounds and
 * score-target hunts at their minimum field, which covers the single-winner,
 * whole-team and points-race paths cheaply.
 */
import { RoundPhase, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import {
  PlayerRoundStatus,
  createMatchSim,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '@tumble/sim/match';
import { createTumblerController } from '@tumble/sim/character';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { computeQualifyTarget } from '@tumble/sim/rounds';
import { beforeAll, describe, expect, it } from 'vitest';
import { showRoundCatalog } from '../src/rounds/index.ts';

const SLOW = process.env.TUMBLE_SLOW === '1';
const STEPS_PER_SECOND = 60;
/** Countdown steps before PLAYING, as the director runs them. */
const COUNTDOWN_STEPS = 3 * STEPS_PER_SECOND;
/**
 * Course progress a running race bot gains over the final window; a bot that
 * keeps falling back to its checkpoint gains nothing yet is still playing,
 * so this is reported, not asserted.
 */
const PROGRESS_EPS = 0.002;
const PROGRESS_WINDOW_SECONDS = 45;
/**
 * A running race bot that never strays further than this from where the
 * final window found it is stuck for good: wedged against geometry or idling
 * in a nav dead end.
 */
const PINNED_METRES = 2;

const deps = { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY };
const rounds = [...showRoundCatalog().values()];

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

function bots(n: number): MatchPlayerInfo[] {
  const skills = ['clumsy', 'average', 'sharp'] as const;
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `Bot${i}`,
    isBot: true,
    // The sim balances teams itself when every seat arrives unassigned.
    team: -1,
    botSkill: skills[i % 3],
  }));
}

/** What one played round looked like. */
interface Played {
  round: RoundDefinition;
  /** Variation the seed picked, or null. */
  variation: string | null;
  entrants: number;
  target: number;
  finished: boolean;
  /** Match seconds when the rules finished (or when the run gave up). */
  endTime: number;
  qualified: number;
  eliminated: number;
  /** Per team: [members, qualified] for team rounds. */
  teams: Map<number, [number, number]>;
  teamScores: number[];
  /** Qualified players not holding the hunt item. */
  qualifiedWithoutItem: number;
  /** Race bots still running whose progress froze over the final window. */
  frozen: number[];
  /** Race bots still running that never left a {@link PINNED_METRES} circle over the final window (`id@x,z`). */
  pinned: string[];
  /** Furthest course progress any player reached (0–1). */
  bestProgress: number;
  timeline: string;
}

/**
 * Plays `round` (authored variation) with `n` bots from countdown to the end of the rules, giving
 * up one second past timer + overtime.
 */
function play(round: RoundDefinition, n: number, seed: number): Played {
  const sim: MatchSimHandle = createMatchSim(
    {
      R,
      round,
      seed,
      stage: 0,
      players: bots(n),
      mode: 'offline',
      // The authored layout: harder variations (Cannonball Canyon's rogue-wave surf blows rock-hoppers
      // off, 46 of 65 by the buzzer) are a challenge bots are not built to time.
      ...(round.variations[0] ? { variationId: round.variations[0].id } : {}),
    },
    deps,
  );
  expect(sim.warnings, round.id).toEqual([]);
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < COUNTDOWN_STEPS; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);

  const limitSeconds = round.duration.seconds + round.duration.overtimeSeconds + 1;
  const limitSteps = Math.round(limitSeconds * STEPS_PER_SECOND);
  const windowSteps = PROGRESS_WINDOW_SECONDS * STEPS_PER_SECOND;
  /** Progress of every player, one entry per elapsed window. */
  const history: Map<number, number>[] = [];
  /** Per player, feet positions sampled once a second over the last window. */
  const trail = new Map<number, { x: number; z: number }[]>();
  const timeline: string[] = [];
  for (let i = 1; i <= limitSteps && !sim.getStatus().finished; i++) {
    sim.step();
    if (i % STEPS_PER_SECOND === 0) {
      for (const [id] of sim.getStatus().players) {
        const body = sim.controller(id)?.body;
        if (!body) continue;
        const t = body.translation();
        const list = trail.get(id) ?? [];
        list.push({ x: t.x, z: t.z });
        if (list.length > PROGRESS_WINDOW_SECONDS) list.shift();
        trail.set(id, list);
      }
    }
    if (i % windowSteps === 0) {
      const snap = new Map<number, number>();
      for (const [id, p] of sim.getStatus().players) snap.set(id, p.progress);
      history.push(snap);
    }
    if (i % (30 * STEPS_PER_SECOND) === 0) {
      const st = sim.getStatus();
      timeline.push(`${i / STEPS_PER_SECOND}s:q${st.qualifiedCount}/e${st.eliminatedCount}`);
    }
  }

  const st = sim.getStatus();
  const teams = new Map<number, [number, number]>();
  let qualifiedWithoutItem = 0;
  for (const [, p] of st.players) {
    if (p.team !== undefined && p.team >= 0) {
      const t = teams.get(p.team) ?? [0, 0];
      t[0]++;
      if (p.status === PlayerRoundStatus.Qualified) t[1]++;
      teams.set(p.team, t);
    }
    if (p.status === PlayerRoundStatus.Qualified && p.hasItem === false) qualifiedWithoutItem++;
  }

  let bestProgress = 0;
  for (const [, p] of st.players) bestProgress = Math.max(bestProgress, p.progress);
  const frozen: number[] = [];
  const pinned: string[] = [];
  if (round.qualification.mode === 'finish' && history.length >= 2) {
    // Compare the last full window against the one before it, for bots that never finished.
    const before = history[history.length - 2]!;
    const after = history[history.length - 1]!;
    for (const [id, p] of st.players) {
      if (p.status === PlayerRoundStatus.Qualified) continue;
      const a = before.get(id) ?? 0;
      const b = after.get(id) ?? 0;
      // A bot on the final stretch can idle at the line once the quota is nearly full.
      if (b - a < PROGRESS_EPS && b < 0.97) frozen.push(id);
      const list = trail.get(id) ?? [];
      if (list.length < PROGRESS_WINDOW_SECONDS) continue;
      let reach = 0;
      for (const q of list) reach = Math.max(reach, Math.hypot(q.x - list[0]!.x, q.z - list[0]!.z));
      if (reach < PINNED_METRES) pinned.push(`${id}@${list[0]!.x.toFixed(0)},${list[0]!.z.toFixed(0)}`);
    }
  }

  const played: Played = {
    round,
    entrants: n,
    variation: sim.variationId,
    target: sim.qualifyTarget,
    finished: st.finished,
    endTime: st.time,
    qualified: st.qualifiedCount,
    eliminated: st.eliminatedCount,
    teams,
    teamScores: [...st.teamScores],
    qualifiedWithoutItem,
    frozen,
    pinned,
    bestProgress,
    timeline: timeline.join(' '),
  };
  sim.dispose();
  return played;
}

/** Logs a one-line summary, then asserts the round-type contract. */
function check(p: Played): void {
  const { round } = p;
  const where = `${round.id}${p.variation ? `/${p.variation}` : ''} (${p.entrants} bots)`;
  const limit = round.duration.seconds + round.duration.overtimeSeconds;
  log(
    `${where}: ${p.finished ? 'finished' : 'TIMED OUT'} at ${p.endTime.toFixed(2)} s / ${limit} s, ` +
      `qualified ${p.qualified} (target ${p.target}), eliminated ${p.eliminated}, ` +
      `best progress ${p.bestProgress.toFixed(2)}` +
      (p.frozen.length ? `, no progress ${p.frozen.length}` : '') +
      (p.pinned.length ? `, pinned ${p.pinned.join(' ')}` : '') +
      (p.teamScores.length ? `, team scores ${p.teamScores.join('/')}` : '') +
      (p.timeline ? ` [${p.timeline}]` : ''),
  );
  expect(p.finished, `${where} never finished by ${limit} s`).toBe(true);
  // Match time is a running sum of 1/60 s steps, so the buzzer can land a step or two late.
  expect(p.endTime, `${where} ran past its timer + overtime`).toBeLessThanOrEqual(
    limit + 2 / STEPS_PER_SECOND + 1e-6,
  );
  expect(p.qualified + p.eliminated, `${where} left fates undecided`).toBe(p.entrants);
  expect(p.target).toBe(computeQualifyTarget(round, p.entrants));

  const mode = round.qualification.mode;
  if (round.type === 'final') {
    expect(p.qualified, `${where}: a final crowns exactly one`).toBe(1);
  } else if (mode === 'finish') {
    expect(p.qualified, `${where}: race quota`).toBe(p.target);
    expect(p.pinned, `${where}: bots pinned for the last ${PROGRESS_WINDOW_SECONDS} s`).toEqual([]);
  } else if (mode === 'survive' || mode === 'logicSurvive') {
    expect(p.qualified, `${where}: survivors`).toBeGreaterThan(0);
    if (p.endTime < round.duration.seconds - 1e-6) {
      // Ended early: survivors dropped to the quota (several falls in one step may undershoot it).
      expect(p.qualified, `${where}: early end overshoots the quota`).toBeLessThanOrEqual(p.target);
    } else {
      expect(p.qualified, `${where}: buzzer qualifies at least the quota`).toBeGreaterThanOrEqual(p.target);
    }
  } else if (mode === 'scoreTarget') {
    expect(p.qualified, `${where}: score-target quota`).toBe(p.target);
  } else if (mode === 'holdItem') {
    expect(p.qualified, `${where}: hunt qualifies the holders`).toBe(p.target);
    expect(p.qualifiedWithoutItem, `${where}: qualified without the item`).toBe(0);
  } else if (mode === 'teamScore') {
    const teamCount = Math.max(2, Math.min(4, round.qualification.teams || 2));
    expect(p.teams.size, `${where}: teams`).toBe(teamCount);
    expect(p.teamScores).toHaveLength(teamCount);
    const sizes = [...p.teams.values()].map(([members]) => members);
    expect(Math.max(...sizes) - Math.min(...sizes), `${where}: team sizes ${sizes}`).toBeLessThanOrEqual(1);
    let out = 0;
    for (const [team, [members, qualified]] of p.teams) {
      // A team qualifies or goes out as one.
      expect([0, members], `${where}: team ${team} split`).toContain(qualified);
      if (qualified === 0) out++;
    }
    expect(out, `${where}: teams eliminated`).toBe(Math.max(1, round.qualification.teamsEliminated));
  }
}

function log(line: string): void {
  process.stderr.write(`[rounds-complete] ${line}\n`);
}

describe('every round to completion with a full field of bots', () => {
  for (const round of rounds) {
    const n = round.players.max;
    it.runIf(SLOW)(`${round.id}: ${n} bots`, () => check(play(round, n, 101)), 900_000);
  }
});

describe('finals, team rounds and score-target hunts to completion (default run)', () => {
  for (const round of rounds) {
    const mode = round.qualification.mode;
    if (round.type !== 'final' && mode !== 'teamScore' && mode !== 'scoreTarget') continue;
    const n = round.type === 'final' ? round.players.max : round.players.min;
    it(`${round.id}: ${n} bots`, () => check(play(round, n, 7)), 300_000);
  }
});
