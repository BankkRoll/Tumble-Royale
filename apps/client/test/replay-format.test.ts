/**
 * Replay container and primitives: varints beyond 32 bits, the event schema
 * round-trip for every SimEvent kind, file encode/decode, and every way a
 * loaded file can be rejected.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@tumble/sim';
import {
  ByteReader,
  ByteWriter,
  ReplayDecodeError,
  readZeroRuns,
  unzigzag,
  writeZeroRuns,
  zigzag,
} from '../src/game/replay/codec.ts';
import {
  GAME_VERSION,
  REPLAY_FORMAT_VERSION,
  ReplayFileError,
  StringTable,
  decodeReplayFile,
  encodeReplayFile,
  readEvent,
  replayFileName,
  sameGameVersion,
  validateReplayHeader,
  writeEvent,
  type ReplayData,
  type ReplayHeader,
} from '../src/game/replay/format.ts';

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    format: REPLAY_FORMAT_VERSION,
    gameVersion: GAME_VERSION,
    protocolVersion: 2,
    recordedAt: '2026-10-03T12:00:00.000Z',
    online: false,
    showName: 'Main Show',
    roundId: 'gumdrop-gauntlet',
    roundName: 'Gumdrop Gauntlet',
    roundType: 'race',
    roundIndex: 0,
    isFinal: false,
    seed: 1234,
    stage: 0,
    variationId: null,
    qualifyTarget: 26,
    localId: 0,
    rate: 20,
    startTime: -3,
    players: [
      {
        id: 0,
        name: 'Sprinkles',
        isBot: false,
        team: -1,
        loadout: { colors: ['#fff', '#000', '#f0f'], pattern: 'plain' },
      },
      { id: 1, name: 'Bot', isBot: true, team: -1, loadout: null },
    ],
    obstacles: ['tiles-1'],
    strings: [],
    frameCount: 2,
    eventCount: 0,
    duration: 0.05,
    outcome: { qualified: [0], eliminated: [1] },
    ...over,
  };
}

function data(over: Partial<ReplayHeader> = {}): ReplayData {
  return { header: header(over), frames: new Uint8Array([1, 2, 3, 250]), events: new Uint8Array([9, 8]) };
}

describe('codec', () => {
  it('round-trips unsigned and signed varints up to 2^53', () => {
    const values = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 32 + 5, 2 ** 40, Number.MAX_SAFE_INTEGER];
    // Zig-zag doubles the magnitude, so signed values stay within 2^52.
    const signed = [0, 1, 300, 2 ** 31, 2 ** 32 + 5, 2 ** 52 - 1];
    const w = new ByteWriter(4);
    for (const v of values) w.varint(v);
    for (const v of signed) w.svarint(-v);
    for (const v of signed) w.svarint(v);
    const r = new ByteReader(w.finish());
    for (const v of values) expect(r.varint()).toBe(v);
    for (const v of signed) expect(r.svarint()).toBe(-v || 0);
    for (const v of signed) expect(r.svarint()).toBe(v);
    expect(r.done).toBe(true);
  });

  it('zig-zags small magnitudes into small codes', () => {
    expect([0, -1, 1, -2, 2].map(zigzag)).toEqual([0, 1, 2, 3, 4]);
    for (const v of [-1e12, -3, 0, 7, 1e12]) expect(unzigzag(zigzag(v))).toBe(v);
  });

  it('writes fixed-width integers little-endian and grows past its capacity', () => {
    const w = new ByteWriter(16);
    w.u16(0xbeef);
    w.u32(0xdeadbeef);
    for (let i = 0; i < 1000; i++) w.u8(i);
    const r = new ByteReader(w.snapshot());
    expect(r.u16()).toBe(0xbeef);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.u8()).toBe(0);
    expect(w.capacity).toBeGreaterThanOrEqual(1006);
  });

  it('collapses zero runs and rejects runs past the end', () => {
    const values = [0, 0, 0, 5, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0];
    const w = new ByteWriter();
    writeZeroRuns(w, values, values.length);
    const bytes = w.finish();
    expect(bytes.length).toBeLessThan(12);
    const out = new Float64Array(values.length);
    readZeroRuns(new ByteReader(bytes), out, values.length);
    expect([...out]).toEqual(values);
    expect(() => readZeroRuns(new ByteReader(bytes), new Float64Array(2), 2)).toThrow(ReplayDecodeError);
  });

  it('rejects reads past the end and negative varints', () => {
    expect(() => new ByteReader(new Uint8Array([0x80])).varint()).toThrow(ReplayDecodeError);
    expect(() => new ByteReader(new Uint8Array([1])).u32()).toThrow(ReplayDecodeError);
    expect(() => new ByteWriter().varint(-1)).toThrow(RangeError);
  });
});

describe('event schema', () => {
  const pos = { x: 1.25, y: -3.5, z: 120.07 };
  const events: SimEvent[] = [
    { type: 'jump', player: 3, pos },
    { type: 'land', player: 3, pos, impact: 12.34 },
    { type: 'dive', player: 3, pos },
    { type: 'getUp', player: 3 },
    { type: 'stun', player: 3, pos, strength: 4.5 },
    { type: 'bounce', player: 3, pos },
    { type: 'bounce', player: 3, pos, obstacle: 'pad-2' },
    { type: 'grabStart', player: 3, target: 7, targetKind: 'ledge' },
    { type: 'grabEnd', player: 3, target: 7, reason: 'stamina' },
    { type: 'emote', player: 3, emote: 2 },
    { type: 'fellOut', player: 3, pos },
    { type: 'respawn', player: 3, pos },
    { type: 'checkpoint', player: 3, index: 4 },
    { type: 'finish', player: 3, tick: 4200, subTick: 0.5 },
    { type: 'qualified', player: 3, place: 1 },
    { type: 'eliminated', player: 9, place: 40 },
    { type: 'tileFell', obstacle: 'tiles-1', tile: 17 },
    { type: 'tileWarn', obstacle: 'tiles-1', tile: 18 },
    { type: 'obstacleCue', obstacle: 'hammer-3', cue: 'swing', pos },
    { type: 'teleport', player: 3, from: pos, to: { x: 0, y: 1, z: 2 } },
    { type: 'score', team: 1, player: 3, delta: 1, total: 12 },
    { type: 'propPickup', player: 3, prop: 5 },
    { type: 'propDrop', player: 3, prop: 5 },
  ];

  it('round-trips every SimEvent kind (positions to the centimetre)', () => {
    const strings = new StringTable();
    const w = new ByteWriter();
    for (const e of events) writeEvent(w, e, strings);
    const r = new ByteReader(w.finish());
    for (const e of events) expect(readEvent(r, strings.list)).toEqual(e);
    expect(r.done).toBe(true);
    expect(strings.list).toEqual(['pad-2', 'tiles-1', 'hammer-3', 'swing']);
  });

  it('covers the whole SimEvent union', () => {
    const kinds = new Set(events.map((e) => e.type));
    // Compile-time list of every SimEvent kind; adding one to the union fails here until the schema knows it.
    const all: Record<SimEvent['type'], true> = {
      jump: true,
      land: true,
      dive: true,
      getUp: true,
      stun: true,
      bounce: true,
      grabStart: true,
      grabEnd: true,
      emote: true,
      fellOut: true,
      respawn: true,
      checkpoint: true,
      finish: true,
      qualified: true,
      eliminated: true,
      tileFell: true,
      tileWarn: true,
      obstacleCue: true,
      teleport: true,
      score: true,
      propPickup: true,
      propDrop: true,
    };
    expect([...kinds].sort()).toEqual(Object.keys(all).sort());
  });

  it('rejects unknown event codes and dangling string refs', () => {
    expect(() => readEvent(new ByteReader(new Uint8Array([200])), [])).toThrow(ReplayDecodeError);
    const w = new ByteWriter();
    writeEvent(w, { type: 'tileFell', obstacle: 'x', tile: 1 }, new StringTable());
    expect(() => readEvent(new ByteReader(w.finish()), [])).toThrow(ReplayDecodeError);
  });
});

describe('replay file', () => {
  it('round-trips header and streams', () => {
    const d = data();
    const out = decodeReplayFile(encodeReplayFile(d));
    expect(out.header).toEqual(d.header);
    expect([...out.frames]).toEqual([...d.frames]);
    expect([...out.events]).toEqual([...d.events]);
  });

  it('rejects other files, newer/older formats, truncation and corruption', () => {
    const bytes = encodeReplayFile(data());
    const problem = (b: Uint8Array): string => {
      try {
        decodeReplayFile(b);
        return 'ok';
      } catch (err) {
        expect(err).toBeInstanceOf(ReplayFileError);
        return (err as ReplayFileError).problem;
      }
    };
    expect(problem(new TextEncoder().encode('PK\u0003\u0004 definitely a zip'))).toBe('magic');
    expect(problem(new Uint8Array(3))).toBe('magic');
    const newer = bytes.slice();
    newer[4] = REPLAY_FORMAT_VERSION + 1;
    expect(problem(newer)).toBe('version');
    expect(problem(bytes.slice(0, bytes.length - 9))).toBe('corrupt');
    const flipped = bytes.slice();
    flipped[bytes.length - 8] = (flipped[bytes.length - 8] as number) ^ 0xff;
    expect(problem(flipped)).toBe('corrupt');
  });

  it('validates untrusted headers field by field', () => {
    const ok = header();
    expect(validateReplayHeader(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    const bad = (patch: Record<string, unknown>): string => {
      try {
        validateReplayHeader({ ...JSON.parse(JSON.stringify(ok)), ...patch });
        return 'ok';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(bad({ roundId: 7 })).toMatch(/roundId/);
    expect(bad({ players: [] })).toMatch(/players/);
    expect(bad({ players: [ok.players[0], ok.players[0]] })).toMatch(/duplicate/);
    expect(bad({ rate: 0 })).toMatch(/rate/);
    expect(bad({ frameCount: 0 })).toMatch(/frameCount/);
    expect(bad({ format: 99 })).toMatch(/format/);
    expect(bad({ outcome: { qualified: ['x'], eliminated: [] } })).toMatch(/outcome/);
    expect(bad({ variationId: 3 })).toMatch(/variationId/);
    expect(bad({ mutatorId: 3 })).toMatch(/mutatorId/);
    expect(validateReplayHeader({ ...ok, mutatorId: 'speed-demons' }).mutatorId).toBe('speed-demons');
    expect(() => validateReplayHeader(null)).toThrow(ReplayFileError);
  });

  it('stamps the root package version and compares major.minor', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as {
      version: string;
    };
    expect(GAME_VERSION).toBe(pkg.version);
    expect(sameGameVersion(GAME_VERSION)).toBe(true);
    const [maj, min] = GAME_VERSION.split('.');
    expect(sameGameVersion(`${maj}.${min}.99`)).toBe(true);
    expect(sameGameVersion(`${Number(maj) + 1}.0.0`)).toBe(false);
  });

  it('names downloads after the round and time', () => {
    expect(replayFileName(header())).toBe('gumdrop-gauntlet-2026-10-03T12-00-00.tumblereplay');
  });
});
