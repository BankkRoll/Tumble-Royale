/**
 * Minimal WebM (Matroska subset) writer for one VP8/VP9 video track.
 *
 * The whole file is laid out once the samples are known, so every element
 * gets its real size (no "unknown size" live-streaming tricks) and the
 * `Duration`, `SeekHead` and `Cues` players need for seeking and for
 * `<video>.duration` are present. Sample payloads are never copied: the
 * result is a list of parts handed straight to a `Blob`.
 *
 * Clusters start on every keyframe (or every ~30 s, the reach of a
 * SimpleBlock's 16-bit relative timestamp) so each one is independently
 * decodable and cue-able.
 */
import { BeWriter, partsLength, type EncodedSample, type VideoTrackInfo } from './bytes.ts';

/** Timestamp unit in nanoseconds: 1 ms. */
const TIMESTAMP_SCALE = 1_000_000;
const MAX_CLUSTER_SPAN_MS = 30_000;

/** EBML element ids used by the writer (ids include their length marker bits). */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

/** Matroska codec ids for the codecs clips use. */
export type WebmCodec = 'V_VP9' | 'V_VP8';

function idBytes(id: number): Uint8Array {
  const w = new BeWriter();
  if (id > 0xffffff) w.u32(id);
  else if (id > 0xffff) w.u24(id);
  else if (id > 0xff) w.u16(id);
  else w.u8(id);
  return w.bytes();
}

/**
 * EBML variable-length size: the shortest encoding, or exactly `width` bytes.
 *
 * @param n - Size value.
 * @param width - Force this many bytes (1–8).
 */
export function vintSize(n: number, width?: number): Uint8Array {
  let len = width ?? 1;
  // All-ones is reserved for "unknown size", hence the -1.
  if (width === undefined) while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = (out[0] as number) | (1 << (8 - len));
  return out;
}

function uintBytes(v: number, width?: number): Uint8Array {
  let len = width ?? 1;
  if (width === undefined) while (len < 8 && v >= 2 ** (8 * len)) len++;
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return out;
}

/** An element as header + payload parts (payloads are referenced, not copied). */
function el(id: number, ...payload: Uint8Array[]): Uint8Array[] {
  const head = new BeWriter()
    .raw(idBytes(id))
    .raw(vintSize(partsLength(payload)))
    .bytes();
  return [head, ...payload];
}

function elUint(id: number, v: number, width?: number): Uint8Array[] {
  return el(id, uintBytes(v, width));
}

function elStr(id: number, s: string): Uint8Array[] {
  return el(id, new TextEncoder().encode(s));
}

function elFloat(id: number, v: number): Uint8Array[] {
  return el(id, new BeWriter().f64(v).bytes());
}

function join(...parts: Uint8Array[][]): Uint8Array[] {
  return parts.flat();
}

function ebmlHeader(): Uint8Array[] {
  return el(
    EBML_ID.EBML,
    ...join(
      elUint(EBML_ID.EBMLVersion, 1),
      elUint(EBML_ID.EBMLReadVersion, 1),
      elUint(EBML_ID.EBMLMaxIDLength, 4),
      elUint(EBML_ID.EBMLMaxSizeLength, 8),
      elStr(EBML_ID.DocType, 'webm'),
      elUint(EBML_ID.DocTypeVersion, 2),
      elUint(EBML_ID.DocTypeReadVersion, 2),
    ),
  );
}

interface ClusterPlan {
  /** Cluster timestamp (ms). */
  t: number;
  parts: Uint8Array[];
}

function msOf(us: number): number {
  return Math.round(us / 1000);
}

function clusters(samples: readonly EncodedSample[]): ClusterPlan[] {
  const out: ClusterPlan[] = [];
  let cur: { t: number; blocks: Uint8Array[][] } | null = null;
  const close = (): void => {
    if (!cur) return;
    out.push({
      t: cur.t,
      parts: el(EBML_ID.Cluster, ...join(elUint(EBML_ID.Timestamp, cur.t), ...cur.blocks)),
    });
  };
  for (const s of samples) {
    const t = msOf(s.timestampUs);
    if (!cur || (s.key && t > cur.t) || t - cur.t > MAX_CLUSTER_SPAN_MS) {
      close();
      cur = { t, blocks: [] };
    }
    const rel = t - cur.t;
    const head = new BeWriter()
      .u8(0x81) // track number 1 as a 1-byte vint
      .u16(rel & 0xffff)
      .u8(s.key ? 0x80 : 0)
      .bytes();
    cur.blocks.push(el(EBML_ID.SimpleBlock, head, s.data));
  }
  close();
  return out;
}

/**
 * Muxes VP8/VP9 samples into a WebM file.
 *
 * @param track - Dimensions (and an optional CodecPrivate).
 * @param samples - Encoded frames in order; the first must be a keyframe.
 * @param codec - Matroska codec id.
 * @param frameDurationUs - Nominal frame duration, written as `DefaultDuration`.
 * @returns File parts for `new Blob(parts, { type: 'video/webm' })`.
 * @throws RangeError when there are no samples or the first one is not a keyframe.
 * @example
 * const parts = muxWebm({ width: 1280, height: 720 }, samples, 'V_VP9', 33_333);
 */
export function muxWebm(
  track: VideoTrackInfo,
  samples: readonly EncodedSample[],
  codec: WebmCodec,
  frameDurationUs: number,
): Uint8Array[] {
  if (samples.length === 0) throw new RangeError('No samples to mux');
  if (!samples[0]?.key) throw new RangeError('The first sample must be a keyframe');
  const last = samples[samples.length - 1] as EncodedSample;
  const durationMs = (last.timestampUs + last.durationUs) / 1000;

  const info = el(
    EBML_ID.Info,
    ...join(
      elUint(EBML_ID.TimestampScale, TIMESTAMP_SCALE),
      elFloat(EBML_ID.Duration, durationMs),
      elStr(EBML_ID.MuxingApp, 'Tumble Royale'),
      elStr(EBML_ID.WritingApp, 'Tumble Royale'),
    ),
  );
  const tracks = el(
    EBML_ID.Tracks,
    ...el(
      EBML_ID.TrackEntry,
      ...join(
        elUint(EBML_ID.TrackNumber, 1),
        elUint(EBML_ID.TrackUID, 1),
        elUint(EBML_ID.TrackType, 1),
        elUint(EBML_ID.FlagLacing, 0),
        elStr(EBML_ID.CodecID, codec),
        elUint(EBML_ID.DefaultDuration, Math.round(frameDurationUs * 1000)),
        track.description && track.description.length > 0 ? el(EBML_ID.CodecPrivate, track.description) : [],
        el(
          EBML_ID.Video,
          ...join(elUint(EBML_ID.PixelWidth, track.width), elUint(EBML_ID.PixelHeight, track.height)),
        ),
      ),
    ),
  );
  const planned = clusters(samples);

  // SeekPositions are fixed-width so the SeekHead's size is known before the offsets are.
  const seekHead = (infoAt: number, tracksAt: number, cuesAt: number): Uint8Array[] => {
    const seek = (id: number, at: number): Uint8Array[] =>
      el(EBML_ID.Seek, ...join(el(EBML_ID.SeekID, idBytes(id)), elUint(EBML_ID.SeekPosition, at, 8)));
    return el(
      EBML_ID.SeekHead,
      ...join(seek(EBML_ID.Info, infoAt), seek(EBML_ID.Tracks, tracksAt), seek(EBML_ID.Cues, cuesAt)),
    );
  };
  const seekLen = partsLength(seekHead(0, 0, 0));
  const infoAt = seekLen;
  const tracksAt = infoAt + partsLength(info);
  let at = tracksAt + partsLength(tracks);
  const cuePoints: Uint8Array[][] = [];
  for (const c of planned) {
    cuePoints.push(
      el(
        EBML_ID.CuePoint,
        ...join(
          elUint(EBML_ID.CueTime, c.t),
          el(
            EBML_ID.CueTrackPositions,
            ...join(elUint(EBML_ID.CueTrack, 1), elUint(EBML_ID.CueClusterPosition, at)),
          ),
        ),
      ),
    );
    at += partsLength(c.parts);
  }
  const cues = el(EBML_ID.Cues, ...join(...cuePoints));
  const body = join(seekHead(infoAt, tracksAt, at), info, tracks, ...planned.map((c) => c.parts), cues);
  const segmentHead = new BeWriter()
    .raw(idBytes(EBML_ID.Segment))
    .raw(vintSize(partsLength(body), 8))
    .bytes();
  return [...ebmlHeader(), segmentHead, ...body];
}
