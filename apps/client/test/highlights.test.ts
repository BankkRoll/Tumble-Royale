/**
 * Automatic highlights: each kind is detected from an event stream and scored
 * by the model (local and final bonuses, closeness scaling), segments stay
 * 3–5 s inside the recording, the top-N pick is deterministic whatever the
 * input order (ties included), keeps variety and drops overlaps, the show's
 * reel is bounded, and finished rounds reach it through the live recorder.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@tumble/sim';
import {
  HIGHLIGHTS_PER_SHOW,
  HIGHLIGHT_MAX_S,
  HIGHLIGHT_MIN_S,
  HighlightReel,
  compareHighlights,
  detectHighlights,
  highlightSegment,
  selectTopHighlights,
  type Highlight,
  type HighlightEvent,
  type HighlightRound,
} from '../src/game/replay/highlights.ts';
import { ui, uiEvents } from '@tumble/ui';
import { ReplayController, type ReplayControllerDeps } from '../src/game/replay/controller.ts';
import type { ReplayData } from '../src/game/replay/format.ts';
import { ReplayLibrary } from '../src/game/replay/library.ts';
import { LiveRecording, type LiveRoundInfo } from '../src/game/replay/live.ts';
import { ReplayRecorder } from '../src/game/replay/recorder.ts';
import type { RoundSource } from '../src/game/round/source.ts';

const ME = 0;

function round(
  over: Partial<HighlightRound['header']> = {},
  extra: Partial<HighlightRound> = {},
): HighlightRound {
  return {
    key: '1:0',
    header: {
      roundIndex: 0,
      roundName: 'Gumdrop Gauntlet',
      roundType: 'race',
      isFinal: false,
      qualifyTarget: 3,
      localId: ME,
      players: [0, 1, 2, 3, 4].map((id) => ({
        id,
        name: `P${id}`,
        isBot: id !== ME,
        team: id % 2,
        loadout: null,
      })),
      duration: 90,
      startTime: -3,
      ...over,
    },
    timeLimit: 80,
    baseType: over.roundType ?? 'race',
    ...extra,
  };
}

function ev(t: number, e: SimEvent): HighlightEvent {
  return { t, e };
}

const q = (t: number, player: number, place: number): HighlightEvent =>
  ev(t, { type: 'qualified', player, place });

function kinds(list: readonly Highlight[]): string[] {
  return list.map((h) => h.kind);
}

describe('detection and scoring', () => {
  it('a won final tops everything, with local and final bonuses', () => {
    const r = round({ isFinal: true, roundType: 'final', qualifyTarget: 1 }, { baseType: 'final' });
    const [h] = detectHighlights(r, [q(50, ME, 1)]);
    expect(h).toMatchObject({ kind: 'finalWin', player: ME, local: true });
    expect(h!.score).toBeCloseTo(100 * 1.5 * 1.2);
    const other = detectHighlights(r, [q(50, 3, 1)])[0]!;
    expect(other.score).toBeCloseTo(100 * 1.2);
    expect(other.local).toBe(false);
  });

  it('photo finishes score higher the closer they are', () => {
    const tight = detectHighlights(round(), [q(30, 1, 1), q(30.05, 2, 2)]).find(
      (h) => h.kind === 'closeFinish',
    );
    const loose = detectHighlights(round(), [q(30, 1, 1), q(30.3, 2, 2)]).find(
      (h) => h.kind === 'closeFinish',
    );
    expect(tight).toMatchObject({ player: 2, other: 1, value: 0.05 });
    expect(tight!.score).toBeGreaterThan(loose!.score);
    expect(detectHighlights(round(), [q(30, 1, 1), q(31, 2, 2)]).some((h) => h.kind === 'closeFinish')).toBe(
      false,
    );
  });

  it('last-second qualifies: near the time limit, or the last spot', () => {
    // Recording time 81 = round time 78: 2 s left of 80.
    const late = detectHighlights(round(), [q(81, ME, 1)]).find((h) => h.kind === 'lastSecondQualify');
    expect(late).toMatchObject({ local: true, value: 2 });
    const lastSpot = detectHighlights(round(), [q(20, 4, 3)]).find((h) => h.kind === 'lastSecondQualify');
    expect(lastSpot).toMatchObject({ player: 4, value: 0 });
    expect(detectHighlights(round(), [q(20, 4, 2)]).some((h) => h.kind === 'lastSecondQualify')).toBe(false);
  });

  it('big falls come from hard landings', () => {
    const list = detectHighlights(round(), [
      ev(10, { type: 'land', player: 2, pos: { x: 0, y: 0, z: 0 }, impact: 24 }),
      ev(12, { type: 'land', player: 3, pos: { x: 0, y: 0, z: 0 }, impact: 9 }),
    ]);
    expect(kinds(list)).toEqual(['bigFall']);
    expect(list[0]!.player).toBe(2);
  });

  it('grab chains of three or more, from whoever started the line', () => {
    const list = detectHighlights(round(), [
      ev(10, { type: 'grabStart', player: 2, target: 3, targetKind: 'player' }),
      ev(11, { type: 'grabStart', player: 1, target: 2, targetKind: 'player' }),
      ev(11.5, { type: 'grabStart', player: 4, target: 1, targetKind: 'player' }),
    ]);
    const chains = list.filter((h) => h.kind === 'chainGrab');
    expect(chains.map((h) => [h.player, h.other, h.value])).toEqual([
      [1, 3, 3],
      [4, 3, 4],
    ]);
    expect(chains[1]!.score).toBeGreaterThan(chains[0]!.score);
    // A released grab breaks the chain.
    const broken = detectHighlights(round(), [
      ev(10, { type: 'grabStart', player: 2, target: 3, targetKind: 'player' }),
      ev(10.5, { type: 'grabEnd', player: 2, target: 3, reason: 'release' }),
      ev(11, { type: 'grabStart', player: 1, target: 2, targetKind: 'player' }),
    ]);
    expect(broken.some((h) => h.kind === 'chainGrab')).toBe(false);
  });

  it('comebacks: qualifying after repeated setbacks', () => {
    const list = detectHighlights(round(), [
      ev(10, { type: 'fellOut', player: ME, pos: { x: 0, y: -10, z: 0 } }),
      ev(14, { type: 'stun', player: ME, pos: { x: 0, y: 0, z: 0 }, strength: 9 }),
      ev(18, { type: 'grabStart', player: 3, target: ME, targetKind: 'player' }),
      q(30, ME, 2),
    ]);
    expect(list.find((h) => h.kind === 'comeback')).toMatchObject({ player: ME, value: 3, local: true });
    // Setbacks long before don't count.
    const stale = detectHighlights(round(), [
      ev(1, { type: 'fellOut', player: 2, pos: { x: 0, y: 0, z: 0 } }),
      q(60, 2, 1),
    ]);
    expect(stale.some((h) => h.kind === 'comeback')).toBe(false);
  });

  it('clutch survival: ledge saves and the last few survivors', () => {
    const r = round({ roundType: 'survival' }, { baseType: 'survival' });
    const list = detectHighlights(r, [
      ev(20, { type: 'grabStart', player: 2, target: -1, targetKind: 'ledge' }),
      ev(30, { type: 'grabStart', player: 3, target: -1, targetKind: 'ledge' }),
      ev(31, { type: 'fellOut', player: 3, pos: { x: 0, y: -10, z: 0 } }),
      q(83, ME, 1),
      q(83, 2, 2),
    ]);
    const clutch = list.filter((h) => h.kind === 'clutchSurvival');
    expect(clutch.map((h) => [h.player, h.value])).toEqual([
      [2, 0],
      [ME, 2],
      [2, 2],
    ]);
  });

  it('team rounds: the last lead change is the decider, heavier when late', () => {
    const r = round({ roundType: 'team' }, { baseType: 'team' });
    const list = detectHighlights(r, [
      ev(10, { type: 'score', team: 0, player: 2, delta: 1, total: 1 }),
      ev(20, { type: 'score', team: 1, player: 1, delta: 2, total: 2 }),
      ev(80, { type: 'score', team: 0, player: 4, delta: 2, total: 3 }),
    ]);
    const d = list.filter((h) => h.kind === 'decisiveScore');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ player: 4, value: 3, t: 80 });
    expect(d[0]!.score).toBeCloseTo(38 * 1.5);
  });

  it('segments stay 3–5 s and inside the recording', () => {
    for (const [t, dur] of [
      [0.2, 90],
      [45, 90],
      [89.9, 90],
      [1, 2.5],
    ] as const) {
      const s = highlightSegment('closeFinish', t, dur);
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.start + s.length).toBeLessThanOrEqual(dur + 1e-9);
      if (dur >= HIGHLIGHT_MIN_S) {
        expect(s.length).toBeGreaterThanOrEqual(HIGHLIGHT_MIN_S);
        expect(s.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_S);
      }
    }
  });
});

function fake(over: Partial<Highlight>): Highlight {
  const base: Highlight = {
    id: '',
    key: 'k0',
    roundIndex: 0,
    roundName: 'R',
    isFinal: false,
    kind: 'bigFall',
    score: 10,
    t: 10,
    start: 8,
    length: 4,
    player: 1,
    other: -1,
    value: 0,
    local: false,
  };
  const h = { ...base, ...over };
  h.id = over.id ?? `${h.key}:${h.kind}:${Math.round(h.t * 100)}:${h.player}`;
  return h;
}

/** Deterministic shuffle (LCG). */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const a = [...list];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe('top-N selection', () => {
  const pool = [
    fake({ kind: 'finalWin', score: 180, key: 'k2', roundIndex: 2, t: 40, start: 36 }),
    fake({ kind: 'closeFinish', score: 60, key: 'k0', t: 30, start: 27 }),
    fake({ kind: 'closeFinish', score: 60, key: 'k1', roundIndex: 1, t: 30, start: 27 }),
    fake({ kind: 'closeFinish', score: 60, key: 'k1', roundIndex: 1, t: 50, start: 47 }),
    fake({ kind: 'bigFall', score: 30, key: 'k0', t: 60, start: 57 }),
    fake({ kind: 'bigFall', score: 29, key: 'k1', roundIndex: 1, t: 70, start: 67 }),
    fake({ kind: 'bigFall', score: 28, key: 'k1', roundIndex: 1, t: 80, start: 77 }),
    fake({ kind: 'chainGrab', score: 45, key: 'k0', t: 15, start: 13 }),
    fake({ kind: 'comeback', score: 45, key: 'k0', t: 15, start: 12, player: 3 }),
  ];

  it('is deterministic whatever the input order', () => {
    const want = selectTopHighlights(pool).map((h) => h.id);
    for (let seed = 1; seed < 20; seed++)
      expect(selectTopHighlights(shuffled(pool, seed)).map((h) => h.id)).toEqual(want);
  });

  it('breaks ties by round, then time, then kind', () => {
    const top = selectTopHighlights(pool);
    expect(top[0]!.kind).toBe('finalWin');
    const ties = top.filter((h) => h.score === 60);
    expect(ties.map((h) => [h.roundIndex, h.t])).toEqual([
      [0, 30],
      [1, 30],
    ]);
    expect(
      compareHighlights(fake({ kind: 'comeback', score: 5 }), fake({ kind: 'bigFall', score: 5 })),
    ).toBeLessThan(0);
  });

  it('keeps variety: two of a kind while others are left, then fills from the spares', () => {
    const top = selectTopHighlights(pool, 6);
    expect(top).toHaveLength(6);
    expect(top.filter((h) => h.kind === 'closeFinish')).toHaveLength(2);
    const all = selectTopHighlights(pool, 9);
    expect(all.filter((h) => h.kind === 'closeFinish').length).toBeGreaterThan(2);
  });

  it('drops a segment overlapping a better one in the same recording', () => {
    const top = selectTopHighlights(pool, 9);
    const both = top.filter((h) => h.key === 'k0' && h.t === 15);
    expect(both).toHaveLength(1);
  });
});

describe('the show reel', () => {
  it('stays bounded over a long show', () => {
    const reel = new HighlightReel();
    for (let r = 0; r < 50; r++)
      reel.add(
        Array.from({ length: 20 }, (_, i) =>
          fake({
            key: `k${r}`,
            roundIndex: r,
            kind: i % 2 ? 'bigFall' : 'chainGrab',
            score: i + r,
            t: i * 6,
            start: i * 6,
          }),
        ),
      );
    expect(reel.list().length).toBeLessThanOrEqual(HIGHLIGHTS_PER_SHOW);
    expect(reel.list()[0]!.roundIndex).toBe(49);
  });

  it('re-recording a round replaces its highlights; evicted rounds drop out; clear empties', () => {
    const reel = new HighlightReel(4);
    reel.add([
      fake({ key: 'a', score: 50 }),
      fake({ key: 'a', kind: 'comeback', score: 40, t: 40, start: 38 }),
    ]);
    reel.add([fake({ key: 'b', score: 30 })]);
    reel.add([fake({ key: 'a', kind: 'chainGrab', score: 5 })]);
    expect(reel.list().map((h) => [h.key, h.kind])).toEqual([
      ['b', 'bigFall'],
      ['a', 'chainGrab'],
    ]);
    reel.retain(new Set(['a']));
    expect(reel.list().map((h) => h.key)).toEqual(['a']);
    expect(reel.get(reel.list()[0]!.id)).toBeDefined();
    reel.clear();
    expect(reel.list()).toHaveLength(0);
  });
});

describe('replay controller: gating and publishing', () => {
  function rec(index: number, events: { t: number; e: SimEvent }[]): ReplayData {
    const r = new ReplayRecorder({
      protocolVersion: 6,
      recordedAt: '2026-10-06T12:00:00.000Z',
      online: false,
      showName: 'Main Show',
      roundId: 'gumdrop-gauntlet',
      roundName: 'Gumdrop Gauntlet',
      roundType: 'race',
      roundIndex: index,
      isFinal: false,
      seed: 1,
      stage: 1,
      variationId: null,
      qualifyTarget: 2,
      localId: ME,
      players: [0, 1, 2].map((id) => ({ id, name: `P${id}`, isBot: id > 0, team: -1, loadout: null })),
    });
    let ei = 0;
    for (let t = 0; t < 40; t += 1 / 20) {
      r.frame(
        t,
        (id, out) => Object.assign(out, { x: id, y: 0, z: t, facing: 0, state: 0, flags: 0 }) && true,
        null,
        null,
      );
      while (ei < events.length && events[ei]!.t <= t) r.event(t, events[ei++]!.e);
    }
    return r.finish({ qualified: [1, 2], eliminated: [ME] })!;
  }

  function controller(flags: { replays: boolean; setting: boolean }): {
    c: ReplayController;
    tracked: { name: string; props: Record<string, unknown> }[];
  } {
    const tracked: { name: string; props: Record<string, unknown> }[] = [];
    const c = new ReplayController({
      director: {} as ReplayControllerDeps['director'],
      logMemory: () => undefined,
      replaysEnabled: () => flags.replays,
      eliminationReplay: () => flags.setting,
      track: (name, props) => tracked.push({ name, props }),
    } as unknown as ReplayControllerDeps);
    return { c, tracked };
  }

  it('elimination replays need both the flag and the setting', () => {
    const f = { replays: true, setting: true };
    const { c } = controller(f);
    expect(c.eliminations.enabled()).toBe(true);
    f.setting = false;
    expect(c.eliminations.enabled()).toBe(false);
    f.setting = true;
    f.replays = false;
    expect(c.eliminations.enabled()).toBe(false);
    c.dispose();
  });

  it('stored rounds feed the reel; the UI gets it only while replays are on', () => {
    const f = { replays: true, setting: true };
    const { c, tracked } = controller(f);
    c.live.showStarted();
    c.library.add(rec(0, [{ t: 30, e: { type: 'qualified', player: 1, place: 1 } }]));
    const entry = c.library.add(
      rec(1, [
        { t: 20, e: { type: 'qualified', player: 1, place: 1 } },
        { t: 20.05, e: { type: 'qualified', player: 2, place: 2 } },
      ]),
    );
    (c as unknown as { findHighlights(e: unknown): void }).findHighlights(entry);
    (c as unknown as { publish(): void }).publish();
    const published = ui.getState().highlights;
    expect(published.map((h) => h.kind)).toContain('closeFinish');
    expect(published[0]?.player).toMatchObject({ name: expect.any(String), isLocal: false });
    uiEvents.emit('highlightShare', { id: published[0]!.id });
    expect(tracked).toEqual([
      { name: 'highlight.share', props: { kind: published[0]!.kind, local: false, final: false } },
    ]);
    f.replays = false;
    (c as unknown as { publish(): void }).publish();
    expect(ui.getState().highlights).toEqual([]);
    // Playing a highlight while replays are off does nothing (no viewer, no analytics).
    uiEvents.emit('highlightPlay', { ids: [published[0]!.id] });
    expect(tracked).toHaveLength(1);
    // A new show starts clean.
    f.replays = true;
    c.live.showStarted();
    expect(ui.getState().highlights).toEqual([]);
    c.dispose();
  });
});

describe('live recorder hooks', () => {
  function source(clock: { t: number }): RoundSource {
    return {
      sim: {
        variationId: null,
        mutatorId: null,
        getObstacleNetStates: () => new Map(),
      } as unknown as RoundSource['sim'],
      players: [],
      localId: ME,
      alive: true,
      renderTime: () => clock.t,
      sample: (id, out) => {
        out.x = id;
        out.y = 0;
        out.z = clock.t;
        out.facing = 0;
        out.state = 0;
        out.stateTime = 0;
        out.grounded = true;
        out.flags = 0;
        out.emote = 0;
        return true;
      },
    };
  }

  function info(index: number): LiveRoundInfo {
    return {
      showName: 'Main Show',
      online: false,
      roundIndex: index,
      isFinal: false,
      round: { id: 'gumdrop-gauntlet', name: 'Gumdrop Gauntlet', type: 'race' } as LiveRoundInfo['round'],
      seed: 3,
      stage: 1,
      qualifyTarget: 2,
      localId: ME,
      players: [0, 1].map((id) => ({ id, name: `P${id}`, isBot: id > 0, team: -1, loadout: null })),
    };
  }

  it('hands each stored round over and serves recordings by round index', () => {
    const lib = new ReplayLibrary();
    const stored: string[] = [];
    const live = new LiveRecording(
      lib,
      () => undefined,
      (e) => stored.push(e.key),
    );
    live.showStarted();
    const clock = { t: 0 };
    live.roundStarted(info(0), source(clock), null);
    for (; clock.t < 3; clock.t += 1 / 30) live.frame();
    expect(live.recordingOf(0)?.header.frameCount).toBeGreaterThan(1);
    live.roundEnded({ qualified: [ME], eliminated: [1] });
    expect(stored).toHaveLength(1);
    expect(live.recordingOf(0)?.header.outcome).toEqual({ qualified: [ME], eliminated: [1] });
    expect(live.recordingOf(5)).toBeNull();
  });

  it('remembers the party mates of the show for Streamer Mode, and forgets them with the show', () => {
    const live = new LiveRecording(new ReplayLibrary(), () => undefined);
    live.showStarted();
    live.roundStarted({ ...info(0), partyMates: [1] }, source({ t: 0 }), null);
    expect([...live.partyMates]).toEqual([1]);
    live.showStarted();
    expect(live.partyMates.size).toBe(0);
  });
});
