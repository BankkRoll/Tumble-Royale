/**
 * Public status page: its own tiny entry (no framework, no game code), the
 * no-JavaScript shell, every UI state (all good, degraded, maintenance,
 * incident, API unreachable, last known), escaping of incident text, and
 * the controller's refresh behaviour against a fake API.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PublicIncident, StatusHistory, StatusSummary } from '@tumble/shared/status';
import { describe, expect, it, vi } from 'vitest';
import { SUMMARY_REFRESH_MS, isSummary, startStatusPage } from '../src/status/page.ts';
import { h, toHtml } from '../src/status/vdom.ts';
import { percent, relative, statusPage, type PageState } from '../src/status/view.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'src');

// -----------------------------------------------------------------------------
// Bundle separation
// -----------------------------------------------------------------------------

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const TYPE_IMPORT_RE = /(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"]/g;

/** Every file and bare package reachable from an entry (type-only imports excluded). */
function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8').replace(TYPE_IMPORT_RE, '');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) stack.push(target);
    }
  }
  return { files, packages };
}

const inStatus = (f: string) => f.startsWith(resolve(SRC, 'status'));

describe('status page bundle', () => {
  it('is its own production entry, routed at /status', () => {
    const config = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/status:\s*resolve\(root, 'status\.html'\)/);
    expect(config).toContain("'status'");
    expect(readFileSync(resolve(ROOT, 'status.html'), 'utf8')).toContain('/src/status/main.ts');
    expect(readFileSync(resolve(ROOT, 'index.html'), 'utf8')).not.toContain('src/status');
  });

  it('loads no framework and no game code', () => {
    const { files, packages } = graph(resolve(SRC, 'status/main.ts'));
    const outside = [...files]
      .filter((f) => !inStatus(f))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(outside).toEqual(['devTools.ts', 'runtimeConfig.ts']);
    expect([...packages].sort()).toEqual(['@tumble/shared/status']);
  });

  it('is never reached from the game or the admin console', () => {
    for (const entry of ['main.ts', 'admin/main.tsx']) {
      const { files } = graph(resolve(SRC, entry));
      expect([...files].filter(inStatus), entry).toEqual([]);
    }
  });

  it('shows a useful message without JavaScript and is indexable', () => {
    const html = readFileSync(resolve(ROOT, 'status.html'), 'utf8');
    expect(html).toContain('Loading live status');
    expect(html).toContain('href="/api/status/feed.atom"');
    expect(html).not.toMatch(/noindex/);
  });
});

describe('status page hosting', () => {
  const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

  it('routes /status to its page on every host, framed by nobody, cached by nobody, indexable', () => {
    const caddy = read('../../deploy/docker/client.Caddyfile');
    const block = caddy.slice(
      caddy.indexOf('@status path'),
      caddy.indexOf('file_server', caddy.indexOf('@status path')),
    );
    expect(block).toContain('/status /status/ /status.html');
    expect(block).toContain('rewrite * /status.html');
    expect(block).toContain('Cache-Control "no-cache"');
    // Frame protection is site-wide (see securityHeaders.test.ts).
    expect(caddy.slice(0, caddy.indexOf('handle'))).toContain('X-Frame-Options "DENY"');
    expect(block).not.toContain('X-Robots-Tag');

    const vercel = JSON.parse(read('vercel.json')) as {
      rewrites: { source: string; destination: string }[];
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    expect(vercel.rewrites).toContainEqual({ source: '/status', destination: '/status.html' });
    const vh = vercel.headers.find((x) => x.source === '/status(.html)?')!.headers;
    expect(vh).toContainEqual({ key: 'Cache-Control', value: 'no-cache' });
    expect(vh.some((x) => x.key === 'X-Robots-Tag')).toBe(false);

    expect(read('public/_redirects')).toMatch(/^\/status\s+\/status\.html\s+200$/m);
    const headers = read('public/_headers');
    const statusHeaders = headers.slice(headers.indexOf('\n/status\n'));
    expect(statusHeaders).toContain('Cache-Control: no-cache');
    expect(statusHeaders).not.toContain('X-Robots-Tag');
  });
});

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const summary = (over: Partial<StatusSummary> = {}): StatusSummary => ({
  overall: 'operational',
  components: [
    { id: 'website', name: 'Website', state: 'operational' },
    { id: 'api', name: 'Accounts & API', state: 'operational' },
    { id: 'gameservers', name: 'Game servers', state: 'operational' },
    { id: 'gameservers:eu', name: 'Game servers · Europe', state: 'operational' },
  ],
  maintenance: { active: null, upcoming: null },
  incidents: [],
  generatedAt: iso(NOW - 5000),
  ...over,
});

const incident = (over: Partial<PublicIncident> = {}): PublicIncident => ({
  id: '11111111-2222-4333-8444-555555555555',
  title: 'Queues are slow',
  impact: 'major',
  status: 'identified',
  components: ['gameservers'],
  startedAt: iso(NOW - 3_600_000),
  updatedAt: iso(NOW - 600_000),
  resolvedAt: null,
  updates: [
    { status: 'identified', message: 'A worker is stuck.', at: iso(NOW - 600_000) },
    { status: 'investigating', message: 'Looking into it.', at: iso(NOW - 3_600_000) },
  ],
  ...over,
});

const history = (over: Partial<StatusHistory> = {}): StatusHistory => ({
  days: Array.from({ length: 90 }, (_, i) => iso(NOW - (89 - i) * 86_400_000).slice(0, 10)),
  components: [
    {
      id: 'api',
      name: 'Accounts & API',
      uptime: 0.99912,
      days: Array.from({ length: 90 }, (_, i) =>
        i === 89
          ? { state: 'partial_outage' as const, uptime: 0.97 }
          : { state: 'operational' as const, uptime: 1 },
      ),
    },
  ],
  incidents: [],
  generatedAt: iso(NOW),
  ...over,
});

const state = (over: Partial<PageState> = {}): PageState => ({
  summary: summary(),
  history: history(),
  unreachable: false,
  lastOk: NOW,
  now: NOW,
  feeds: {
    atom: 'https://play.example.com/api/status/feed.atom',
    json: 'https://play.example.com/api/status/feed.json',
  },
  formatTime: (t) => `T(${t})`,
  ...over,
});

const render = (over: Partial<PageState> = {}) => toHtml(statusPage(state(over)));

describe('status page views', () => {
  it('all good: headline, components, uptime bars and feeds', () => {
    const html = render();
    expect(html).toContain('data-testid="overall-operational"');
    expect(html).toContain('All systems operational');
    expect(html).toContain('Updated just now');
    expect(html).toContain('data-testid="component-gameservers:eu"');
    expect(html).toContain('st-region');
    expect(html.match(/class="st-bar /g)).toHaveLength(90);
    expect(html).toContain('99.91% uptime');
    expect(html).toContain(`title="${iso(NOW).slice(0, 10)} · Partial outage · 97.00%"`);
    expect(html).toContain('No incidents in the last 90 days.');
    expect(html).toContain('href="https://play.example.com/api/status/feed.atom"');
    expect(html).not.toContain('Active incidents');
  });

  it('degraded: shows the headline and the component state', () => {
    const html = render({
      summary: summary({
        overall: 'degraded',
        components: [{ id: 'api', name: 'Accounts & API', state: 'degraded' }],
      }),
    });
    expect(html).toContain('data-testid="overall-degraded"');
    expect(html).toContain('Some systems are slow');
    expect(html).toContain('<span class="st-state st-degraded">Degraded performance</span>');
  });

  it('maintenance: active window with its end, and an upcoming one', () => {
    const html = render({
      summary: summary({
        overall: 'maintenance',
        maintenance: {
          active: { message: 'Upgrading the servers.', startsAt: null, endsAt: iso(NOW + 2 * 3_600_000) },
          upcoming: null,
        },
      }),
    });
    expect(html).toContain('Down for maintenance');
    expect(html).toContain('data-testid="maintenance-active"');
    expect(html).toContain('Upgrading the servers.');
    expect(html).toContain(`Expected back T(${iso(NOW + 2 * 3_600_000)}) (in 2 h).`);

    const soon = render({
      summary: summary({
        maintenance: {
          active: null,
          upcoming: { message: 'Patch day', startsAt: iso(NOW + 1_800_000), endsAt: null },
        },
      }),
    });
    expect(soon).toContain('data-testid="maintenance-upcoming"');
    expect(soon).toContain('Scheduled maintenance');
    expect(soon).toContain('(in 30 min)');
    expect(soon).toContain('All systems operational');
  });

  it('incident: active incident with its timeline, newest first, linked by anchor', () => {
    const html = render({ summary: summary({ overall: 'partial_outage', incidents: [incident()] }) });
    expect(html).toContain('Active incidents');
    expect(html).toContain('id="incident-11111111-2222-4333-8444-555555555555"');
    expect(html).toContain('Major impact · Game servers · started 1 h ago');
    expect(html.indexOf('A worker is stuck.')).toBeLessThan(html.indexOf('Looking into it.'));
    // Still listed as active, so not repeated under past incidents.
    const past = render({
      summary: summary({ incidents: [incident()] }),
      history: history({ incidents: [incident()] }),
    });
    expect(past.match(/data-testid="incident"/g)).toHaveLength(1);
    expect(past).toContain('No incidents in the last 90 days.');
  });

  it('past incidents show their window', () => {
    const resolved = incident({ status: 'resolved', resolvedAt: iso(NOW - 60_000) });
    const html = render({ history: history({ incidents: [resolved] }) });
    expect(html).toContain('Past incidents');
    expect(html).toContain(`T(${resolved.startedAt}) – T(${resolved.resolvedAt})`);
  });

  it('API unreachable: explains it before any data, keeps the last known status after', () => {
    const none = render({ summary: null, history: null, unreachable: true, lastOk: null });
    expect(none).toContain('data-testid="status-unreachable"');
    expect(none).toContain('We can’t reach the status service');
    expect(none).not.toContain('Components');

    const stale = render({ unreachable: true, lastOk: NOW - 5 * 60_000 });
    expect(stale).toContain('Last known status from 5 min ago');
    expect(stale).toContain('All systems operational');

    expect(render({ summary: null, history: null })).toContain('Checking status…');
  });

  it('escapes incident text and refuses unsafe links', () => {
    const evil = incident({
      title: '<img src=x onerror=alert(1)>',
      updates: [{ status: 'investigating', message: '<script>alert("x")</script> & co', at: iso(NOW) }],
    });
    const html = render({ summary: summary({ incidents: [evil] }) });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert("x")&lt;/script&gt; &amp; co');
    expect(toHtml(h('a', { href: 'javascript:alert(1)', onclick: 'x' }, 'x'))).toBe('<a>x</a>');
    expect(toHtml(h('a', { title: '"><b>' }, 'x'))).toBe('<a title="&quot;&gt;&lt;b&gt;">x</a>');
  });

  it('formats uptime without rounding a bad day up to 100%', () => {
    expect(percent(1)).toBe('100%');
    expect(percent(0.99996)).toBe('99.99%');
    expect(percent(0.5)).toBe('50.00%');
    expect(percent(null)).toBe('No data');
    const fresh = render({
      history: history({
        components: [
          {
            id: 'api',
            name: 'Accounts & API',
            uptime: null,
            days: Array.from({ length: 90 }, () => ({ state: null, uptime: null })),
          },
        ],
      }),
    });
    expect(fresh).toContain('No data yet');
    expect(fresh).not.toContain('No data uptime');
    expect(relative(iso(NOW - 3 * 86_400_000), NOW)).toBe('3 d ago');
  });
});

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

/** Just enough of an element for `mount`: records what was rendered. */
function fakeRoot() {
  const rendered: unknown[] = [];
  const doc = {
    createDocumentFragment: () => ({
      nodes: [] as unknown[],
      append(...n: unknown[]) {
        this.nodes.push(...n);
      },
    }),
    createTextNode: (t: string) => t,
    createElement: (tag: string) => ({
      tag,
      attrs: {} as Record<string, string>,
      nodes: [] as unknown[],
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
      append(...n: unknown[]) {
        this.nodes.push(...n);
      },
    }),
  };
  return {
    rendered,
    root: { ownerDocument: doc, replaceChildren: (n: unknown) => rendered.push(n) } as unknown as Element,
  };
}

describe('status page controller', () => {
  it('renders, then fills in, and keeps the last good summary when the API stops answering', async () => {
    let mode: 'ok' | 'down' | 'html' = 'ok';
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (mode === 'down') throw new TypeError('Failed to fetch');
      if (mode === 'html') return new Response('<html>Bad gateway</html>', { status: 200 });
      if (url.endsWith('/status/summary')) return Response.json(summary());
      if (url.endsWith('/status/history')) return Response.json(history());
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const { root, rendered } = fakeRoot();
    let now = NOW;
    const page = startStatusPage({
      root,
      api: 'https://play.example.com/api',
      fetch: fetchFn,
      now: () => now,
    });
    try {
      expect(rendered.length).toBeGreaterThanOrEqual(1);
      await page.refresh(true);
      expect(page.state()).toMatchObject({ unreachable: false, lastOk: NOW });
      expect(page.state().summary?.overall).toBe('operational');
      expect(page.state().history?.days).toHaveLength(90);
      expect(calls).toContain('https://play.example.com/api/status/history');

      now += 30_000;
      mode = 'down';
      await page.refresh();
      expect(page.state()).toMatchObject({ unreachable: true, lastOk: NOW });
      expect(page.state().summary?.overall).toBe('operational');

      mode = 'html';
      await page.refresh();
      expect(page.state().unreachable).toBe(true);

      mode = 'ok';
      now += 30_000;
      await page.refresh();
      expect(page.state()).toMatchObject({ unreachable: false, lastOk: now });
    } finally {
      page.stop();
    }
  });

  it('an older refresh answering last never paints over a newer one', async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const fetchFn = ((url: string) =>
      url.endsWith('/status/summary')
        ? new Promise<Response>((resolve, reject) =>
            answers.push((ok) => (ok ? resolve(Response.json(summary())) : reject(new TypeError('down')))),
          )
        : Promise.resolve(Response.json(history()))) as typeof fetch;
    const { root } = fakeRoot();
    const page = startStatusPage({
      root,
      api: 'https://play.example.com/api',
      fetch: fetchFn,
      now: () => NOW,
    });
    try {
      const older = page.refresh();
      const newer = page.refresh();
      answers[2]!(true);
      await newer;
      answers[1]!(false);
      await older;
      expect(page.state().unreachable).toBe(false);
    } finally {
      answers[0]?.(true);
      page.stop();
    }
  });

  it('retries a failed history load on the next refresh, not ten minutes later', async () => {
    vi.useFakeTimers();
    let historyUp = false;
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/status/summary')) return Response.json(summary());
      if (!historyUp) throw new TypeError('down');
      return Response.json(history());
    }) as typeof fetch;
    const { root } = fakeRoot();
    const page = startStatusPage({ root, api: 'https://play.example.com/api', fetch: fetchFn });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(page.state().history).toBeNull();
      historyUp = true;
      await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
      expect(calls.filter((c) => c.endsWith('/status/history'))).toHaveLength(2);
      expect(page.state().history?.days).toHaveLength(90);
      await vi.advanceTimersByTimeAsync(SUMMARY_REFRESH_MS);
      expect(calls.filter((c) => c.endsWith('/status/history'))).toHaveLength(2);
    } finally {
      page.stop();
      vi.useRealTimers();
    }
  });

  it('accepts only summary-shaped answers', () => {
    expect(isSummary(summary())).toBe(true);
    expect(
      isSummary({ overall: 'fine', components: [], incidents: [], maintenance: {}, generatedAt: '' }),
    ).toBe(false);
    expect(isSummary(null)).toBe(false);
    expect(isSummary('<html>')).toBe(false);
  });
});
