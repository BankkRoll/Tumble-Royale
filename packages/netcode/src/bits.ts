/**
 * Bit-level writer and reader used by every binary message.
 *
 * Bits are packed LSB-first into bytes. Both classes are designed to be
 * allocated once and reused for every message (`reset()`), so the hot paths
 * (snapshots at 30 Hz × 40 clients, inputs at 60 Hz) never allocate.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Shared scratch for float <-> bits conversion (never escapes this module). */
const floatScratch = new DataView(new ArrayBuffer(8));

/**
 * Writes bit-packed data into a growable byte buffer.
 *
 * @example
 * const w = new BitWriter(256);
 * w.writeUint(5, 3);
 * w.writeFloat32(1.5);
 * socket.send(w.finish().slice());
 */
export class BitWriter {
  private buf: Uint8Array;
  private byteLen = 0;
  /** Pending bits not yet flushed to `buf`; always < 2^8 between calls. */
  private acc = 0;
  private accBits = 0;

  /** @param capacity - Initial capacity in bytes; grows on demand. */
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  /** Clears the writer for a new message without releasing its buffer. */
  reset(): this {
    this.byteLen = 0;
    this.acc = 0;
    this.accBits = 0;
    return this;
  }

  /** Total bits written so far. */
  get bitLength(): number {
    return this.byteLen * 8 + this.accBits;
  }

  /** Bytes the message occupies once finished (partial final byte rounded up). */
  get byteLength(): number {
    return this.byteLen + (this.accBits > 0 ? 1 : 0);
  }

  /**
   * Writes the low `bits` bits of an unsigned integer.
   *
   * @param value - Unsigned integer; bits above `bits` are discarded.
   * @param bits - 0–32.
   */
  writeBits(value: number, bits: number): void {
    if (bits <= 0) return;
    // PERF: stay in 32-bit integer ops; ≤ 7 bits are pending, so > 25-bit writes are split in two.
    if (bits > 24) {
      this.writeBits(value & 0xffff, 16);
      this.writeBits((value >>> 16) & ((1 << (bits - 16)) - 1), bits - 16);
      return;
    }
    if (this.byteLen + 4 > this.buf.length) this.grow(this.byteLen + 4);
    let acc = (this.acc | ((value & ((1 << bits) - 1)) << this.accBits)) >>> 0;
    let accBits = this.accBits + bits;
    const buf = this.buf;
    while (accBits >= 8) {
      buf[this.byteLen++] = acc & 0xff;
      acc >>>= 8;
      accBits -= 8;
    }
    this.acc = acc;
    this.accBits = accBits;
  }

  /** Writes one bit. */
  writeBool(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  /** Writes an unsigned integer in `bits` bits (alias of {@link writeBits}, clamped to the range). */
  writeUint(value: number, bits: number): void {
    const max = 2 ** bits - 1;
    this.writeBits(value < 0 ? 0 : value > max ? max : value, bits);
  }

  /** Writes a two's-complement signed integer in `bits` bits, clamped to the representable range. */
  writeInt(value: number, bits: number): void {
    const half = 2 ** (bits - 1);
    const v = value < -half ? -half : value > half - 1 ? half - 1 : value;
    this.writeBits(v < 0 ? v + 2 ** bits : v, bits);
  }

  /**
   * Writes `value` quantised into `bits` bits over [min, max] (clamped).
   * Max error is `(max - min) / (2^bits - 1) / 2`.
   */
  writeQuantized(value: number, min: number, max: number, bits: number): void {
    this.writeBits(quantizeRange(value, min, max, bits), bits);
  }

  /** Writes an IEEE-754 float32. */
  writeFloat32(value: number): void {
    floatScratch.setFloat32(0, value, true);
    this.writeBits(floatScratch.getUint32(0, true), 32);
  }

  /** Writes an IEEE-754 float64 (64 bits). */
  writeFloat64(value: number): void {
    floatScratch.setFloat64(0, value, true);
    this.writeBits(floatScratch.getUint32(0, true), 32);
    this.writeBits(floatScratch.getUint32(4, true), 32);
  }

  /** Writes an unsigned LEB128-style varint in 8-bit groups (values up to 2^53). */
  writeVarUint(value: number): void {
    let v = value < 0 ? 0 : Math.floor(value);
    while (v >= 128) {
      this.writeBits((v % 128) | 128, 8);
      v = Math.floor(v / 128);
    }
    this.writeBits(v, 8);
  }

  /** Writes a zigzag-encoded signed varint. */
  writeVarInt(value: number): void {
    const v = Math.trunc(value);
    this.writeVarUint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  /** Writes raw bytes, byte-aligned relative to the bit stream (not the buffer). */
  writeBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i]!, 8);
  }

  /** Writes a varint byte length followed by the bytes. */
  writeByteArray(bytes: Uint8Array): void {
    this.writeVarUint(bytes.length);
    this.writeBytes(bytes);
  }

  /**
   * Writes a short UTF-8 string (varint byte length + bytes), truncated to `maxBytes`.
   * Allocates for the UTF-8 encode, so keep strings off per-tick paths.
   */
  writeString(value: string, maxBytes = 255): void {
    let bytes = textEncoder.encode(value);
    if (bytes.length > maxBytes) bytes = bytes.subarray(0, maxBytes);
    this.writeByteArray(bytes);
  }

  /** Returns the current position for a later {@link rewind}. */
  mark(): number {
    return this.bitLength;
  }

  /**
   * Truncates the stream back to a position previously returned by {@link mark}.
   * Used to undo an entity that would overflow the packet budget.
   */
  rewind(bitPos: number): void {
    if (bitPos >= this.bitLength) return;
    this.byteLen = bitPos >>> 3;
    this.accBits = bitPos & 7;
    this.acc = this.accBits === 0 ? 0 : this.buf[this.byteLen]! & ((1 << this.accBits) - 1);
  }

  /**
   * Flushes the trailing partial byte and returns a view of the message.
   * The view aliases the internal buffer: copy it (`slice()`) before handing it
   * to anything that may hold on to it after the next `reset()`.
   */
  finish(): Uint8Array {
    if (this.accBits > 0) {
      if (this.byteLen + 1 > this.buf.length) this.grow(this.byteLen + 1);
      this.buf[this.byteLen] = this.acc;
      return this.buf.subarray(0, this.byteLen + 1);
    }
    return this.buf.subarray(0, this.byteLen);
  }

  private grow(min: number): void {
    const next = new Uint8Array(Math.max(min, this.buf.length * 2));
    next.set(this.buf.subarray(0, this.byteLen));
    this.buf = next;
  }
}

/**
 * Reads bit-packed data written by {@link BitWriter}.
 *
 * Reading past the end never throws: it returns zeros and sets {@link overflow},
 * so decoders validate once at the end instead of guarding every field.
 */
export class BitReader {
  private buf: Uint8Array = new Uint8Array(0);
  private bytePos = 0;
  private acc = 0;
  private accBits = 0;
  /** True once a read ran past the end of the buffer (the message is malformed). */
  overflow = false;

  /** @param data - Optional initial buffer. */
  constructor(data?: Uint8Array) {
    if (data) this.reset(data);
  }

  /** Points the reader at a new message. The buffer is not copied. */
  reset(data: Uint8Array): this {
    this.buf = data;
    this.bytePos = 0;
    this.acc = 0;
    this.accBits = 0;
    this.overflow = false;
    return this;
  }

  /** Bits consumed so far. */
  get bitPosition(): number {
    return this.bytePos * 8 - this.accBits;
  }

  /** Bits left in the buffer. */
  get remainingBits(): number {
    return this.buf.length * 8 - this.bitPosition;
  }

  /** Reads an unsigned integer of `bits` bits (0–32). */
  readBits(bits: number): number {
    if (bits <= 0) return 0;
    if (bits > 24) {
      const lo = this.readBits(16);
      return lo + this.readBits(bits - 16) * 65536;
    }
    let acc = this.acc;
    let accBits = this.accBits;
    while (accBits < bits) {
      if (this.bytePos >= this.buf.length) {
        this.overflow = true;
        this.acc = 0;
        this.accBits = 0;
        return 0;
      }
      acc = (acc | (this.buf[this.bytePos++]! << accBits)) >>> 0;
      accBits += 8;
    }
    const value = acc & ((1 << bits) - 1);
    this.acc = acc >>> bits;
    this.accBits = accBits - bits;
    return value;
  }

  /** Reads one bit. */
  readBool(): boolean {
    return this.readBits(1) === 1;
  }

  /** Reads an unsigned integer of `bits` bits. */
  readUint(bits: number): number {
    return this.readBits(bits);
  }

  /** Reads a two's-complement signed integer of `bits` bits. */
  readInt(bits: number): number {
    const v = this.readBits(bits);
    const half = 2 ** (bits - 1);
    return v >= half ? v - 2 ** bits : v;
  }

  /** Reads a value written by {@link BitWriter.writeQuantized}. */
  readQuantized(min: number, max: number, bits: number): number {
    return dequantizeRange(this.readBits(bits), min, max, bits);
  }

  /** Reads an IEEE-754 float32. */
  readFloat32(): number {
    floatScratch.setUint32(0, this.readBits(32), true);
    return floatScratch.getFloat32(0, true);
  }

  /** Reads an IEEE-754 float64. */
  readFloat64(): number {
    const lo = this.readBits(32);
    const hi = this.readBits(32);
    floatScratch.setUint32(0, lo, true);
    floatScratch.setUint32(4, hi, true);
    return floatScratch.getFloat64(0, true);
  }

  /** Reads an unsigned varint. */
  readVarUint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.readBits(8);
      result += (b & 127) * scale;
      if ((b & 128) === 0 || this.overflow) return result;
      scale *= 128;
    }
    // More than 8 groups exceeds 2^53: the message is corrupt.
    this.overflow = true;
    return 0;
  }

  /** Reads a zigzag-encoded signed varint. */
  readVarInt(): number {
    const v = this.readVarUint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  /** Reads `length` raw bytes into a new array. */
  readBytes(length: number): Uint8Array {
    if (length > this.remainingBits / 8) {
      this.overflow = true;
      return new Uint8Array(0);
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.readBits(8);
    return out;
  }

  /** Reads a varint-length-prefixed byte array. */
  readByteArray(): Uint8Array {
    return this.readBytes(this.readVarUint());
  }

  /** Reads a string written by {@link BitWriter.writeString}. */
  readString(): string {
    const bytes = this.readByteArray();
    return this.overflow ? '' : textDecoder.decode(bytes);
  }
}

/**
 * Maps `value` in [min, max] onto an integer in [0, 2^bits - 1] (clamped, rounded).
 *
 * @returns The quantised integer.
 */
export function quantizeRange(value: number, min: number, max: number, bits: number): number {
  const steps = 2 ** bits - 1;
  if (!(value > min)) return 0;
  if (value >= max) return steps;
  return Math.round(((value - min) / (max - min)) * steps);
}

/** Inverse of {@link quantizeRange}. */
export function dequantizeRange(q: number, min: number, max: number, bits: number): number {
  return min + (q / (2 ** bits - 1)) * (max - min);
}
