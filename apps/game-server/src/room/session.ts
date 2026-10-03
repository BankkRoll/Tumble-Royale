/**
 * Per-connection protocol state: reliable channel, snapshot encoder, rate
 * limits and RTT estimation. Game-level state (the player slot, inputs) lives
 * in the {@link Room}; a slot outlives its session across reconnects.
 */
import {
  ReliableEndpoint,
  SnapshotEncoder,
  encodeReliableMessage,
  type LowFreqMessage,
} from '@tumble/netcode';
import { ConnectionGuard, DEFAULT_LIMITS, type ConnectionLimits } from '../antiCheat.ts';
import type { Connection } from '../transport/types.ts';

const SENT_RING = 64;

/** One connected client. */
export class ClientSession {
  readonly guard: ConnectionGuard;
  readonly reliable = new ReliableEndpoint();
  readonly encoder: SnapshotEncoder;
  /** Player id once joined, else -1. */
  playerId = -1;
  /** Entity the client spectates (interest management), or -1. */
  spectateTarget = -1;
  /** Smoothed RTT estimate from snapshot→ack timing (ms). */
  rttMs = 100;
  private rttSamples = 0;
  private readonly sentIds = new Int32Array(SENT_RING).fill(-1);
  private readonly sentAt = new Float64Array(SENT_RING);
  private lastAck = -1;

  /**
   * @param conn - The underlying connection.
   * @param now - Current time (ms).
   * @param snapshotByteBudget - Per-snapshot byte budget.
   * @param limits - Rate limits.
   */
  constructor(
    readonly conn: Connection,
    now: number,
    snapshotByteBudget: number,
    limits: ConnectionLimits = DEFAULT_LIMITS,
  ) {
    this.guard = new ConnectionGuard(limits, now);
    this.encoder = new SnapshotEncoder({ byteBudget: snapshotByteBudget });
  }

  /** Queues a low-frequency message on the reliable channel. */
  sendLowFreq(msg: LowFreqMessage): void {
    this.reliable.send(encodeReliableMessage({ kind: 'msg', msg }));
  }

  /** Records when a snapshot went out, for RTT estimation. */
  noteSnapshotSent(snapshotId: number, now: number): void {
    const i = snapshotId % SENT_RING;
    this.sentIds[i] = snapshotId;
    this.sentAt[i] = now;
  }

  /** Applies a snapshot ack from an InputBatch. */
  onSnapshotAck(snapshotId: number, now: number): void {
    if (snapshotId < 0) return;
    this.encoder.ack(snapshotId);
    if (snapshotId === this.lastAck) return;
    this.lastAck = snapshotId;
    const i = snapshotId % SENT_RING;
    if (this.sentIds[i] !== snapshotId) return;
    // The ack rides on the next 60 Hz input, so it includes up to one client frame of delay.
    const sample = now - this.sentAt[i]!;
    if (sample < 0 || sample > 5000) return;
    this.rttMs = this.rttSamples++ === 0 ? sample : this.rttMs + (sample - this.rttMs) * 0.1;
  }

  /** Forgets snapshot/ack state (new connection for a resumed player). */
  resetSnapshots(): void {
    this.encoder.reset();
    this.sentIds.fill(-1);
    this.lastAck = -1;
  }
}
