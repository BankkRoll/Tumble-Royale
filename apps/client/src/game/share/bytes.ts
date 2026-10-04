/**
 * Shared plumbing for the clip muxers: the encoded-sample shape both
 * containers consume and a small big-endian byte builder (MP4 boxes and EBML
 * headers are big-endian; sample payloads are never copied through it).
 */

/** One encoded video frame as WebCodecs hands it over. */
export interface EncodedSample {
  /** Codec payload (AVCC length-prefixed NAL units for H.264, raw frames for VP8/VP9). */
  data: Uint8Array;
  /** Presentation time in microseconds from the start of the clip. */
  timestampUs: number;
  /** Frame duration in microseconds. */
  durationUs: number;
  /** Sync sample (keyframe). */
  key: boolean;
}

/** Video track facts a muxer needs. */
export interface VideoTrackInfo {
  width: number;
  height: number;
  /**
   * Codec configuration record: the `avcC` payload for H.264 (WebCodecs
   * `decoderConfig.description`). Optional for VP8/VP9.
   */
  description?: Uint8Array | null;
}

/**
 * Growable big-endian writer for container headers.
 *
 * @example
 * const w = new BeWriter();
 * w.u32(8).ascii('free');
 * const box = w.bytes();
 */
export class BeWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  /** Bytes written so far. */
  get length(): number {
    return this.len;
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Appends one byte. */
  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  /** Appends a big-endian 16-bit integer. */
  u16(v: number): this {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  /** Appends a big-endian 24-bit integer. */
  u24(v: number): this {
    this.ensure(3);
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  /** Appends a big-endian 32-bit integer (negative values wrap to two's complement). */
  u32(v: number): this {
    this.ensure(4);
    const u = v >>> 0;
    this.buf[this.len++] = (u >>> 24) & 0xff;
    this.buf[this.len++] = (u >>> 16) & 0xff;
    this.buf[this.len++] = (u >>> 8) & 0xff;
    this.buf[this.len++] = u & 0xff;
    return this;
  }

  /** Appends a big-endian IEEE 754 double. */
  f64(v: number): this {
    this.ensure(8);
    new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, v);
    this.len += 8;
    return this;
  }

  /** Appends ASCII text without a terminator. */
  ascii(s: string): this {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0x7f;
    return this;
  }

  /** Appends raw bytes. */
  raw(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Appends `n` zero bytes. */
  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  /** A copy of everything written. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Total byte length of a list of parts. */
export function partsLength(parts: readonly Uint8Array[]): number {
  let n = 0;
  for (const p of parts) n += p.length;
  return n;
}

/**
 * Integer tick of a microsecond time on a timescale, rounded so frame
 * durations derived from consecutive ticks never drift from the timestamps.
 *
 * @param us - Microseconds.
 * @param timescale - Ticks per second.
 */
export function usToTicks(us: number, timescale: number): number {
  return Math.round((us * timescale) / 1_000_000);
}
