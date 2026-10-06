/**
 * Group-5 rounds (Comet Catch, Sunbeam Squabble, Colour Cauldron, Trail
 * Tracer, Throne Rush): registry and schema, obstacle params, sim builds in
 * every variation, objective scaling from a duel to a full lobby, play to the
 * end at the minimum field, and same-seed determinism.
 */
import { RoundDefinitionSchema, RoundPhase, type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import {
  PlayerRoundStatus,
  createMatchSim,
  createSimpleController,
  resolveObstacles,
  type MatchSimHandle,
} from '@tumble/sim/match';
import { createTumblerController } from '@tumble/sim/character';
import {
  CometFieldSchema,
  OBSTACLE_REGISTRY,
  SunbeamZonesSchema,
  ThroneFloorSchema,
  cometActiveCount,
  sunbeamActiveCount,
  throneSeatsFor,
  type CometFieldRuntime,
  type SunbeamZonesRuntime,
} from '@tumble/sim/obstacles';
import { computeQualifyTarget } from '@tumble/sim/rounds';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS_GROUP_5 } from '../src/rounds/group-5.ts';
import { getRound, showRoundCatalog } from '../src/rounds/index.ts';
import { PLANNED_ROUNDS } from '../src/shows/index.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const IDS = ['comet-catch', 'sunbeam-squabble', 'colour-cauldron', 'trail-tracer', 'throne-rush'];
const LOGIC_IDS = new Set(['colour-cauldron', 'trail-tracer']);

function round(id: string): RoundDefinition {
  const r = getRound(id);
  if (!r) throw new Error(`round ${id} not registered`);
  return r;
}

function bots(n: number) {
  const skills = ['sharp', 'average', 'clumsy'] as const;
  return Array.from({ length: n }, (_, id) => ({
    id,
    name: `bot-${id}`,
    isBot: true,
    team: -1,
    botSkill: skills[id % 3],
  }));
}

function build(
  def: RoundDefinition,
  opts: { seed?: number; variationId?: string; n?: number; real?: boolean } = {},
): MatchSimHandle {
  return createMatchSim(
    {
      R,
      round: def,
      seed: opts.seed ?? 11,
      stage: 0,
      players: bots(opts.n ?? 12),
      mode: 'offline',
      ...(opts.variationId ? { variationId: opts.variationId } : {}),
    },
    {
      createController: opts.real ? createTumblerController : createSimpleController,
      obstacles: OBSTACLE_REGISTRY,
    },
  );
}

/** Countdown, then PLAYING until every fate is decided (or timer + overtime + 2 s). */
function runFull(sim: MatchSimHandle): void {
  sim.setPhase(RoundPhase.Countdown);
  const d = sim.round.duration;
  const maxSteps = Math.ceil((3 + d.seconds + d.overtimeSeconds + 2) * 60);
  for (let i = 0; i < maxSteps; i++) {
    if (sim.phase === RoundPhase.Countdown && sim.time >= 0) sim.setPhase(RoundPhase.Playing, 0);
    sim.step();
    sim.events.drain();
    if (sim.getStatus().finished) break;
  }
}

describe('group-5 registry', () => {
  it('registers all five rounds with valid definitions', () => {
    expect(ROUNDS_GROUP_5.map((r) => r.id)).toEqual(IDS);
    for (const r of ROUNDS_GROUP_5) expect(() => RoundDefinitionSchema.parse(r)).not.toThrow();
    for (const id of IDS) expect(showRoundCatalog().has(id), id).toBe(true);
  });

  it('adds two hunts, two logic rounds and one final, each in its playlist pool', () => {
    const types = IDS.map((id) => round(id).type);
    expect(types).toEqual(['hunt', 'hunt', 'logic', 'logic', 'final']);
    expect(PLANNED_ROUNDS.hunt).toEqual(expect.arrayContaining(['comet-catch', 'sunbeam-squabble']));
    expect(PLANNED_ROUNDS.logic).toEqual(expect.arrayContaining(['colour-cauldron', 'trail-tracer']));
    expect(PLANNED_ROUNDS.final).toContain('throne-rush');
  });

  it('has variations, tips, its own rules card, music and bot hints per round', () => {
    for (const id of IDS) {
      const r = round(id);
      expect(r.variations.length, id).toBeGreaterThanOrEqual(3);
      expect(r.tips.length, id).toBe(3);
      expect(r.rulesCard?.length, id).toBeGreaterThanOrEqual(3);
      expect(r.music, id).toMatch(/^mus_/);
      expect(r.botNav.length, id).toBeGreaterThan(0);
      expect(r.flyover.path.length, id).toBeGreaterThanOrEqual(2);
      expect(r.objective.length, id).toBeLessThanOrEqual(48);
      expect(r.players.min, id).toBeLessThanOrEqual(2);
      expect(r.players.max, id).toBe(r.type === 'final' ? 15 : 100);
    }
  });

  it('score-target hunts name their goal on the objective', () => {
    for (const id of ['comet-catch', 'sunbeam-squabble']) {
      const q = round(id).qualification;
      expect(q.mode, id).toBe('scoreTarget');
      expect(round(id).objective, id).toContain(String(q.scoreGoal));
    }
  });
});

describe.each(IDS)('%s', (id) => {
  it('obstacle params parse with no stripped keys (every variation)', () => {
    const r = round(id);
    for (const variation of [null, ...r.variations]) {
      for (const inst of resolveObstacles(r, variation)) {
        const mod = OBSTACLE_REGISTRY.get(inst.type);
        expect(mod, `${id}/${inst.id}: unknown type ${inst.type}`).toBeDefined();
        const parsed = mod!.schema.parse(inst.params) as Record<string, unknown>;
        for (const key of Object.keys(inst.params))
          expect(
            parsed,
            `${id}/${variation?.id ?? 'base'}/${inst.id}: param "${key}" stripped`,
          ).toHaveProperty(key);
      }
    }
  });

  it('builds with zero warnings in every variation', () => {
    const r = round(id);
    for (const variation of [undefined, ...r.variations.map((v) => v.id)]) {
      const sim = build(r, { variationId: variation, n: 6 });
      expect(sim.warnings, `${id}/${variation}`).toEqual([]);
      sim.dispose();
    }
  });

  it('plays to the end at its smallest field', () => {
    const r = round(id);
    const n = Math.max(2, r.players.min);
    const sim = build(r, { n, real: true, seed: 5 });
    runFull(sim);
    const st = sim.getStatus();
    expect(st.finished).toBe(true);
    expect(st.qualifiedCount + st.eliminatedCount).toBe(n);
    // A logic round only cuts when someone picks wrong; when every bot answers
    // right to the buzzer, all survivors qualify. The cut rate is pinned below.
    if (LOGIC_IDS.has(id)) expect(st.qualifiedCount).toBeGreaterThanOrEqual(computeQualifyTarget(r, n));
    else expect(st.qualifiedCount).toBe(computeQualifyTarget(r, n));
    sim.dispose();
  });

  if (LOGIC_IDS.has(id))
    it('cuts a two-bot field on most seeds', () => {
      const r = round(id);
      let cut = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const sim = build(r, { n: 2, real: true, seed });
        runFull(sim);
        if (sim.getStatus().qualifiedCount === computeQualifyTarget(r, 2)) cut++;
        sim.dispose();
      }
      expect(cut).toBeGreaterThanOrEqual(16);
    }, 120_000);

  it('same seed, same outcome', () => {
    const r = round(id);
    const outcome = (): string => {
      const sim = build(r, { n: 12, real: true, seed: 23 });
      runFull(sim);
      const st = sim.getStatus();
      const fates = [...st.players].map(([pid, p]) => `${pid}:${p.status}:${p.place}:${p.score}`);
      const out = `${st.time.toFixed(4)}|${sim.variationId}|${fates.join(',')}`;
      sim.dispose();
      return out;
    };
    expect(outcome()).toBe(outcome());
  });
});

describe('objective scaling from a duel to a full lobby', () => {
  it('comets: a handful for two, dozens for a hundred', () => {
    const p = CometFieldSchema.parse(round('comet-catch').obstacles.find((o) => o.id === 'comets')!.params);
    expect(cometActiveCount(p, 2)).toBe(3);
    expect(cometActiveCount(p, 100)).toBe(32);
    // A full lobby needs goal × quota catches; each comet is catchable once per hop.
    const goal = round('comet-catch').qualification.scoreGoal!;
    const catchesPerSecond = cometActiveCount(p, 100) / p.hop;
    expect((goal * computeQualifyTarget(round('comet-catch'), 100)) / catchesPerSecond).toBeLessThan(
      round('comet-catch').duration.seconds * 0.6,
    );
    const sim = build(round('comet-catch'), { n: 100 });
    expect((sim.obstacle('comets') as unknown as CometFieldRuntime).activeCount).toBe(32);
    sim.dispose();
  });

  it('sunbeams: one shared beam for a duel, twelve for a hundred', () => {
    const r = round('sunbeam-squabble');
    const p = SunbeamZonesSchema.parse(r.obstacles.find((o) => o.id === 'sunbeams')!.params);
    expect(sunbeamActiveCount(p, 2)).toBe(1);
    expect(sunbeamActiveCount(p, 100)).toBe(12);
    const points = r.qualification.scoreGoal! * computeQualifyTarget(r, 100);
    expect(points / (sunbeamActiveCount(p, 100) * p.rate)).toBeLessThan(r.duration.seconds * 0.6);
    const sim = build(r, { n: 2 });
    expect((sim.obstacle('sunbeams') as unknown as SunbeamZonesRuntime).activeCount).toBe(1);
    sim.dispose();
  });

  it('thrones: the court shrinks by a quarter a cycle and always ends one seat short', () => {
    const p = ThroneFloorSchema.parse(round('throne-rush').obstacles.find((o) => o.id === 'thrones')!.params);
    let n = round('throne-rush').players.max;
    let cycles = 0;
    while (n > 1) {
      const seats = throneSeatsFor(p, n);
      expect(seats).toBeLessThan(n);
      n = seats;
      cycles++;
    }
    expect(cycles).toBeLessThanOrEqual(10);
    expect(throneSeatsFor(p, 2)).toBe(1);
  });

  it('logic floors hold a full lobby on their spawn grid', () => {
    for (const id of ['colour-cauldron', 'trail-tracer']) {
      const sim = build(round(id), { n: 100 });
      sim.setPhase(RoundPhase.Countdown);
      for (let i = 0; i < 60; i++) sim.step();
      let onBoard = 0;
      for (const [pid] of sim.getStatus().players) {
        const t = sim.controller(pid)!.body.translation();
        if (t.y > -0.5 && Math.abs(t.x) < 14.5 && Math.abs(t.z) < 14.5) onBoard++;
      }
      expect(onBoard, id).toBe(100);
      expect(sim.getStatus().players.size).toBe(100);
      for (const [, p] of sim.getStatus().players) expect(p.status).toBe(PlayerRoundStatus.Playing);
      sim.dispose();
    }
  });
});
