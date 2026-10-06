/**
 * The broadcast director: deterministic shot selection from round frames and
 * events — the establishing shot, leaders, close races, the qualifying
 * bubble, near-eliminations, team score swings, the final — and its comfort
 * rules (minimum and maximum holds, hysteresis, lingering on a knock-out,
 * the wide shot coming back when nothing happens).
 */
import { describe, expect, it } from 'vitest';
import {
  BroadcastDirector,
  DIRECTOR_TIMING,
  type DirectorFrame,
  type DirectorPlayer,
  type DirectorShot,
} from '../src/game/spectate/director.ts';

const T = DIRECTOR_TIMING;

function player(id: number, place: number, over: Partial<DirectorPlayer> = {}): DirectorPlayer {
  return { id, status: 'playing', place, progress: 1 - place * 0.05, team: -1, danger: 0, ...over };
}

function race(time: number, players: DirectorPlayer[], over: Partial<DirectorFrame> = {}): DirectorFrame {
  return { time, kind: 'race', isFinal: false, qualifyTarget: 10, players, ...over };
}

/** Runs the director at 4 Hz from `from` to `to`, returning every distinct shot in order. */
function run(
  d: BroadcastDirector,
  from: number,
  to: number,
  frame: (t: number) => DirectorFrame,
): { at: number; shot: DirectorShot }[] {
  const out: { at: number; shot: DirectorShot }[] = [];
  let last = '';
  for (let t = from; t <= to + 1e-9; t += 0.25) {
    const shot = d.update(frame(t));
    const key = JSON.stringify(shot);
    if (key !== last) out.push({ at: t, shot });
    last = key;
  }
  return out;
}

const field = [player(1, 1), player(2, 2), player(3, 3), player(4, 4)];

describe('broadcast director', () => {
  it('opens on the course overview, then cuts to the leader', () => {
    const d = new BroadcastDirector();
    d.reset(0);
    const shots = run(d, 0, 6, (t) => race(t, field));
    expect(shots[0]!.shot).toEqual({ kind: 'overview', reason: 'opening' });
    expect(shots[1]).toEqual({ at: T.opening, shot: { kind: 'follow', id: 1, reason: 'leader' } });
  });

  it('is deterministic: the same frames always give the same cut list', () => {
    const frame = (t: number): DirectorFrame =>
      race(
        t,
        field.map((p) => ({ ...p, progress: p.progress + Math.sin(t + p.id) * 0.02 })),
      );
    const a = run(new BroadcastDirector(), 0, 60, frame);
    const b = run(new BroadcastDirector(), 0, 60, frame);
    expect(a).toEqual(b);
  });

  it('never cuts faster than the minimum hold', () => {
    const d = new BroadcastDirector();
    // The lead changes hands every half second: a naive director would strobe.
    const shots = run(d, 0, 60, (t) => {
      const flip = Math.floor(t * 2) % 2 === 0;
      return race(t, [player(flip ? 1 : 2, 1), player(flip ? 2 : 1, 2), player(3, 3)]);
    });
    for (let i = 1; i < shots.length; i++)
      expect(shots[i]!.at - shots[i - 1]!.at).toBeGreaterThanOrEqual(T.minHold - 1e-9);
  });

  it('switches to a neck-and-neck race only when it clearly beats the current shot', () => {
    const d = new BroadcastDirector();
    run(d, 0, 10, (t) => race(t, field));
    expect(d.shot).toMatchObject({ kind: 'follow', id: 1 });
    // 3rd and 4th are inside the close gap: they outrank a lone leader.
    const close = [
      player(1, 1, { progress: 0.9 }),
      player(2, 2, { progress: 0.7 }),
      player(3, 3, { progress: 0.6 }),
      player(4, 4, { progress: 0.595 }),
    ];
    const shots = run(d, 10.25, 20, (t) => race(t, close));
    expect(shots.at(-1)!.shot).toMatchObject({ kind: 'follow', reason: 'closeRace' });
  });

  it('watches the qualifying bubble in a race', () => {
    const d = new BroadcastDirector();
    const players = Array.from({ length: 12 }, (_, i) => player(i + 1, i + 1, { progress: 0.9 - i * 0.05 }));
    const scored = d.scores(race(5, players, { qualifyTarget: 10 }));
    const bubble = scored.filter((s) => s.reason === 'bubble').map((s) => s.id);
    expect(bubble).toEqual(expect.arrayContaining([10, 11]));
  });

  it('follows a Tumbler about to fall out in survival rounds', () => {
    const d = new BroadcastDirector();
    const players = [player(1, 1), player(2, 2), player(3, 3, { danger: 1 })];
    run(d, 0, T.opening + 0.25, (t) => ({ ...race(t, players), kind: 'survival' }));
    expect(d.shot).toEqual({ kind: 'follow', id: 3, reason: 'danger' });
  });

  it('holds on a followed player who is knocked out long enough to show it, then moves on', () => {
    const d = new BroadcastDirector();
    run(d, 0, 6, (t) => race(t, field));
    expect(d.shot).toMatchObject({ kind: 'follow', id: 1 });
    d.note({ kind: 'eliminated', id: 1 }, 6.25);
    const out = field.map((p) => (p.id === 1 ? { ...p, status: 'eliminated' as const } : p));
    const shots = run(d, 6.25, 12, (t) => race(t, out));
    expect(shots[0]!.shot).toMatchObject({ kind: 'follow', id: 1 });
    const next = shots.find((s) => s.shot.kind === 'follow' && s.shot.id !== 1)!;
    expect(next.at - 6.25).toBeGreaterThanOrEqual(T.eliminatedLinger - 1e-9);
    expect(next.at - 6.25).toBeLessThan(T.eliminatedLinger + 0.5);
  });

  it('rotates to the next story after the maximum hold', () => {
    const d = new BroadcastDirector();
    const shots = run(d, 0, T.opening + T.maxHold + 1, (t) => race(t, field));
    const follows = shots.filter((s) => s.shot.kind === 'follow');
    expect(follows.length).toBeGreaterThanOrEqual(2);
    expect(follows[1]!.at - follows[0]!.at).toBeCloseTo(T.maxHold, 5);
  });

  it('brings back the wide shot when nothing interesting happens for a while', () => {
    const d = new BroadcastDirector();
    // Nobody leads clearly (no places), nobody is in danger: a quiet survival round.
    const quiet = [player(1, 0), player(2, 0), player(3, 0)];
    const shots = run(d, 0, 40, (t) => ({ ...race(t, quiet), kind: 'survival' }));
    const quietOverview = shots.find((s) => s.shot.kind === 'overview' && s.shot.reason === 'quiet');
    expect(quietOverview).toBeDefined();
    expect(quietOverview!.at).toBeGreaterThanOrEqual(T.quietAfter - 1e-9);
  });

  it('follows the team that just scored', () => {
    const d = new BroadcastDirector();
    const players = [
      player(1, 1, { team: 0 }),
      player(2, 2, { team: 0 }),
      player(3, 3, { team: 1 }),
      player(4, 4, { team: 1 }),
    ];
    run(d, 0, 9, (t) => ({ ...race(t, players), kind: 'team' }));
    d.note({ kind: 'teamScore', team: 1, delta: 2 }, 9.25);
    run(d, 9.25, 12, (t) => ({ ...race(t, players), kind: 'team' }));
    expect(d.shot).toEqual({ kind: 'follow', id: 3, reason: 'teamSwing' });
  });

  it('calls the final by name', () => {
    const d = new BroadcastDirector();
    run(d, 0, 6, (t) => race(t, field, { isFinal: true, qualifyTarget: 1 }));
    expect(d.shot).toMatchObject({ kind: 'follow', id: 1, reason: 'final' });
  });

  it('breaks near-ties toward party and club members', () => {
    const d = new BroadcastDirector({ prefer: new Set([2]) });
    const tied = [player(1, 0), player(2, 0), player(3, 0)];
    expect(d.scores(race(5, tied, { kind: 'survival' }))[0]!.id).toBe(2);
  });
});
