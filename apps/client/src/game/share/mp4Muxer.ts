/**
 * Minimal MP4 (ISO BMFF) writer for one H.264 video track.
 *
 * Layout: `ftyp`, `mdat` with every sample back to back (one chunk), then
 * `moov` with the sample tables. Putting `moov` last means nothing has to be
 * patched or rewritten once the samples are known, and the samples are never
 * copied: the result is a list of parts handed straight to a `Blob`.
 *
 * Only what clips need is supported: one video track, `avc1` with the `avcC`
 * record WebCodecs provides, 32-bit offsets (clips are a few MB).
 */
import { BeWriter, partsLength, usToTicks, type EncodedSample, type VideoTrackInfo } from './bytes.ts';

/** Media timescale (ticks per second); 90 kHz divides every common frame rate. */
export const MP4_TIMESCALE = 90_000;
/** Movie timescale for `mvhd`/`tkhd` durations. */
const MOVIE_TIMESCALE = 1000;
const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const w = new BeWriter();
  w.u32(8 + partsLength(payload)).ascii(type);
  for (const p of payload) w.raw(p);
  return w.bytes();
}

function fullBox(type: string, version: number, flags: number, body: (w: BeWriter) => void): Uint8Array {
  const w = new BeWriter();
  w.u8(version).u24(flags);
  body(w);
  return box(type, w.bytes());
}

function matrix(w: BeWriter): void {
  for (const v of UNITY_MATRIX) w.u32(v);
}

function ftyp(): Uint8Array {
  const w = new BeWriter();
  w.ascii('isom').u32(0x200).ascii('isom').ascii('iso2').ascii('avc1').ascii('mp41');
  return box('ftyp', w.bytes());
}

/** Per-sample media ticks (start and duration), derived from timestamps so rounding never accumulates. */
function sampleTicks(samples: readonly EncodedSample[]): { start: number; duration: number }[] {
  return samples.map((s, i) => {
    const start = usToTicks(s.timestampUs, MP4_TIMESCALE);
    const next = samples[i + 1];
    const end = next
      ? usToTicks(next.timestampUs, MP4_TIMESCALE)
      : usToTicks(s.timestampUs + s.durationUs, MP4_TIMESCALE);
    return { start, duration: Math.max(1, end - start) };
  });
}

/** Run-length `stts` entries: [count, delta] pairs. */
function timeToSample(ticks: readonly { duration: number }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const t of ticks) {
    const last = out[out.length - 1];
    if (last && last[1] === t.duration) last[0]++;
    else out.push([1, t.duration]);
  }
  return out;
}

function avc1(track: VideoTrackInfo): Uint8Array {
  const w = new BeWriter();
  w.zeros(6).u16(1); // reserved, data_reference_index
  w.u16(0).u16(0).zeros(12); // pre_defined, reserved, pre_defined[3]
  w.u16(track.width).u16(track.height);
  w.u32(0x00480000).u32(0x00480000).u32(0); // 72 dpi, reserved
  w.u16(1); // frame_count
  const name = 'Tumble Royale';
  w.u8(name.length)
    .ascii(name)
    .zeros(31 - name.length);
  w.u16(0x0018).u16(0xffff); // depth, pre_defined = -1
  w.raw(box('avcC', track.description ?? new Uint8Array(0)));
  return box('avc1', w.bytes());
}

function moov(
  track: VideoTrackInfo,
  samples: readonly EncodedSample[],
  ticks: readonly { start: number; duration: number }[],
  dataOffset: number,
): Uint8Array {
  const mediaDuration = ticks.reduce((a, t) => a + t.duration, 0);
  const movieDuration = Math.round((mediaDuration * MOVIE_TIMESCALE) / MP4_TIMESCALE);

  const mvhd = fullBox('mvhd', 0, 0, (w) => {
    w.u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(movieDuration);
    w.u32(0x00010000).u16(0x0100).zeros(10); // rate 1.0, volume 1.0, reserved
    matrix(w);
    w.zeros(24).u32(2); // pre_defined[6], next_track_ID
  });
  const tkhd = fullBox('tkhd', 0, 0x000003, (w) => {
    w.u32(0).u32(0).u32(1).u32(0).u32(movieDuration);
    w.zeros(8).u16(0).u16(0).u16(0).u16(0); // reserved[2], layer, alternate_group, volume, reserved
    matrix(w);
    w.u32(track.width * 0x10000).u32(track.height * 0x10000);
  });
  const mdhd = fullBox('mdhd', 0, 0, (w) => {
    // Language "und", packed as three 5-bit letters.
    w.u32(0).u32(0).u32(MP4_TIMESCALE).u32(mediaDuration).u16(0x55c4).u16(0);
  });
  const hdlr = fullBox('hdlr', 0, 0, (w) => {
    w.u32(0).ascii('vide').zeros(12).ascii('VideoHandler').u8(0);
  });
  const vmhd = fullBox('vmhd', 0, 1, (w) => {
    w.u16(0).zeros(6);
  });
  const dinf = box(
    'dinf',
    fullBox('dref', 0, 0, (w) => {
      w.u32(1).raw(fullBox('url ', 0, 1, () => {}));
    }),
  );
  const stsd = fullBox('stsd', 0, 0, (w) => {
    w.u32(1).raw(avc1(track));
  });
  const runs = timeToSample(ticks);
  const stts = fullBox('stts', 0, 0, (w) => {
    w.u32(runs.length);
    for (const [count, delta] of runs) w.u32(count).u32(delta);
  });
  const keys: number[] = [];
  samples.forEach((s, i) => {
    if (s.key) keys.push(i + 1);
  });
  const stss = fullBox('stss', 0, 0, (w) => {
    w.u32(keys.length);
    for (const k of keys) w.u32(k);
  });
  const stsc = fullBox('stsc', 0, 0, (w) => {
    w.u32(1).u32(1).u32(samples.length).u32(1);
  });
  const stsz = fullBox('stsz', 0, 0, (w) => {
    w.u32(0).u32(samples.length);
    for (const s of samples) w.u32(s.data.length);
  });
  const stco = fullBox('stco', 0, 0, (w) => {
    w.u32(1).u32(dataOffset);
  });
  const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
  const minf = box('minf', vmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  return box('moov', mvhd, trak);
}

/**
 * Muxes H.264 samples into an MP4 file.
 *
 * @param track - Dimensions and the `avcC` record.
 * @param samples - Encoded frames in decode order (WebCodecs output order; no B-frames).
 * @returns File parts, in order, for `new Blob(parts, { type: 'video/mp4' })`.
 * @throws RangeError when there are no samples or the first one is not a keyframe.
 * @example
 * const parts = muxMp4({ width: 1280, height: 720, description: avcC }, samples);
 * const file = new Blob(parts, { type: 'video/mp4' });
 */
export function muxMp4(track: VideoTrackInfo, samples: readonly EncodedSample[]): Uint8Array[] {
  if (samples.length === 0) throw new RangeError('No samples to mux');
  if (!samples[0]?.key) throw new RangeError('The first sample must be a keyframe');
  const head = ftyp();
  const payload = samples.reduce((a, s) => a + s.data.length, 0);
  const mdatHeader = new BeWriter()
    .u32(8 + payload)
    .ascii('mdat')
    .bytes();
  const ticks = sampleTicks(samples);
  const tail = moov(track, samples, ticks, head.length + mdatHeader.length);
  return [head, mdatHeader, ...samples.map((s) => s.data), tail];
}
