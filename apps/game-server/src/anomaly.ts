/**
 * Anomaly telemetry: sanity checks that never act on a player, only count and
 * log, so a sim bug or an abusive client shows up on dashboards without an
 * honest player ever being kicked for it.
 *
 * - Authoritative bodies: the server never accepts client positions, so a
 *   body moving faster than any mechanic allows, or jumping metres in one
 *   tick without a teleport/respawn event, means a SIM bug (tunnelling, a
 *   launcher with a bad param, a NaN recovery).
 * - Client inputs: batch floods beyond the 60 Hz cadence, sequence numbers
 *   running ahead of the wall clock or rewinding mid-session, and out-of-range
 *   emote slots: none of these come from the real client.
 */
import { MAX_ENTITIES } from '@tumble/netcode';
import type { Vec3 } from '@tumble/shared';

/** Counted anomaly kinds (Prometheus label values). */
export const ANOMALY_KINDS = [
  'sim_speed',
  'sim_teleport',
  'input_flood',
  'input_seq_ahead',
  'input_seq_rewind',
  'input_bad_emote',
] as const;

/** One anomaly kind. */
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/** Counters per kind. */
export type AnomalyCounts = Record<AnomalyKind, number>;

/** @returns Zeroed counters. */
export function createAnomalyCounts(): AnomalyCounts {
  return {
    sim_speed: 0,
    sim_teleport: 0,
    input_flood: 0,
    input_seq_ahead: 0,
    input_seq_rewind: 0,
    input_bad_emote: 0,
  };
}

/**
 * Fastest legitimate body speed (m/s). Cannons and bounce pads stay well
 * under this; the snapshot velocity range is ±40 m/s per axis.
 */
export const MAX_BODY_SPEED = 70;
/** A jump of more than this in one network tick, with no teleport event, is a teleport anomaly (m). */
export const TELEPORT_DISTANCE = 8;

/**
 * Tracks authoritative body positions once per network tick.
 *
 * @example
 * monitor.exempt(id);                    // teleport / respawn / fellOut event this tick
 * const kind = monitor.observe(id, pos, 1 / 30);
 */
export class BodyMonitor {
  private readonly last = new Float64Array(MAX_ENTITIES * 3);
  private readonly known = new Uint8Array(MAX_ENTITIES);
  private readonly skip = new Uint8Array(MAX_ENTITIES);

  /** Forget everything (new sim). */
  reset(): void {
    this.known.fill(0);
    this.skip.fill(0);
  }

  /** Forget one player (left the lobby). */
  forget(id: number): void {
    if (id >= 0 && id < MAX_ENTITIES) this.known[id] = 0;
  }

  /** The next observation of `id` is a legitimate discontinuity (teleport, respawn). */
  exempt(id: number): void {
    if (id >= 0 && id < MAX_ENTITIES) this.skip[id] = 1;
  }

  /**
   * Records `id`'s position after `dt` seconds.
   *
   * @returns The anomaly this movement shows, or null.
   */
  observe(id: number, pos: Vec3, dt: number): AnomalyKind | null {
    if (id < 0 || id >= MAX_ENTITIES) return null;
    const o = id * 3;
    const l = this.last;
    let kind: AnomalyKind | null = null;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      kind = 'sim_teleport';
    } else if (this.known[id] && !this.skip[id]) {
      const d = Math.hypot(pos.x - l[o]!, pos.y - l[o + 1]!, pos.z - l[o + 2]!);
      if (d > TELEPORT_DISTANCE) kind = 'sim_teleport';
      else if (dt > 0 && d / dt > MAX_BODY_SPEED) kind = 'sim_speed';
    }
    l[o] = pos.x;
    l[o + 1] = pos.y;
    l[o + 2] = pos.z;
    this.known[id] = 1;
    this.skip[id] = 0;
    return kind;
  }
}

/**
 * Counts input batches per session in one-second windows. The real client
 * sends one batch per 60 Hz step (plus 10 Hz ack-only batches when idle), so
 * a window well past that is a flood even after a stall's catch-up burst.
 */
export class InputRateMonitor {
  private windowStart = -1;
  private count = 0;
  private flagged = false;
  private lastSeq = -1;

  /**
   * @param maxPerSec - Batches per second tolerated. Twice the 60 Hz cadence:
   *   stays under the connection rate limit (150/s) so floods are seen
   *   before the limiter starts dropping them.
   */
  constructor(private readonly maxPerSec = 120) {}

  /**
   * Notes one batch.
   *
   * @returns True the first time a window crosses the limit.
   */
  note(now: number): boolean {
    if (this.windowStart < 0 || now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.count = 0;
      this.flagged = false;
    }
    this.count++;
    if (!this.flagged && this.count > this.maxPerSec) {
      this.flagged = true;
      return true;
    }
    return false;
  }

  /**
   * Notes a batch's newest sequence.
   *
   * @returns True when it rewound far behind the previous one (not a reorder).
   */
  noteSeq(seq: number): boolean {
    const prev = this.lastSeq;
    if (seq > prev) this.lastSeq = seq;
    // Reordered or redundant batches are a few steps behind; a rewind of seconds is not.
    return prev >= 0 && seq < prev - 600;
  }

  /** Forget sequence history (session resumed: the client restarts its counter). */
  resetSeq(): void {
    this.lastSeq = -1;
  }
}
