/**
 * Custom rounds: share codes, validation rules (schema, budgets, allowed
 * obstacles, text filter, bounds, spawn on ground, reachable finish), bot
 * legs, the round file format and the playable round a show runs, including
 * that it builds and plays deterministically in the real match sim.
 */
import { RoundPhase, type RoundDefinitionInput } from '@tumble/shared';
import { loadRapier, type CharacterFullState, type Rapier } from '@tumble/sim';
import { PlayerRoundStatus, createMatchSim, type MatchSimHandle } from '@tumble/sim/match';
import { createTumblerController } from '@tumble/sim/character';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOM_ROUND_LIMITS,
  customRoundId,
  exportRoundFile,
  isCustomRoundId,
  normalizeShareCode,
  obstacleAllowed,
  parseRoundFile,
  playableCustomRound,
  randomShareCode,
  shareCodeOf,
  starterRound,
  validateCustomRound,
  type CustomRoundType,
} from '../src/custom/index.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const codes = (input: unknown) =>
  validateCustomRound(input)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);

describe('share codes', () => {
  it('normalises what players type and rejects lookalike characters', () => {
    expect(normalizeShareCode(' k7mq-2x9a ')).toBe('K7MQ2X9A');
    expect(normalizeShareCode('K7MQ2X9')).toBeNull();
    expect(normalizeShareCode('K7MQ2X9O')).toBeNull();
    expect(normalizeShareCode('K7MQ2X91')).toBeNull();
  });

  it('round-trips ids', () => {
    const code = randomShareCode((n) => n - 1);
    expect(code).toHaveLength(8);
    expect(normalizeShareCode(code)).toBe(code);
    expect(shareCodeOf(customRoundId(code))).toBe(code);
    expect(isCustomRoundId('gumdrop-gauntlet')).toBe(false);
    expect(isCustomRoundId('custom:nope')).toBe(false);
  });
});

describe('starter rounds', () => {
  for (const type of ['race', 'survival', 'hunt', 'logic'] as CustomRoundType[]) {
    it(`${type} starter passes validation`, () => {
      const v = validateCustomRound(starterRound(type));
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(v.ok).toBe(true);
    });
  }

  it('generates straight bot legs for the race starter', () => {
    const v = validateCustomRound(starterRound('race'));
    expect(v.nav?.status).toBe('route');
    const nav = v.nav?.botNav ?? [];
    expect(nav.length).toBeGreaterThan(3);
    expect(nav.filter((w) => w.action !== 'run').length).toBe(3);
    expect(nav.at(-1)?.position.z).toBe(56);
    expect(nav.every((w, i) => w.id === i && (i === nav.length - 1 || w.next[0] === i + 1))).toBe(true);
  });
});

describe('validation rules', () => {
  it('rejects schema failures with a path', () => {
    const r = clone(starterRound()) as Record<string, unknown>;
    delete r.spawn;
    const v = validateCustomRound(r);
    expect(v.ok).toBe(false);
    expect(v.issues[0]?.code).toBe('schema');
    expect(v.issues[0]?.path).toBe('spawn');
  });

  it('rejects oversized and prototype-polluting input', () => {
    const big = clone(starterRound());
    big.designNotes = 'x'.repeat(CUSTOM_ROUND_LIMITS.maxBytes);
    expect(codes(big)).toEqual(['too_large']);
    const evil = JSON.parse(
      JSON.stringify(starterRound()).replace(
        '"params":{"index":1',
        '"params":{"__proto__":{"x":1},"index":1',
      ),
    );
    expect(codes(evil)).toEqual(['not_json']);
  });

  it('only allows editor round types with their qualification mode', () => {
    const team = clone(starterRound()) as RoundDefinitionInput;
    team.type = 'team';
    expect(codes(team)).toContain('round_type');
    const wrongMode = clone(starterRound());
    wrongMode.qualification = { mode: 'survive', ratio: 0.5 };
    expect(codes(wrongMode)).toContain('qualification_mode');
  });

  it('enforces budgets', () => {
    const r = clone(starterRound());
    r.geometry = Array.from({ length: CUSTOM_ROUND_LIMITS.maxGeometry + 1 }, () => ({
      shape: 'box' as const,
      position: { x: 0, y: -0.5, z: 0 },
      size: { x: 2, y: 1, z: 2 },
    }));
    expect(codes(r)).toContain('geometry_budget');
    const tiles = clone(starterRound());
    tiles.obstacles = Array.from({ length: 9 }, (_, i) => ({
      id: `tiles-${i}`,
      type: 'fallingTiles',
      position: { x: 0, y: 0, z: 22 },
      params: { cols: 8, rows: 8 },
    }));
    expect(codes(tiles)).toContain('collider_budget');
  });

  it('checks obstacle types, params and per-type permissions', () => {
    const r = clone(starterRound());
    r.obstacles = [
      ...(r.obstacles ?? []),
      { id: 'x1', type: 'notAThing', position: { x: 0, y: 0, z: 0 }, params: {} },
      { id: 'x2', type: 'pendulumHammer', position: { x: 0, y: 0, z: 22 }, params: { period: -1 } },
      { id: 'x3', type: 'throneFloor', position: { x: 0, y: 0, z: 0 }, params: {} },
      { id: 'x4', type: 'cometField', position: { x: 0, y: 0, z: 0 }, params: {} },
    ];
    const c = codes(r);
    expect(c).toContain('obstacle_type');
    expect(c).toContain('obstacle_params');
    expect(c.filter((x) => x === 'obstacle_not_allowed')).toHaveLength(2);
    expect(obstacleAllowed('cometField', 'hunt')).toBe(true);
    expect(obstacleAllowed('puzzleFloor', 'race')).toBe(false);
  });

  it('requires unique ids', () => {
    const r = clone(starterRound());
    r.obstacles![1]!.id = 'cp-1-gate';
    expect(codes(r)).toContain('duplicate_id');
  });

  it('filters names, objectives and tips', () => {
    const r = clone(starterRound());
    r.name = 'fuck race';
    r.tips = ['ok tip', 'shit'];
    const c = codes(r);
    expect(c).toContain('name');
    expect(c).toContain('tips');
    const short = clone(starterRound());
    short.name = 'ab';
    expect(codes(short)).toContain('name');
  });

  it('keeps everything inside the bounds', () => {
    const r = clone(starterRound());
    r.obstacles![0]!.position = { x: 500, y: 0, z: 0 };
    expect(codes(r)).toContain('obstacle_bounds');
    const huge = clone(starterRound());
    huge.bounds = { min: { x: -1000, y: -20, z: -40 }, max: { x: 1000, y: 40, z: 100 } };
    expect(codes(huge)).toContain('bounds_size');
  });

  it('needs the kill plane under the lowest floor', () => {
    const r = clone(starterRound());
    r.killY = -1;
    expect(codes(r)).toContain('kill_too_high');
  });

  it('puts every spawn slot of a full lobby on solid ground', () => {
    const r = clone(starterRound());
    r.spawn = { ...r.spawn, origin: { x: 0, y: 0.1, z: 7 } };
    expect(codes(r)).toContain('spawn_floating');
    const high = clone(starterRound());
    high.spawn = { ...high.spawn, origin: { x: 0, y: 5, z: 0 } };
    expect(codes(high)).toContain('spawn_floating');
  });

  it('needs a reachable finish in races', () => {
    const none = clone(starterRound());
    none.triggers = none.triggers!.filter((t) => t.kind !== 'finish');
    expect(codes(none)).toContain('no_finish');
    const far = clone(starterRound());
    // Move the last platform (and the finish on it) 20 m further: an unjumpable gap.
    far.geometry![3]!.position.z += 20;
    far.triggers!.find((t) => t.kind === 'finish')!.position.z += 20;
    expect(codes(far)).toContain('finish_unreachable');
    const high = clone(starterRound());
    high.geometry![3]!.position.y += 4;
    high.triggers!.find((t) => t.kind === 'finish')!.position.y += 4;
    expect(codes(high)).toContain('finish_unreachable');
  });

  it('counts bounce pads, ramps and moving platforms as ways across', () => {
    const r = clone(starterRound());
    r.geometry![3]!.position.y += 4;
    r.triggers!.find((t) => t.kind === 'finish')!.position.y += 4;
    r.geometry!.push({
      shape: 'ramp',
      position: { x: 0, y: 2, z: 44 },
      size: { x: 6, y: 4, z: 4 },
    });
    expect(codes(r)).not.toContain('finish_unreachable');
    const mover = clone(starterRound());
    mover.geometry![3]!.position.z += 20;
    mover.triggers!.find((t) => t.kind === 'finish')!.position.z += 20;
    mover.obstacles!.push({
      id: 'deck',
      type: 'movingPlatform',
      position: { x: 0, y: 0, z: 48 },
      params: {
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 16 },
        ],
      },
    });
    expect(codes(mover)).not.toContain('finish_unreachable');
  });

  it('needs the type-specific obstacle in hunts and logic rounds', () => {
    const hunt = clone(starterRound('hunt'));
    hunt.obstacles = [];
    expect(codes(hunt)).toContain('no_scoring');
    const logic = clone(starterRound('logic'));
    logic.obstacles = [];
    expect(codes(logic)).toContain('no_puzzle');
  });

  it('warns when bots cannot follow the straight legs', () => {
    const r = clone(starterRound());
    r.geometry![1]!.size.z = 10;
    r.obstacles!.push({
      id: 'deck',
      type: 'movingPlatform',
      position: { x: 0, y: 0, z: 26 },
      params: {
        points: [
          { x: 6, y: 0, z: 0 },
          { x: 6, y: 0, z: 4 },
        ],
      },
    });
    const v = validateCustomRound(r);
    expect(v.issues.some((i) => i.code === 'bot_gaps')).toBe(true);
    expect(v.nav?.status).toBe('gaps');
  });
});

describe('round files', () => {
  it('round-trips through export and import', () => {
    const round = starterRound('survival');
    const parsed = parseRoundFile(exportRoundFile(round, 'Dodge it'));
    expect(parsed).toEqual({ ok: true, round, description: 'Dodge it' });
  });

  it('accepts bare definitions and rejects other files', () => {
    expect(parseRoundFile(JSON.stringify(starterRound())).ok).toBe(true);
    expect(parseRoundFile('nope')).toEqual({ ok: false, error: 'That file is not JSON' });
    expect(parseRoundFile('{"a":1}').ok).toBe(false);
    expect(parseRoundFile('{"format":"tumble-royale/round","version":9,"round":{}}').ok).toBe(false);
  });
});

describe('playable rounds', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await loadRapier();
  });

  it('fixes the id, player range and bot legs', () => {
    const r = playableCustomRound(starterRound(), customRoundId('K7MQ2X9A'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.round.id).toBe('custom:K7MQ2X9A');
    expect(r.round.players.max).toBe(100);
    expect(r.round.botNav.length).toBeGreaterThan(3);
    expect(r.botRoute).toBe('route');
    expect(playableCustomRound({}, 'custom:X').ok).toBe(false);
  });

  function play(seed: number): { finished: number[]; positions: string } {
    const r = playableCustomRound(starterRound(), 'custom:K7MQ2X9A');
    if (!r.ok) throw new Error('starter invalid');
    const sim = createMatchSim(
      {
        R,
        round: r.round,
        seed,
        stage: 0,
        players: Array.from({ length: 12 }, (_, id) => ({ id, name: `b${id}`, isBot: true, team: -1 })),
        mode: 'offline',
      },
      { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY },
    ) as MatchSimHandle;
    sim.setPhase(RoundPhase.Playing, 0);
    for (let i = 0; i < 60 * 40 && !sim.getStatus().finished; i++) sim.step();
    const status = sim.getStatus();
    const finished = [...status.players.entries()]
      .filter(([, p]) => p.status === PlayerRoundStatus.Qualified)
      .map(([id]) => id);
    const st: CharacterFullState = {
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
    const positions = Array.from({ length: 12 }, (_, id) =>
      sim.getPlayerState(id, st) ? `${st.pos.x.toFixed(4)},${st.pos.z.toFixed(4)}` : '-',
    ).join('|');
    sim.dispose();
    return { finished, positions };
  }

  it('plays to the same result with the same seed', () => {
    const a = play(11);
    const b = play(11);
    expect(a).toEqual(b);
    expect(a.finished.length).toBeGreaterThan(0);
  });
});
