import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { drain, type DrainDeps } from '../src/drain.ts';
import { createLogger, lineLogger } from '../src/logger.ts';
import { ResultsOutbox } from '../src/outbox.ts';
import { sendResultsOnce, type MatchResultPayload, type SendOutcome } from '../src/results.ts';

const payload = (matchId: string): MatchResultPayload => ({
  matchId,
  queue: 'casual',
  playlistId: 'main-show',
  region: 'na',
  startedAt: '2026-10-02T12:00:00.000Z',
  endedAt: '2026-10-02T12:08:00.000Z',
  participants: [{ key: '0', userId: 'u1', isBot: false, name: 'A' }],
  rounds: [],
  placements: [{ key: '0', placement: 1, crowned: true }],
});

/** A fake clock whose sleep advances time instantly. */
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => (t += ms) };
}

function deps(overrides: Partial<DrainDeps> = {}): DrainDeps & { calls: string[] } {
  const calls: string[] = [];
  const time = fakeTime();
  return {
    calls,
    setDraining: () => void calls.push('draining'),
    link: {
      drain: async () => void calls.push('draining-reported'),
      stop: async () => void calls.push('deregistered'),
    },
    rooms: () => 0,
    closeServer: async () => void calls.push('closed'),
    outbox: { flush: async () => (calls.push('flushed'), 0), stop: () => void calls.push('outbox-stopped') },
    log: () => undefined,
    settleMs: 15_000,
    timeoutMs: 600_000,
    outboxFlushMs: 10_000,
    now: time.now,
    sleep: time.sleep,
    ...overrides,
  };
}

describe('drain', () => {
  it('reports draining, waits for rooms, deregisters only then, closes and flushes in order', async () => {
    let open = 2;
    const time = fakeTime();
    const d = deps({
      now: time.now,
      sleep: async (ms) => {
        time.advance(ms);
        // Rooms finish 2 minutes in.
        if (time.now() >= 120_000) open = 0;
      },
      rooms: () => open,
    });
    const r = await drain(d);
    // Deregistering only after the rooms closed keeps rejoins and host kicks working for running shows.
    expect(d.calls).toEqual([
      'draining',
      'draining-reported',
      'deregistered',
      'closed',
      'flushed',
      'outbox-stopped',
    ]);
    expect(r).toEqual({ roomsCut: 0, outboxLeft: 0 });
    expect(time.now()).toBeGreaterThanOrEqual(120_000);
    expect(time.now()).toBeLessThan(125_000);
  });

  it('cuts running shows off at the timeout', async () => {
    const time = fakeTime();
    const d = deps({ rooms: () => 3, timeoutMs: 60_000, now: time.now, sleep: time.sleep });
    const r = await drain(d);
    expect(r.roomsCut).toBe(3);
    expect(time.now()).toBe(60_000);
    expect(d.calls).toContain('closed');
  });

  it('never settles longer than the timeout, and skips settling when unlinked', async () => {
    const time = fakeTime();
    await drain(deps({ settleMs: 120_000, timeoutMs: 30_000, now: time.now, sleep: time.sleep }));
    expect(time.now()).toBe(30_000);
    const t2 = fakeTime();
    await drain(deps({ link: null, now: t2.now, sleep: t2.sleep }));
    expect(t2.now()).toBe(0);
  });

  it('survives a matchmaker that cannot be reached and reports what the outbox kept', async () => {
    const d = deps({
      link: { drain: () => Promise.reject(new Error('down')), stop: () => Promise.reject(new Error('down')) },
      outbox: { flush: async () => 2, stop: () => undefined },
    });
    expect(await drain(d)).toEqual({ roomsCut: 0, outboxLeft: 2 });
  });
});

describe('outbox backlog and flush', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tumble-outbox-ops-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts waiting shows and delivers them on flush', async () => {
    let apiUp = false;
    const send = vi.fn(async (p: MatchResultPayload): Promise<SendOutcome> =>
      apiUp
        ? { kind: 'delivered', response: { matchId: p.matchId, alreadyProcessed: false, rewards: [] } }
        : { kind: 'retry', detail: 'down' },
    );
    const o = new ResultsOutbox({ dir, send, immediateAttempts: 1, baseDelayMs: 60_000 });
    await o.post(payload('m_flush_1'));
    await o.post(payload('m_flush_2'));
    expect(o.backlog).toBe(2);
    apiUp = true;
    expect(await o.flush(2000, 1)).toBe(0);
    expect(o.backlog).toBe(0);
    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toEqual([]);
    o.stop();
  });

  it('gives up at the flush deadline and keeps the records on disk', async () => {
    const send = async (): Promise<SendOutcome> => ({ kind: 'retry', detail: 'down' });
    const o = new ResultsOutbox({ dir, send, immediateAttempts: 1, baseDelayMs: 60_000 });
    await o.post(payload('m_stuck_1'));
    expect(await o.flush(30, 5)).toBe(1);
    o.stop();
    // A restart picks the record up again.
    const next = new ResultsOutbox({ dir, send, baseDelayMs: 60_000 });
    await next.start();
    expect(next.backlog).toBe(1);
    next.stop();
  });

  it('drops dead-lettered shows from the backlog', async () => {
    const send = async (): Promise<SendOutcome> => ({ kind: 'rejected', status: 400, detail: 'bad' });
    const o = new ResultsOutbox({ dir, send, immediateAttempts: 1 });
    await o.post(payload('m_bad_1'));
    expect(o.backlog).toBe(0);
    o.stop();
  });
});

describe('results request id', () => {
  it('tags the ingest call with the match id', async () => {
    let header: string | null = null;
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      header = new Headers(init?.headers).get('x-request-id');
      return Response.json({ matchId: 'm_req_1', alreadyProcessed: false, rewards: [] });
    }) as unknown as typeof fetch;
    await sendResultsOnce(
      { apiUrl: 'http://api.test', secret: 's'.repeat(32), fetch: fetchFn },
      payload('m_req_1'),
    );
    expect(header).toBe('match-m_req_1');
  });
});

describe('structured logs', () => {
  it('writes JSON lines with matchId, roomId and a level from the wording', () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
    const log = lineLogger(createLogger({ serverId: 'gs-1', region: 'eu', stream }));
    log('[rooms] created r3 for match m_abc123 (main-show, 2 humans + 38 bots)');
    log('[outbox] m_abc123: API unreachable, will keep retrying in the background');
    log('[rooms] r3 crashed and was closed: boom');
    expect(lines[0]).toMatchObject({
      level: 30,
      service: 'game-server',
      serverId: 'gs-1',
      region: 'eu',
      matchId: 'm_abc123',
      roomId: 'r3',
    });
    expect(lines[1]).toMatchObject({ level: 40, matchId: 'm_abc123' });
    expect(lines[2]).toMatchObject({ level: 50 });
  });
});

describe('ops config', () => {
  const base = {
    NODE_ENV: 'test',
    GAME_TICKET_SECRET: 'test-game-ticket-secret-0123456789',
    REPORT_RESULTS: '0',
  };

  it('has safe drain defaults and validates overrides', () => {
    expect(loadConfig(base).ops).toEqual({
      logLevel: 'info',
      sentryDsn: undefined,
      drainTimeoutMs: 900_000,
      drainSettleMs: 15_000,
      outboxFlushMs: 15_000,
    });
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud', DRAIN_TIMEOUT_MS: '-1' })).toThrow(
      /LOG_LEVEL[\s\S]*DRAIN_TIMEOUT_MS|DRAIN_TIMEOUT_MS[\s\S]*LOG_LEVEL/,
    );
  });
});
