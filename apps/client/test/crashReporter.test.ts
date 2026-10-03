import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrashReporter } from '../src/crashReporter.ts';

interface Sent {
  url: string;
  body: string;
}

function recorder(fail = false) {
  const sent: Sent[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body) });
    if (fail) throw new TypeError('network down');
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

const events = (s: Sent) =>
  (JSON.parse(s.body) as { events: { name: string; props: Record<string, unknown> }[] }).events;

afterEach(() => vi.useRealTimers());

describe('CrashReporter', () => {
  it('batches errors to /events and folds duplicates', async () => {
    const { sent, fetchFn } = recorder();
    const r = new CrashReporter({ apiUrl: 'https://x.test/api', fetch: fetchFn });
    r.capture('error', new TypeError('boom'), { source: 'https://x.test/a.js?v=1', line: 3, col: 9 });
    r.capture('error', new TypeError('boom'), { source: 'https://x.test/a.js?v=1', line: 3, col: 9 });
    r.capture('unhandledrejection', 'nope');
    await r.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://x.test/api/events');
    const ev = events(sent[0]!);
    expect(ev.map((e) => e.name)).toEqual(['client.error', 'client.error']);
    expect(ev[0]!.props).toMatchObject({
      kind: 'error',
      type: 'TypeError',
      message: 'boom',
      source: 'https://x.test/a.js',
      count: 2,
    });
    expect(ev[1]!.props).toMatchObject({ kind: 'unhandledrejection', type: 'string', message: 'nope' });
  });

  it('caps reports per minute and per page load', async () => {
    let now = 0;
    const { sent, fetchFn } = recorder();
    const r = new CrashReporter({
      apiUrl: 'https://x.test/api',
      fetch: fetchFn,
      now: () => now,
      perMinute: 3,
      perSession: 5,
    });
    for (let i = 0; i < 10; i++) r.capture('error', new Error(`e${i}`));
    await r.flush();
    expect(events(sent[0]!)).toHaveLength(3);
    expect(r.dropped).toBe(7);
    now += 61_000;
    for (let i = 10; i < 20; i++) r.capture('error', new Error(`e${i}`));
    await r.flush();
    // Per-session cap of 5: only two more fit.
    expect(events(sent[1]!)).toHaveLength(2);
  });

  it('never throws or re-reports when sending fails', async () => {
    const { sent, fetchFn } = recorder(true);
    const r = new CrashReporter({ apiUrl: 'https://x.test/api', fetch: fetchFn });
    r.capture('error', new Error('first'));
    await expect(r.flush()).resolves.toBeUndefined();
    await r.flush();
    expect(sent).toHaveLength(1);
  });

  it('also sends to a Sentry DSN', async () => {
    const { sent, fetchFn } = recorder();
    const r = new CrashReporter({
      apiUrl: null,
      sentryDsn: 'https://pub@sentry.example.com/12',
      fetch: fetchFn,
    });
    r.capture('error', new RangeError('bad'));
    await r.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://sentry.example.com/api/12/envelope/?sentry_key=pub&sentry_version=7');
    const [, item, event] = sent[0]!.body.split('\n');
    expect(JSON.parse(item!)).toEqual({ type: 'event' });
    expect(JSON.parse(event!).exception.values[0]).toEqual({ type: 'RangeError', value: 'bad' });
  });

  it('flushes on a timer and hooks the window events', async () => {
    vi.useFakeTimers();
    const { sent, fetchFn } = recorder();
    const target = new EventTarget();
    const r = new CrashReporter({ apiUrl: 'https://x.test/api', fetch: fetchFn, flushMs: 100 });
    const uninstall = r.install(target as unknown as Window);
    const err = Object.assign(new Event('error'), { message: 'kaput', error: new Error('kaput') });
    target.dispatchEvent(err);
    // A resource load failure: a bare Event without message or error.
    target.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toHaveLength(1);
    expect(events(sent[0]!)).toHaveLength(1);
    uninstall();
    target.dispatchEvent(err);
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toHaveLength(1);
  });
});
