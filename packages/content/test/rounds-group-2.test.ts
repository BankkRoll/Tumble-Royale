/**
 * Level-builder group 2 rounds: Hammer Highway, Wind Tunnel Peaks, Cannonball
 * Canyon, Spin Cycle and Spin Cycle Finale. Validates data against the round
 * and obstacle schemas, checks layout invariants (spawns on ground, respawns,
 * nav connectivity, bounds) and runs every round with 40 bots.
 */
import {
  RoundDefinitionSchema,
  RoundPhase,
  type RoundDefinition,
  type StaticPiece,
  type Vec3,
} from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import {
  createMatchSim,
  createSimpleController,
  resolveObstacles,
  spawnSlots,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '@tumble/sim/match';
import { OBSTACLE_REGISTRY, getObstacleModule } from '@tumble/sim/obstacles';
import { appendFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUNDS_GROUP_2 } from '../src/rounds/group-2.ts';
import { CHARACTER_TUNING } from '../src/tuning/character.ts';
import { GRAVITY_Y } from '@tumble/shared';
import { HIGH_BAR, LOW_BAR } from '../src/rounds/spin-cycle/drum.ts';

const EXPECTED = [
  'hammer-highway',
  'wind-tunnel-peaks',
  'cannonball-canyon',
  'spin-cycle',
  'spin-cycle-finale',
];

const rounds: RoundDefinition[] = ROUNDS_GROUP_2.map((r) => RoundDefinitionSchema.parse(r));

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

function players(n: number): MatchPlayerInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `Bot${i}`,
    isBot: true,
    team: -1,
    botSkill: (['clumsy', 'average', 'sharp'] as const)[i % 3],
  }));
}

function startPlaying(sim: MatchSimHandle): void {
  sim.setPhase(RoundPhase.Countdown);
  for (let i = 0; i < 180; i++) sim.step();
  sim.setPhase(RoundPhase.Playing, 0);
}

/** Top surface of an unrotated solid piece under (x, z), or null. */
function topUnder(p: StaticPiece, x: number, z: number): number | null {
  if (p.decorative) return null;
  const r = p.rotation;
  if (r && ((r.yaw ?? 0) !== 0 || (r.pitch ?? 0) !== 0 || (r.roll ?? 0) !== 0)) return null;
  const { position: c, size: s } = p;
  if (p.shape === 'box') {
    if (Math.abs(x - c.x) <= s.x / 2 && Math.abs(z - c.z) <= s.z / 2) return c.y + s.y / 2;
  } else if (p.shape === 'cylinder' || p.shape === 'hexPrism') {
    if (Math.hypot(x - c.x, z - c.z) <= s.x * (p.shape === 'hexPrism' ? 0.86 : 1)) return c.y + s.y / 2;
  } else if (p.shape === 'ramp') {
    if (Math.abs(x - c.x) <= s.x / 2 && Math.abs(z - c.z) <= s.z / 2) {
      return c.y - s.y / 2 + s.y * ((z - (c.z - s.z / 2)) / s.z);
    }
  }
  return null;
}

/** Top of a platform obstacle's rest pose (drum floor panels, bridges) under (x, z), or null. */
function bridgeTopUnder(o: RoundDefinition['obstacles'][number], x: number, z: number): number | null {
  const yaw = ((o.rotation?.yaw ?? 0) * Math.PI) / 180;
  const dx = x - o.position.x;
  const dz = z - o.position.z;
  const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  if (o.type === 'collapsingBridge') {
    const p = o.params as { segments: number; segmentLength: number; width: number };
    return Math.abs(lx) <= p.width / 2 && lz >= 0 && lz <= p.segments * p.segmentLength ? o.position.y : null;
  }
  if (o.type === 'movingPlatform') {
    const p = o.params as { size: Vec3; points?: Vec3[] };
    const first = p.points?.[0] ?? { x: 0, y: 0, z: 0 };
    return Math.abs(lx - first.x) <= p.size.x / 2 && Math.abs(lz - first.z) <= p.size.z / 2
      ? o.position.y + first.y
      : null;
  }
  return null;
}

/** True when a solid surface (static piece or drum floor panel) lies just under `p` (feet height). */
function onGround(round: RoundDefinition, p: Vec3): boolean {
  const near = (top: number | null): boolean => top !== null && p.y - top >= -0.05 && p.y - top <= 0.6;
  return (
    round.geometry.some((g) => near(topUnder(g as StaticPiece, p.x, p.z))) ||
    round.obstacles.some((o) => near(bridgeTopUnder(o, p.x, p.z)))
  );
}

function inside(round: RoundDefinition, p: Vec3, margin = 0): boolean {
  const { min, max } = round.bounds;
  return (
    p.x >= min.x + margin &&
    p.x <= max.x - margin &&
    p.y >= min.y + margin &&
    p.y <= max.y - margin &&
    p.z >= min.z + margin &&
    p.z <= max.z - margin
  );
}

describe('group 2 registry', () => {
  it('lists every group-2 round once', () => {
    expect(rounds.map((r) => r.id)).toEqual(EXPECTED);
  });
});

describe.each(rounds.map((r) => [r.id, r] as const))('%s', (_id, round) => {
  it('parses and carries the authored metadata', () => {
    expect(round.objective.length).toBeGreaterThan(10);
    expect(round.tips.length).toBeGreaterThanOrEqual(3);
    expect(round.variations.length).toBeGreaterThanOrEqual(3);
    expect(round.speedScaleByStage.length).toBe(5);
    expect(round.music.startsWith('mus_')).toBe(true);
    expect(new Set(round.obstacles.map((o) => o.id)).size).toBe(round.obstacles.length);
    expect(new Set(round.botNav.map((w) => w.id)).size).toBe(round.botNav.length);
  });

  it('every obstacle (incl. variations) parses with its module schema without stripped keys', () => {
    const variants = [null, ...round.variations];
    for (const variation of variants) {
      for (const inst of resolveObstacles(round, variation)) {
        const mod = getObstacleModule(inst.type);
        expect(mod, `${inst.id}: unknown type ${inst.type}`).toBeDefined();
        const parsed = mod!.schema.parse(inst.params) as Record<string, unknown>;
        for (const key of Object.keys(inst.params)) {
          expect(
            key in parsed,
            `${variation?.id ?? 'base'} ${inst.id}: param "${key}" is not in the ${inst.type} schema`,
          ).toBe(true);
        }
      }
    }
    for (const variation of round.variations) {
      for (const id of [...Object.keys(variation.obstacleParams), ...variation.removeObstacles]) {
        expect(
          round.obstacles.some((o) => o.id === id),
          `${variation.id}: unknown obstacle ${id}`,
        ).toBe(true);
      }
    }
  });

  it('spawns and respawns stand on solid ground', () => {
    const slots = spawnSlots(
      round,
      7,
      Array.from({ length: round.players.max }, () => -1),
    );
    for (const s of slots) expect(onGround(round, s.pos), `spawn ${JSON.stringify(s.pos)}`).toBe(true);
    for (const t of round.triggers.filter((tr) => tr.kind === 'checkpoint')) {
      expect(t.respawn.length, `${t.id} respawns`).toBeGreaterThan(0);
      for (const p of t.respawn)
        expect(onGround(round, p), `${t.id} respawn ${JSON.stringify(p)}`).toBe(true);
    }
  });

  it('keeps all playable content inside bounds', () => {
    for (const g of round.geometry) {
      if (g.decorative) continue;
      expect(inside(round, g.position), `piece at ${JSON.stringify(g.position)}`).toBe(true);
    }
    for (const o of round.obstacles) expect(inside(round, o.position), o.id).toBe(true);
    for (const t of round.triggers) expect(inside(round, t.position), t.id).toBe(true);
    for (const w of round.botNav) expect(inside(round, w.position, 1), `wp ${w.id}`).toBe(true);
    expect(round.bounds.min.y).toBeLessThanOrEqual(round.killY - 5);
  });

  it('bot nav is well formed', () => {
    const ids = new Set(round.botNav.map((w) => w.id));
    for (const w of round.botNav) for (const n of w.next) expect(ids.has(n), `wp ${w.id} → ${n}`).toBe(true);
    for (const w of round.botNav)
      if (w.timeAgainst)
        expect(
          round.obstacles.some((o) => o.id === w.timeAgainst),
          `wp ${w.id} timeAgainst`,
        ).toBe(true);
    if (round.type !== 'race') return;
    // Every node is reachable from an entry node on the start plaza and can reach the finish sink.
    const byId = new Map(round.botNav.map((w) => [w.id, w]));
    const incoming = new Set(round.botNav.flatMap((w) => w.next));
    const entries = round.botNav.filter((w) => !incoming.has(w.id));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(
        Math.hypot(e.position.x - round.spawn.origin.x, e.position.z - round.spawn.origin.z),
        `entry wp ${e.id}`,
      ).toBeLessThan(12);
    }
    const seen = new Set<number>(entries.map((e) => e.id));
    const queue = entries.map((e) => e.id);
    while (queue.length)
      for (const n of byId.get(queue.shift()!)!.next)
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
    expect(seen.size).toBe(round.botNav.length);
    const sinks = round.botNav.filter((w) => w.next.length === 0);
    expect(sinks).toHaveLength(1);
    const finish = round.triggers.find((t) => t.kind === 'finish')!;
    expect(
      Math.hypot(sinks[0]!.position.x - finish.position.x, sinks[0]!.position.z - finish.position.z),
    ).toBeLessThan(3);
    const reach = new Map<number, boolean>();
    const canFinish = (id: number, stack = new Set<number>()): boolean => {
      if (reach.has(id)) return reach.get(id)!;
      if (stack.has(id)) return false;
      stack.add(id);
      const w = byId.get(id)!;
      const ok = w.next.length === 0 || w.next.some((n) => canFinish(n, stack));
      reach.set(id, ok);
      return ok;
    };
    for (const w of round.botNav) expect(canFinish(w.id), `wp ${w.id} reaches finish`).toBe(true);
  });

  it('builds without warnings for every variation and runs 40 bots', { timeout: 120_000 }, () => {
    for (const variation of round.variations) {
      const sim = createMatchSim(
        { R, round, seed: 11, stage: 2, players: players(4), mode: 'authority', variationId: variation.id },
        { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
      );
      expect(sim.warnings, `${variation.id}: ${sim.warnings.join('\n')}`).toHaveLength(0);
      sim.dispose();
    }
    const sim = createMatchSim(
      { R, round, seed: 3, stage: 0, players: players(40), mode: 'authority' },
      { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
    );
    expect(sim.warnings).toHaveLength(0);
    startPlaying(sim);
    expect(() => {
      for (let i = 0; i < 1900; i++) sim.step();
    }).not.toThrow();
    const status = sim.getStatus();
    expect(status.players.size).toBe(40);
    sim.dispose();
  });
});

/**
 * Balance probe with the real Tumbler controller (slow, opt-in):
 * `G2_DIAG=hammer-highway G2_SECONDS=150 vitest run test/rounds-group-2.test.ts`
 * prints where bots are every 10 s so stalls show up as a pile-up in one bin.
 */
describe.runIf(!!process.env.G2_DIAG)('balance probe', () => {
  it('reports bot progress', { timeout: 900_000 }, async () => {
    const { createTumblerController } = await import('@tumble/sim/character');
    const ids = process.env.G2_DIAG!.split(',');
    const seconds = Number(process.env.G2_SECONDS ?? 120);
    for (const id of ids) {
      const round = rounds.find((r) => r.id === id)!;
      const n = Number(process.env.G2_BOTS ?? (round.type === 'race' ? 24 : round.players.ideal));
      const sim = createMatchSim(
        {
          R,
          round,
          seed: 7,
          stage: 0,
          players: players(n),
          mode: 'offline',
          ...(process.env.G2_VAR ? { variationId: process.env.G2_VAR } : {}),
        },
        { createController: createTumblerController, obstacles: OBSTACLE_REGISTRY },
      );
      startPlaying(sim);
      const fell = new Map<string, number>();
      const lastStun = new Map<number, number>();
      const hits = new Map<string, number>();
      const walkOffs: string[] = [];
      const bySkill = [0, 0, 0];
      const fs = {
        pos: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        vel: { x: 0, y: 0, z: 0 },
        angVel: { x: 0, y: 0, z: 0 },
      } as unknown as Parameters<MatchSimHandle['getPlayerState']>[1];
      const lines: string[] = [`${id} (${sim.variationId}) ${n} bots`];
      for (let s = 1; s <= seconds * 60; s++) {
        sim.step();
        for (const e of sim.events.drain()) {
          if (e.type === 'stun') lastStun.set(e.player, s);
          if (e.type === 'obstacleCue' && /bonk|squash|trip|ropeHit|hit/i.test(e.cue))
            hits.set(e.obstacle, (hits.get(e.obstacle) ?? 0) + 1);
          if (e.type !== 'fellOut') continue;
          const knocked = s - (lastStun.get(e.player) ?? -1e9) < 240;
          const k =
            (round.type === 'race' ? Math.floor(e.pos.z / 20) * 20 : Math.round(s / 600) * 10) +
            (knocked ? 'k' : 'w');
          fell.set(k, (fell.get(k) ?? 0) + 1);
          bySkill[e.player % 3]!++;
          if (!knocked && walkOffs.length < 40)
            walkOffs.push(`(${e.pos.x.toFixed(1)},${e.pos.z.toFixed(0)})`);
        }
        if (process.env.G2_TRACE && s % 12 === 0) {
          const pid = Number(process.env.G2_TRACE);
          sim.getPlayerState(pid, fs);
          const p = fs.pos;
          lines.push(
            `  trace t=${(s / 60).toFixed(1)} p=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) st=${fs.state}`,
          );
        }
        if (s % 600 === 0) {
          const st = sim.getStatus();
          const bins = new Map<number, number>();
          for (const [pid, info] of st.players) {
            if (info.status === 2) continue;
            sim.getPlayerState(pid, fs);
            const p = fs.pos;
            const k = round.type === 'race' ? Math.floor(p.z / 20) * 20 : Math.round(Math.hypot(p.x, p.z));
            bins.set(k, (bins.get(k) ?? 0) + 1);
          }
          const hist = [...bins.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([k, c]) => `${k}:${c}`)
            .join(' ');
          lines.push(`t=${s / 60}s q=${st.qualifiedCount} e=${st.eliminatedCount} hist ${hist}`);
        }
      }
      lines.push(
        `falls (k=knocked w=walked): ${[...fell.entries()]
          .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
          .map(([k, c]) => `${k}:${c}`)
          .join(' ')}`,
      );
      lines.push(`hits: ${[...hits.entries()].map(([k, c]) => `${k}:${c}`).join(' ')}`);
      lines.push(`walk-offs: ${walkOffs.join(' ')}`);
      lines.push(`falls by skill clumsy/average/sharp: ${bySkill.join('/')}`);
      const left: string[] = [];
      for (const [pid, info] of sim.getStatus().players) {
        if (info.status !== 0) continue;
        sim.getPlayerState(pid, fs);
        left.push(`#${pid}(${fs.pos.x.toFixed(1)},${fs.pos.y.toFixed(1)},${fs.pos.z.toFixed(1)})`);
      }
      lines.push(`still playing: ${left.join(' ')}`);
      if (process.env.G2_OUT) appendFileSync(process.env.G2_OUT, lines.join('\n') + '\n');
      else console.log(lines.join('\n'));
      sim.dispose();
    }
  });
});

describe.runIf(!!process.env.G2_COUNTS)('content counts', () => {
  it('prints piece / obstacle / trigger / waypoint counts', () => {
    for (const r of rounds) {
      const deco = r.geometry.filter((g) => g.decorative).length;
      const types = new Map<string, number>();
      for (const o of r.obstacles) types.set(o.type, (types.get(o.type) ?? 0) + 1);
      const line = `${r.id}: ${r.geometry.length} pieces (${deco} decor), ${r.obstacles.length} obstacles [${[...types].map(([t, n]) => `${t}×${n}`).join(', ')}], ${r.triggers.length} triggers, ${r.botNav.length} waypoints, ${r.variations.length} variations`;
      if (process.env.G2_OUT) appendFileSync(process.env.G2_OUT, line + '\n');
      else console.log(line);
    }
  });
});

describe('spin cycle bars', () => {
  // A diving Tumbler keeps its upright 1.8 m capsule and hops by diveUpSpeed,
  // so the "dive under" bar must clear a diver's hop but not a jump.
  const t = CHARACTER_TUNING;
  const capsuleTop = 2 * (t.halfHeight + t.radius);
  const g = -GRAVITY_Y;
  const diveHop = (t.diveUpSpeed * t.diveUpSpeed) / (2 * g * t.diveGravityScale);
  const jumpRise = (t.jumpSpeed * t.jumpSpeed) / (2 * g);

  it('high bar is dive-clearable and jump-deadly', () => {
    const bottom = HIGH_BAR.height - HIGH_BAR.radius;
    expect(bottom).toBeGreaterThan(capsuleTop + diveHop + 0.1);
    expect(bottom).toBeLessThan(capsuleTop + jumpRise * 0.5);
  });

  it('low bar is jump-clearable and blocks walkers', () => {
    const top = LOW_BAR.height + LOW_BAR.radius;
    expect(top).toBeLessThan(jumpRise - 0.4);
    expect(top).toBeGreaterThan(t.stepHeight);
  });
});
