/**
 * Recorder → timeline round trip on a synthetic 40-player round whose motion
 * is a pure function of time (so every decoded sample can be checked against
 * the truth), plus the size budget: a 5-minute, 40-player round must encode
 * under 5 MB.
 */
import { describe, expect, it } from 'vitest';
import { CharacterFlag, CharacterState, type SimEvent } from '@tumble/sim';
import {
  CameraModeCode,
  GAME_VERSION,
  decodeReplayFile,
  encodeReplayFile,
} from '../src/game/replay/format.ts';
import {
  ReplayRecorder,
  type RecordableCamera,
  type RecordablePlayer,
  type ReplayMeta,
} from '../src/game/replay/recorder.ts';
import { ReplayTimeline, createCursor } from '../src/game/replay/timeline.ts';

const PLAYERS = 40;
const FPS = 60;

function meta(players = PLAYERS): ReplayMeta {
  return {
    protocolVersion: 2,
    recordedAt: '2026-10-03T12:00:00.000Z',
    online: false,
    showName: 'Main Show',
    roundId: 'gumdrop-gauntlet',
    roundName: 'Gumdrop Gauntlet',
    roundType: 'race',
    roundIndex: 1,
    isFinal: false,
    seed: 99,
    stage: 1,
    variationId: null,
    qualifyTarget: 26,
    localId: 0,
    players: Array.from({ length: players }, (_, id) => ({
      id,
      name: `P${id}`,
      isBot: id !== 0,
      team: -1,
      loadout: { colors: ['#ff4f9a', '#ffd23f', '#5aa9ff'], pattern: 'plain' },
    })),
  };
}

/** Out time per player (a third get knocked out along the way). */
function outAt(id: number, length: number): number {
  return id % 3 === 2 ? 20 + ((id * 37) % Math.max(1, length - 40)) : Infinity;
}

/**
 * Ground-truth rendered state: running down the course with weaving, a jump
 * every few seconds, a dive now and then, respawn teleports, emotes at the end.
 */
function truth(id: number, t: number, length: number, out: RecordablePlayer): boolean {
  if (t >= outAt(id, length)) return false;
  const speed = 6 + (id % 5) * 0.6;
  const phase = id * 0.7;
  const respawns = Math.floor(Math.max(0, t) / 45);
  // Each respawn sends the player 12 m back (a teleport).
  out.x = (id - PLAYERS / 2) * 1.2 + Math.sin(t * 0.9 + phase) * 2.5;
  out.z = Math.max(0, t) * speed - respawns * 12;
  const jumpT = (t + phase) % 3.2;
  const airborne = jumpT < 0.8;
  out.y = 2 + (airborne ? 9.5 * jumpT - 0.5 * 23.75 * jumpT * jumpT : 0);
  out.vx = Math.cos(t * 0.9 + phase) * 2.5 * 0.9;
  out.vy = airborne ? 9.5 - 23.75 * jumpT : 0;
  out.vz = speed;
  out.facing = Math.atan2(out.vx, out.vz);
  const diving = !airborne && (t + id) % 7 < 0.6;
  out.state =
    t < 0
      ? CharacterState.Idle
      : airborne
        ? jumpT < 0.4
          ? CharacterState.Jump
          : CharacterState.Fall
        : diving
          ? CharacterState.DiveSlide
          : CharacterState.Run;
  out.stateTime = airborne ? (jumpT < 0.4 ? jumpT : jumpT - 0.4) : 0;
  out.grounded = !airborne;
  out.flags =
    (id === 1 && t > 100 ? CharacterFlag.Carrying : 0) | ((t + id) % 45 < 1.5 ? CharacterFlag.Ghost : 0);
  out.emote = 0;
  return true;
}

interface Run {
  recorder: ReplayRecorder;
  frames: number;
}

/** Records a synthetic round of `length` seconds from a 60 fps render loop. */
function record(length: number, players = PLAYERS): Run {
  const rec = new ReplayRecorder(meta(players));
  const cam: RecordableCamera = { mode: CameraModeCode.Follow, target: 0, yaw: 0, pitch: 0.3 };
  const tiles = new Array<number>(64).fill(0);
  const props = new Array<number>(1 + 10 * 13).fill(0);
  props[0] = 10;
  const states = new Map<string, number[]>([
    ['tiles', tiles],
    ['props', props],
  ]);
  let frames = 0;
  const start = -3;
  for (let f = 0; f <= (length - start) * FPS; f++) {
    const t = start + f / FPS;
    cam.yaw = Math.sin(t * 0.2) * 1.5;
    if (t > 60) {
      cam.mode = CameraModeCode.Spectate;
      cam.target = 5;
    }
    if (rec.due(t)) {
      // A tile falls every 4 s; the carried prop (id 1 holds it after 100 s) moves with its carrier.
      const fallen = Math.floor(Math.max(0, t) / 4);
      for (let i = 0; i < tiles.length; i++) tiles[i] = i < fallen ? 2 : 0;
      for (let p = 0; p < 10; p++) {
        const o = 1 + p * 13;
        props[o + 3] = p * 2.5;
        props[o + 4] = 1.25;
        props[o + 5] = p === 0 && t > 100 ? t * 6.3 : 40;
        props[o + 9] = 1;
      }
      rec.frame(t, (id, out) => truth(id, t, length, out), cam, states);
      frames++;
    }
    for (let id = 0; id < players; id++) {
      const jumpT = (t + id * 0.7) % 3.2;
      if (t > 0 && jumpT < 1 / FPS) {
        const e: SimEvent = { type: 'jump', player: id, pos: { x: 0, y: 2, z: t * 6 } };
        if (t < outAt(id, length)) rec.event(t, e);
      }
      if (Math.abs(t - outAt(id, length)) < 0.5 / FPS)
        rec.event(t, { type: 'eliminated', player: id, place: 40 - id });
    }
    if (Math.abs(t - 150) < 0.5 / FPS) rec.event(t, { type: 'qualified', player: 0, place: 3 });
  }
  return { recorder: rec, frames };
}

describe('replay recording', () => {
  const LENGTH = 180;
  const run = record(LENGTH);
  const data = run.recorder.finish({ qualified: [0], eliminated: [2] });
  if (!data) throw new Error('no recording');
  const tl = new ReplayTimeline(decodeReplayFile(encodeReplayFile(data)));

  it('samples at 20 Hz of round time and fills the header', () => {
    expect(data.header.frameCount).toBe(run.frames);
    expect(run.frames).toBe((LENGTH + 3) * 20 + 1);
    expect(data.header.startTime).toBeCloseTo(-3, 6);
    expect(data.header.duration).toBeCloseTo(LENGTH + 3, 6);
    expect(data.header.gameVersion).toBe(GAME_VERSION);
    expect(data.header.obstacles).toEqual(['tiles', 'props']);
    expect(tl.duration).toBeCloseTo(LENGTH + 3, 6);
  });

  it('reproduces every player within quantisation + interpolation error', () => {
    const c = createCursor();
    const got: RecordablePlayer = {
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
    const want: RecordablePlayer = { ...got };
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      // On-sample and between-sample times, away from teleports and state edges.
      const rel = (k * 0.4567) % (LENGTH - 1);
      const t = -3 + rel;
      tl.locate(rel, c);
      for (let id = 0; id < PLAYERS; id += 3) {
        const present = truth(id, t, LENGTH, want);
        const ok = tl.samplePlayer(tl.slotOf(id), c, got);
        const tSample = -3 + tl.times[c.i]!;
        const tNext = -3 + tl.times[c.j]!;
        const presentAtSample = truth(id, tSample, LENGTH, { ...want });
        expect(ok).toBe(presentAtSample);
        if (!present || !ok) continue;
        const nextKnown = truth(id, tNext, LENGTH, { ...want });
        const edge = t % 45 > 44.9 || t % 45 < 0.1 || !nextKnown;
        const jumpT = (t + id * 0.7) % 3.2;
        // Straight-line interpolation of a jump arc is off by at most g·dt²/8 ≈ 7 mm at 20 Hz.
        if (!edge) {
          expect(Math.abs(got.x - want.x)).toBeLessThan(0.03);
          expect(Math.abs(got.z - want.z)).toBeLessThan(0.03);
          if (jumpT > 0.06 && jumpT < 0.74) expect(Math.abs(got.y - want.y)).toBeLessThan(0.03);
          expect(Math.abs(got.vz - want.vz)).toBeLessThan(0.05);
          const dy = Math.atan2(Math.sin(got.facing - want.facing), Math.cos(got.facing - want.facing));
          expect(Math.abs(dy)).toBeLessThan(0.01);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('keeps discrete state, state time, flags and grounded from the sample at or before', () => {
    const c = createCursor();
    const got: RecordablePlayer = {
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
    const want = { ...got };
    for (const rel of [10, 33.05, 104.4, 150.25]) {
      tl.locate(rel, c);
      truth(1, -3 + tl.times[c.i]!, LENGTH, want);
      expect(tl.samplePlayer(tl.slotOf(1), c, got)).toBe(true);
      expect(got.state).toBe(want.state);
      expect(got.flags).toBe(want.flags);
      expect(got.grounded).toBe(want.grounded);
      if (want.state === CharacterState.Jump || want.state === CharacterState.Fall)
        expect(Math.abs(got.stateTime - (want.stateTime + (rel - tl.times[c.i]!)))).toBeLessThan(0.02);
    }
  });

  it('snaps teleports instead of smearing across the course', () => {
    const c = createCursor();
    const got: RecordablePlayer = {
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
    // Respawn at round time 45: 12 m backwards between the samples at rel 47.95 and 48.0.
    tl.locate(47.96, c);
    tl.samplePlayer(0, c, got);
    const before = got.z;
    tl.locate(47.99, c);
    tl.samplePlayer(0, c, got);
    expect(Math.abs(got.z - before)).toBeGreaterThan(9);
    tl.locate(47.951, c);
    tl.samplePlayer(0, c, got);
    expect(Math.abs(got.z - before)).toBeLessThan(0.5);
  });

  it('drops players after they leave and marks eliminations and your qualification', () => {
    const c = createCursor();
    const got: RecordablePlayer = {
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
    const gone = outAt(2, LENGTH);
    tl.locate(gone + 3 + 1, c);
    expect(tl.samplePlayer(tl.slotOf(2), c, got)).toBe(false);
    tl.locate(gone + 3 - 1, c);
    expect(tl.samplePlayer(tl.slotOf(2), c, got)).toBe(true);
    const local = tl.markers.filter((m) => m.kind === 'localQualified');
    expect(local).toHaveLength(1);
    expect(local[0]!.t).toBeCloseTo(153, 1);
    const outs = tl.markers.filter((m) => m.kind === 'eliminated');
    expect(outs.length).toBe(
      Array.from({ length: PLAYERS }, (_, id) => outAt(id, LENGTH)).filter(Number.isFinite).length,
    );
  });

  it('replays the camera track and obstacle states', () => {
    const c = createCursor();
    const cam: RecordableCamera = { mode: 0, target: 0, yaw: 0, pitch: 0 };
    tl.locate(20, c);
    expect(tl.sampleCamera(c, cam)).toBe(true);
    expect(cam.mode).toBe(CameraModeCode.Follow);
    const dYaw = cam.yaw - Math.sin(17 * 0.2) * 1.5;
    expect(Math.abs(Math.atan2(Math.sin(dYaw), Math.cos(dYaw)))).toBeLessThan(0.005);
    expect(cam.pitch).toBeCloseTo(0.3, 2);
    tl.locate(70, c);
    tl.sampleCamera(c, cam);
    expect(cam.mode).toBe(CameraModeCode.Spectate);
    expect(cam.target).toBe(5);

    tl.locate(3 + 41, c);
    const tiles = tl.obstacleState(0, c.i)!;
    expect(tiles.length).toBe(64);
    expect(tiles.filter((v) => v === 2).length).toBe(10);
    tl.locate(3 + 120, c);
    const props = tl.obstacleState(1, c.i)!;
    expect(props[0]).toBe(10);
    expect(props[1 + 5]).toBeCloseTo(-3 + tl.times[c.i]! > 100 ? (-3 + tl.times[c.i]!) * 6.3 : 40, 2);
    expect(props[1 + 13 + 3]).toBeCloseTo(2.5, 3);
  });

  it('lists events by time window', () => {
    const seen: number[] = [];
    tl.forEachEvent(3 + 10, 3 + 13.2, (e, t) => {
      if (e.type === 'jump') seen.push(t);
    });
    expect(seen.length).toBeGreaterThan(30);
    expect(seen.every((t) => t > 13 && t <= 16.2)).toBe(true);
  });

  it('hands out snapshots of a round still in progress', () => {
    const rec = new ReplayRecorder(meta(4));
    expect(rec.snapshot()).toBeNull();
    const out: RecordablePlayer = {
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
    for (let f = 0; f < 120; f++) {
      const t = f / FPS;
      rec.frame(t, (id, o) => truth(id, t, 100, o), null, null);
    }
    const snap = rec.snapshot()!;
    expect(snap.header.frameCount).toBe(40);
    expect(snap.header.outcome).toBeNull();
    const tl2 = new ReplayTimeline(snap);
    expect(tl2.sampleCamera(tl2.locate(1, createCursor()), { mode: 0, target: 0, yaw: 0, pitch: 0 })).toBe(
      false,
    );
    expect(tl2.samplePlayer(0, tl2.locate(1, createCursor()), out)).toBe(true);
    // Recording carries on after a snapshot.
    rec.frame(2.5, (id, o) => truth(id, 2.5, 100, o), null, null);
    expect(rec.finish(null)!.header.frameCount).toBe(41);
    expect(rec.closed).toBe(true);
    expect(rec.finish(null)).toBeNull();
  });

  it('records a 5-minute, 40-player round in well under 5 MB', () => {
    const big = record(300).recorder;
    const memory = big.memoryBytes;
    const final = big.finish({ qualified: [], eliminated: [] })!;
    const file = encodeReplayFile(final);
    const perSecond = file.length / 303;
    console.info(
      `[replay size] 5 min x 40 players: file ${(file.length / 1024 / 1024).toFixed(2)} MB ` +
        `(frames ${(final.frames.length / 1024).toFixed(0)} KB, events ${(final.events.length / 1024).toFixed(0)} KB, ` +
        `${(perSecond / 1024).toFixed(1)} KB/s); recorder held ${(memory / 1024 / 1024).toFixed(2)} MB while recording`,
    );
    expect(file.length).toBeLessThan(5 * 1024 * 1024);
    expect(memory).toBeLessThan(8 * 1024 * 1024);
    const t0 = performance.now();
    const decoded = new ReplayTimeline(decodeReplayFile(file));
    const ms = performance.now() - t0;
    console.info(`[replay size] decode ${ms.toFixed(0)} ms for ${decoded.frameCount} frames`);
    expect(decoded.frameCount).toBe(final.header.frameCount);
  });
});
