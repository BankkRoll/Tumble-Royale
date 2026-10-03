/**
 * Dependency-free Prometheus metrics for the Node services (Node only).
 *
 * Responsibilities:
 * - Counters, gauges and histograms with labels, rendered in the Prometheus
 *   text exposition format (0.0.4).
 * - Gauges computed at scrape time (queue depth, open sockets) through
 *   collect callbacks, so nothing has to be kept in sync by hand.
 * - The shared `/metrics` access rule ({@link metricsAccess}).
 *
 * prom-client would do, but it pulls in its own default process collectors
 * and a cluster aggregator none of the services use; this is ~200 lines.
 */

/** Label set of one series. */
export type Labels = Readonly<Record<string, string | number>>;

/** Value source for a gauge read at scrape time. */
export type GaugeCollect = () =>
  number | readonly (readonly [Labels, number])[] | Promise<number | readonly (readonly [Labels, number])[]>;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

const escapeLabel = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (v: string): string => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

function labelKey(labels: Labels | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`).join(',')}}`;
}

function fmt(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

interface Metric {
  readonly name: string;
  render(): Promise<string[]>;
}

/** Monotonic counter. */
export class Counter implements Metric {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    private readonly help: string,
  ) {}

  /**
   * Adds to a series.
   *
   * @param labels - Series labels.
   * @param by - Non-negative increment (default 1).
   */
  inc(labels?: Labels, by = 1): void {
    if (!(by >= 0)) return;
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  /** Current value of a series (tests). */
  get(labels?: Labels): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  async render(): Promise<string[]> {
    const out = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) out.push(`${this.name} 0`);
    for (const [k, v] of this.values) out.push(`${this.name}${k} ${fmt(v)}`);
    return out;
  }
}

/** Gauge set directly or computed at scrape time. */
export class Gauge implements Metric {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    private readonly help: string,
    private readonly collect?: GaugeCollect,
  ) {}

  /** Sets a series. */
  set(labels: Labels | undefined, value: number): void {
    this.values.set(labelKey(labels), value);
  }

  /** Adds `by` (may be negative) to a series. */
  inc(labels?: Labels, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  /** Removes a series (e.g. a game server that deregistered). */
  remove(labels?: Labels): void {
    this.values.delete(labelKey(labels));
  }

  /** Current value of a set series (tests). */
  get(labels?: Labels): number | undefined {
    return this.values.get(labelKey(labels));
  }

  async render(): Promise<string[]> {
    const out = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} gauge`];
    const series = new Map(this.values);
    if (this.collect) {
      try {
        const v = await this.collect();
        if (typeof v === 'number') series.set('', v);
        else for (const [labels, n] of v) series.set(labelKey(labels), n);
      } catch {
        // A failing source (Redis down) must not take the whole scrape with it; the series just goes missing.
      }
    }
    for (const [k, v] of series) out.push(`${this.name}${k} ${fmt(v)}`);
    return out;
  }
}

/** Default latency buckets in seconds (5 ms – 10 s). */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** Cumulative histogram. */
export class Histogram implements Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; n: number }>();
  private readonly buckets: readonly number[];

  constructor(
    readonly name: string,
    private readonly help: string,
    buckets: readonly number[] = LATENCY_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  /**
   * Records one observation.
   *
   * @param labels - Series labels (must not include `le`).
   * @param value - Observed value (seconds for latencies).
   */
  observe(labels: Labels | undefined, value: number): void {
    if (!Number.isFinite(value)) return;
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels: labels ?? {}, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, n: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]!++;
    s.sum += value;
    s.n++;
  }

  /** Observation count of a series (tests). */
  count(labels?: Labels): number {
    return this.series.get(labelKey(labels))?.n ?? 0;
  }

  async render(): Promise<string[]> {
    const out = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      this.buckets.forEach((b, i) => {
        out.push(`${this.name}_bucket${labelKey({ ...s.labels, le: fmt(b) })} ${s.counts[i]}`);
      });
      out.push(`${this.name}_bucket${labelKey({ ...s.labels, le: '+Inf' })} ${s.n}`);
      out.push(`${this.name}_sum${k} ${fmt(s.sum)}`);
      out.push(`${this.name}_count${k} ${s.n}`);
    }
    return out;
  }
}

/**
 * A set of metrics rendered together.
 *
 * @example
 * const reg = new Registry();
 * const hits = reg.counter('tumble_hits_total', 'Hits.');
 * hits.inc({ route: '/x' });
 * res.end(await reg.render());
 */
export class Registry {
  private readonly metrics = new Map<string, Metric>();

  private add<M extends Metric>(m: M): M {
    if (!NAME_RE.test(m.name)) throw new Error(`invalid metric name ${m.name}`);
    if (this.metrics.has(m.name)) throw new Error(`duplicate metric ${m.name}`);
    this.metrics.set(m.name, m);
    return m;
  }

  /** Registers a counter. */
  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help));
  }

  /** Registers a gauge, optionally computed at scrape time. */
  gauge(name: string, help: string, collect?: GaugeCollect): Gauge {
    return this.add(new Gauge(name, help, collect));
  }

  /** Registers a histogram. */
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, buckets));
  }

  /** Prometheus text exposition of every metric. */
  async render(): Promise<string> {
    const parts = await Promise.all([...this.metrics.values()].map((m) => m.render()));
    return parts.flat().join('\n') + '\n';
  }
}

/** Content type of {@link Registry.render}'s output. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Decides whether a `/metrics` request is served.
 *
 * - `METRICS_TOKEN` set: only `Authorization: Bearer <token>` is served.
 * - Unset in production: disabled (answer 404), so a public deployment never
 *   leaks internals by default.
 * - Unset elsewhere: open, for local dashboards.
 *
 * @param token - Configured `METRICS_TOKEN`.
 * @param authorization - Request `Authorization` header.
 * @param production - `NODE_ENV === 'production'`.
 * @returns `ok`, `unauthorized` (401) or `disabled` (404).
 */
export function metricsAccess(
  token: string | undefined,
  authorization: string | undefined,
  production: boolean,
): 'ok' | 'unauthorized' | 'disabled' {
  if (!token) return production ? 'disabled' : 'ok';
  const given = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (given.length !== token.length) return 'unauthorized';
  // Constant-time: the loop length depends only on the configured token.
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? 'ok' : 'unauthorized';
}

/**
 * Adds process gauges (memory, uptime, event-loop delay) to a registry.
 *
 * @param reg - Target registry.
 * @param eventLoopDelay - From `perf_hooks.monitorEventLoopDelay()`, already enabled.
 */
export function registerProcessMetrics(
  reg: Registry,
  eventLoopDelay?: { percentile(p: number): number; mean: number },
): void {
  reg.gauge('tumble_process_resident_memory_bytes', 'Resident set size.', () => process.memoryUsage().rss);
  reg.gauge('tumble_process_heap_used_bytes', 'V8 heap in use.', () => process.memoryUsage().heapUsed);
  reg.gauge('tumble_process_uptime_seconds', 'Seconds since the process started.', () => process.uptime());
  if (eventLoopDelay) {
    reg.gauge('tumble_event_loop_delay_seconds', 'Event-loop delay (mean and p99).', () => [
      [{ stat: 'mean' }, (eventLoopDelay.mean || 0) / 1e9],
      [{ stat: 'p99' }, eventLoopDelay.percentile(99) / 1e9],
    ]);
  }
}
