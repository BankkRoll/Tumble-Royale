import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_INTERNAL_SECRET, resultsConfig } from '../src/config.ts';
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

const delivered = (matchId: string): SendOutcome => ({
  kind: 'delivered',
  response: { matchId, alreadyProcessed: false, rewards: [] },
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let dir: string;
const outboxes: ResultsOutbox[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tumble-outbox-'));
});
afterEach(async () => {
  for (const o of outboxes.splice(0)) o.stop();
  await rm(dir, { recursive: true, force: true });
});

function outbox(send: (p: MatchResultPayload) => Promise<SendOutcome>): ResultsOutbox {
  const o = new ResultsOutbox({
    dir,
    send,
    immediateAttempts: 2,
    immediateDelayMs: 1,
    baseDelayMs: 5,
    maxDelayMs: 20,
  });
  outboxes.push(o);
  return o;
}

describe('results outbox', () => {
  it('returns the API response and leaves nothing behind when delivery works', async () => {
    const o = outbox(async (p) => delivered(p.matchId));
    expect(await o.post(payload('m_ok_000'))).toMatchObject({ matchId: 'm_ok_000' });
    expect(await o.pending()).toEqual([]);
  });

  it('persists before sending and retries in the background with backoff until delivered', async () => {
    const seenOnDisk: boolean[] = [];
    let calls = 0;
    const o = outbox(async (p) => {
      seenOnDisk.push((await readdir(dir)).includes(`${p.matchId}.json`));
      return ++calls < 6 ? { kind: 'retry', detail: 'ECONNREFUSED' } : delivered(p.matchId);
    });
    expect(await o.post(payload('m_flaky_1'))).toBeNull();
    expect(await o.pending()).toEqual(['m_flaky_1']);
    await until(async () => (await o.pending()).length === 0);
    expect(calls).toBe(6);
    expect(seenOnDisk.every(Boolean)).toBe(true);
  });

  it('survives a restart: a new outbox delivers what the old one could not', async () => {
    const first = outbox(async () => ({ kind: 'retry', detail: 'down' }));
    await first.post(payload('m_restart'));
    first.stop();
    // A torn write from a crash is cleaned up, not delivered.
    await writeFile(join(dir, '.m_torn.abcd.tmp'), '{"payl');

    const sent: string[] = [];
    const second = outbox(async (p) => {
      sent.push(p.matchId);
      return delivered(p.matchId);
    });
    await second.start();
    await until(async () => (await readdir(dir)).length === 0);
    expect(sent).toEqual(['m_restart']);
  });

  it('dead-letters payloads the API rejects instead of retrying them forever', async () => {
    let calls = 0;
    const o = outbox(async () => {
      calls++;
      return { kind: 'rejected', status: 400, detail: 'inconsistent_result' };
    });
    expect(await o.post(payload('m_bad_01'))).toBeNull();
    expect(calls).toBe(1);
    expect(await o.pending()).toEqual([]);
    expect(await readdir(join(dir, 'dead'))).toEqual(['m_bad_01.json']);
  });

  it('caps the backoff interval', async () => {
    const at: number[] = [];
    const o = outbox(async () => {
      at.push(Date.now());
      return { kind: 'retry', detail: 'down' };
    });
    await o.post(payload('m_capped'));
    await until(() => at.length >= 9, 5000);
    o.stop();
    const gaps = at.slice(3).map((t, i) => t - at[i + 2]!);
    expect(Math.max(...gaps)).toBeLessThan(200);
  });
});

describe('sendResultsOnce', () => {
  it('classifies API answers', async () => {
    const answer = (status: number, body = '{}') =>
      sendResultsOnce(
        {
          apiUrl: 'http://api.test',
          secret: 's',
          fetch: (async () => new Response(body, { status })) as typeof fetch,
        },
        payload('m_classify'),
      );
    expect((await answer(200, '{"matchId":"m","alreadyProcessed":true,"rewards":[]}')).kind).toBe(
      'delivered',
    );
    expect((await answer(400)).kind).toBe('rejected');
    expect((await answer(401)).kind).toBe('retry');
    expect((await answer(503)).kind).toBe('retry');
    const offline = await sendResultsOnce(
      {
        apiUrl: 'http://api.test',
        secret: 's',
        fetch: (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
      },
      payload('m_offline'),
    );
    expect(offline).toEqual({ kind: 'retry', detail: 'ECONNREFUSED' });
  });
});

describe('results config', () => {
  it('reports to the local API by default in development', () => {
    expect(resultsConfig({ NODE_ENV: 'development' })).toEqual({
      apiUrl: 'http://localhost:7360',
      secret: DEV_INTERNAL_SECRET,
      outboxDir: './.data/results-outbox',
    });
    expect(resultsConfig({})).not.toBeNull();
    expect(resultsConfig({ REPORT_RESULTS: '0' })).toBeNull();
    expect(resultsConfig({ NODE_ENV: 'test' })).toBeNull();
  });

  it('requires explicit, non-development settings in production', () => {
    expect(resultsConfig({ NODE_ENV: 'production' })).toBeNull();
    expect(() =>
      resultsConfig({
        NODE_ENV: 'production',
        API_URL: 'https://api',
        INTERNAL_HMAC_SECRET: DEV_INTERNAL_SECRET,
      }),
    ).toThrow(/INTERNAL_HMAC_SECRET/);
    expect(
      resultsConfig({
        NODE_ENV: 'production',
        API_URL: 'https://api',
        INTERNAL_HMAC_SECRET: 'real-secret-0123456789',
        RESULTS_OUTBOX_DIR: '/var/lib/tumble/outbox',
      }),
    ).toMatchObject({ outboxDir: '/var/lib/tumble/outbox' });
  });
});
