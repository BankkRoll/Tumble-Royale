/**
 * Status page vocabulary: severity and the headline rule, component ids,
 * public text cleaning, UTC day buckets across month and year boundaries,
 * uptime ratios, and the signed internal call the API makes to the
 * matchmaker for capacity.
 */
import { describe, expect, it } from 'vitest';
import { signInternal, verifyInternal } from '../src/liveopsClient.ts';
import {
  cleanPublicText,
  componentName,
  countKey,
  dayKey,
  dayRange,
  dayState,
  impactState,
  isComponentId,
  NO_SAMPLES,
  overallState,
  sumCounts,
  uptimeRatio,
  worse,
} from '../src/status.ts';

describe('states', () => {
  it('orders severity and keeps the worse state', () => {
    expect(worse('operational', 'degraded')).toBe('degraded');
    expect(worse('major_outage', 'partial_outage')).toBe('major_outage');
    expect(worse('maintenance', 'operational')).toBe('maintenance');
    expect(worse('unknown', 'degraded')).toBe('degraded');
    expect(impactState('minor')).toBe('degraded');
    expect(impactState('major')).toBe('partial_outage');
    expect(impactState('critical')).toBe('major_outage');
  });

  it('derives the headline: maintenance first, non-critical outages count as partial', () => {
    const ok = [
      { id: 'api', state: 'operational' as const },
      { id: 'chat', state: 'operational' as const },
    ];
    expect(overallState(ok, false)).toBe('operational');
    expect(overallState(ok, true)).toBe('maintenance');
    expect(overallState([{ id: 'chat', state: 'major_outage' }], false)).toBe('partial_outage');
    expect(overallState([{ id: 'gameservers:eu', state: 'major_outage' }], false)).toBe('partial_outage');
    expect(overallState([{ id: 'api', state: 'major_outage' }], false)).toBe('major_outage');
    expect(overallState([{ id: 'store', state: 'maintenance' }], false)).toBe('operational');
    expect(overallState([{ id: 'gameservers', state: 'unknown' }], false)).toBe('operational');
    expect(overallState(ok, false, ['major_outage'])).toBe('major_outage');
  });
});

describe('components', () => {
  it('accepts the fixed ids and well-formed regions only', () => {
    for (const id of ['website', 'api', 'chat', 'gameservers:eu', 'gameservers:us-west-2'])
      expect(isComponentId(id), id).toBe(true);
    for (const id of [
      'db',
      'gameservers:',
      'gameservers:EU',
      'gameservers:<b>',
      'gameservers:a'.padEnd(40, 'a'),
      3,
    ])
      expect(isComponentId(id), String(id)).toBe(false);
    expect(componentName('gameservers:oce')).toBe('Game servers · Oceania');
    expect(componentName('gameservers:mars')).toBe('Game servers · MARS');
    expect(componentName('store')).toBe('Store & payments');
  });

  it('cleans public text without touching markup', () => {
    expect(cleanPublicText('  a\r\nb\u0000c\u202e <b>x</b>\t ')).toBe('a\nbc <b>x</b>');
  });
});

describe('uptime', () => {
  it('buckets by UTC day, whatever the local time zone', () => {
    expect(dayKey(Date.parse('2026-10-05T23:59:59.999Z'))).toBe('2026-10-05');
    expect(dayKey(Date.parse('2026-10-06T00:00:00.000Z'))).toBe('2026-10-06');
    expect(dayKey(Date.parse('2026-10-06T01:00:00+02:00'))).toBe('2026-10-05');
  });

  it('lists the window oldest first across month, leap-day and year boundaries', () => {
    const r = dayRange(Date.parse('2027-01-02T10:00:00Z'), 5);
    expect(r).toEqual(['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(dayRange(Date.parse('2028-03-01T00:00:00Z'), 2)).toEqual(['2028-02-29', '2028-03-01']);
    const full = dayRange(Date.parse('2026-10-05T12:00:00Z'));
    expect(full).toHaveLength(90);
    expect(full[0]).toBe('2026-07-08');
    expect(new Set(full).size).toBe(90);
  });

  it('weighs outages and ignores maintenance and unknown samples', () => {
    const c = (o: Partial<typeof NO_SAMPLES>) => ({ ...NO_SAMPLES, ...o });
    expect(uptimeRatio(c({ samples: 4, operational: 4 }))).toBe(1);
    expect(uptimeRatio(c({ samples: 4, operational: 2, partial: 2 }))).toBe(0.75);
    expect(uptimeRatio(c({ samples: 4, degraded: 2, major: 2 }))).toBe(0.5);
    expect(uptimeRatio(c({ samples: 10, operational: 1, maintenance: 9 }))).toBe(1);
    expect(uptimeRatio(c({ samples: 3, maintenance: 3 }))).toBeNull();
    expect(uptimeRatio(NO_SAMPLES)).toBeNull();
    expect(dayState(c({ samples: 2, operational: 1, degraded: 1 }))).toBe('degraded');
    expect(dayState(c({ samples: 1, maintenance: 1 }))).toBe('maintenance');
    expect(dayState(NO_SAMPLES)).toBeNull();
    expect(countKey('unknown')).toBeNull();
    expect(countKey('partial_outage')).toBe('partial');
    expect(
      sumCounts([c({ samples: 1, operational: 1 }), c({ samples: 2, major: 1, maintenance: 1 })]),
    ).toEqual(c({ samples: 3, operational: 1, major: 1, maintenance: 1 }));
  });
});

describe('verifyInternal', () => {
  const secret = 'shared-secret-0123456789';
  const now = Date.parse('2026-10-05T12:00:00Z');

  it('accepts what signInternal signed, within the window', () => {
    expect(verifyInternal(secret, signInternal(secret, '', now), '', now)).toBe(true);
    expect(verifyInternal(secret, signInternal(secret, '', now - 60_000), '', now)).toBe(true);
  });

  it('rejects another secret, another body, stale or malformed headers', () => {
    expect(verifyInternal(secret, signInternal('other-secret-0123456789', '', now), '', now)).toBe(false);
    expect(verifyInternal(secret, signInternal(secret, '{}', now), '', now)).toBe(false);
    expect(verifyInternal(secret, signInternal(secret, '', now - 6 * 60_000), '', now)).toBe(false);
    expect(verifyInternal(secret, {}, '', now)).toBe(false);
    const h = signInternal(secret, '', now);
    expect(verifyInternal(secret, { ...h, 'x-tumble-signature': 'zz' }, '', now)).toBe(false);
    expect(verifyInternal(secret, { ...h, 'x-tumble-nonce': 'short' }, '', now)).toBe(false);
  });
});
