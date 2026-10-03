/**
 * Byte-level primitives for the replay format: a growable writer and a
 * bounds-checked reader with unsigned/zig-zag varints that stay exact up to
 * 2^53 (net states pack large integers, so 32-bit bitwise varints would wrap).
 */

/** Thrown when a reader runs past its data or meets a malformed value. */
export class ReplayDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDecodeError';
  }
}

const TWO_32 = 0x1_0000_0000;

/**
 * Maps a signed integer to an unsigned one (0, -1, 1, -2 → 0, 1, 2, 3).
 *
 * @param n - Safe integer.
 * @returns Non-negative safe integer.
 */
export function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

/**
 * Inverse of {@link zigzag}.
 *
 * @param u - Non-negative safe integer.
 */
export function unzigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

/**
 * Append-only byte buffer that doubles its capacity as it fills.
 *
 * @example
 * const w = new ByteWriter();
 * w.svarint(-3);
 * const bytes = w.finish();
 */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  /** @param capacity - Initial capacity in bytes. */
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  /** Bytes written so far. */
  get length(): number {
    return this.len;
  }

  /** Bytes reserved (the memory the writer actually holds). */
  get capacity(): number {
    return this.buf.length;
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Writes one byte (0–255). */
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** Writes a little-endian u16. */
  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }

  /** Writes a little-endian u32. */
  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  /**
   * Writes an unsigned LEB128 varint.
   *
   * @param v - Non-negative safe integer.
   */
  varint(v: number): void {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new RangeError(`varint out of range: ${v}`);
    this.ensure(8);
    // Division instead of `>>>` so values above 2^32 survive.
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
  }

  /** Writes a zig-zag signed varint. */
  svarint(v: number): void {
    this.varint(zigzag(v));
  }

  /** Appends raw bytes. */
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** Forgets the contents but keeps the allocation (per-frame scratch). */
  reset(): void {
    this.len = 0;
  }

  /** The written bytes as a view (invalidated by the next write). */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  /** Copies the written bytes out (the writer stays usable). */
  snapshot(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** Returns the written bytes, trimmed, and resets the writer. */
  finish(): Uint8Array {
    const out = this.buf.slice(0, this.len);
    this.buf = new Uint8Array(16);
    this.len = 0;
    return out;
  }
}

/** Sequential reader over a byte array; every read is bounds-checked. */
export class ByteReader {
  private pos = 0;

  /** @param buf - Bytes to read. */
  constructor(private readonly buf: Uint8Array) {}

  /** Current offset. */
  get offset(): number {
    return this.pos;
  }

  /** True when every byte has been consumed. */
  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new ReplayDecodeError('Unexpected end of replay data');
  }

  /** Reads one byte. */
  u8(): number {
    this.need(1);
    return this.buf[this.pos++] as number;
  }

  /** Reads a little-endian u16. */
  u16(): number {
    this.need(2);
    const b = this.buf;
    const v = (b[this.pos] as number) | ((b[this.pos + 1] as number) << 8);
    this.pos += 2;
    return v;
  }

  /** Reads a little-endian u32. */
  u32(): number {
    this.need(4);
    const b = this.buf;
    const p = this.pos;
    const v =
      ((b[p] as number) |
        ((b[p + 1] as number) << 8) |
        ((b[p + 2] as number) << 16) |
        ((b[p + 3] as number) << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  /** Reads an unsigned LEB128 varint. */
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * mul;
      if ((byte & 0x80) === 0) return result;
      mul *= 0x80;
    }
    throw new ReplayDecodeError('Varint too long');
  }

  /** Reads a zig-zag signed varint. */
  svarint(): number {
    return unzigzag(this.varint());
  }

  /** Reads `n` raw bytes (a view, not a copy). */
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Largest integer {@link ByteWriter.u32} round-trips. */
export const U32_MAX = TWO_32 - 1;
