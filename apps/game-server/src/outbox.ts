/**
 * Durable results outbox.
 *
 * Responsibilities:
 * - Write every show's results to disk before the first delivery attempt, so
 *   a crash, restart or API outage never loses a show's grants.
 * - Try a few quick deliveries so the players still in the room see their
 *   rewards; after that keep retrying in the background with exponential
 *   backoff (capped) for as long as it takes, including across restarts.
 * - Move payloads the API rejects outright (malformed) to `dead/` for a human
 *   to inspect instead of retrying them forever.
 *
 * Retrying is safe because the API keys every grant by match id: a re-post of
 * an ingested match replays the stored rewards (`alreadyProcessed: true`) and
 * grants nothing twice.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestResponse, MatchResultPayload, ResultsSink, SendOutcome } from './results.ts';

/** One pending delivery as stored on disk. */
interface OutboxRecord {
  payload: MatchResultPayload;
  /** Failed attempts so far. */
  attempts: number;
  /** Epoch ms when the show was queued. */
  queuedAt: number;
}

/** Options for {@link ResultsOutbox}. */
export interface ResultsOutboxOptions {
  /** Directory for pending payloads (created if missing). */
  dir: string;
  /** One delivery attempt (see `sendResultsOnce`). */
  send: (payload: MatchResultPayload) => Promise<SendOutcome>;
  /** Attempts made while the room waits to show rewards (default 3). */
  immediateAttempts?: number;
  /** Pause after the first immediate attempt (default 500 ms); doubles per attempt. */
  immediateDelayMs?: number;
  /** First background retry delay (default 2 s); doubles per attempt. */
  baseDelayMs?: number;
  /** Cap on the background retry delay (default 5 min). */
  maxDelayMs?: number;
  log?: (msg: string) => void;
  /** Wall clock (ms). */
  now?: () => number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Results sink that never drops a show.
 *
 * @example
 * const outbox = new ResultsOutbox({ dir: './.data/results-outbox', send: (p) => sendResultsOnce(api, p) });
 * await outbox.start(); // resumes anything left over from a previous run
 */
export class ResultsOutbox implements ResultsSink {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: ResultsOutboxOptions) {
    this.now = opts.now ?? Date.now;
  }

  private file(matchId: string): string {
    return join(this.opts.dir, `${matchId}.json`);
  }

  /** Writes atomically (temp file + rename) so a crash never leaves a torn record. */
  private async persist(rec: OutboxRecord): Promise<void> {
    const tmp = join(this.opts.dir, `.${rec.payload.matchId}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(rec));
    await rename(tmp, this.file(rec.payload.matchId));
  }

  /** Re-schedules every payload left on disk by a previous run. */
  async start(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    for (const name of await readdir(this.opts.dir)) {
      if (!name.endsWith('.json')) {
        // Leftover temp file from a crash mid-write; its rename never happened.
        if (name.endsWith('.tmp')) await rm(join(this.opts.dir, name), { force: true });
        continue;
      }
      try {
        const rec = JSON.parse(await readFile(join(this.opts.dir, name), 'utf8')) as OutboxRecord;
        if (!rec.payload || !SAFE_ID.test(rec.payload.matchId)) throw new Error('malformed record');
        this.schedule(rec, 0);
      } catch (err) {
        this.opts.log?.(`[outbox] cannot read ${name}: ${err instanceof Error ? err.message : String(err)}`);
        await this.deadLetter(name);
      }
    }
  }

  /** Match ids still waiting for delivery. */
  async pending(): Promise<string[]> {
    const names = await readdir(this.opts.dir).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  }

  async post(payload: MatchResultPayload): Promise<IngestResponse | null> {
    if (!SAFE_ID.test(payload.matchId)) {
      this.opts.log?.(`[outbox] refusing unsafe match id ${JSON.stringify(payload.matchId)}`);
      return null;
    }
    await mkdir(this.opts.dir, { recursive: true });
    const rec: OutboxRecord = { payload, attempts: 0, queuedAt: this.now() };
    await this.persist(rec);
    const tries = this.opts.immediateAttempts ?? 3;
    for (let i = 0; i < tries && !this.stopped; i++) {
      const res = await this.attempt(rec);
      if (res !== 'retry') return res;
      if (i < tries - 1)
        await new Promise((r) => setTimeout(r, (this.opts.immediateDelayMs ?? 500) * 2 ** i));
    }
    this.schedule(rec, this.delay(rec.attempts));
    this.opts.log?.(`[outbox] ${payload.matchId}: API unreachable, will keep retrying in the background`);
    return null;
  }

  /** Cancels background retries (records stay on disk for the next start). */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private delay(attempts: number): number {
    const base = this.opts.baseDelayMs ?? 2000;
    return Math.min(this.opts.maxDelayMs ?? 5 * 60_000, base * 2 ** Math.max(0, attempts - 1));
  }

  private schedule(rec: OutboxRecord, delayMs: number): void {
    if (this.stopped) return;
    const id = rec.payload.matchId;
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      void this.attempt(rec).then((res) => {
        if (res === 'retry') this.schedule(rec, this.delay(rec.attempts));
      });
    }, delayMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  /** @returns The API response, null when dead-lettered, or `retry`. */
  private async attempt(rec: OutboxRecord): Promise<IngestResponse | null | 'retry'> {
    const id = rec.payload.matchId;
    // A background retry and a fresh post of the same match must not race on the file.
    if (this.inFlight.has(id)) return 'retry';
    this.inFlight.add(id);
    try {
      const out = await this.opts.send(rec.payload);
      if (out.kind === 'delivered') {
        await rm(this.file(id), { force: true });
        if (rec.attempts > 0)
          this.opts.log?.(`[outbox] ${id}: delivered after ${rec.attempts} failed attempts`);
        return out.response;
      }
      if (out.kind === 'rejected') {
        this.opts.log?.(`[outbox] ${id}: API rejected the results (${out.status}); moved to dead/`);
        await this.deadLetter(`${id}.json`);
        return null;
      }
      rec.attempts++;
      await this.persist(rec).catch(() => undefined);
      return 'retry';
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async deadLetter(name: string): Promise<void> {
    const dead = join(this.opts.dir, 'dead');
    await mkdir(dead, { recursive: true });
    await rename(join(this.opts.dir, name), join(dead, name)).catch(() => undefined);
  }
}
