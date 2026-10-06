/**
 * Reliable, ordered message channel on top of an unreliable/unordered packet
 * transport. Today the transport is a WebSocket (already reliable), but the
 * NetworkConditioner drops/reorders packets in testing and WebTransport
 * datagrams are on the roadmap, so delivery guarantees live here.
 *
 * Design: every outgoing message gets a 16-bit sequence number and stays queued
 * until the peer's cumulative ack covers it. Each flush (re)sends unacked
 * messages whose retransmit timeout elapsed, packed into one packet up to a byte
 * budget, and piggybacks our own cumulative ack. The receiver buffers
 * out-of-order messages and delivers strictly in sequence.
 *
 * Packet: `type:8 hasAck:1 [ack:16] count:varint { seq:16 len:varint bytes }*`
 */
import type { BitReader, BitWriter } from './bits.ts';
import { MsgType } from './protocol.ts';

const SEQ_MOD = 65536;
const SEQ_HALF = 32768;

/** True when sequence `a` is newer than `b` under 16-bit wraparound. */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b + SEQ_MOD) % SEQ_MOD;
  return d !== 0 && d < SEQ_HALF;
}

/** Tuning for {@link ReliableEndpoint}. */
export interface ReliableOptions {
  /** Soft cap on packet size; a single oversized message is still sent alone. */
  maxPacketBytes?: number;
  /** Lower bound on the retransmit timeout. */
  minRtoMs?: number;
  /** Upper bound on the retransmit timeout. */
  maxRtoMs?: number;
  /** Messages queued beyond this are a sign the peer is gone; {@link ReliableEndpoint.overflowed} turns true. */
  maxPending?: number;
  /** Out-of-order messages held for in-order delivery, at most (64). */
  maxEarly?: number;
  /** Bytes of out-of-order messages held, at most (64 KiB). */
  maxEarlyBytes?: number;
  /**
   * A message further than this ahead of the next expected sequence (256) is
   * a protocol violation: honest reordering never gets close, so it can only
   * be a peer trying to make us buffer.
   */
  maxAhead?: number;
  /** Largest message accepted from the peer; a bigger one is a protocol violation (default: no limit). */
  maxMessageBytes?: number;
}

interface Outgoing {
  seq: number;
  data: Uint8Array;
  lastSent: number;
  sends: number;
}

/**
 * One side of a reliable channel. Each peer owns one endpoint; the server owns
 * one per client.
 *
 * @example
 * const ch = new ReliableEndpoint();
 * ch.send(encodeReliableMessage({ kind: 'msg', msg: { t: 'chat', from: 1, text: 'gg' } }));
 * if (ch.flush(now, rttMs, writer.reset())) socket.send(writer.finish().slice());
 * // on receive of a MsgType.Reliable packet:
 * ch.receive(reader, (payload) => handle(decodeReliableMessage(payload)));
 */
export class ReliableEndpoint {
  private readonly maxPacketBytes: number;
  private readonly minRto: number;
  private readonly maxRto: number;
  private readonly maxPending: number;
  private readonly maxEarly: number;
  private readonly maxEarlyBytes: number;
  private readonly maxAhead: number;
  private readonly maxMessageBytes: number;

  private readonly outgoing: Outgoing[] = [];
  private nextSendSeq = 0;

  private nextExpected = 0;
  private readonly early = new Map<number, Uint8Array>();
  private earlyBytes = 0;
  private ackDirty = false;
  private receivedAny = false;

  /** Total messages delivered to the application. */
  delivered = 0;
  /** Total retransmissions (diagnostics). */
  retransmits = 0;

  /** @param opts - Optional tuning. */
  constructor(opts: ReliableOptions = {}) {
    this.maxPacketBytes = opts.maxPacketBytes ?? 1100;
    this.minRto = opts.minRtoMs ?? 100;
    this.maxRto = opts.maxRtoMs ?? 2000;
    this.maxPending = opts.maxPending ?? 4096;
    this.maxEarly = opts.maxEarly ?? 64;
    this.maxEarlyBytes = opts.maxEarlyBytes ?? 64 * 1024;
    this.maxAhead = opts.maxAhead ?? 256;
    this.maxMessageBytes = opts.maxMessageBytes ?? Infinity;
  }

  /** Messages sent but not yet acknowledged. */
  get pending(): number {
    return this.outgoing.length;
  }

  /** True when the peer has stopped acking for so long that the queue exceeded `maxPending`. */
  get overflowed(): boolean {
    return this.outgoing.length > this.maxPending;
  }

  /**
   * Queues a message. Ownership of `payload` transfers to the channel (do not mutate it).
   *
   * @returns The sequence number assigned.
   */
  send(payload: Uint8Array): number {
    const seq = this.nextSendSeq;
    this.nextSendSeq = (seq + 1) % SEQ_MOD;
    this.outgoing.push({ seq, data: payload, lastSent: -Infinity, sends: 0 });
    return seq;
  }

  /** True when a flush would write something now (new data, a due retransmit or an owed ack). */
  wantsFlush(now: number, rttMs: number): boolean {
    if (this.ackDirty) return true;
    const rto = this.rto(rttMs);
    for (const m of this.outgoing) if (now - m.lastSent >= rto) return true;
    return false;
  }

  /**
   * Writes a Reliable packet if there is anything to send or acknowledge.
   *
   * @param now - Current time in ms (any monotonic clock).
   * @param rttMs - Current smoothed RTT estimate, for the retransmit timeout.
   * @param w - A reset writer; the packet is written from its start.
   * @returns True if a packet was written.
   */
  flush(now: number, rttMs: number, w: BitWriter): boolean {
    const rto = this.rto(rttMs);
    let due = 0;
    for (const m of this.outgoing) if (now - m.lastSent >= rto) due++;
    if (due === 0 && !this.ackDirty) return false;

    w.writeBits(MsgType.Reliable, 8);
    w.writeBool(this.receivedAny);
    if (this.receivedAny) w.writeBits((this.nextExpected - 1 + SEQ_MOD) % SEQ_MOD, 16);

    // Count first: pick messages that fit the budget, oldest first, so a lost head-of-line message is never starved.
    let bytes = w.byteLength + 3;
    let count = 0;
    for (const m of this.outgoing) {
      if (count >= due) break;
      if (now - m.lastSent < rto) continue;
      const size = 2 + varintSize(m.data.length) + m.data.length;
      if (count > 0 && bytes + size > this.maxPacketBytes) break;
      bytes += size;
      count++;
    }
    w.writeVarUint(count);
    let written = 0;
    for (const m of this.outgoing) {
      if (written >= count) break;
      if (now - m.lastSent < rto) continue;
      w.writeBits(m.seq, 16);
      w.writeByteArray(m.data);
      if (m.sends > 0) this.retransmits++;
      m.lastSent = now;
      m.sends++;
      written++;
    }
    this.ackDirty = false;
    return true;
  }

  /**
   * Consumes a Reliable packet (after its type byte) and delivers any newly
   * in-order messages.
   *
   * @param r - Reader positioned after the type byte.
   * @param deliver - Called once per message, in sequence order. The payload may alias the packet buffer.
   * @returns False if the packet was malformed, carried an oversized message
   *   or one implausibly far ahead (see {@link ReliableOptions}).
   */
  receive(r: BitReader, deliver: (payload: Uint8Array) => void): boolean {
    if (r.readBool()) this.applyAck(r.readBits(16));
    const count = r.readVarUint();
    if (count > 0) this.ackDirty = true;
    for (let i = 0; i < count && !r.overflow; i++) {
      const seq = r.readBits(16);
      const data = r.readByteArray();
      if (r.overflow || data.length > this.maxMessageBytes) return false;
      this.receivedAny = true;
      if (seq === this.nextExpected) {
        this.deliverOne(data, deliver);
        this.drainEarly(deliver);
      } else if (seqNewer(seq, this.nextExpected)) {
        if ((seq - this.nextExpected + SEQ_MOD) % SEQ_MOD > this.maxAhead) return false;
        // SECURITY: bounded by count and bytes, so a hostile peer cannot make us hold megabytes.
        // A message dropped here is simply not acked and comes again.
        if (
          !this.early.has(seq) &&
          this.early.size < this.maxEarly &&
          this.earlyBytes + data.length <= this.maxEarlyBytes
        ) {
          // Copied: the payload may alias a packet buffer the caller reuses.
          this.early.set(seq, data.slice());
          this.earlyBytes += data.length;
        }
      }
      // Older sequences are duplicates of delivered messages: ignore, but keep acking.
    }
    return !r.overflow;
  }

  /** Clears all state (new session). */
  reset(): void {
    this.outgoing.length = 0;
    this.nextSendSeq = 0;
    this.nextExpected = 0;
    this.early.clear();
    this.earlyBytes = 0;
    this.ackDirty = false;
    this.receivedAny = false;
  }

  private deliverOne(data: Uint8Array, deliver: (payload: Uint8Array) => void): void {
    this.nextExpected = (this.nextExpected + 1) % SEQ_MOD;
    this.delivered++;
    deliver(data);
  }

  private drainEarly(deliver: (payload: Uint8Array) => void): void {
    for (;;) {
      const data = this.early.get(this.nextExpected);
      if (!data) return;
      this.early.delete(this.nextExpected);
      this.earlyBytes -= data.length;
      this.deliverOne(data, deliver);
    }
  }

  private applyAck(ack: number): void {
    let n = 0;
    while (n < this.outgoing.length) {
      const seq = this.outgoing[n]!.seq;
      if (seq === ack || seqNewer(ack, seq)) n++;
      else break;
    }
    if (n > 0) this.outgoing.splice(0, n);
  }

  private rto(rttMs: number): number {
    const r = rttMs * 1.5 + 30;
    return r < this.minRto ? this.minRto : r > this.maxRto ? this.maxRto : r;
  }
}

function varintSize(n: number): number {
  let s = 1;
  while (n >= 128) {
    n = Math.floor(n / 128);
    s++;
  }
  return s;
}
