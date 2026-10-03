import { GRAVITY_Y, Rng, RoundPhase, ShowPhase, type RoundDefinition } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { Button, emptyInput, type CharacterFullState } from '../src/character/types.ts';
import { createTumblerController, DEFAULT_TUNING, resolveTuning } from '../src/character/index.ts';
import { hashFloats, loadRapier } from '../src/index.ts';
import {
  PlayerRoundStatus,
  clampRoundTimeScale,
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  scaleRoundTimer,
  testObstacleModules,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '../src/match/index.ts';
import {
  MUTATORS,
  MUTATOR_IDS,
  applyMutatorTuning,
  getMutator,
  mutatorWindAt,
  pickMutator,
} from '../src/mutators/index.ts';
import {
  ShowDirector,
  createOfflineShow,
  minimumShowSeats,
  type RoundDriver,
  type RoundStartInfo,
  type ShowPlaylistInput,
} from '../src/show/index.ts';

const realDeps = () => ({ createController: createTumblerController, obstacles: testObstacleModules() });

function humans(n: number): MatchPlayerInfo[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `P${i}`, isBot: false, team: -1 }));
}

function state(): CharacterFullState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
    prevButtons: 0,
    grabStamina: 0,
    grabTarget: -1,
    stunTimer: 0,
    ghostTimer: 0,
    emote: 0,
    flags: 0,
  };
}

function startPlaying(sim: MatchSimHandle): void {
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < 180; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
}

/** Runs `steps` fixed steps of scripted input and returns a hash of every player's state. */
async function runSim(
  mutatorId: string | null,
  steps: number,
  input: (step: number, id: number) => { moveX: number; moveZ: number; buttons: number },
  seed = 31,
  n = 6,
) {
  const R = await loadRapier();
  const sim = createMatchSim(
    { R, round: createTestArenaRound(), seed, stage: 0, players: humans(n), mode: 'authority', mutatorId },
    realDeps(),
  );
  startPlaying(sim);
  const inp = emptyInput();
  const s = state();
  let maxY = -Infinity;
  for (let step = 0; step < steps; step++) {
    for (let id = 0; id < n; id++) {
      Object.assign(inp, input(step, id), { yaw: 0, emote: 0 });
      sim.setInput(id, inp);
    }
    sim.step();
    sim.getPlayerState(0, s);
    maxY = Math.max(maxY, s.pos.y);
  }
  const values: number[] = [];
  const positions: { x: number; y: number; z: number }[] = [];
  for (let id = 0; id < n; id++) {
    sim.getPlayerState(id, s);
    values.push(s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.state);
    positions.push({ ...s.pos });
  }
  const result = { hash: hashFloats(values), positions, maxY, gravity: sim.world.gravity.y, sim };
  sim.dispose();
  return result;
}

describe('mutator catalogue', () => {
  it('has at least five data-only mutators with names and descriptions', () => {
    expect(MUTATOR_IDS.length).toBeGreaterThanOrEqual(5);
    for (const id of MUTATOR_IDS) {
      const m = MUTATORS[id]!;
      expect(m.id).toBe(id);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      // Plain data: survives a JSON round trip unchanged.
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    }
    expect(getMutator('nope')).toBeNull();
    expect(getMutator(null)).toBeNull();
    expect(getMutator('toString')).toBeNull();
  });

  it('scales tuning without touching the frozen defaults', () => {
    const t = applyMutatorTuning(resolveTuning(), getMutator('speed-demons'));
    expect(t.maxSpeed).toBeCloseTo(DEFAULT_TUNING.maxSpeed * 1.2);
    const slippery = applyMutatorTuning(resolveTuning(), getMutator('slippery-floors'));
    expect(slippery.surfaces.normal.decelMul).toBeLessThan(0.5);
    expect(DEFAULT_TUNING.surfaces.normal.decelMul).toBe(1);
    expect(resolveTuning().surfaces.normal.decelMul).toBe(1);
  });

  it('picks the same mutator for the same seed and varies across seeds', () => {
    const pool = MUTATOR_IDS.map((id) => ({ id, weight: 1 }));
    for (let seed = 0; seed < 50; seed++) expect(pickMutator(seed, pool)).toBe(pickMutator(seed, pool));
    const seen = new Set(Array.from({ length: 200 }, (_, seed) => pickMutator(seed * 7919, pool)));
    expect(seen.size).toBe(MUTATOR_IDS.length);
    expect(pickMutator(1, [])).toBeNull();
    expect(pickMutator(1, [{ id: 'unknown', weight: 5 }])).toBeNull();
    expect(
      pickMutator(1, [
        { id: 'unknown', weight: 5 },
        { id: 'gusty', weight: 1 },
      ]),
    ).toBe('gusty');
    expect(
      pickMutator(1, [
        { id: 'gusty', weight: 0 },
        { id: 'moon-bounce', weight: 1 },
      ]),
    ).toBe('moon-bounce');
  });

  it('blows gusts on a fixed, seeded schedule', () => {
    const wind = MUTATORS.gusty!.wind!;
    const out = { x: 0, z: 0 };
    expect(mutatorWindAt(wind, 5, wind.delay - 0.1, out)).toBe(false);
    expect(out).toEqual({ x: 0, z: 0 });
    expect(mutatorWindAt(wind, 5, wind.delay + wind.ramp + 0.1, out)).toBe(true);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(wind.accel, 5);
    expect(mutatorWindAt(wind, 5, wind.delay + wind.duration + 0.1, out)).toBe(false);
    const a = { x: 0, z: 0 };
    const b = { x: 0, z: 0 };
    mutatorWindAt(wind, 5, wind.delay + 1, a);
    mutatorWindAt(wind, 5, wind.delay + 1, b);
    expect(a).toEqual(b);
    mutatorWindAt(wind, 5, wind.delay + wind.period + 1, b);
    expect(b).not.toEqual(a);
  });
});

describe('mutators in the match sim', () => {
  const forwardHop = (step: number, id: number) => ({
    moveX: Math.sin(step * 0.05 + id) * 0.5,
    moveZ: 1,
    buttons: (step + id * 7) % 60 < 10 ? Button.Jump : 0,
  });

  it('is deterministic for every mutator: same seed and inputs, same result', async () => {
    for (const id of MUTATOR_IDS) {
      const a = await runSim(id, 480, forwardHop);
      const b = await runSim(id, 480, forwardHop);
      expect(a.hash, id).toBe(b.hash);
    }
  }, 60_000);

  it('rejects unknown ids with a warning instead of failing', async () => {
    const R = await loadRapier();
    const sim = createMatchSim(
      {
        R,
        round: createTestArenaRound(),
        seed: 1,
        stage: 0,
        players: humans(2),
        mode: 'authority',
        mutatorId: 'x',
      },
      realDeps(),
    );
    expect(sim.mutatorId).toBeNull();
    expect(sim.warnings.join()).toContain('unknown mutator');
    sim.dispose();
  });

  it('Moon Bounce lowers gravity and jumps go higher', async () => {
    const jump = (step: number) => ({ moveX: 0, moveZ: 0, buttons: step % 120 < 30 ? Button.Jump : 0 });
    const normal = await runSim(null, 240, jump);
    const moon = await runSim('moon-bounce', 240, jump);
    expect(normal.gravity).toBeCloseTo(GRAVITY_Y);
    expect(moon.gravity).toBeCloseTo(GRAVITY_Y * 0.5);
    expect(moon.maxY).toBeGreaterThan(normal.maxY + 0.5);
  }, 30_000);

  it('Mirror Mirror flips human strafing', async () => {
    const strafe = () => ({ moveX: 1, moveZ: 0, buttons: 0 });
    const normal = await runSim(null, 90, strafe, 3, 1);
    const mirrored = await runSim('mirror-mirror', 90, strafe, 3, 1);
    const spawnX = (await runSim(null, 0, strafe, 3, 1)).positions[0]!.x;
    const dn = normal.positions[0]!.x - spawnX;
    const dm = mirrored.positions[0]!.x - spawnX;
    expect(Math.abs(dn)).toBeGreaterThan(2);
    expect(Math.sign(dm)).toBe(-Math.sign(dn));
    expect(Math.abs(dm)).toBeCloseTo(Math.abs(dn), 1);
  }, 30_000);

  it('Speed Demons runs farther in the same time', async () => {
    const run = () => ({ moveX: 0, moveZ: 1, buttons: 0 });
    const normal = await runSim(null, 90, run, 3, 1);
    const fast = await runSim('speed-demons', 90, run, 3, 1);
    expect(fast.positions[0]!.z).toBeGreaterThan(normal.positions[0]!.z + 1);
  }, 30_000);

  it('Gusty pushes idle players around once the gusts start', async () => {
    const idle = () => ({ moveX: 0, moveZ: 0, buttons: 0 });
    const wind = MUTATORS.gusty!.wind!;
    const steps = Math.round((wind.delay + 2) * 60);
    const calm = await runSim(null, steps, idle, 3, 1);
    const gusty = await runSim('gusty', steps, idle, 3, 1);
    const d = Math.hypot(
      gusty.positions[0]!.x - calm.positions[0]!.x,
      gusty.positions[0]!.z - calm.positions[0]!.z,
    );
    expect(d).toBeGreaterThan(1);
  }, 30_000);
});

describe('round time scale', () => {
  it('clamps to 0.5–2 and treats junk as 1', () => {
    expect(clampRoundTimeScale(undefined)).toBe(1);
    expect(clampRoundTimeScale(Number.NaN)).toBe(1);
    expect(clampRoundTimeScale(0.1)).toBe(0.5);
    expect(clampRoundTimeScale(5)).toBe(2);
    expect(clampRoundTimeScale(1.5)).toBe(1.5);
  });

  it('scales the round timer and overtime in the sim', async () => {
    const R = await loadRapier();
    const round = createTestArenaRound({ duration: { seconds: 60, overtimeSeconds: 10 } });
    expect(scaleRoundTimer(round, 1)).toBe(round);
    const sim = createMatchSim(
      { R, round, seed: 1, stage: 0, players: humans(2), mode: 'authority', roundTimeScale: 1.5 },
      { createController: createSimpleController, obstacles: testObstacleModules() },
    );
    expect(sim.round.duration.seconds).toBe(90);
    expect(sim.round.duration.overtimeSeconds).toBe(15);
    expect(sim.getStatus().timeLeft).toBe(90);
    sim.dispose();
  });
});

// -----------------------------------------------------------------------------
// Director
// -----------------------------------------------------------------------------

const ROUNDS: RoundDefinition[] = [
  createTestArenaRound({ id: 'race-a', duration: { seconds: 30, overtimeSeconds: 0 } }),
  createTestArenaRound({ id: 'race-b', duration: { seconds: 30, overtimeSeconds: 0 } }),
  createTestArenaRound({
    id: 'final-a',
    type: 'final',
    players: { min: 2, max: 20, ideal: 8 },
    duration: { seconds: 30, overtimeSeconds: 0 },
  }),
];

const CHAOS: ShowPlaylistInput = {
  id: 'chaos',
  name: 'Chaos',
  minRounds: 2,
  maxRounds: 3,
  pool: ROUNDS.map((r) => ({ roundId: r.id })),
  mutators: MUTATOR_IDS.map((id) => ({ id, weight: 1 })),
};

/** Never finishes: lets the director's own PLAYING cut-off end each round. */
class StallDriver implements RoundDriver {
  phase: number = RoundPhase.Loading;
  readonly players = new Map<
    number,
    { status: 0 | 1 | 2 | 3; score: number; progress: number; place: number }
  >();
  constructor(info: RoundStartInfo) {
    // Everyone stays undecided, so the cut-off qualifies the whole field and the show goes on.
    info.players.forEach((p, i) =>
      this.players.set(p.id, { status: PlayerRoundStatus.Playing, score: 0, progress: 0, place: i + 1 }),
    );
  }
  setPhase(phase: number): void {
    this.phase = phase;
  }
  getStatus() {
    return { phase: this.phase as never, finished: false, players: this.players };
  }
  dispose(): void {}
}

function director(seed: number, extra: Partial<ConstructorParameters<typeof ShowDirector>[0]> = {}) {
  const infos: RoundStartInfo[] = [];
  const d = new ShowDirector({
    seed,
    playlist: CHAOS,
    rounds: ROUNDS,
    participants: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `P${i}`, isBot: true })),
    host: {
      startRound(info) {
        infos.push(info);
        return new StallDriver(info);
      },
    },
    timings: {
      preShow: 1,
      introFlyover: 1,
      rulesCard: 1,
      countdown: 1,
      results: 1,
      transition: 1,
      safetyGrace: 0,
    },
    ...extra,
  });
  return { d, infos };
}

describe('ShowDirector mutators and timer scale', () => {
  it('picks one seeded mutator per show and hands it to every round', () => {
    const { d, infos } = director(77);
    expect(d.mutatorId).not.toBeNull();
    expect(d.mutatorId).toBe(director(77).d.mutatorId);
    for (let i = 0; i < 400; i++) d.tick(1);
    expect(infos.length).toBeGreaterThanOrEqual(2);
    for (const info of infos) expect(info.mutatorId).toBe(d.mutatorId);
    expect(d.current().mutatorId).toBe(d.mutatorId);
  });

  it('adding mutators to a playlist does not change round selection', () => {
    const rounds = (playlist: ShowPlaylistInput) => {
      const { d, infos } = director(5, { playlist });
      for (let i = 0; i < 400; i++) d.tick(1);
      return infos.map((x) => x.round.id);
    };
    expect(rounds(CHAOS)).toEqual(rounds({ ...CHAOS, mutators: [] }));
  });

  it('has no mutator unless the playlist lists some, and honours a forced one', () => {
    expect(director(1, { playlist: { ...CHAOS, mutators: [] } }).d.mutatorId).toBeNull();
    expect(director(1, { mutatorId: 'gusty' }).d.mutatorId).toBe('gusty');
    expect(director(1, { mutatorId: null }).d.mutatorId).toBeNull();
  });

  it('scales its PLAYING cut-off with the round timer and forwards the scale', () => {
    const timeToSecondRound = (scale: number | undefined) => {
      const { d, infos } = director(9, scale === undefined ? {} : { roundTimeScale: scale });
      let t = 0;
      while (infos.length < 2 && t < 1000) {
        d.tick(0.5);
        t += 0.5;
      }
      return { t, info: infos[0]! };
    };
    const base = timeToSecondRound(undefined);
    const long = timeToSecondRound(2);
    const huge = timeToSecondRound(10);
    expect(base.info.roundTimeScale).toBe(1);
    expect(long.info.roundTimeScale).toBe(2);
    expect(huge.info.roundTimeScale).toBe(2);
    expect(long.t - base.t).toBeCloseTo(30, 0);
  });
});

describe('offline show options', () => {
  const playlist: ShowPlaylistInput = { ...CHAOS, maxPlayers: 30, botsAllowed: false, mutators: [] };
  const deps = { createController: createSimpleController, obstacles: testObstacleModules() };

  it('fills only the seats the pool needs when bots are off', async () => {
    const R = await loadRapier();
    const rounds = [
      ...ROUNDS,
      createTestArenaRound({ id: 'team-a', type: 'team', players: { min: 9, max: 40, ideal: 24 } }),
    ];
    expect(minimumShowSeats(playlist, ROUNDS)).toBe(2);
    expect(minimumShowSeats({ ...playlist, pool: [{ roundId: 'final-a' }] }, ROUNDS)).toBe(2);
    expect(minimumShowSeats({ ...playlist, pool: [...playlist.pool, { roundId: 'team-a' }] }, rounds)).toBe(
      9,
    );

    const raceOnly = { ...playlist, pool: [{ roundId: 'race-a' }] };
    const arenaMin = ROUNDS[0]!.players.min;
    const show = createOfflineShow({ R, deps, playlist: raceOnly, rounds: ROUNDS, seed: 1, humanName: 'Me' });
    expect(show.participants.length).toBe(Math.max(2, arenaMin));
    expect(show.participants.filter((p) => !p.isBot).length).toBe(1);
    show.dispose();

    const withTeams = createOfflineShow({
      R,
      deps,
      playlist: { ...playlist, pool: [...playlist.pool, { roundId: 'team-a' }] },
      rounds,
      seed: 1,
      humanName: 'Me',
    });
    expect(withTeams.participants.length).toBe(9);
    withTeams.dispose();

    const full = createOfflineShow({
      R,
      deps,
      playlist: { ...playlist, botsAllowed: true },
      rounds: ROUNDS,
      seed: 1,
      humanName: 'Me',
    });
    expect(full.participants.length).toBe(30);
    full.dispose();
  });

  it('passes the timer scale and mutator to every match sim', async () => {
    const R = await loadRapier();
    const show = createOfflineShow({
      R,
      deps,
      playlist: { ...playlist, botsAllowed: true, maxPlayers: 6 },
      rounds: ROUNDS,
      seed: 4,
      humanName: null,
      roundTimeScale: 0.5,
      mutatorId: 'speed-demons',
      timings: { preShow: 0.1 },
    });
    const rng = new Rng(1);
    for (let i = 0; i < 30 && !show.match; i++) show.advance(1 / 30 + rng.next() * 0.001);
    expect(show.match).not.toBeNull();
    expect(show.match!.round.duration.seconds).toBe(15);
    expect(show.match!.mutatorId).toBe('speed-demons');
    expect(show.director.current().showPhase).toBe(ShowPhase.InRound);
    show.dispose();
  });
});
