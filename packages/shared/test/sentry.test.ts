import { describe, expect, it } from 'vitest';
import { parseSentryDsn, sendToSentry, sentryEnvelope } from '../src/sentry.ts';

describe('parseSentryDsn', () => {
  it('builds the envelope URL, keeping a path prefix', () => {
    expect(parseSentryDsn('https://abc@o1.ingest.sentry.io/42')?.url).toBe(
      'https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=abc&sentry_version=7',
    );
    expect(parseSentryDsn('http://k@glitchtip.local:8000/sub/3')?.url).toBe(
      'http://glitchtip.local:8000/sub/api/3/envelope/?sentry_key=k&sentry_version=7',
    );
  });

  it('rejects malformed DSNs', () => {
    for (const dsn of ['', 'nope', 'https://host/1', 'https://k@host/', 'https://k@host/abc', 'ftp://k@h/1'])
      expect(parseSentryDsn(dsn)).toBeNull();
  });
});

describe('sentryEnvelope', () => {
  it('writes header, item header and event lines', () => {
    const t = parseSentryDsn('https://abc@sentry.example.com/1')!;
    const lines = sentryEnvelope(t, {
      type: 'Error',
      message: 'x',
      stack: 'Error: x\n at y',
      platform: 'node',
      timestamp: 1_700_000_000,
      tags: { service: 'api' },
    }).split('\n');
    expect(lines).toHaveLength(3);
    const head = JSON.parse(lines[0]!);
    const event = JSON.parse(lines[2]!);
    expect(head.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.event_id).toBe(head.event_id);
    expect(event.tags).toEqual({ service: 'api' });
    expect(event.extra.stack).toContain('at y');
  });
});

describe('sendToSentry', () => {
  it('reports failure instead of throwing', async () => {
    const t = parseSentryDsn('https://abc@sentry.example.com/1')!;
    const failing = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    await expect(
      sendToSentry(t, { type: 'E', message: 'm', platform: 'node', timestamp: 1 }, failing),
    ).resolves.toBe(false);
  });
});
