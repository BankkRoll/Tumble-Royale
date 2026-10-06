/**
 * Public status summary: the state rules for every combination of probe
 * results, maintenance and incidents; real probes against a failing KV and a
 * slow or dead matchmaker; caching; the exact public payload shape; the
 * uptime sampler's one-writer-per-slot lock across two API instances; and
 * daily uptime buckets across a UTC day boundary.
 */
import type { MaintenanceStatus } from '@tumble/shared/liveops';
import type { PublicIncident, StatusSummary } from '@tumble/shared/status';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.ts';
import { statusUptime } from '../src/db/schema.ts';
import { createKV, type KV } from '../src/kv/index.ts';
import { computeSummary, type ProbeReport } from '../src/status/compute.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi } from './helpers.ts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const OFF: MaintenanceStatus = {
  enabled: false,
  message: 'Back soon',
  startsAt: null,
  endsAt: null,
  phase: 'off',
};
const fast = { ok: true, ms: 5 };
const down = { ok: false, ms: 2000 };

const report = (over: Partial<ProbeReport> = {}): ProbeReport => ({
  db: fast,
  kv: fast,
  matchmaker: { ...fast, servers: 2 },
  capacity: [
    { region: 'eu', servers: 1, capacity: 100, load: 10 },
    { region: 'na', servers: 1, capacity: 100, load: 10 },
  ],
  knownRegions: [],
  flags: { store: true, chat: true },
  maintenance: OFF,
  incidents: [],
  ...over,
});

const states = (s: StatusSummary) => Object.fromEntries(s.components.map((c) => [c.id, c.state]));

const incident = (over: Partial<PublicIncident> = {}): PublicIncident => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Slow logins',
  impact: 'minor',
  status: 'investigating',
  components: ['api'],
  startedAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  resolvedAt: null,
  updates: [],
  ...over,
});

describe('computeSummary', () => {
  it('is operational with every probe healthy, listing components in display order', () => {
    const s = computeSummary(report(), NOW);
    expect(s.overall).toBe('operational');
    expect(s.components.map((c) => c.id)).toEqual([
      'website',
      'api',
      'matchmaking',
      'gameservers',
      'gameservers:eu',
      'gameservers:na',
      'store',
      'chat',
    ]);
    expect(s.components.find((c) => c.id === 'gameservers:eu')?.name).toBe('Game servers · Europe');
    expect(new Set(Object.values(states(s)))).toEqual(new Set(['operational']));
  });

  it('marks slow probes degraded and failed ones as outages', () => {
    expect(states(computeSummary(report({ db: { ok: true, ms: 1500 } }), NOW)).api).toBe('degraded');
    expect(computeSummary(report({ db: { ok: true, ms: 1500 } }), NOW).overall).toBe('degraded');

    const noDb = computeSummary(report({ db: down }), NOW);
    expect(states(noDb)).toMatchObject({ api: 'major_outage', store: 'major_outage', chat: 'operational' });
    expect(noDb.overall).toBe('major_outage');

    const noKv = computeSummary(report({ kv: down }), NOW);
    expect(states(noKv)).toMatchObject({ api: 'partial_outage', chat: 'major_outage', store: 'operational' });
    expect(noKv.overall).toBe('partial_outage');

    const slowMm = computeSummary(report({ matchmaker: { ok: true, ms: 1200, servers: 2 } }), NOW);
    expect(states(slowMm).matchmaking).toBe('degraded');
  });

  it('calls the whole service down when the matchmaker is, and game servers unknown', () => {
    const s = computeSummary(report({ matchmaker: { ...down, servers: null }, capacity: null }), NOW);
    expect(states(s)).toMatchObject({ matchmaking: 'major_outage', gameservers: 'unknown' });
    expect(s.overall).toBe('major_outage');
  });

  it('rates regions: missing, full and healthy; the total follows', () => {
    const one = computeSummary(
      report({ capacity: [{ region: 'eu', servers: 1, capacity: 100, load: 10 }], knownRegions: ['na'] }),
      NOW,
    );
    expect(states(one)).toMatchObject({
      gameservers: 'partial_outage',
      'gameservers:eu': 'operational',
      'gameservers:na': 'major_outage',
    });
    // One region down is not the whole service down.
    expect(one.overall).toBe('partial_outage');

    const busy = computeSummary(
      report({
        capacity: [
          { region: 'eu', servers: 1, capacity: 100, load: 95 },
          { region: 'na', servers: 1, capacity: 100, load: 10 },
        ],
      }),
      NOW,
    );
    expect(states(busy)).toMatchObject({ gameservers: 'degraded', 'gameservers:eu': 'degraded' });

    const none = computeSummary(report({ capacity: [], knownRegions: ['eu', 'na'] }), NOW);
    expect(states(none).gameservers).toBe('major_outage');
    expect(none.overall).toBe('major_outage');

    const empty = computeSummary(report({ capacity: [] }), NOW);
    expect(states(empty).gameservers).toBe('major_outage');
  });

  it('shows a single region only as the total row', () => {
    const s = computeSummary(
      report({ capacity: [{ region: 'eu', servers: 2, capacity: 50, load: 1 }] }),
      NOW,
    );
    expect(s.components.map((c) => c.id)).not.toContain('gameservers:eu');
  });

  it('drops malformed and excess region ids from the public list', () => {
    const regions = Array.from({ length: 20 }, (_, i) => ({
      region: `r${String(i).padStart(2, '0')}`,
      servers: 1,
      capacity: 10,
      load: 0,
    }));
    const s = computeSummary(
      report({ capacity: [...regions, { region: '<script>', servers: 1, capacity: 1, load: 0 }] }),
      NOW,
    );
    const ids = s.components.map((c) => c.id).filter((id) => id.startsWith('gameservers:'));
    expect(ids).toHaveLength(12);
    expect(JSON.stringify(s)).not.toContain('<script>');
  });

  it('falls back to the server count when capacity is unavailable', () => {
    expect(states(computeSummary(report({ capacity: null }), NOW)).gameservers).toBe('operational');
    const empty = computeSummary(report({ capacity: null, matchmaker: { ...fast, servers: 0 } }), NOW);
    expect(states(empty).gameservers).toBe('major_outage');
  });

  it('leaves matchmaking and game servers out when no matchmaker is configured', () => {
    const s = computeSummary(report({ matchmaker: null, capacity: null }), NOW);
    expect(s.components.map((c) => c.id)).toEqual(['website', 'api', 'store', 'chat']);
  });

  it('shows switched-off store and chat as maintenance without lowering the headline', () => {
    const s = computeSummary(report({ flags: { store: false, chat: false } }), NOW);
    expect(states(s)).toMatchObject({ store: 'maintenance', chat: 'maintenance' });
    expect(s.overall).toBe('operational');
  });

  it('puts every component but the website into maintenance during a window', () => {
    const active = { ...OFF, enabled: true, phase: 'active' as const, endsAt: '2026-10-05T13:00:00.000Z' };
    const s = computeSummary(report({ maintenance: active, db: down }), NOW);
    expect(s.overall).toBe('maintenance');
    expect(states(s)).toMatchObject({
      website: 'operational',
      api: 'maintenance',
      gameservers: 'maintenance',
    });
    expect(s.maintenance).toEqual({
      active: { message: 'Back soon', startsAt: null, endsAt: '2026-10-05T13:00:00.000Z' },
      upcoming: null,
    });
    const soon = { ...OFF, enabled: true, phase: 'scheduled' as const, startsAt: '2026-10-05T18:00:00.000Z' };
    const t = computeSummary(report({ maintenance: soon }), NOW);
    expect(t.overall).toBe('operational');
    expect(t.maintenance.upcoming?.startsAt).toBe('2026-10-05T18:00:00.000Z');
  });

  it('raises components to the impact of open incidents, never lowers them', () => {
    const minor = computeSummary(report({ incidents: [incident()] }), NOW);
    expect(states(minor).api).toBe('degraded');
    expect(minor.overall).toBe('degraded');
    expect(minor.incidents).toHaveLength(1);

    const major = computeSummary(
      report({ incidents: [incident({ impact: 'major', components: ['chat'] })] }),
      NOW,
    );
    expect(states(major).chat).toBe('partial_outage');

    const critical = computeSummary(
      report({ incidents: [incident({ impact: 'critical', components: ['website'] })] }),
      NOW,
    );
    expect(states(critical).website).toBe('major_outage');
    // The website alone is not critical to play: partial.
    expect(critical.overall).toBe('partial_outage');

    const worseProbe = computeSummary(report({ db: down, incidents: [incident()] }), NOW);
    expect(states(worseProbe).api).toBe('major_outage');

    const unscoped = computeSummary(
      report({ incidents: [incident({ impact: 'critical', components: [] })] }),
      NOW,
    );
    expect(unscoped.overall).toBe('major_outage');

    const unknown = computeSummary(
      report({
        matchmaker: { ...down, servers: null },
        capacity: null,
        incidents: [incident({ impact: 'major', components: ['gameservers'] })],
      }),
      NOW,
    );
    expect(states(unknown).gameservers).toBe('partial_outage');

    const resolved = computeSummary(report({ incidents: [incident({ status: 'resolved' })] }), NOW);
    expect(resolved.overall).toBe('operational');
    expect(resolved.incidents).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The service, with real probes
// -----------------------------------------------------------------------------

const MM = 'http://mm.internal.test:7370';

interface MatchmakerStub {
  fetch: typeof fetch;
  calls: string[];
  mode: 'ok' | 'slow' | 'hang' | 'error';
  capacity: unknown;
}

function matchmakerStub(): MatchmakerStub {
  const stub: MatchmakerStub = {
    calls: [],
    mode: 'ok',
    capacity: {
      regions: [
        { region: 'eu', servers: 3, capacity: 300, load: 30 },
        { region: 'na', servers: 2, capacity: 200, load: 20 },
      ],
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      stub.calls.push(url);
      const signal = init?.signal;
      if (stub.mode === 'hang')
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      if (stub.mode === 'error') throw new Error('ECONNREFUSED 10.0.0.7:7370');
      if (stub.mode === 'slow') await new Promise((r) => setTimeout(r, 80));
      if (url === `${MM}/health`) return Response.json({ ok: true, servers: 5, queued: 3 });
      if (url === `${MM}/internal/capacity`) {
        const h = new Headers(init?.headers);
        if (!h.get('x-tumble-signature')) return new Response('', { status: 401 });
        return Response.json(stub.capacity);
      }
      return new Response('', { status: 404 });
    }) as typeof fetch,
  };
  return stub;
}

let apis: TestApi[] = [];
afterEach(async () => {
  for (const a of apis) await a.close();
  apis = [];
});

async function statusApi(
  opts: { kv?: KV; stub?: MatchmakerStub; start?: string; status?: Record<string, number> } = {},
) {
  const stub = opts.stub ?? matchmakerStub();
  const api = await createTestApi(
    opts.start ?? '2026-10-05T12:00:00.000Z',
    { MATCHMAKER_URL: MM, ...(opts.kv ? { REDIS_URL: '' } : {}) },
    {
      fetch: stub.fetch,
      ...(opts.kv ? { kv: opts.kv } : {}),
      status: { timeoutMs: 300, slowMs: 50, ...opts.status },
    },
  );
  apis.push(api);
  return { api, stub };
}

const summaryOf = async (api: TestApi) => {
  const res = await api.req('GET', '/status/summary');
  expect(res.statusCode).toBe(200);
  return res.json() as StatusSummary;
};

/** A memory KV whose ping fails, as when Redis is unreachable. */
function brokenKv(): KV {
  const kv = createKV(undefined, () => NOW);
  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === 'ping') return () => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:6379'));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('GET /status/summary', () => {
  it('reports real probes and nothing else: no hosts, counts, errors or player data', async () => {
    const { api } = await statusApi();
    const res = await api.req('GET', '/status/summary');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=15');
    const s = res.json() as StatusSummary;
    expect(Object.keys(s).sort()).toEqual([
      'components',
      'generatedAt',
      'incidents',
      'maintenance',
      'overall',
    ]);
    for (const c of s.components) expect(Object.keys(c).sort()).toEqual(['id', 'name', 'state']);
    expect(Object.keys(s.maintenance).sort()).toEqual(['active', 'upcoming']);
    expect(s.overall).toBe('operational');
    expect(states(s)).toMatchObject({ 'gameservers:eu': 'operational', 'gameservers:na': 'operational' });
    for (const secret of [
      'mm.internal.test',
      '7370',
      '"capacity"',
      '"load"',
      '"servers"',
      'queued',
      'redis',
      'pglite',
    ])
      expect(res.body).not.toContain(secret);
  });

  it('keeps leaking nothing when probes fail with revealing errors', async () => {
    const stub = matchmakerStub();
    stub.mode = 'error';
    const { api } = await statusApi({ kv: brokenKv(), stub });
    const res = await api.req('GET', '/status/summary');
    const s = res.json() as StatusSummary;
    expect(states(s)).toMatchObject({
      api: 'partial_outage',
      chat: 'major_outage',
      matchmaking: 'major_outage',
      gameservers: 'unknown',
    });
    expect(s.overall).toBe('major_outage');
    for (const leak of ['ECONNREFUSED', '10.0.0.7', '10.1.2.3', '6379']) expect(res.body).not.toContain(leak);
  });

  it('treats a hung matchmaker as down once the probe times out', async () => {
    const stub = matchmakerStub();
    stub.mode = 'hang';
    const { api } = await statusApi({ stub });
    const started = Date.now();
    const s = await summaryOf(api);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(states(s)).toMatchObject({ matchmaking: 'major_outage', gameservers: 'unknown' });
  });

  it('treats a slow matchmaker as degraded, not down', async () => {
    const stub = matchmakerStub();
    stub.mode = 'slow';
    const { api } = await statusApi({ stub });
    expect(states(await summaryOf(api)).matchmaking).toBe('degraded');
  });

  it('ignores a malformed capacity answer and falls back to the health count', async () => {
    const stub = matchmakerStub();
    stub.capacity = { regions: 'nope' };
    const { api } = await statusApi({ stub });
    const s = await summaryOf(api);
    expect(states(s).gameservers).toBe('operational');
    expect(s.components.some((c) => c.id.startsWith('gameservers:'))).toBe(false);
  });

  it('caches for a few seconds, then probes again', async () => {
    const { api, stub } = await statusApi({ status: { cacheMs: 5000 } });
    await summaryOf(api);
    await summaryOf(api);
    await Promise.all([summaryOf(api), summaryOf(api)]);
    const health = () => stub.calls.filter((u) => u.endsWith('/health')).length;
    expect(health()).toBe(1);
    api.clock.advance(5000);
    await summaryOf(api);
    expect(health()).toBe(2);
  });

  it('follows maintenance and kill switches set through live ops', async () => {
    const { api } = await statusApi({ status: { cacheMs: 0 } });
    const admin = (method: 'PUT' | 'DELETE', url: string, body?: unknown) =>
      api.req(method, url, { token: ADMIN_TOKEN, ...(body ? { body } : {}) });
    expect((await admin('PUT', '/internal/flags/store.enabled', { enabled: false })).statusCode).toBe(200);
    expect(states(await summaryOf(api)).store).toBe('maintenance');

    const startsAt = '2026-10-05T14:00:00.000Z';
    expect((await admin('PUT', '/internal/maintenance', { enabled: true, startsAt })).statusCode).toBe(200);
    let s = await summaryOf(api);
    expect(s.overall).toBe('operational');
    expect(s.maintenance.upcoming?.startsAt).toBe(startsAt);

    api.clock.set('2026-10-05T14:00:00.000Z');
    s = await summaryOf(api);
    expect(s.overall).toBe('maintenance');
    expect(s.maintenance.active?.message).toBeTruthy();
    expect(states(s).matchmaking).toBe('maintenance');
  });

  it('is rate limited per client', async () => {
    const { api } = await statusApi();
    let last = 0;
    for (let i = 0; i < 61; i++)
      last = (await api.req('GET', '/status/summary', { ip: '10.9.9.9' })).statusCode;
    expect(last).toBe(429);
    expect((await api.req('GET', '/status/summary', { ip: '10.9.9.10' })).statusCode).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// Uptime sampling and history
// -----------------------------------------------------------------------------

describe('uptime sampler', () => {
  it('writes one sample per slot across two API instances', async () => {
    const database = await openDatabase({ databaseUrl: undefined, pgliteDir: 'memory://' });
    const db = { ...database, close: async () => undefined };
    const kv = createKV(undefined, () => NOW);
    const build = () =>
      createTestApi(
        '2026-10-05T12:00:10.000Z',
        { DATABASE_URL: '', REDIS_URL: '', MATCHMAKER_URL: MM },
        { kv, database: db, fetch: matchmakerStub().fetch },
      );
    const a = await build();
    const b = await build();
    try {
      const wrote = await Promise.all([a.status.sample(), b.status.sample(), a.status.sample()]);
      expect(wrote.filter(Boolean)).toHaveLength(1);
      const rows = await a.ctx.db.select().from(statusUptime).where(eq(statusUptime.component, 'api'));
      expect(rows).toEqual([expect.objectContaining({ day: '2026-10-05', samples: 1, operational: 1 })]);

      a.clock.advance(60_000);
      b.clock.advance(60_000);
      expect(await b.status.sample()).toBe(true);
      expect(await a.status.sample()).toBe(false);
      const [api2] = await a.ctx.db.select().from(statusUptime).where(eq(statusUptime.component, 'api'));
      expect(api2).toMatchObject({ samples: 2, operational: 2 });
    } finally {
      await a.close();
      await b.close();
      await kv.close();
      await database.close();
    }
  });

  it('buckets samples by UTC day across midnight and reports daily and 90-day uptime', async () => {
    const stub = matchmakerStub();
    const { api } = await statusApi({
      start: '2026-10-05T23:58:30.000Z',
      stub,
      status: { cacheMs: 0, historyCacheMs: 0 },
    });
    expect(await api.status.sample()).toBe(true);
    api.clock.advance(60_000);
    stub.mode = 'error';
    expect(await api.status.sample()).toBe(true);
    // 00:00:30 the next day.
    api.clock.advance(60_000);
    expect(await api.status.sample()).toBe(true);
    stub.mode = 'ok';
    api.clock.advance(60_000);
    expect(await api.status.sample()).toBe(true);

    const res = await api.req('GET', '/status/history');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const h = res.json();
    expect(h.days).toHaveLength(90);
    expect(h.days.slice(-2)).toEqual(['2026-10-05', '2026-10-06']);
    const mm = h.components.find((c: { id: string }) => c.id === 'matchmaking');
    // Day 1: up then down; day 2: down then up.
    expect(mm.days.slice(-2)).toEqual([
      { state: 'major_outage', uptime: 0.5 },
      { state: 'major_outage', uptime: 0.5 },
    ]);
    expect(mm.days[0]).toEqual({ state: null, uptime: null });
    expect(mm.uptime).toBe(0.5);
    const web = h.components.find((c: { id: string }) => c.id === 'website');
    expect(web.uptime).toBe(1);
    // Game servers were unknown while the matchmaker was down: those samples do not count.
    const gs = h.components.find((c: { id: string }) => c.id === 'gameservers');
    expect(gs.uptime).toBe(1);
  });

  it('prunes days older than the 90-day window', async () => {
    const { api } = await statusApi();
    await api.ctx.db.insert(statusUptime).values([
      { component: 'api', day: '2026-07-07', samples: 5, operational: 5 },
      { component: 'api', day: '2026-07-08', samples: 5, operational: 5 },
    ]);
    await api.status.sample();
    const days = (await api.ctx.db.select().from(statusUptime).where(eq(statusUptime.component, 'api'))).map(
      (r) => r.day,
    );
    // 2026-07-08 is the first of the 90 days ending 2026-10-05.
    expect(days.sort()).toEqual(['2026-07-08', '2026-10-05']);
  });

  it('keeps a region that vanished on the page as down', async () => {
    const stub = matchmakerStub();
    const { api } = await statusApi({ stub, status: { cacheMs: 0 } });
    stub.capacity = {
      regions: [
        { region: 'eu', servers: 1, capacity: 100, load: 0 },
        { region: 'na', servers: 1, capacity: 100, load: 0 },
        { region: 'asia', servers: 1, capacity: 100, load: 0 },
      ],
    };
    await api.status.sample();
    stub.capacity = { regions: [{ region: 'eu', servers: 1, capacity: 100, load: 0 }] };
    const s = await summaryOf(api);
    expect(states(s)).toMatchObject({
      gameservers: 'partial_outage',
      'gameservers:asia': 'major_outage',
      'gameservers:na': 'major_outage',
      'gameservers:eu': 'operational',
    });
  });
});
