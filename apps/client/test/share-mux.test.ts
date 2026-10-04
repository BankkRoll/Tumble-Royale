/**
 * Clip muxers: the MP4 and WebM writers produce files whose structure a
 * player accepts. Each file is parsed back here box by box / element by
 * element and checked for headers, codec configuration, sample tables,
 * durations and keyframes.
 */
import { describe, expect, it } from 'vitest';
import type { EncodedSample } from '../src/game/share/bytes.ts';
import { MP4_TIMESCALE, muxMp4 } from '../src/game/share/mp4Muxer.ts';
import { EBML_ID, muxWebm, vintSize } from '../src/game/share/webmMuxer.ts';

const FRAME_US = Math.round(1_000_000 / 30);

/** 30 fps samples, a keyframe every `keyEvery`, payload bytes tagged with their index. */
function samples(n: number, keyEvery = 60): EncodedSample[] {
  return Array.from({ length: n }, (_, i) => {
    const data = new Uint8Array(20 + (i % 7));
    data.fill(i & 0xff);
    return { data, timestampUs: i * FRAME_US, durationUs: FRAME_US, key: i % keyEvery === 0 };
  });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// -----------------------------------------------------------------------------
// MP4
// -----------------------------------------------------------------------------

interface Box {
  type: string;
  start: number;
  size: number;
  body: Uint8Array;
}

function boxes(buf: Uint8Array, from = 0, to = buf.length): Box[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    const size = dv.getUint32(at);
    const type = String.fromCharCode(...buf.subarray(at + 4, at + 8));
    expect(size).toBeGreaterThanOrEqual(8);
    expect(at + size).toBeLessThanOrEqual(to);
    out.push({ type, start: at, size, body: buf.subarray(at + 8, at + size) });
    at += size;
  }
  expect(at).toBe(to);
  return out;
}

/** Bytes before the child boxes of containers that have a header of their own. */
const HEADER: Record<string, number> = { stsd: 8, avc1: 78 };

function child(parent: Uint8Array, path: string[], parentType = ''): Uint8Array {
  let cur = parent;
  let curType = parentType;
  for (const type of path) {
    const found = boxes(cur, HEADER[curType] ?? 0).find((b) => b.type === type);
    if (!found) throw new Error(`missing ${type}`);
    cur = found.body;
    curType = type;
  }
  return cur;
}

function u32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
}

describe('MP4 muxer', () => {
  const avcC = new Uint8Array([
    1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80,
  ]);
  const input = samples(300);
  const file = concat(muxMp4({ width: 1280, height: 720, description: avcC }, input));
  const top = boxes(file);

  it('lays out ftyp, mdat, moov with a compatible brand', () => {
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
    const ftyp = top[0]!.body;
    expect(String.fromCharCode(...ftyp.subarray(0, 4))).toBe('isom');
    expect(String.fromCharCode(...ftyp.subarray(8))).toContain('avc1');
  });

  it('stores every sample once, in order, where stco points', () => {
    const mdat = top[1]!;
    const total = input.reduce((a, s) => a + s.data.length, 0);
    expect(mdat.size).toBe(8 + total);
    const stbl = child(top[2]!.body, ['trak', 'mdia', 'minf', 'stbl']);
    const stco = child(stbl, ['stco']);
    expect(u32(stco, 4)).toBe(1);
    const offset = u32(stco, 8);
    expect(offset).toBe(mdat.start + 8);
    expect(file.subarray(offset, offset + input[0]!.data.length)).toEqual(input[0]!.data);
    const stsz = child(stbl, ['stsz']);
    expect(u32(stsz, 8)).toBe(300);
    for (let i = 0; i < 300; i++) expect(u32(stsz, 12 + i * 4)).toBe(input[i]!.data.length);
    const stsc = child(stbl, ['stsc']);
    expect([u32(stsc, 4), u32(stsc, 8), u32(stsc, 12), u32(stsc, 16)]).toEqual([1, 1, 300, 1]);
  });

  it('carries the avcC record and the frame size', () => {
    const stsd = child(top[2]!.body, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
    expect(u32(stsd, 4)).toBe(1);
    const avc1 = child(stsd, ['avc1'], 'stsd');
    const dv = new DataView(avc1.buffer, avc1.byteOffset, avc1.byteLength);
    expect(dv.getUint16(24)).toBe(1280);
    expect(dv.getUint16(26)).toBe(720);
    expect(child(stsd, ['avc1', 'avcC'], 'stsd')).toEqual(avcC);
    const tkhd = child(top[2]!.body, ['trak', 'tkhd']);
    expect(u32(tkhd, 76) / 0x10000).toBe(1280);
    expect(u32(tkhd, 80) / 0x10000).toBe(720);
  });

  it('reports a 10 s duration in every header and the sample table', () => {
    const moov = top[2]!.body;
    const mvhd = child(moov, ['mvhd']);
    expect(u32(mvhd, 16) / u32(mvhd, 12)).toBeCloseTo(10, 2);
    const mdhd = child(moov, ['trak', 'mdia', 'mdhd']);
    expect(u32(mdhd, 12)).toBe(MP4_TIMESCALE);
    expect(u32(mdhd, 16) / MP4_TIMESCALE).toBeCloseTo(10, 3);
    const stts = child(moov, ['trak', 'mdia', 'minf', 'stbl', 'stts']);
    let count = 0;
    let ticks = 0;
    for (let i = 0; i < u32(stts, 4); i++) {
      const n = u32(stts, 8 + i * 8);
      count += n;
      ticks += n * u32(stts, 12 + i * 8);
    }
    expect(count).toBe(300);
    expect(ticks).toBe(u32(mdhd, 16));
    const hdlr = child(moov, ['trak', 'mdia', 'hdlr']);
    expect(String.fromCharCode(...hdlr.subarray(8, 12))).toBe('vide');
  });

  it('lists exactly the keyframes as sync samples', () => {
    const stss = child(top[2]!.body, ['trak', 'mdia', 'minf', 'stbl', 'stss']);
    const n = u32(stss, 4);
    const keys = Array.from({ length: n }, (_, i) => u32(stss, 8 + i * 4));
    expect(keys).toEqual([1, 61, 121, 181, 241]);
  });

  it('refuses empty input and a leading delta frame', () => {
    expect(() => muxMp4({ width: 2, height: 2 }, [])).toThrow(RangeError);
    const bad = samples(3);
    bad[0]!.key = false;
    expect(() => muxMp4({ width: 2, height: 2 }, bad)).toThrow(/keyframe/);
  });
});

// -----------------------------------------------------------------------------
// WebM
// -----------------------------------------------------------------------------

interface Element {
  id: number;
  start: number;
  dataStart: number;
  size: number;
}

function readVint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; len: number } {
  const first = b[at]!;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + b[at + i]!;
  return { value, len };
}

function elements(b: Uint8Array, from: number, to: number): Element[] {
  const out: Element[] = [];
  let at = from;
  while (at < to) {
    const id = readVint(b, at, true);
    const size = readVint(b, at + id.len, false);
    const dataStart = at + id.len + size.len;
    expect(dataStart + size.value).toBeLessThanOrEqual(to);
    out.push({ id: id.value, start: at, dataStart, size: size.value });
    at = dataStart + size.value;
  }
  expect(at).toBe(to);
  return out;
}

function find(b: Uint8Array, list: Element[], id: number): Element {
  const e = list.find((x) => x.id === id);
  if (!e) throw new Error(`missing 0x${id.toString(16)}`);
  return e;
}

function kids(b: Uint8Array, e: Element): Element[] {
  return elements(b, e.dataStart, e.dataStart + e.size);
}

function uint(b: Uint8Array, e: Element): number {
  let v = 0;
  for (let i = 0; i < e.size; i++) v = v * 256 + b[e.dataStart + i]!;
  return v;
}

function text(b: Uint8Array, e: Element): string {
  return new TextDecoder().decode(b.subarray(e.dataStart, e.dataStart + e.size));
}

describe('WebM muxer', () => {
  const input = samples(450);
  const file = concat(muxWebm({ width: 1280, height: 720 }, input, 'V_VP9', FRAME_US));
  const top = elements(file, 0, file.length);
  const segment = find(file, top, EBML_ID.Segment);
  const body = kids(file, segment);

  it('starts with a webm EBML header and one sized Segment', () => {
    expect(top.map((e) => e.id)).toEqual([EBML_ID.EBML, EBML_ID.Segment]);
    const head = kids(file, top[0]!);
    expect(text(file, find(file, head, EBML_ID.DocType))).toBe('webm');
    expect(uint(file, find(file, head, EBML_ID.DocTypeReadVersion))).toBe(2);
    expect(segment.dataStart + segment.size).toBe(file.length);
  });

  it('declares the duration, codec and frame size', () => {
    const info = kids(file, find(file, body, EBML_ID.Info));
    expect(uint(file, find(file, info, EBML_ID.TimestampScale))).toBe(1_000_000);
    const d = find(file, info, EBML_ID.Duration);
    const ms = new DataView(file.buffer, file.byteOffset + d.dataStart, 8).getFloat64(0);
    expect(ms).toBeCloseTo(15_000, 0);
    const entry = kids(file, find(file, kids(file, find(file, body, EBML_ID.Tracks)), EBML_ID.TrackEntry));
    expect(text(file, find(file, entry, EBML_ID.CodecID))).toBe('V_VP9');
    expect(uint(file, find(file, entry, EBML_ID.TrackType))).toBe(1);
    const video = kids(file, find(file, entry, EBML_ID.Video));
    expect(uint(file, find(file, video, EBML_ID.PixelWidth))).toBe(1280);
    expect(uint(file, find(file, video, EBML_ID.PixelHeight))).toBe(720);
  });

  it('starts a cluster on every keyframe and keeps every frame in order', () => {
    const clusters = body.filter((e) => e.id === EBML_ID.Cluster);
    expect(clusters).toHaveLength(8);
    let frame = 0;
    for (const c of clusters) {
      const items = kids(file, c);
      const base = uint(file, find(file, items, EBML_ID.Timestamp));
      const blocks = items.filter((e) => e.id === EBML_ID.SimpleBlock);
      blocks.forEach((blk, i) => {
        expect(file[blk.dataStart]).toBe(0x81);
        const rel = new DataView(file.buffer, file.byteOffset + blk.dataStart + 1, 2).getInt16(0);
        expect(base + rel).toBe(Math.round((frame * FRAME_US) / 1000));
        const key = (file[blk.dataStart + 3]! & 0x80) !== 0;
        expect(key).toBe(i === 0);
        expect(blk.size - 4).toBe(input[frame]!.data.length);
        expect(file[blk.dataStart + 4]).toBe(frame & 0xff);
        frame++;
      });
    }
    expect(frame).toBe(450);
  });

  it('points the SeekHead and Cues at the real positions', () => {
    const seeks = kids(file, find(file, body, EBML_ID.SeekHead));
    const at = (id: number): number => {
      for (const s of seeks) {
        const parts = kids(file, s);
        const sid = find(file, parts, EBML_ID.SeekID);
        if (readVint(file, sid.dataStart, true).value === id)
          return uint(file, find(file, parts, EBML_ID.SeekPosition));
      }
      throw new Error('no seek');
    };
    for (const id of [EBML_ID.Info, EBML_ID.Tracks, EBML_ID.Cues]) {
      const target = find(file, body, id);
      expect(at(id)).toBe(target.start - segment.dataStart);
    }
    const cues = kids(file, find(file, body, EBML_ID.Cues));
    const clusters = body.filter((e) => e.id === EBML_ID.Cluster);
    expect(cues).toHaveLength(clusters.length);
    cues.forEach((cp, i) => {
      const pos = kids(file, find(file, kids(file, cp), EBML_ID.CueTrackPositions));
      expect(uint(file, find(file, pos, EBML_ID.CueClusterPosition))).toBe(
        clusters[i]!.start - segment.dataStart,
      );
    });
  });

  it('encodes sizes as EBML vints', () => {
    expect(vintSize(0)).toEqual(new Uint8Array([0x80]));
    expect(vintSize(126)).toEqual(new Uint8Array([0xfe]));
    // 127 would be the reserved all-ones value at one byte.
    expect(vintSize(127)).toEqual(new Uint8Array([0x40, 0x7f]));
    expect(vintSize(5, 8)).toEqual(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 5]));
  });

  it('refuses empty input and a leading delta frame', () => {
    expect(() => muxWebm({ width: 2, height: 2 }, [], 'V_VP8', FRAME_US)).toThrow(RangeError);
    const bad = samples(2);
    bad[0]!.key = false;
    expect(() => muxWebm({ width: 2, height: 2 }, bad, 'V_VP8', FRAME_US)).toThrow(/keyframe/);
  });
});
