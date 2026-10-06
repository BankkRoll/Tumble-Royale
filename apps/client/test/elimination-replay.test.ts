/**
 * "How you went out" end to end below the renderer: the window and speed
 * plan picked from a full offline recording, the online ring buffer (bounds,
 * fidelity, turning it into a playable recording), the session glue (feature
 * gating, zero work when off, one replay per knock-out) and the player's
 * states (loading, playing with slow motion, still frame, skip by intent /
 * key / pad, screen changes, the viewer winning, analytics).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterState, type SimEvent } from '@tumble/sim';
import { ui, uiEvents } from '@tumble/ui';
import { ReplayClock } from '../src/game/replay/clock.ts';
import type { CauseObstacle } from '../src/game/replay/elimCause.ts';
import {
  ELIM_SLOW_RATE,
  ELIM_TAIL_S,
  ELIM_TARGET_REAL_S,
  ELIM_WINDOW_S,
  planElimPlayback,
  planElimination,
  playbackRateAt,
  playbackRealSeconds,
  selectEliminationWindow,
  timedEvents,
} from '../src/game/replay/elimination.ts';
import {
  ELIM_LOAD_TIMEOUT_S,
  ELIM_STILL_S,
  EliminationPlayer,
  type EliminationPlayerDeps,
  type EliminationReplays,
} from '../src/game/replay/elimPlayer.ts';
import type { ReplayData } from '../src/game/replay/format.ts';
import { ReplayRecorder, type RecordablePlayer, type ReplayMeta } from '../src/game/replay/recorder.ts';
import { ReplayTape, TAPE_SECONDS } from '../src/game/replay/tape.ts';
import { ReplayTimeline, createCursor } from '../src/game/replay/timeline.ts';
import type { ReplayView } from '../src/game/replay/view.ts';
import { SessionElimination, eliminationFacts } from '../src/game/show/elimination.ts';
import type { LiveRoundInfo } from '../src/game/replay/live.ts';
import type { RoundSource } from '../src/game/round/source.ts';
import { installFakeDom, fakePad, setButton } from './fakeDom.ts';

const ME = 0;
const START = -3;
const SWEEPER: CauseObstacle = { id: 'sweep-1', type: 'sweeperArm', x: 0, y: 2, z: 100, reach: 9 };

function meta(localId = ME, online = false): ReplayMeta {
  return {
    protocolVersion: 6,
    recordedAt: '2026-10-06T12:00:00.000Z',
    online,
    showName: 'Main Show',
    roundId: 'gumdrop-gauntlet',
    roundName: 'Gumdrop Gauntlet',
    roundType: 'survival',
    roundIndex: 1,
    isFinal: false,
    seed: 7,
    stage: 1,
    variationId: null,
    qualifyTarget: 2,
    localId,
    players: [0, 1, 2, 3].map((id) => ({ id, name: `P${id}`, isBot: id !== 0, team: -1, loadout: null })),
  };
}

/** Where player `id` is at round time `t` (the local player goes over the edge at `outAt`). */
function truth(id: number, t: number, outAt: number, out: RecordablePlayer): boolean {
  if (id === ME && t > outAt + 0.5) return false;
  out.x = id * 2;
  out.y = id === ME && t > outAt - 1 ? 2 - (t - (outAt - 1)) * 10 : 2;
  out.z = Math.max(0, t) * 2;
  out.vx = 0;
  out.vy = 0;
  out.vz = 2;
  out.facing = 0;
  out.state = CharacterState.Run;
  out.stateTime = 0.5;
  out.grounded = true;
  out.flags = 0;
  out.emote = 0;
  return true;
}

/** Local knock-out by a sweeper at round time `stunAt`, falling out at `outAt`. */
function knockoutEvents(stunAt: number, outAt: number): { t: number; e: SimEvent }[] {
  return [
    { t: stunAt - 3, e: { type: 'jump', player: 2, pos: { x: 4, y: 2, z: 10 } } },
    { t: stunAt, e: { type: 'stun', player: ME, pos: { x: 1, y: 2, z: 101 }, strength: 12 } },
    { t: outAt, e: { type: 'fellOut', player: ME, pos: { x: 0, y: -20, z: 102 } } },
    { t: outAt, e: { type: 'eliminated', player: ME, place: 4 } },
  ];
}

/** A full offline recording of `length` round seconds (plus the countdown). */
function recording(length: number, stunAt: number, outAt: number): ReplayData {
  const rec = new ReplayRecorder(meta());
  const events = knockoutEvents(stunAt, outAt);
  let ei = 0;
  for (let t = START; t <= length; t += 1 / 60) {
    rec.frame(t, (id, out) => truth(id, t, outAt, out), null, null);
    while (ei < events.length && (events[ei] as { t: number }).t <= t) {
      const ev = events[ei++] as { t: number; e: SimEvent };
      rec.event(t, ev.e);
    }
  }
  return rec.finish({ qualified: [1, 2], eliminated: [3, ME] }) as ReplayData;
}

const facts = { obstacles: [SWEEPER], teams: new Map<number, number>(), finishGap: null };

// -----------------------------------------------------------------------------
// Window and speed plan
// -----------------------------------------------------------------------------

describe('window selection', () => {
  it('ends just after the knock-out and covers the last ~7.5 s', () => {
    const w = selectEliminationWindow(60, 40, 38);
    expect(w).toEqual({ start: 40 + ELIM_TAIL_S - ELIM_WINDOW_S, end: 40 + ELIM_TAIL_S, focus: 38 });
  });

  it('clamps to the recording at both ends', () => {
    expect(selectEliminationWindow(4, 3.5, 2)).toEqual({ start: 0, end: 4, focus: 2 });
    expect(selectEliminationWindow(60, 60, 59).end).toBe(60);
  });

  it('keeps a beat of lead-in before an early decisive moment', () => {
    const w = selectEliminationWindow(60, 40, 33);
    expect(w.start).toBeLessThanOrEqual(31.5);
    expect(w.focus).toBe(33);
  });

  it('plays in about five seconds, slow around the decisive moment', () => {
    const p = planElimPlayback(selectEliminationWindow(60, 40, 38));
    expect(playbackRealSeconds(p)).toBeGreaterThan(ELIM_TARGET_REAL_S - 0.6);
    expect(playbackRealSeconds(p)).toBeLessThan(ELIM_TARGET_REAL_S + 0.6);
    expect(playbackRateAt(p, 38)).toBe(ELIM_SLOW_RATE);
    expect(playbackRateAt(p, p.start)).toBe(p.fastRate);
    expect(p.fastRate).toBeGreaterThanOrEqual(1);
    expect(p.fastRate).toBeLessThanOrEqual(3);
    // A short window simply plays at normal speed outside the slow-motion stretch.
    expect(planElimPlayback({ start: 0, end: 2, focus: 1 }).fastRate).toBe(1);
  });
});

describe('offline: planning from the full recording', () => {
  const data = recording(60, 37.5, 40);

  it('finds the knock-out, attributes it and selects the window around it', () => {
    const plan = planElimination(data, facts);
    expect(plan).not.toBeNull();
    const p = plan!.playback;
    const elimRel = 40 - data.header.startTime;
    expect(plan!.cause).toMatchObject({ kind: 'obstacle', obstacleType: 'sweeperArm' });
    expect(p.end).toBeCloseTo(elimRel + ELIM_TAIL_S, 1);
    expect(p.end - p.start).toBeCloseTo(ELIM_WINDOW_S, 1);
    expect(p.focus).toBeCloseTo(37.5 - data.header.startTime, 1);
    expect(plan!.follow).toBe(ME);
    // The window decodes: the local player is on screen at its start.
    const tl = new ReplayTimeline(data);
    const out = { ...emptySample() };
    expect(tl.samplePlayer(tl.slotOf(ME), tl.locate(p.start, createCursor()), out)).toBe(true);
  });

  it('reads events with their round times', () => {
    const ev = timedEvents(data);
    expect(ev.find((x) => x.e.type === 'eliminated')?.t).toBeCloseTo(40, 1);
  });

  it('declines spectated rounds and rounds without the knock-out', () => {
    const spectated = { ...data, header: { ...data.header, localId: -1 } };
    expect(planElimination(spectated, facts)).toBeNull();
    const clean = recording(30, 50, 55);
    expect(planElimination(clean, facts)).toBeNull();
  });
});

function emptySample(): RecordablePlayer {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: true,
    flags: 0,
    emote: 0,
  };
}

// -----------------------------------------------------------------------------
// Ring buffer
// -----------------------------------------------------------------------------

describe('ring buffer', () => {
  function feed(tape: ReplayTape, from: number, to: number, outAt: number, events = true): void {
    const evs = knockoutEvents(outAt - 2.5, outAt);
    let ei = 0;
    const net = new Map<string, number[]>([['tiles-1', [0, 0, 0]]]);
    for (let t = from; t <= to; t += 1 / 60) {
      net.set('tiles-1', [Math.floor(t), 1, 2]);
      if (tape.due(t)) tape.frame(t, (id, out) => truth(id, t, outAt, out), null, net);
      while (events && ei < evs.length && (evs[ei] as { t: number }).t <= t) {
        tape.event(t, (evs[ei++] as { e: SimEvent }).e);
      }
      if (events) tape.event(t, { type: 'jump', player: 3, pos: { x: 6, y: 2, z: t } });
    }
  }

  it('holds at most its capacity, oldest overwritten, at a constant size', () => {
    const tape = new ReplayTape([0, 1, 2, 3], TAPE_SECONDS, 20, 64);
    expect(tape.capacity).toBe(201);
    feed(tape, 0, 2, 100);
    const warm = tape.memoryBytes;
    feed(tape, 2, 120, 100);
    expect(tape.length).toBe(tape.capacity);
    expect(tape.memoryBytes).toBe(warm);
    expect(tape.eventCount).toBe(64);
    expect(tape.newestTime - tape.oldestTime).toBeCloseTo(TAPE_SECONDS, 1);
    expect(tape.newestTime).toBeGreaterThan(119.9);
  });

  it('samples on the rate grid only', () => {
    const tape = new ReplayTape([0]);
    let written = 0;
    for (let k = 0; k < 144; k++) {
      const t = k / 144;
      if (tape.frame(t, (id, out) => truth(id, t, 99, out), null, null)) written++;
    }
    expect(written).toBe(20);
  });

  it('turns into a recording that decodes to what was sampled', () => {
    const tape = new ReplayTape([0, 1, 2, 3]);
    feed(tape, 0, 50.4, 50);
    const data = tape.toReplayData(meta(ME, true))!;
    expect(data.header.frameCount).toBe(tape.length);
    expect(data.header.startTime).toBeCloseTo(tape.oldestTime, 5);
    const tl = new ReplayTimeline(data);
    const c = createCursor();
    const out = emptySample();
    const truthOut = emptySample();
    for (const rel of [0, 2.5, 5, 8]) {
      tl.locate(rel, c);
      const t = data.header.startTime + tl.times[c.i]!;
      expect(tl.samplePlayer(tl.slotOf(2), tl.locate(tl.times[c.i]!, c), out)).toBe(true);
      truth(2, t, 50, truthOut);
      expect(out.z).toBeCloseTo(truthOut.z, 1);
    }
    // Obstacle states and events come along.
    expect(data.header.obstacles).toEqual(['tiles-1']);
    expect(tl.events.some((e) => e.type === 'eliminated')).toBe(true);
    expect(tl.events.every((_, i) => tl.eventTimes[i]! >= 0)).toBe(true);
  });

  it('keeps growing obstacle states without losing earlier frames', () => {
    const tape = new ReplayTape([0]);
    const net = new Map<string, number[]>();
    for (let k = 0; k < 40; k++) {
      const t = k / 20;
      net.set(
        'props',
        Array.from({ length: k < 20 ? 3 : 12 }, (_, i) => i + k),
      );
      tape.frame(t, (id, out) => truth(id, t, 99, out), null, net);
    }
    const tl = new ReplayTimeline(tape.toReplayData(meta())!);
    expect(Array.from(tl.obstacleState(0, 0)!)).toEqual([0, 1, 2]);
    expect(tl.obstacleState(0, 39)!.length).toBe(12);
  });

  it('online: plans the replay from the tape alone', () => {
    const tape = new ReplayTape([0, 1, 2, 3]);
    feed(tape, 0, 50.9, 50);
    const plan = planElimination(tape.toReplayData(meta(ME, true))!, facts);
    expect(plan).not.toBeNull();
    expect(plan!.cause.kind).toBe('obstacle');
    expect(plan!.playback.end - plan!.playback.start).toBeLessThanOrEqual(ELIM_WINDOW_S + 1e-6);
  });

  it('online: a knock-out older than the tape is not replayed', () => {
    const tape = new ReplayTape([0, 1, 2, 3]);
    feed(tape, 0, 70, 50);
    expect(planElimination(tape.toReplayData(meta(ME, true))!, { ...facts, eliminatedAt: 50 })).toBeNull();
  });

  it('is empty-safe', () => {
    const tape = new ReplayTape([0]);
    expect(tape.toReplayData(meta())).toBeNull();
    expect(Number.isNaN(tape.oldestTime)).toBe(true);
    tape.clear();
    expect(tape.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Session glue
// -----------------------------------------------------------------------------

function fakeSource(t: { now: number }, outAt: number): RoundSource {
  return {
    sim: {
      obstacleRuntimes: [
        {
          instance: {
            id: 'sweep-1',
            type: 'sweeperArm',
            position: { x: 0, y: 2, z: 100 },
            params: { armLength: 7 },
          },
        },
      ],
      getObstacleNetStates: () => new Map(),
    } as unknown as RoundSource['sim'],
    players: [],
    localId: ME,
    alive: true,
    renderTime: () => t.now,
    sample: (id, out) => truth(id, t.now, outAt, out),
  };
}

function info(localId = ME): LiveRoundInfo {
  return {
    showName: 'Main Show',
    online: true,
    roundIndex: 1,
    isFinal: false,
    round: { id: 'gumdrop-gauntlet', name: 'Gumdrop Gauntlet', type: 'survival' } as LiveRoundInfo['round'],
    seed: 7,
    stage: 1,
    qualifyTarget: 2,
    localId,
    players: meta().players,
  };
}

function fakeService(
  enabled: boolean,
  data: ReplayData | null = null,
): EliminationReplays & {
  plays: Parameters<EliminationReplays['play']>[0][];
} {
  const plays: Parameters<EliminationReplays['play']>[0][] = [];
  return {
    plays,
    enabled: () => enabled,
    recording: () => data,
    play: (req) => {
      plays.push(req);
      return true;
    },
    stop: () => undefined,
    playing: false,
  };
}

describe('session glue', () => {
  it('does nothing at all while the feature is off', () => {
    const svc = fakeService(false);
    const s = new SessionElimination(svc, true);
    const clock = { now: 0 };
    s.roundStarted(info(), fakeSource(clock, 50));
    expect(s.activeTape).toBeNull();
    s.frame(null);
    s.knockedOut(1, eliminationFacts(null, { type: 'survival', triggers: [] }, new Map(), ME));
    expect(s.pending).toBe(false);
    expect(s.play(String, false)).toBe(false);
    expect(svc.plays).toHaveLength(0);
  });

  it('online: keeps a tape and plays the knock-out once, from it', () => {
    const svc = fakeService(true);
    const s = new SessionElimination(svc, true);
    const clock = { now: 0 };
    const src = fakeSource(clock, 50);
    s.roundStarted(info(), src);
    expect(s.activeTape).not.toBeNull();
    const evs = knockoutEvents(47.5, 50);
    let ei = 0;
    for (; clock.now <= 50.9; clock.now += 1 / 60) {
      s.frame(null);
      while (ei < evs.length && (evs[ei] as { t: number }).t <= clock.now)
        s.event((evs[ei++] as { e: SimEvent }).e);
      if (ei === evs.length && !s.pending) {
        s.knockedOut(1, eliminationFacts(src, { type: 'survival', triggers: [] }, new Map(), ME));
      }
    }
    expect(s.pending).toBe(true);
    expect(s.play((id) => `P${id}`, true)).toBe(true);
    expect(svc.plays[0]).toMatchObject({ still: true, online: true, cause: 'Knocked off by a sweeper' });
    expect(s.play(String, false)).toBe(false);
    expect(svc.plays).toHaveLength(1);
  });

  it('offline: no tape; the round recorder supplies the recording', () => {
    const svc = fakeService(true, recording(60, 37.5, 40));
    const s = new SessionElimination(svc, false);
    s.roundStarted(info(), fakeSource({ now: 0 }, 40));
    expect(s.activeTape).toBeNull();
    s.knockedOut(1, facts);
    expect(s.play(String, false)).toBe(true);
    expect(svc.plays[0]?.plan.cause.kind).toBe('obstacle');
  });

  it('spectated rounds are never replayed', () => {
    const svc = fakeService(true);
    const s = new SessionElimination(svc, true);
    s.roundStarted(info(-1), fakeSource({ now: 0 }, 40));
    expect(s.activeTape).toBeNull();
    s.knockedOut(1, facts);
    expect(s.pending).toBe(false);
  });

  it('facts: placed obstacles with reach, and the gap to the finish in races', () => {
    const src = fakeSource({ now: 10 }, 99);
    const f = eliminationFacts(
      src,
      {
        type: 'race',
        triggers: [
          {
            id: 'fin',
            kind: 'finish',
            position: { x: 0, y: 0, z: 36 },
            size: { x: 20, y: 4, z: 2 },
            index: 0,
            respawn: [],
            respawnYaw: 0,
          },
        ],
      },
      new Map(),
      ME,
    );
    expect(f.obstacles[0]).toMatchObject({ id: 'sweep-1', reach: 9 });
    expect(f.finishGap).toBeGreaterThan(0);
    expect(f.eliminatedAt).toBe(10);
  });
});

// -----------------------------------------------------------------------------
// Player
// -----------------------------------------------------------------------------

interface FakeView {
  clock: ReplayClock;
  timeline: { header: { roundId: string } };
  lockFollow: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

describe('player', () => {
  let dom: ReturnType<typeof installFakeDom>;
  let tracked: { name: string; props: Record<string, unknown> }[];
  let view: FakeView;
  let overlay: FakeView | null;
  let viewerOpen: boolean;
  let resolveLoad: ((v: ReplayView | null) => void) | null;
  let player: EliminationPlayer;
  const data = recording(60, 37.5, 40);
  const plan = planElimination(data, facts)!;

  beforeEach(() => {
    dom = installFakeDom();
    tracked = [];
    overlay = null;
    viewerOpen = false;
    resolveLoad = null;
    view = {
      clock: new ReplayClock(data.header.duration),
      timeline: { header: { roundId: 'gumdrop-gauntlet' } },
      lockFollow: vi.fn(),
      dispose: vi.fn(),
    };
    ui.getState().setElimReplay(null);
    const deps: EliminationPlayerDeps = {
      loadView: () =>
        new Promise((r) => {
          resolveLoad = r;
        }),
      showOverlay: (v) => {
        overlay = v as unknown as FakeView;
      },
      clearOverlay: () => {
        overlay?.dispose();
        overlay = null;
      },
      viewerOpen: () => viewerOpen,
      enabled: () => true,
      recording: () => data,
      track: (name, props) => tracked.push({ name, props }),
      logMemory: () => undefined,
    };
    player = new EliminationPlayer(deps);
  });

  afterEach(() => {
    player.dispose();
    vi.unstubAllGlobals();
  });

  async function start(still = false): Promise<void> {
    expect(player.play({ data, plan, cause: 'Knocked off by a sweeper', still, online: false })).toBe(true);
    resolveLoad?.(view as unknown as ReplayView);
    await Promise.resolve();
    await Promise.resolve();
  }

  /** One app frame: the player drives the clock, then the director advances the view. */
  function tick(dt: number): void {
    player.frame(dt);
    if (overlay) overlay.clock.advance(dt);
  }

  it('shows the cause while loading, then plays locked on the right player', async () => {
    player.play({ data, plan, cause: 'Knocked off by a sweeper', still: false, online: false });
    expect(ui.getState().elimReplay).toMatchObject({ mode: 'loading', cause: 'Knocked off by a sweeper' });
    resolveLoad?.(view as unknown as ReplayView);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.getState().elimReplay?.mode).toBe('playing');
    expect(view.lockFollow).toHaveBeenCalledWith(plan.follow);
    expect(view.clock.time).toBeCloseTo(plan.playback.start, 5);
    expect(overlay).toBe(view);
  });

  it('plays the window through slow motion and ends by itself as watched', async () => {
    await start();
    let sawSlow = false;
    let real = 0;
    while (ui.getState().elimReplay && real < 20) {
      tick(1 / 60);
      real += 1 / 60;
      if (ui.getState().elimReplay?.slow) sawSlow = true;
    }
    expect(sawSlow).toBe(true);
    expect(real).toBeGreaterThan(ELIM_TARGET_REAL_S - 1);
    expect(real).toBeLessThan(ELIM_TARGET_REAL_S + 1);
    expect(ui.getState().elimReplay).toBeNull();
    expect(view.dispose).toHaveBeenCalled();
    expect(tracked).toEqual([
      {
        name: 'replay.elimination',
        props: expect.objectContaining({ outcome: 'watched', cause: 'obstacle' }),
      },
    ]);
  });

  it('Reduce Motion: one still frame of the decisive moment, then done', async () => {
    await start(true);
    expect(ui.getState().elimReplay?.mode).toBe('still');
    expect(view.clock.playing).toBe(false);
    expect(view.clock.time).toBeCloseTo(plan.playback.focus, 5);
    for (let t = 0; t < ELIM_STILL_S - 0.2; t += 0.1) tick(0.1);
    expect(ui.getState().elimReplay).not.toBeNull();
    tick(0.3);
    expect(ui.getState().elimReplay).toBeNull();
    expect(tracked[0]?.props).toMatchObject({ outcome: 'watched', still: true });
  });

  it('skips on the Skip intent', async () => {
    await start();
    tick(0.1);
    uiEvents.emit('elimReplaySkip');
    expect(ui.getState().elimReplay).toBeNull();
    expect(tracked[0]?.props.outcome).toBe('skipped');
  });

  it('skips on any key, but not on keys still held from play', async () => {
    await start();
    dom.key('keydown', 'KeyW');
    expect(ui.getState().elimReplay).not.toBeNull();
    for (let i = 0; i < 30; i++) tick(1 / 60);
    dom.key('keydown', 'Space');
    expect(ui.getState().elimReplay).toBeNull();
    expect(tracked[0]?.props.outcome).toBe('skipped');
  });

  it('skips on a fresh pad press, not on a button already down', async () => {
    const pad = fakePad();
    dom.pads.push(pad);
    setButton(pad, 0, true);
    await start();
    for (let i = 0; i < 40; i++) tick(1 / 60);
    expect(ui.getState().elimReplay).not.toBeNull();
    setButton(pad, 0, false);
    tick(1 / 60);
    setButton(pad, 1, true);
    tick(1 / 60);
    expect(ui.getState().elimReplay).toBeNull();
  });

  it('yields when the show changes screen', async () => {
    await start();
    tick(0.1);
    ui.getState().setScreen('roundResults', { transition: 'cut' });
    tick(0.1);
    expect(ui.getState().elimReplay).toBeNull();
    expect(tracked[0]?.props.outcome).toBe('interrupted');
  });

  it('gives up when the replay takes too long to build', () => {
    player.play({ data, plan, cause: 'Fell off the course', still: false, online: true });
    for (let t = 0; t <= ELIM_LOAD_TIMEOUT_S + 0.2; t += 0.1) player.frame(0.1);
    expect(ui.getState().elimReplay).toBeNull();
    expect(tracked[0]?.props).toMatchObject({ outcome: 'unavailable', online: true });
    // A build finishing afterwards is thrown away.
    resolveLoad?.(view as unknown as ReplayView);
  });

  it('never starts over the open replay viewer, and stops for it', async () => {
    viewerOpen = true;
    expect(player.play({ data, plan, cause: 'x', still: false, online: false })).toBe(false);
    viewerOpen = false;
    await start();
    player.stop();
    expect(player.playing).toBe(false);
    expect(overlay).toBeNull();
  });
});
