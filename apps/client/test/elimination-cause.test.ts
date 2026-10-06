/**
 * "How you went out": attributing the local player's knock-out from event
 * streams. Every cause type, the decisive moment it reports, the generic
 * fallbacks for ambiguous or unexplained falls, the text (names supplied by
 * the caller, so Streamer Mode masking is theirs), reach and finish gaps.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@tumble/sim';
import {
  CAUSE_AMBIGUOUS_S,
  attributeElimination,
  causeFocusPlayer,
  causeText,
  finishGapSeconds,
  obstacleReach,
  type CauseContext,
  type CauseObstacle,
  type TimedEvent,
} from '../src/game/replay/elimCause.ts';

const ME = 0;
const P = { x: 0, y: 5, z: 0 };

const SWEEPER: CauseObstacle = { id: 'sweep-1', type: 'sweeperArm', x: 1, y: 5, z: 1, reach: 9 };
const PAD: CauseObstacle = { id: 'boing-1', type: 'bouncePad', x: 30, y: 5, z: 0, reach: 6 };
const TILES: CauseObstacle = { id: 'tiles-1', type: 'fallingTiles', x: 0, y: 5, z: 0, reach: 14 };
const FAR_TILES: CauseObstacle = { id: 'tiles-far', type: 'fallingTiles', x: 200, y: 5, z: 0, reach: 14 };

function ctx(over: Partial<CauseContext> = {}): CauseContext {
  return {
    localId: ME,
    roundType: 'survival',
    isFinal: false,
    eliminatedAt: 20,
    teams: new Map(),
    obstacles: [SWEEPER, PAD, TILES, FAR_TILES],
    finishGap: null,
    ...over,
  };
}

function at(t: number, e: SimEvent): TimedEvent {
  return { t, e };
}

const fell = (t: number, player = ME): TimedEvent =>
  at(t, { type: 'fellOut', player, pos: { x: 0, y: -20, z: 0 } });
const out = (t: number, player = ME): TimedEvent => at(t, { type: 'eliminated', player, place: 10 });

describe('fall-based causes', () => {
  it('blames a hazard when the stun lands inside its reach', () => {
    const c = attributeElimination(
      [at(17.2, { type: 'stun', player: ME, pos: { x: 3, y: 5, z: 2 }, strength: 12 }), fell(19.9), out(20)],
      ctx(),
    );
    expect(c).toEqual({ kind: 'obstacle', obstacleType: 'sweeperArm', via: 'knock', at: 17.2 });
    expect(causeText(c, String)).toBe('Knocked off by a sweeper');
  });

  it('blames a bounce off a named obstacle', () => {
    const c = attributeElimination(
      [at(18, { type: 'bounce', player: ME, pos: P, obstacle: 'boing-1' }), fell(19.8), out(20)],
      ctx({ obstacles: [PAD] }),
    );
    expect(c).toMatchObject({ kind: 'obstacle', obstacleType: 'bouncePad', via: 'bounce', at: 18 });
    expect(causeText(c, String)).toBe('Launched off by a boing pad');
  });

  it('blames the grabber of a grab that carried the player off (released or still held)', () => {
    const released = attributeElimination(
      [
        at(16, { type: 'grabStart', player: 7, target: ME, targetKind: 'player' }),
        at(18.5, { type: 'grabEnd', player: 7, target: ME, reason: 'release' }),
        fell(19.9),
        out(20),
      ],
      ctx({ obstacles: [] }),
    );
    expect(released).toEqual({ kind: 'grabbed', by: 7, at: 18.5 });
    expect(causeText(released, (id) => `Bean${id}`)).toBe('Grabbed by Bean7');
    expect(causeFocusPlayer(released, ME)).toBe(7);

    const held = attributeElimination(
      [at(19, { type: 'grabStart', player: 4, target: ME, targetKind: 'player' }), fell(19.9), out(20)],
      ctx({ obstacles: [] }),
    );
    expect(held).toMatchObject({ kind: 'grabbed', by: 4 });
  });

  it('ignores a grab that ended long before the fall', () => {
    const c = attributeElimination(
      [
        at(16, { type: 'grabStart', player: 7, target: ME, targetKind: 'player' }),
        at(16.4, { type: 'grabEnd', player: 7, target: ME, reason: 'broken' }),
        fell(19.9),
        out(20),
      ],
      ctx({ obstacles: [] }),
    );
    expect(c).toEqual({ kind: 'fell', at: 19.9 });
  });

  it('blames a diving player for a stun away from any hazard', () => {
    const c = attributeElimination(
      [
        at(18.5, { type: 'dive', player: 3, pos: { x: 50.5, y: 5, z: 0 } }),
        at(18.9, { type: 'stun', player: ME, pos: { x: 51, y: 5, z: 0.5 }, strength: 9 }),
        fell(19.8),
        out(20),
      ],
      ctx(),
    );
    expect(c).toEqual({ kind: 'bumped', by: 3, at: 18.9 });
    expect(causeText(c, (id) => `P${id}`)).toBe('Bumped off by P3');
  });

  it('blames the floor when nearby tiles dropped just before the fall, never far-away ones', () => {
    const near = attributeElimination(
      [at(19, { type: 'tileFell', obstacle: 'tiles-1', tile: 4 }), fell(19.7), out(20)],
      ctx(),
    );
    expect(near).toEqual({ kind: 'floor', at: 19 });
    expect(causeText(near, String)).toBe('The floor dropped away');
    const far = attributeElimination(
      [at(19, { type: 'tileFell', obstacle: 'tiles-far', tile: 4 }), fell(19.7), out(20)],
      ctx(),
    );
    expect(far.kind).toBe('fell');
  });

  it('calls an unexplained fall in a logic round a wrong tile, elsewhere a plain fall', () => {
    expect(attributeElimination([fell(19.9), out(20)], ctx({ roundType: 'logic' }))).toEqual({
      kind: 'wrongTile',
      at: 19.9,
    });
    const plain = attributeElimination([fell(19.9), out(20)], ctx());
    expect(plain).toEqual({ kind: 'fell', at: 19.9 });
    expect(causeText(plain, String)).toBe('Fell off the course');
  });

  it('falls back to generic when two different causes are a toss-up', () => {
    const c = attributeElimination(
      [
        at(18.6, { type: 'grabStart', player: 5, target: ME, targetKind: 'player' }),
        at(18.8, { type: 'grabEnd', player: 5, target: ME, reason: 'broken' }),
        at(18.8 + CAUSE_AMBIGUOUS_S / 2, {
          type: 'stun',
          player: ME,
          pos: { x: 2, y: 5, z: 2 },
          strength: 15,
        }),
        fell(19.9),
        out(20),
      ],
      ctx(),
    );
    expect(c.kind).toBe('fell');
  });

  it('keeps the latest cause when the earlier one is clearly older', () => {
    const c = attributeElimination(
      [
        at(17, { type: 'grabStart', player: 5, target: ME, targetKind: 'player' }),
        at(17.5, { type: 'grabEnd', player: 5, target: ME, reason: 'release' }),
        at(19, { type: 'stun', player: ME, pos: { x: 2, y: 5, z: 2 }, strength: 15 }),
        fell(19.9),
        out(20),
      ],
      ctx(),
    );
    expect(c.kind).toBe('obstacle');
  });

  it("ignores other players' events and stuns with no source", () => {
    const c = attributeElimination(
      [
        at(18, { type: 'grabStart', player: 5, target: 9, targetKind: 'player' }),
        at(18.2, { type: 'stun', player: 9, pos: P, strength: 15 }),
        at(19, { type: 'stun', player: ME, pos: { x: 90, y: 5, z: 90 }, strength: 9 }),
        fell(19.9),
        out(20),
      ],
      ctx(),
    );
    expect(c).toEqual({ kind: 'fell', at: 19 });
  });
});

describe('end-of-round causes', () => {
  it('race: missed the cut, with the gap when known', () => {
    const c = attributeElimination([out(60)], ctx({ roundType: 'race', eliminatedAt: 60, finishGap: 0.42 }));
    expect(c).toEqual({ kind: 'missedCut', gap: 0.42, at: 60 });
    expect(causeText(c, String)).toBe('Missed the cut by 0.4 s');
    const unknown = attributeElimination([out(60)], ctx({ roundType: 'race', eliminatedAt: 60 }));
    expect(causeText(unknown, String)).toBe("Didn't make the cut");
    const huge = attributeElimination([out(60)], ctx({ roundType: 'race', eliminatedAt: 60, finishGap: 40 }));
    expect(causeText(huge, String)).toBe("Didn't make the cut");
  });

  it('a mid-round knock-out without a fall (a forfeit) is generic, never a missed cut', () => {
    const c = attributeElimination([out(30)], ctx({ roundType: 'race', eliminatedAt: 30, atRoundEnd: false }));
    expect(c).toEqual({ kind: 'unknown', at: 30 });
  });

  it('a fall long before the end is not what knocked a racer out', () => {
    const c = attributeElimination([fell(30), out(60)], ctx({ roundType: 'race', eliminatedAt: 60 }));
    expect(c.kind).toBe('missedCut');
  });

  it('team: the final scores and the last score as the decisive moment', () => {
    const teams = new Map([
      [ME, 1],
      [3, 0],
    ]);
    const c = attributeElimination(
      [
        at(40, { type: 'score', team: 0, player: 3, delta: 1, total: 14 }),
        at(55, { type: 'score', team: 1, player: ME, delta: 1, total: 12 }),
        at(58, { type: 'score', team: 0, player: 3, delta: 1, total: 15 }),
        out(60),
      ],
      ctx({ roundType: 'team', eliminatedAt: 60, teams }),
    );
    expect(c).toEqual({ kind: 'teamLost', score: 12, best: 15, at: 58 });
    expect(causeText(c, String)).toBe('Your team lost 12–15');
  });

  it('team: a tie or missing team is ambiguous, so generic', () => {
    const teams = new Map([[ME, 1]]);
    const tie = attributeElimination(
      [
        at(40, { type: 'score', team: 0, player: 3, delta: 1, total: 5 }),
        at(41, { type: 'score', team: 1, player: ME, delta: 1, total: 5 }),
        out(60),
      ],
      ctx({ roundType: 'team', eliminatedAt: 60, teams }),
    );
    expect(tie.kind).toBe('unknown');
    expect(causeText(tie, String)).toBe('Knocked out');
    expect(attributeElimination([out(60)], ctx({ roundType: 'team', eliminatedAt: 60 })).kind).toBe(
      'unknown',
    );
  });

  it('hunt and other timed rounds: time ran out', () => {
    const c = attributeElimination([out(90)], ctx({ roundType: 'hunt', eliminatedAt: 90 }));
    expect(c).toEqual({ kind: 'timeUp', at: 90 });
    expect(causeText(c, String)).toBe('Time ran out');
  });
});

describe('helpers', () => {
  it('reach follows the longest sweeping parameter, with a floor and a cap', () => {
    expect(obstacleReach({ armLength: 7 })).toBe(9);
    expect(obstacleReach({ radiusX: 4, radiusZ: 11 })).toBe(13);
    expect(obstacleReach({})).toBe(6);
    expect(obstacleReach(undefined)).toBe(6);
    expect(obstacleReach({ length: 400 })).toBe(40);
    expect(obstacleReach({ armLength: 'long' })).toBe(6);
  });

  it('finish gap: distance to the nearest finish volume at running speed', () => {
    const finish = { position: { x: 0, y: 0, z: 100 }, size: { x: 10, y: 4, z: 2 } };
    expect(finishGapSeconds({ x: 0, y: 0, z: 91 }, [finish], 8)).toBeCloseTo(1);
    expect(finishGapSeconds({ x: 2, y: 0, z: 100 }, [finish], 8)).toBe(0);
    expect(finishGapSeconds({ x: 0, y: 0, z: 0 }, [], 8)).toBeNull();
  });

  it('names come from the caller, so masking is theirs', () => {
    const masked = causeText({ kind: 'grabbed', by: 4, at: 1 }, (id) => `Tumbler ${id + 1}`);
    expect(masked).toBe('Grabbed by Tumbler 5');
    expect(causeFocusPlayer({ kind: 'fell', at: 1 }, ME)).toBe(ME);
  });
});
