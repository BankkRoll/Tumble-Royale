/**
 * Bot swarm: headless load tester for the game server.
 *
 * Spawns N protocol-complete WebSocket clients (optionally across several
 * processes), lets them play for a while, then prints snapshot rate, bandwidth
 * and RTT per client plus the server's own tick profile from `/metrics`.
 *
 * Usage:
 *   pnpm --filter @tumble/bot-swarm start -- --clients 40 --url ws://localhost:7350/ws --duration 60
 *   … --clients 2000 --procs 8      (fan out across child processes)
 *   … --ramp 20                     (ms between connection opens)
 *   … --lag 150 --jitter 20 --loss 0.02   (simulated round-trip latency, jitter, per-direction loss)
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { conditionerFromParams, type ConditionerOptions } from '@tumble/netcode';
import { SwarmClient, type ClientStats } from './client.ts';

interface Args {
  clients: number;
  url: string;
  duration: number;
  procs: number;
  ramp: number;
  child: boolean;
  offset: number;
  /** Round-trip latency / jitter (ms), loss probability: applied half each way. */
  lag: number;
  jitter: number;
  loss: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
  };
  return {
    clients: Math.max(1, Math.min(5000, Number(get('clients', '40')))),
    url: get('url', 'ws://localhost:7350/ws'),
    duration: Math.max(1, Number(get('duration', '60'))),
    procs: Math.max(1, Math.min(64, Number(get('procs', '1')))),
    ramp: Math.max(0, Number(get('ramp', '10'))),
    child: argv.includes('--child'),
    offset: Number(get('offset', '0')),
    lag: Number(get('lag', '0')),
    jitter: Number(get('jitter', '0')),
    loss: Number(get('loss', '0')),
  };
}

/** Aggregate of many clients' stats, mergeable across processes. */
interface Aggregate {
  clients: number;
  welcomed: number;
  kicked: number;
  snapshots: number;
  snapshotBytes: number;
  deltaSnapshots: number;
  decodeErrors: number;
  bytesIn: number;
  bytesOut: number;
  activeSeconds: number;
  rtts: number[];
}

function aggregate(stats: readonly ClientStats[]): Aggregate {
  const a: Aggregate = {
    clients: stats.length,
    welcomed: 0,
    kicked: 0,
    snapshots: 0,
    snapshotBytes: 0,
    deltaSnapshots: 0,
    decodeErrors: 0,
    bytesIn: 0,
    bytesOut: 0,
    activeSeconds: 0,
    rtts: [],
  };
  for (const s of stats) {
    if (s.welcomed) a.welcomed++;
    if (s.kicked) a.kicked++;
    a.snapshots += s.snapshots;
    a.snapshotBytes += s.snapshotBytes;
    a.deltaSnapshots += s.deltaSnapshots;
    a.decodeErrors += s.decodeErrors;
    a.bytesIn += s.bytesIn;
    a.bytesOut += s.bytesOut;
    if (s.snapshots > 1) a.activeSeconds += (s.lastSnapshotAt - s.firstSnapshotAt) / 1000;
    a.rtts.push(...s.rttSamples);
  }
  return a;
}

function merge(parts: readonly Aggregate[]): Aggregate {
  const out = aggregate([]);
  for (const p of parts) {
    out.clients += p.clients;
    out.welcomed += p.welcomed;
    out.kicked += p.kicked;
    out.snapshots += p.snapshots;
    out.snapshotBytes += p.snapshotBytes;
    out.deltaSnapshots += p.deltaSnapshots;
    out.decodeErrors += p.decodeErrors;
    out.bytesIn += p.bytesIn;
    out.bytesOut += p.bytesOut;
    out.activeSeconds += p.activeSeconds;
    out.rtts.push(...p.rtts);
  }
  return out;
}

/** Runs `count` clients in this process for `duration` seconds. */
async function runClients(args: Args, count: number, offset: number): Promise<Aggregate> {
  const clients: SwarmClient[] = [];
  const cond: ConditionerOptions | null = conditionerFromParams(
    new URLSearchParams({ lag: String(args.lag), jitter: String(args.jitter), loss: String(args.loss) }),
  );
  for (let i = 0; i < count; i++) {
    const c = new SwarmClient(args.url, offset + i, cond);
    c.connect();
    clients.push(c);
    if (args.ramp > 0) await new Promise((r) => setTimeout(r, args.ramp));
  }
  // Timers are coarse (≈15 ms on Windows), so step on an accumulator rather than trusting the interval.
  const stepMs = 1000 / 60;
  let next = performance.now();
  const timer = setInterval(() => {
    const t = performance.now();
    let n = 0;
    while (t >= next && n < 4) {
      for (const c of clients) c.step();
      next += stepMs;
      n++;
    }
    if (t - next > 250) next = t;
  }, 4);
  await new Promise((r) => setTimeout(r, args.duration * 1000));
  clearInterval(timer);
  for (const c of clients) c.close();
  return aggregate(clients.map((c) => c.stats));
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

function report(a: Aggregate, args: Args): void {
  const perClientSec = Math.max(1e-6, a.activeSeconds);
  const f1 = (v: number): string => v.toFixed(1);
  console.log('\n=== bot-swarm summary ===');
  console.log(
    `clients        ${a.clients} (welcomed ${a.welcomed}, kicked ${a.kicked}) over ${args.duration}s, ${args.procs} proc(s)`,
  );
  console.log(`snapshots/s    ${f1(a.snapshots / perClientSec)} per client (target 30)`);
  console.log(
    `snapshot size  avg ${f1(a.snapshotBytes / Math.max(1, a.snapshots))} B, delta ${f1((100 * a.deltaSnapshots) / Math.max(1, a.snapshots))}%`,
  );
  console.log(
    `down           ${f1(a.bytesIn / perClientSec / 1024)} KB/s per client, ${f1(a.bytesIn / args.duration / 1024)} KB/s total`,
  );
  console.log(`up             ${f1(a.bytesOut / perClientSec / 1024)} KB/s per client`);
  console.log(
    `rtt            avg ${f1(a.rtts.reduce((s, v) => s + v, 0) / Math.max(1, a.rtts.length))} ms, p95 ${f1(pct(a.rtts, 0.95))} ms (${a.rtts.length} samples)`,
  );
  console.log(`decode errors  ${a.decodeErrors}`);
}

async function printServerMetrics(wsUrl: string): Promise<void> {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/metrics';
    const text = await (await fetch(u)).text();
    const pick = text
      .split('\n')
      .filter((l) => /^tumble_(tick_ms|snapshot_bytes|bytes_out|players|rooms|rtt)/.test(l));
    console.log('\n=== server /metrics ===');
    for (const l of pick) console.log(l);
  } catch (e) {
    console.log(`(could not read server metrics: ${(e as Error).message})`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.child) {
    const agg = await runClients(args, args.clients, args.offset);
    process.send?.(agg);
    return;
  }
  console.log(`bot-swarm: ${args.clients} clients → ${args.url} for ${args.duration}s`);
  let result: Aggregate;
  if (args.procs <= 1) {
    result = await runClients(args, args.clients, 0);
  } else {
    const per = Math.ceil(args.clients / args.procs);
    const self = fileURLToPath(import.meta.url);
    const parts = await Promise.all(
      Array.from({ length: args.procs }, (_, p) => {
        const count = Math.min(per, args.clients - p * per);
        if (count <= 0) return Promise.resolve(aggregate([]));
        return new Promise<Aggregate>((resolve, reject) => {
          const child = fork(
            self,
            [
              '--child',
              ...['--clients', String(count), '--offset', String(p * per), '--url', args.url],
              ...['--duration', String(args.duration), '--ramp', String(args.ramp)],
              ...['--lag', String(args.lag), '--jitter', String(args.jitter), '--loss', String(args.loss)],
            ],
            { execArgv: ['--import', 'tsx'] },
          );
          child.once('message', (m) => resolve(m as Aggregate));
          child.once('error', reject);
        });
      }),
    );
    result = merge(parts);
  }
  report(result, args);
  await printServerMetrics(args.url);
  process.exit(0);
}

void main();
