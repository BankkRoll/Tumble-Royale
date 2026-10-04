/**
 * Client live ops: analytics batching and privacy gates, feature flags,
 * playlist schedules (with clock skew) and the maintenance controller.
 */
import type { FlagMap } from '@tumble/shared/liveops';
import { ui } from '@tumble/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashReporter } from '../src/crashReporter.ts';
import { Analytics, FpsSampler, type AnalyticsOptions } from '../src/game/liveOps/analytics.ts';
import { LiveOpsController, type LiveOpsApi } from '../src/game/liveOps/controller.ts';
import { FlagStore, gatedReplays, parseFlags } from '../src/game/liveOps/flags.ts';
import {
  activeSchedule,
  isPlaylistLive,
  parseSchedule,
  refreshSchedule,
  scheduledCard,
  setActiveSchedule,
  type ScheduleCache,
} from '../src/game/liveOps/schedule.ts';
import { uiPlaylists } from '../src/game/meta.ts';
import { queueRefusal } from '../src/game/online/partyPlay.ts';
import type { ReplayHooks } from '../src/game/replay/live.ts';

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const T = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  store.clear();
  setActiveSchedule(null);
});

// -----------------------------------------------------------------------------
// Analytics
// -----------------------------------------------------------------------------

describe('Analytics', () => {
  let now = T;
  const make = (over: Partial<AnalyticsOptions> = {}) => {
    const sent: { url: string; init: RequestInit }[] = [];
    const beacons: { url: string; body: string; type: string }[] = [];
    const a = new Analytics({
      endpoint: () => 'https://api.test/events',
      allowed: () => true,
      sampleRate: () => 1,
      token: async () => 'tok-fresh',
      tokenSync: () => 'tok-stored',
      now: () => now,
      random: () => 0.5,
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      sendBeacon: (url, data) => {
        void data.text().then((body) => beacons.push({ url, body, type: data.type }));
        return true;
      },
      ...over,
    });
    return { a, sent, beacons };
  };

  beforeEach(() => {
    now = T;
  });

  it('queues allow-listed events and posts them in one batch with the account token', async () => {
    const { a, sent } = make();
    expect(a.track('show_start', { playlist: 'main-show', online: true })).toBe(true);
    expect(a.track('round_end', { round: 'tilt-town', qualified: true })).toBe(true);
    await a.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok-fresh' });
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      events: [
        { name: 'show_start', props: { playlist: 'main-show', online: true } },
        { name: 'round_end', props: { round: 'tilt-town', qualified: true } },
      ],
    });
    expect(a.pending).toHaveLength(0);
  });

  it('sends nothing while the player has analytics off (or the browser asks not to track)', () => {
    let allowed = false;
    const { a } = make({ allowed: () => allowed });
    expect(a.track('store_view')).toBe(false);
    allowed = true;
    expect(a.track('store_view')).toBe(true);
    expect(a.dropped.not_allowed).toBe(1);
  });

  it('samples per page load from the flag rate', () => {
    let rate = 0.25;
    const { a } = make({ sampleRate: () => rate, random: () => 0.5 });
    expect(a.track('store_view')).toBe(false);
    rate = 0.75;
    expect(a.track('store_view')).toBe(true);
    rate = 0;
    expect(a.track('quit_point')).toBe(false);
    expect(a.dropped.sampled_out).toBe(2);
  });

  it('drops events when there is no API instead of queueing them forever', async () => {
    const { a, sent } = make({ endpoint: () => null });
    expect(a.track('show_end', { placement: 1 })).toBe(false);
    await a.flush();
    expect(sent).toHaveLength(0);
    expect(a.dropped.no_api).toBe(1);
  });

  it('refuses unknown names and props the API would reject', () => {
    const { a } = make();
    expect(a.track('made_up' as never)).toBe(false);
    expect(a.track('show_end', { nested: { a: 1 } as never })).toBe(false);
    expect(a.track('show_end', { long: 'x'.repeat(200) })).toBe(false);
    expect(a.dropped.invalid).toBe(3);
  });

  it('folds identical events within a second and caps the rate per minute', () => {
    const { a } = make({ perMinute: 3 });
    expect(a.track('store_view', { online: true })).toBe(true);
    expect(a.track('store_view', { online: true })).toBe(false);
    now += 1000;
    expect(a.track('store_view', { online: true })).toBe(true);
    expect(a.track('quit_point', { round: 'a' })).toBe(true);
    expect(a.track('quit_point', { round: 'b' })).toBe(false);
    expect(a.dropped).toMatchObject({ duplicate: 1, rate_limited: 1 });
    now += 60_000;
    expect(a.track('quit_point', { round: 'c' })).toBe(true);
  });

  it('caps the queue between flushes', () => {
    const { a } = make({ maxQueue: 2, perMinute: 100 });
    for (let i = 0; i < 4; i++) a.track('load_time', { round: `r${i}`, ms: i });
    expect(a.pending).toHaveLength(2);
  });

  it('splits large queues into API-sized batches and survives a failed send', async () => {
    let calls = 0;
    const { a } = make({
      maxQueue: 120,
      perMinute: 1000,
      fetch: (async (_u: string, init: RequestInit) => {
        calls++;
        expect(JSON.parse(String(init.body)).events.length).toBeLessThanOrEqual(50);
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    for (let i = 0; i < 120; i++) a.track('load_time', { round: `r${i}`, ms: i });
    await expect(a.flush()).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(a.pending).toHaveLength(0);
  });

  it('flushes after 15 s on its own', async () => {
    vi.useFakeTimers();
    try {
      const { a, sent } = make();
      a.track('store_view');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('beacons the last batch on pagehide as text/plain with the stored token', async () => {
    const { a, beacons } = make();
    const target = new EventTarget() as unknown as Window;
    const before = vi.fn(() => a.track('error_count', { count: 2 }));
    const off = a.install(target, undefined, before);
    a.track('quit_point', { round: 'tilt-town' });
    target.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(beacons).toHaveLength(1));
    expect(before).toHaveBeenCalledOnce();
    expect(beacons[0]!.type).toBe('text/plain');
    const body = JSON.parse(beacons[0]!.body);
    expect(body.auth).toBe('tok-stored');
    expect(body.events.map((e: { name: string }) => e.name)).toEqual(['quit_point', 'error_count']);
    off();
  });

  it('falls back to a keepalive fetch when the beacon is refused, and flushes when the tab hides', async () => {
    const { a, sent } = make({ sendBeacon: () => false });
    const target = new EventTarget() as unknown as Window;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' }) as unknown as Document;
    a.install(target, doc);
    a.track('store_view');
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.init).toMatchObject({ keepalive: true, headers: { 'content-type': 'text/plain' } });
  });
});

describe('FpsSampler', () => {
  it('reports the average frame rate as a bucket and needs enough frames', () => {
    const s = new FpsSampler();
    for (let i = 0; i < 10; i++) s.add(1 / 60);
    expect(s.take()).toBeNull();
    for (let i = 0; i < 120; i++) s.add(1 / 60);
    expect(s.take()).toBe('58+');
    for (let i = 0; i < 60; i++) s.add(1 / 25);
    s.add(5);
    expect(s.take()).toBe('20-30');
    for (let i = 0; i < 60; i++) s.add(1 / 12);
    expect(s.take()).toBe('<20');
  });
});

describe('crash reporter error count', () => {
  it('counts every captured error, repeats and drops included', () => {
    const r = new CrashReporter({ apiUrl: null, perMinute: 1, flushMs: 60_000 });
    r.capture('error', new Error('a'));
    r.capture('error', new Error('a'));
    r.capture('error', new Error('b'));
    expect(r.captured).toBe(3);
    expect(r.dropped).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Flags
// -----------------------------------------------------------------------------

describe('FlagStore', () => {
  it('starts from the cache or the defaults and works offline', () => {
    const empty = new FlagStore(null);
    expect(empty.flag('store.enabled')).toBe(true);
    expect(empty.sampleRate()).toBe(1);
    const cached = new FlagStore({
      load: () => ({ 'store.enabled': { enabled: false, payload: null } }),
      save: () => undefined,
    });
    expect(cached.flag('store.enabled')).toBe(false);
  });

  it('caches and notifies only when something changed', async () => {
    const saved: FlagMap[] = [];
    const f = new FlagStore({ load: () => null, save: (m) => void saved.push(m) });
    const seen = vi.fn();
    f.subscribe(seen);
    const answer = {
      flags: {
        'chat.global': { enabled: false, payload: null },
        'analytics.sample': { enabled: true, payload: 0.1 },
      },
    };
    expect(await f.refresh(async () => answer)).toBe(true);
    expect(await f.refresh(async () => answer)).toBe(true);
    expect(seen).toHaveBeenCalledOnce();
    expect(saved).toHaveLength(1);
    expect(f.flag('chat.global')).toBe(false);
    expect(f.sampleRate()).toBe(0.1);
  });

  it('keeps the current flags when the API is unreachable', async () => {
    const f = new FlagStore(null);
    f.apply({ 'replays.enabled': { enabled: false } });
    expect(
      await f.refresh(async () => {
        throw new Error('offline');
      }),
    ).toBe(false);
    expect(f.flag('replays.enabled')).toBe(false);
  });

  it('drops malformed entries one by one', () => {
    expect(
      parseFlags({
        a: { enabled: true },
        b: { enabled: 'yes' },
        c: null,
        ['x'.repeat(70)]: { enabled: true },
      }),
    ).toEqual({ a: { enabled: true, payload: null } });
    expect(parseFlags([1, 2])).toEqual({});
  });

  it('gates replay recording per show', () => {
    const calls: string[] = [];
    const inner: ReplayHooks = {
      showStarted: () => void calls.push('show'),
      roundStarted: () => void calls.push('round'),
      frame: () => void calls.push('frame'),
      event: () => void calls.push('event'),
      roundEnded: () => void calls.push('end'),
    };
    let on = false;
    const hooks = gatedReplays(inner, () => on);
    hooks.showStarted();
    hooks.roundStarted({} as never, {} as never, null);
    hooks.frame();
    on = true;
    // Mid-show changes wait for the next show.
    hooks.roundEnded(null);
    expect(calls).toEqual(['show']);
    hooks.showStarted();
    hooks.roundStarted({} as never, {} as never, null);
    hooks.event({} as never);
    hooks.roundEnded(null);
    expect(calls).toEqual(['show', 'show', 'round', 'event', 'end']);
  });
});

// -----------------------------------------------------------------------------
// Playlist schedules
// -----------------------------------------------------------------------------

describe('playlist schedules', () => {
  const cache = (playlists: ScheduleCache['playlists'], offsetMs = 0): ScheduleCache => ({
    playlists,
    offsetMs,
    fetchedAt: T,
  });

  it('parses the public answer, mapping a hidden phase to hidden', () => {
    expect(
      parseSchedule([
        { id: 'duos', startsAt: null, endsAt: iso(T), featured: false, phase: 'live' },
        { id: 'squads', startsAt: 'garbage', endsAt: null, featured: true, phase: 'hidden' },
        { nope: 1 },
      ]),
    ).toEqual([
      { id: 'duos', startsAt: null, endsAt: iso(T), featured: false, hidden: false },
      { id: 'squads', startsAt: null, endsAt: null, featured: true, hidden: true },
    ]);
    expect(parseSchedule('x')).toEqual([]);
  });

  it('opens exactly at startsAt and closes exactly at endsAt', () => {
    const c = cache([{ id: 'duos', startsAt: iso(T), endsAt: iso(T + 1000), featured: true, hidden: false }]);
    expect(scheduledCard(undefined, 'duos', c, T - 1).phase).toBe('upcoming');
    expect(scheduledCard(undefined, 'duos', c, T).phase).toBe('live');
    expect(scheduledCard(undefined, 'duos', c, T + 999).phase).toBe('live');
    expect(scheduledCard(undefined, 'duos', c, T + 1000).phase).toBe('ended');
  });

  it('follows the server clock when the device clock is wrong, and shows device-clock countdowns', () => {
    // The device runs 10 minutes slow: server time = device + 10 min.
    const offset = 600_000;
    const c = cache([{ id: 'duos', startsAt: null, endsAt: iso(T), featured: false, hidden: false }], offset);
    expect(scheduledCard(undefined, 'duos', c, T - offset - 1).phase).toBe('live');
    expect(scheduledCard(undefined, 'duos', c, T - offset).phase).toBe('ended');
    expect(scheduledCard(undefined, 'duos', c, T - offset - 1).endsAt).toBe(T - offset);
  });

  it('offers live playlists with Ends in, featured upcoming ones as Coming soon, and hides the rest', () => {
    const c = cache([
      { id: 'duos', startsAt: null, endsAt: iso(T + 3_600_000), featured: false, hidden: false },
      { id: 'squads', startsAt: iso(T + 86_400_000), endsAt: null, featured: true, hidden: false },
      { id: 'chaos-mode', startsAt: iso(T + 86_400_000), endsAt: null, featured: false, hidden: false },
      { id: 'ranked', startsAt: null, endsAt: iso(T), featured: false, hidden: false },
    ]);
    const cards = uiPlaylists(10, c, T);
    const byId = new Map(cards.map((p) => [p.id, p]));
    expect(byId.get('duos')).toMatchObject({ endsAt: T + 3_600_000 });
    expect(byId.get('duos')?.comingSoon).toBeUndefined();
    expect(byId.get('squads')).toMatchObject({ comingSoon: true, startsAt: T + 86_400_000 });
    expect(byId.get('squads')?.endsAt).toBeUndefined();
    expect(byId.has('chaos-mode')).toBe(false);
    expect(byId.has('ranked')).toBe(false);
    expect(byId.get('main-show')?.endsAt).toBeUndefined();
  });

  it('falls back to the bundled playlists offline', () => {
    const ids = uiPlaylists(10, null, T).map((p) => p.id);
    expect(ids).toEqual(['main-show', 'duos', 'squads', 'chaos-mode', 'ranked']);
  });

  it('measures the clock offset when fetching and caches the answer for offline boots', async () => {
    let now = T;
    const answer = {
      playlists: [{ id: 'duos', startsAt: null, endsAt: null, featured: false, phase: 'hidden' }],
      serverTime: T + 5000 + 100,
    };
    const fresh = await refreshSchedule(
      async () => {
        now += 200;
        return answer;
      },
      () => now,
    );
    expect(fresh?.offsetMs).toBe(5000);
    setActiveSchedule(null);
    expect(activeSchedule()?.playlists[0]).toMatchObject({ id: 'duos', hidden: true });
    expect(isPlaylistLive({}, 'duos', T)).toBe(false);
    expect(isPlaylistLive({}, 'main-show', T)).toBe(true);
    expect(isPlaylistLive(undefined, 'brand-new', T)).toBe(true);
    expect(await refreshSchedule(async () => Promise.reject(new Error('offline')))).toBeNull();
    expect(activeSchedule()).not.toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

describe('LiveOpsController', () => {
  let now = T;
  const published: { maintenance?: unknown; flags?: unknown }[] = [];
  const api = (maintenance: unknown, serverTime = T): LiveOpsApi & { fail: boolean } => {
    const a = {
      fail: false,
      flags: async () => ({ flags: { 'store.enabled': { enabled: false, payload: null } } }),
      status: async () => {
        if (a.fail) throw new Error('offline');
        return { maintenance, serverTime };
      },
      playlistSchedule: async () => ({ playlists: [], serverTime }),
    };
    return a;
  };

  beforeEach(() => {
    now = T;
    published.length = 0;
  });
  afterEach(() => ui.getState().setLiveOps({ maintenance: null, flags: {} }));

  it('announces scheduled maintenance and flips to active exactly at the start, on the server clock', async () => {
    const onMaintenance = vi.fn();
    // Device clock 1 min slow.
    const a = api(
      { enabled: true, message: 'Patching', startsAt: iso(T + 600_000), endsAt: null },
      T + 60_000,
    );
    const c = new LiveOpsController({
      api: a,
      now: () => now,
      flags: new FlagStore(null),
      publish: (p) => void published.push(p),
      onMaintenance,
    });
    await c.refreshStatus();
    expect(c.maintenance().phase).toBe('scheduled');
    expect(published.at(-1)?.maintenance).toEqual({
      phase: 'scheduled',
      message: 'Patching',
      startsAt: T + 540_000,
      endsAt: null,
    });
    expect(onMaintenance).toHaveBeenLastCalledWith('scheduled');
    now = T + 539_999;
    c.tick();
    expect(c.maintenanceActive()).toBe(false);
    now = T + 540_000;
    c.tick();
    expect(c.maintenanceActive()).toBe(true);
    expect(onMaintenance).toHaveBeenLastCalledWith('active');
    expect(published.at(-1)?.maintenance).toMatchObject({ phase: 'active' });
  });

  it('keeps the last known window when the API stops answering', async () => {
    const a = api({ enabled: true, message: 'Down', startsAt: null, endsAt: null });
    const c = new LiveOpsController({
      api: a,
      now: () => now,
      flags: new FlagStore(null),
      publish: () => undefined,
    });
    await c.refreshStatus();
    a.fail = true;
    await c.refreshStatus();
    expect(c.maintenanceActive()).toBe(true);
  });

  it('publishes flags to the UI and re-offers playlists', async () => {
    const onPlaylists = vi.fn();
    const flags = new FlagStore(null);
    const c = new LiveOpsController({ api: api(null), now: () => now, flags, onPlaylists });
    vi.useFakeTimers();
    try {
      c.start();
      await c.refresh();
      expect(ui.getState().liveOps.flags).toEqual({ 'store.enabled': false });
      expect(onPlaylists).toHaveBeenCalled();
      expect(c.maintenanceActive()).toBe(false);
    } finally {
      c.stop();
      vi.useRealTimers();
    }
  });

  it('does nothing without an API and never blocks play', async () => {
    const c = new LiveOpsController({ api: null, flags: new FlagStore(null), publish: () => undefined });
    c.start();
    await c.refresh();
    expect(c.maintenanceActive()).toBe(false);
    c.stop();
  });
});

describe('queue refusals', () => {
  it('explains maintenance and closed playlists', () => {
    expect(queueRefusal('maintenance', 'Back at 6.')).toEqual({
      title: 'Down for maintenance',
      body: 'Back at 6. You can still play Vs Bots.',
    });
    expect(queueRefusal('playlist_unavailable', 'Chaos Mode has ended').title).toBe(
      "That playlist isn't open",
    );
  });
});
