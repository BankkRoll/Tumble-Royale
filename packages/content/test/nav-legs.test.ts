/**
 * Bot nav legs that cost whole races at 100 bots, pinned so they stay fixed.
 *
 * Bots steer straight at their next waypoint and jump along their run-up, so
 * a leg that cuts a corner walks bots off an edge and a take-off approached
 * at an angle sends the jump sideways:
 *
 * - Hammer Highway: last ram → side checkpoint node left the 6 m Ram Run at
 *   x ≈ −4, z 113–122 (236 walk-offs; 20 of 60 qualified by the buzzer).
 *   Now the run ends on its centre line before fanning out (60 of 60).
 * - Cannonball Canyon: checkpoint → stepping-rock take-off ran diagonally off
 *   the deck at x ≈ −8 and the jump landed 2.6 m wide of rock 1 (1,763
 *   walk-offs; 58 of 65 at 240 s). Now bots line up on the rock line first
 *   (178 walk-offs; 65 of 65 by 210 s).
 *
 * Legs are sampled every half metre under a Tumbler's footprint in every
 * variation.
 */
import { type RoundDefinition } from '@tumble/shared';
import { loadRapier, type Rapier } from '@tumble/sim';
import { createMatchSim, createSimpleController, type MatchSimHandle } from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRound } from '../src/rounds/index.ts';

const STEP = 0.5;
/** Rays start this far above the leg and reach this far below it. */
const ABOVE = 2;
const BELOW = 3;
/** Footprint radius probed around each sample, so seams between floor pieces never read as holes. */
const FOOT = 0.35;
/** Sharpest turn between a run-up and the jump it feeds. */
const MAX_TAKEOFF_TURN = 40;

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

type Vec = { x: number; y: number; z: number };

function grounded(world: MatchSimHandle['world'], p: Vec): boolean {
  for (let k = -1; k < 8; k++) {
    const ox = k < 0 ? 0 : FOOT * Math.cos((k * Math.PI) / 4);
    const oz = k < 0 ? 0 : FOOT * Math.sin((k * Math.PI) / 4);
    const ray = new R.Ray({ x: p.x + ox, y: p.y + ABOVE, z: p.z + oz }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(
      ray,
      ABOVE + BELOW,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (c) => !c.isSensor(),
    );
    if (hit !== null) return true;
  }
  return false;
}

/** Every variation's level, built empty and stepped once so scene queries see it. */
function levels(round: RoundDefinition): { variation: string; sim: MatchSimHandle }[] {
  return round.variations.map((v) => {
    const sim = createMatchSim(
      { R, round, seed: 3, stage: 0, players: [], mode: 'offline', variationId: v.id },
      { createController: createSimpleController, obstacles: OBSTACLE_REGISTRY },
    );
    sim.step();
    return { variation: v.id, sim };
  });
}

/** First sample along `a→b` (stopping `short` m before `b`) with no ground under it. */
function hole(world: MatchSimHandle['world'], a: Vec, b: Vec, short = 0): Vec | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  for (let s = 0; s <= len - short; s += STEP) {
    const t = len > 0 ? s / len : 0;
    const p = { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
    if (!grounded(world, p)) return p;
  }
  return null;
}

function node(round: RoundDefinition, id: number) {
  const w = round.botNav.find((n) => n.id === id);
  expect(w, `${round.id} waypoint ${id}`).toBeDefined();
  return w!;
}

describe('race nav legs that walked 100-bot fields off the course', () => {
  it('hammer-highway: from the last ram to the plaza stays on the Ram Run', () => {
    const round = getRound('hammer-highway')!;
    const lastRam = node(round, 102);
    const legs: [Vec, Vec][] = [];
    for (const id of lastRam.next) {
      const mid = node(round, id);
      legs.push([lastRam.position, mid.position]);
      for (const cp of mid.next) legs.push([mid.position, node(round, cp).position]);
    }
    for (const { variation, sim } of levels(round)) {
      for (const [a, b] of legs)
        expect(hole(sim.world, a, b), `${variation} ${JSON.stringify([a, b])}`).toBeNull();
      sim.dispose();
    }
  });

  it('cannonball-canyon: the stepping-rock take-off is approached along the rock line', () => {
    const round = getRound('cannonball-canyon')!;
    const takeoff = node(round, 410);
    const firstRock = node(round, takeoff.next[0]!);
    const runUps = round.botNav.filter((w) => w.next.includes(takeoff.id));
    expect(runUps.length).toBeGreaterThan(0);
    const jx = firstRock.position.x - takeoff.position.x;
    const jz = firstRock.position.z - takeoff.position.z;
    for (const a of runUps) {
      const ax = takeoff.position.x - a.position.x;
      const az = takeoff.position.z - a.position.z;
      const cos = (ax * jx + az * jz) / (Math.hypot(ax, az) * Math.hypot(jx, jz));
      const turn = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
      expect(turn, `run-up ${a.id} → ${takeoff.id}`).toBeLessThanOrEqual(MAX_TAKEOFF_TURN);
    }
    for (const { variation, sim } of levels(round)) {
      for (const a of runUps) {
        // The take-off node sits just past the deck's rim on purpose.
        const short = takeoff.radius + 0.5;
        expect(
          hole(sim.world, a.position, takeoff.position, short),
          `${variation} run-up ${a.id}`,
        ).toBeNull();
      }
      sim.dispose();
    }
  });
});
