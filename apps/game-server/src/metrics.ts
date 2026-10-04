/**
 * Server metrics: rolling tick-time windows with a per-phase breakdown,
 * traffic counters, and Prometheus text exposition for `/metrics`.
 */
import { ANOMALY_KINDS, createAnomalyCounts, type AnomalyCounts } from './anomaly.ts';

/** Rolling window of samples with mean / percentile / max. */
export class RollingWindow {
  private readonly buf: Float64Array;
  private readonly sorted: Float64Array;
  private n = 0;
  private head = 0;

  /** @param size - Samples kept. */
  constructor(size = 300) {
    this.buf = new Float64Array(size);
    this.sorted = new Float64Array(size);
  }

  /** Adds one sample. */
  add(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  /** Number of samples. */
  get count(): number {
    return this.n;
  }

  /** Mean of the window, 0 when empty. */
  mean(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.buf[i]!;
    return this.n ? s / this.n : 0;
  }

  /** Max of the window, 0 when empty. */
  max(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.buf[i]! > m) m = this.buf[i]!;
    return m;
  }

  /** Percentile in [0, 1] (nearest rank). */
  percentile(p: number): number {
    if (this.n === 0) return 0;
    const s = this.sorted.subarray(0, this.n);
    s.set(this.buf.subarray(0, this.n));
    s.sort();
    return s[Math.min(this.n - 1, Math.floor(p * this.n))]!;
  }

  /** Clears all samples. */
  clear(): void {
    this.n = 0;
    this.head = 0;
  }
}

/** Tick phases measured separately. */
export type TickPhase = 'total' | 'sim' | 'snapshot' | 'send';

/** Process-wide counters and windows. One instance per process. */
export class ServerMetrics {
  readonly tick: Record<TickPhase, RollingWindow> = {
    total: new RollingWindow(),
    sim: new RollingWindow(),
    snapshot: new RollingWindow(),
    send: new RollingWindow(),
  };
  /** Snapshot sizes in bytes. */
  readonly snapshotBytes = new RollingWindow(2000);
  /** Client RTT estimates (ms), one sample per session per report. */
  readonly rtt = new RollingWindow(500);
  rooms = 0;
  players = 0;
  humans = 0;
  bots = 0;
  snapshotsSent = 0;
  snapshotsDropped = 0;
  kicks = 0;
  rateLimited = 0;
  inputMissed = 0;
  inputLate = 0;
  roomCrashes = 0;
  /** Show results waiting in the outbox for the API. */
  outboxBacklog = 0;
  /** 1 while the server drains for shutdown. */
  draining = 0;
  /** Sanity-check anomalies by kind (telemetry only; nobody is kicked for these). */
  readonly anomalies: AnomalyCounts = createAnomalyCounts();
  /** Grabs the server granted from a lag-compensated view. */
  lagCompGrabs = 0;
  /** Dive tackles the server granted from a lag-compensated view. */
  lagCompTackles = 0;
  private bytesOutSample = 0;
  private bytesOutAt = 0;
  /** Outbound bytes/s over the last rate interval. */
  bytesOutPerSec = 0;
  /** Inbound bytes/s over the last rate interval. */
  bytesInPerSec = 0;
  private bytesInSample = 0;

  /**
   * Updates the bytes/s rates from cumulative transport counters.
   *
   * @param nowMs - Current time.
   */
  updateRates(nowMs: number, bytesOut: number, bytesIn: number): void {
    if (this.bytesOutAt > 0) {
      const dt = (nowMs - this.bytesOutAt) / 1000;
      if (dt > 0) {
        this.bytesOutPerSec = (bytesOut - this.bytesOutSample) / dt;
        this.bytesInPerSec = (bytesIn - this.bytesInSample) / dt;
      }
    }
    this.bytesOutAt = nowMs;
    this.bytesOutSample = bytesOut;
    this.bytesInSample = bytesIn;
  }

  /** One-line profile summary for the periodic log. */
  summary(): string {
    const t = this.tick;
    const f = (v: number): string => v.toFixed(2);
    return (
      `rooms=${this.rooms} players=${this.players} (humans=${this.humans} bots=${this.bots}) ` +
      `tick avg=${f(t.total.mean())}ms p95=${f(t.total.percentile(0.95))} max=${f(t.total.max())} ` +
      `[sim ${f(t.sim.mean())} snap ${f(t.snapshot.mean())} send ${f(t.send.mean())}] ` +
      `snapshot avg=${this.snapshotBytes.mean().toFixed(0)}B p95=${this.snapshotBytes.percentile(0.95).toFixed(0)}B ` +
      `out=${(this.bytesOutPerSec / 1024).toFixed(1)}KB/s in=${(this.bytesInPerSec / 1024).toFixed(1)}KB/s ` +
      `rtt=${this.rtt.mean().toFixed(0)}ms`
    );
  }

  /** Prometheus text exposition (format 0.0.4). */
  prometheus(): string {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number, labels = ''): void => {
      lines.push(
        `# HELP ${name} ${help}`,
        `# TYPE ${name} gauge`,
        `${name}${labels} ${Number.isFinite(value) ? value : 0}`,
      );
    };
    const counter = (name: string, help: string, value: number): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`);
    };
    lines.push(
      '# HELP tumble_tick_ms Server tick duration over the last ~10 s, by phase.',
      '# TYPE tumble_tick_ms gauge',
    );
    for (const phase of Object.keys(this.tick) as TickPhase[]) {
      const w = this.tick[phase];
      lines.push(`tumble_tick_ms{phase="${phase}",stat="avg"} ${w.mean().toFixed(4)}`);
      lines.push(`tumble_tick_ms{phase="${phase}",stat="p50"} ${w.percentile(0.5).toFixed(4)}`);
      lines.push(`tumble_tick_ms{phase="${phase}",stat="p95"} ${w.percentile(0.95).toFixed(4)}`);
      lines.push(`tumble_tick_ms{phase="${phase}",stat="max"} ${w.max().toFixed(4)}`);
    }
    gauge('tumble_rooms', 'Active rooms.', this.rooms);
    gauge('tumble_players', 'Players in rooms (humans + bots).', this.players);
    gauge('tumble_humans', 'Connected human players.', this.humans);
    gauge('tumble_bots', 'Bot players.', this.bots);
    gauge('tumble_bytes_out_per_second', 'Outbound bytes per second.', this.bytesOutPerSec);
    gauge('tumble_bytes_in_per_second', 'Inbound bytes per second.', this.bytesInPerSec);
    gauge('tumble_snapshot_bytes_avg', 'Mean snapshot size in bytes.', this.snapshotBytes.mean());
    gauge('tumble_snapshot_bytes_p95', 'p95 snapshot size in bytes.', this.snapshotBytes.percentile(0.95));
    gauge('tumble_rtt_ms_avg', 'Mean client RTT (ms).', this.rtt.mean());
    gauge('tumble_rtt_ms_p95', 'p95 client RTT (ms).', this.rtt.percentile(0.95));
    gauge('tumble_outbox_backlog', 'Show results waiting for delivery to the API.', this.outboxBacklog);
    gauge('tumble_draining', '1 while the server drains for shutdown.', this.draining);
    counter('tumble_snapshots_sent_total', 'Snapshots sent.', this.snapshotsSent);
    counter(
      'tumble_snapshots_dropped_total',
      'Snapshots skipped due to socket backpressure.',
      this.snapshotsDropped,
    );
    counter('tumble_kicks_total', 'Sessions kicked.', this.kicks);
    counter(
      'tumble_rate_limited_total',
      'Messages rejected by rate limits or sanity checks.',
      this.rateLimited,
    );
    counter('tumble_input_missed_total', 'Inputs that never arrived (repeated instead).', this.inputMissed);
    counter('tumble_input_late_total', 'Inputs that arrived after their step.', this.inputLate);
    counter('tumble_room_crashes_total', 'Rooms closed after an exception in their tick.', this.roomCrashes);
    lines.push(
      '# HELP tumble_anomalies_total Sanity-check anomalies (sim body speed/teleport, client input floods and impossible sequences).',
      '# TYPE tumble_anomalies_total counter',
    );
    for (const kind of ANOMALY_KINDS)
      lines.push(`tumble_anomalies_total{kind="${kind}"} ${this.anomalies[kind]}`);
    lines.push(
      '# HELP tumble_lagcomp_assists_total Hits granted from a lag-compensated client view.',
      '# TYPE tumble_lagcomp_assists_total counter',
      `tumble_lagcomp_assists_total{kind="grab"} ${this.lagCompGrabs}`,
      `tumble_lagcomp_assists_total{kind="tackle"} ${this.lagCompTackles}`,
    );
    return lines.join('\n') + '\n';
  }
}
