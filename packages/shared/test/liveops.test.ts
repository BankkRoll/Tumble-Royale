import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_LIMITS,
  analyticsSampleRate,
  clockOffset,
  flagEnabled,
  isAnalyticsEvent,
  maintenancePhase,
  mergeSchedule,
  parseMaintenance,
  playlistPhase,
  validAnalyticsProps,
} from '../src/liveops.ts';
import { apiErrorReporter, ApiLiveOps, signInternal } from '../src/liveopsClient.ts';

const T = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('flags', () => {
  it('defaults every known flag to on, so nothing is switched off by accident', () => {
    expect(flagEnabled(null, 'store.enabled')).toBe(true);
    expect(flagEnabled({}, 'chat.global')).toBe(true);
    expect(flagEnabled({ 'chat.global': { enabled: 'no' as never, payload: null } }, 'chat.global')).toBe(
      true,
    );
    expect(flagEnabled({ 'chat.global': { enabled: false, payload: null } }, 'chat.global')).toBe(false);
  });

  it('reads the analytics sample rate from the flag payload', () => {
    expect(analyticsSampleRate(null)).toBe(1);
    expect(analyticsSampleRate({ 'analytics.sample': { enabled: false, payload: 0.5 } })).toBe(0);
    expect(analyticsSampleRate({ 'analytics.sample': { enabled: true, payload: 0.25 } })).toBe(0.25);
    expect(analyticsSampleRate({ 'analytics.sample': { enabled: true, payload: { rate: 0.1 } } })).toBe(0.1);
    expect(analyticsSampleRate({ 'analytics.sample': { enabled: true, payload: 7 } })).toBe(1);
    expect(analyticsSampleRate({ 'analytics.sample': { enabled: true, payload: -1 } })).toBe(0);
    expect(analyticsSampleRate({ 'analytics.sample': { enabled: true, payload: 'x' } })).toBe(1);
  });

  it('ships round voting on by default and allow-lists its small vote.cast event', () => {
    expect(flagEnabled(null, 'shows.mapVoting')).toBe(true);
    expect(flagEnabled({ 'shows.mapVoting': { enabled: false, payload: null } }, 'shows.mapVoting')).toBe(
      false,
    );
    expect(isAnalyticsEvent('vote.cast')).toBe(true);
    expect(validAnalyticsProps({ round: 2, option: 1, changed: false, online: true })).not.toBeNull();
  });
});

describe('maintenance windows', () => {
  const m = { enabled: true, message: 'm', startsAt: iso(T), endsAt: iso(T + 3_600_000) };

  it('is scheduled before the start, active from exactly the start, off from exactly the end', () => {
    expect(maintenancePhase(m, T - 1)).toBe('scheduled');
    expect(maintenancePhase(m, T)).toBe('active');
    expect(maintenancePhase(m, T + 3_599_999)).toBe('active');
    expect(maintenancePhase(m, T + 3_600_000)).toBe('off');
  });

  it('is off when disabled, and open-ended without times', () => {
    expect(maintenancePhase({ ...m, enabled: false }, T)).toBe('off');
    expect(maintenancePhase({ ...m, startsAt: null, endsAt: null }, 0)).toBe('active');
    expect(maintenancePhase(null, T)).toBe('off');
  });

  it('parses untrusted input defensively', () => {
    expect(parseMaintenance('nope').enabled).toBe(false);
    const p = parseMaintenance({ enabled: true, message: '  ', startsAt: 'garbage', endsAt: iso(T) });
    expect(p.message.length).toBeGreaterThan(0);
    expect(p.startsAt).toBeNull();
    expect(p.endsAt).toBe(iso(T));
  });
});

describe('playlist schedules', () => {
  it('goes live exactly at startsAt and ends exactly at endsAt', () => {
    const s = { startsAt: iso(T), endsAt: iso(T + 1000) };
    expect(playlistPhase(s, T - 1)).toBe('upcoming');
    expect(playlistPhase(s, T)).toBe('live');
    expect(playlistPhase(s, T + 999)).toBe('live');
    expect(playlistPhase(s, T + 1000)).toBe('ended');
  });

  it('treats a missing schedule as permanently live and hidden as hidden whatever the times', () => {
    expect(playlistPhase(undefined, T)).toBe('live');
    expect(playlistPhase({ hidden: true }, T)).toBe('hidden');
  });

  it('lets an override replace the bundled schedule, including clearing an end', () => {
    const bundled = { startsAt: null, endsAt: iso(T), featured: true };
    expect(mergeSchedule(bundled, null)).toEqual({
      startsAt: null,
      endsAt: iso(T),
      featured: true,
      hidden: false,
    });
    const o = { id: 'x', startsAt: null, endsAt: null, featured: false, hidden: false };
    expect(playlistPhase(mergeSchedule(bundled, o), T + 1)).toBe('live');
  });
});

describe('analytics validation', () => {
  it('accepts allow-listed names only', () => {
    expect(isAnalyticsEvent('show_end')).toBe(true);
    expect(isAnalyticsEvent('audit.admin.rename')).toBe(false);
    expect(isAnalyticsEvent(42)).toBe(false);
  });

  it('accepts flat, small payloads and rejects everything else', () => {
    expect(validAnalyticsProps(undefined)).toEqual({});
    expect(validAnalyticsProps({ placement: 3, playlist: 'main-show', won: false, x: null })).toEqual({
      placement: 3,
      playlist: 'main-show',
      won: false,
      x: null,
    });
    expect(validAnalyticsProps({ nested: { a: 1 } })).toBeNull();
    expect(validAnalyticsProps({ s: 'x'.repeat(ANALYTICS_LIMITS.maxStringLength + 1) })).toBeNull();
    expect(validAnalyticsProps({ n: Number.NaN })).toBeNull();
    expect(validAnalyticsProps({ 'bad-key': 1 })).toBeNull();
    expect(validAnalyticsProps([1, 2])).toBeNull();
    const many = Object.fromEntries(
      Array.from({ length: ANALYTICS_LIMITS.maxProps + 1 }, (_, i) => [`k${i}`, i]),
    );
    expect(validAnalyticsProps(many)).toBeNull();
  });
});

describe('clockOffset', () => {
  it('assumes the server read its clock mid-flight', () => {
    // Device is 10 s behind; 200 ms round trip.
    expect(clockOffset(T + 10_100, T, T + 200)).toBe(10_000);
    expect(clockOffset(T, T, T)).toBe(0);
  });
});

describe('ApiLiveOps', () => {
  const secret = 'test-internal-hmac-secret-0123456789';
  const snapshot = {
    flags: { 'mutators.chaos': { enabled: false, rolloutPercent: 100, payload: null } },
    maintenance: { enabled: true, message: 'Patching', startsAt: iso(T + 600_000), endsAt: null },
    playlists: [{ id: 'chaos-mode', startsAt: null, endsAt: iso(T), featured: false, hidden: false }],
    serverTime: T,
  };

  function setup(answer: () => Response | Promise<Response>) {
    let now = T;
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(init!);
      return answer();
    }) as unknown as typeof fetch;
    const log = vi.fn();
    const live = new ApiLiveOps({ apiUrl: 'http://api', secret, fetch: fetchFn, now: () => now, log });
    return { live, calls, log, advance: (ms: number) => void (now += ms) };
  }

  it('signs the request the way the API verifies it', async () => {
    const { live, calls } = setup(() => Response.json(snapshot));
    await live.get();
    const h = calls[0]!.headers as Record<string, string>;
    const expected = createHmac('sha256', secret)
      .update(
        `POST\n/internal/liveops\n${h['x-tumble-timestamp']}\n${h['x-tumble-nonce']}\n${String(calls[0]!.body)}`,
      )
      .digest('hex');
    expect(h['x-tumble-signature']).toBe(expected);
    expect(h['x-tumble-signature-version']).toBe('2');
  });

  it('caches for 30 s and shares one request between concurrent callers', async () => {
    const { live, calls, advance } = setup(() => Response.json(snapshot));
    const [a, b] = await Promise.all([live.get(), live.get()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
    expect(a.flag('mutators.chaos')).toBe(false);
    expect(a.flag('store.enabled')).toBe(true);
    expect(a.maintenance(T).phase).toBe('scheduled');
    expect(a.playlist('chaos-mode', null, T)).toBe('ended');
    expect(a.playlist('main-show', null, T)).toBe('live');
    advance(29_999);
    await live.get();
    expect(calls).toHaveLength(1);
    advance(1);
    await live.get();
    expect(calls).toHaveLength(2);
  });

  it('keeps the last known state through an outage and logs it once', async () => {
    let up = true;
    const { live, log, advance } = setup(() => {
      if (!up) throw new Error('ECONNREFUSED');
      return Response.json(snapshot);
    });
    expect((await live.get()).maintenance(T + 600_000).phase).toBe('active');
    up = false;
    advance(31_000);
    expect((await live.get()).maintenance(T + 600_000).phase).toBe('active');
    advance(31_000);
    await live.get();
    expect(log).toHaveBeenCalledOnce();
    expect(live.failures).toBe(2);
  });

  it('corrects for a service clock that runs behind or ahead of the API', async () => {
    // The API is 10 s ahead of this service; maintenance starts 5 s after the API's "now".
    const ahead = { ...snapshot, serverTime: T + 10_000 };
    ahead.maintenance = { ...snapshot.maintenance, startsAt: iso(T + 15_000) };
    const { live } = setup(() => Response.json(ahead));
    const s = await live.get();
    expect(s.offsetMs).toBe(10_000);
    expect(s.maintenance(T + 4_999).phase).toBe('scheduled');
    expect(s.maintenance(T + 5_000).phase).toBe('active');
    // A playlist that ended at the API's "now" is over for this service already.
    const ended = { ...snapshot, serverTime: T - 3000 };
    ended.playlists = [{ id: 'duos', startsAt: null, endsAt: iso(T - 3000), featured: false, hidden: false }];
    const behind = setup(() => Response.json(ended));
    expect((await behind.live.get()).playlist('duos', null, T)).toBe('ended');
    expect((await behind.live.get()).playlist('duos', null, T - 1)).toBe('live');
  });

  it('answers the defaults before the first success and on malformed answers', async () => {
    const { live } = setup(() => new Response('<html>', { status: 200 }));
    const s = await live.get();
    expect(s.flag('mutators.chaos')).toBe(true);
    expect(s.maintenance(T).phase).toBe('off');
  });

  it('peek answers at once and refreshes in the background', async () => {
    const { live, calls } = setup(() => Response.json(snapshot));
    expect(live.peek().flag('mutators.chaos')).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await live.refresh();
    expect(live.peek().flag('mutators.chaos')).toBe(false);
  });
});

describe('apiErrorReporter', () => {
  it('posts a signed, bounded server.error report and never throws', async () => {
    const bodies: string[] = [];
    const ok = apiErrorReporter({
      apiUrl: 'http://api',
      secret: 's'.repeat(32),
      service: 'matchmaker',
      fetch: (async (_u: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    const err = new RangeError('x'.repeat(2000));
    await ok(err, { kind: 'uncaughtException' });
    const body = JSON.parse(bodies[0]!);
    expect(body).toMatchObject({ service: 'matchmaker', kind: 'uncaughtException', type: 'RangeError' });
    expect(body.message).toHaveLength(500);

    const down = apiErrorReporter({
      apiUrl: 'http://api',
      secret: 's'.repeat(32),
      service: 'game-server',
      fetch: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    });
    await expect(down('plain string', {})).resolves.toBeUndefined();
  });

  it('signs with the same scheme as signInternal', () => {
    const h = signInternal('k', '{}', 1_700_000_000_000, { method: 'POST', path: '/internal/errors' });
    expect(h['x-tumble-timestamp']).toBe('1700000000000');
    expect(h['x-tumble-nonce']).toMatch(/^[0-9a-f]{32}$/);
  });
});
