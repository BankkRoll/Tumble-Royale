import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installLifecycle, type LifecycleLogger } from '../src/lifecycle.ts';
import { EnvIssues } from '../src/env.ts';
import {
  metricsAccess,
  publicMetricsAccess,
  readMetricsExposure,
  Registry,
  startInternalMetrics,
} from '../src/metrics.ts';
import { matchRequestId, requestIdFor, sanitizeRequestId } from '../src/requestId.ts';

describe('Registry', () => {
  it('renders counters, gauges and histograms in the text format', async () => {
    const reg = new Registry();
    const c = reg.counter('t_hits_total', 'Hits.');
    c.inc({ route: '/a' });
    c.inc({ route: '/a' }, 2);
    c.inc({ route: 'quote"back\\slash\nnl' });
    reg.gauge('t_depth', 'Depth.', () => [[{ q: 'solo' }, 3]]);
    const h = reg.histogram('t_seconds', 'Latency.', [0.1, 1]);
    h.observe({ r: 'x' }, 0.05);
    h.observe({ r: 'x' }, 0.5);
    h.observe({ r: 'x' }, 5);
    const text = await reg.render();
    expect(text).toContain('# TYPE t_hits_total counter');
    expect(text).toContain('t_hits_total{route="/a"} 3');
    expect(text).toContain('t_hits_total{route="quote\\"back\\\\slash\\nnl"} 1');
    expect(text).toContain('t_depth{q="solo"} 3');
    expect(text).toContain('t_seconds_bucket{le="0.1",r="x"} 1');
    expect(text).toContain('t_seconds_bucket{le="1",r="x"} 2');
    expect(text).toContain('t_seconds_bucket{le="+Inf",r="x"} 3');
    expect(text).toContain('t_seconds_count{r="x"} 3');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('survives a failing gauge source and rejects bad or duplicate names', async () => {
    const reg = new Registry();
    reg.gauge('t_broken', 'Broken.', () => Promise.reject(new Error('redis down')));
    reg.counter('t_ok_total', 'Ok.').inc();
    const text = await reg.render();
    expect(text).toContain('t_ok_total 1');
    expect(text).toContain('# TYPE t_broken gauge');
    expect(() => reg.counter('t_ok_total', 'again')).toThrow(/duplicate/);
    expect(() => reg.counter('bad-name', 'x')).toThrow(/invalid/);
  });
});

describe('metricsAccess', () => {
  it('is open in development, disabled in production without a token', () => {
    expect(metricsAccess(undefined, undefined, false)).toBe('ok');
    expect(metricsAccess(undefined, 'Bearer x', true)).toBe('disabled');
  });

  it('requires the exact bearer token when configured', () => {
    expect(metricsAccess('tok', undefined, true)).toBe('unauthorized');
    expect(metricsAccess('tok', 'Bearer tok2', true)).toBe('unauthorized');
    expect(metricsAccess('tok', 'Basic tok', false)).toBe('unauthorized');
    expect(metricsAccess('tok', 'Bearer tok', true)).toBe('ok');
  });
});

describe('request ids', () => {
  it('keeps plain ids and replaces unsafe ones', () => {
    expect(sanitizeRequestId('abc-123:x.y_z')).toBe('abc-123:x.y_z');
    expect(sanitizeRequestId(['first', 'second'])).toBe('first');
    expect(sanitizeRequestId('has space')).toBeUndefined();
    expect(sanitizeRequestId('x'.repeat(129))).toBeUndefined();
    expect(requestIdFor('evil\r\ninjected')).toMatch(/^[0-9a-f-]{36}$/);
    expect(matchRequestId('m_123')).toBe('match-m_123');
  });
});

function harness() {
  const proc = new EventEmitter() as EventEmitter & { exit: ReturnType<typeof vi.fn> };
  const exited = new Promise<number>((resolve) => {
    proc.exit = vi.fn((code: number) => resolve(code));
  });
  const lines: string[] = [];
  const log: LifecycleLogger = {
    info: (_o, m) => void lines.push(`info ${m}`),
    error: (_o, m) => void lines.push(`error ${m}`),
    fatal: (_o, m) => void lines.push(`fatal ${m}`),
  };
  return { proc, exited, lines, log };
}

describe('installLifecycle', () => {
  it('runs closers newest-first on SIGTERM and exits 0', async () => {
    const h = harness();
    const life = installLifecycle({ service: 't', log: h.log, process: h.proc as never });
    const order: string[] = [];
    life.onShutdown(() => void order.push('db'));
    life.onShutdown(async () => void order.push('http'));
    h.proc.emit('SIGTERM');
    expect(life.shuttingDown).toBe(true);
    expect(await h.exited).toBe(0);
    expect(order).toEqual(['http', 'db']);
  });

  it('exits at once on a second signal', async () => {
    const h = harness();
    const life = installLifecycle({ service: 't', log: h.log, process: h.proc as never });
    life.onShutdown(() => new Promise(() => undefined));
    h.proc.emit('SIGTERM');
    h.proc.emit('SIGINT');
    expect(await h.exited).toBe(130);
  });

  it('exits 0 immediately when a signal arrives before startup registered anything', async () => {
    const h = harness();
    installLifecycle({ service: 't', log: h.log, process: h.proc as never });
    h.proc.emit('SIGTERM');
    expect(await h.exited).toBe(0);
  });

  it('gives up on a hung closer after the timeout and exits 1', async () => {
    const h = harness();
    const life = installLifecycle({
      service: 't',
      log: h.log,
      process: h.proc as never,
      shutdownTimeoutMs: 20,
    });
    life.onShutdown(() => new Promise(() => undefined));
    h.proc.emit('SIGTERM');
    expect(await h.exited).toBe(1);
    expect(h.lines.some((l) => l.includes('timed out'))).toBe(true);
  });

  it('logs, reports and exits 1 on an uncaught exception, once', async () => {
    const h = harness();
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const life = installLifecycle({
      service: 'svc',
      log: h.log,
      process: h.proc as never,
      sentryDsn: 'https://k@sentry.example.com/1',
      fetch: fetchFn,
    });
    const closed = vi.fn();
    life.onShutdown(closed);
    h.proc.emit('uncaughtException', new TypeError('kaboom'));
    expect(await h.exited).toBe(1);
    expect(closed).toHaveBeenCalledOnce();
    expect(h.lines).toContain('fatal [svc] uncaughtException; exiting');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('kaboom');
    // A second crash while the first is handled exits without re-entering.
    h.proc.emit('unhandledRejection', new Error('again'));
    expect(h.proc.exit).toHaveBeenLastCalledWith(1);
  });
});

describe('metrics exposure', () => {
  it('reads METRICS_TOKEN, INTERNAL_PORT and INTERNAL_HOST like the game server', () => {
    const issues = new EnvIssues({ METRICS_TOKEN: 'short', INTERNAL_PORT: '7360' });
    readMetricsExposure(issues, 7360);
    expect(issues.list.map((i) => i.name)).toEqual(['METRICS_TOKEN', 'INTERNAL_PORT']);
    const ok = readMetricsExposure(
      new EnvIssues({ METRICS_TOKEN: 'x'.repeat(16), INTERNAL_PORT: '9360', INTERNAL_HOST: '10.0.0.4' }),
      7360,
    );
    expect(ok).toEqual({ token: 'x'.repeat(16), internalPort: 9360, internalHost: '10.0.0.4' });
  });

  it('closes the public route when a private listener exists, unless a token is set', () => {
    const internal = { token: undefined, internalPort: 9360, internalHost: undefined };
    expect(publicMetricsAccess(internal, undefined, false)).toBe('disabled');
    expect(publicMetricsAccess({ ...internal, internalPort: undefined }, undefined, false)).toBe('ok');
    const token = 't'.repeat(16);
    expect(publicMetricsAccess({ ...internal, token }, `Bearer ${token}`, true)).toBe('ok');
  });

  it('serves /metrics and /health on the private listener', async () => {
    const server = await startInternalMetrics(() => 'tumble_up 1\n', 0, '127.0.0.1');
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await (await fetch(`${base}/metrics`)).text()).toBe('tumble_up 1\n');
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/rooms`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
