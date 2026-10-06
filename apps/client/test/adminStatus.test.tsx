/**
 * Admin console status view: role gating (moderators read, admins write),
 * the incident card's controls, escaping of incident text, and routing.
 */
import type { PublicIncident } from '@tumble/shared/status';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminApi, tabSessionStore } from '../src/admin/api.ts';
import { ConsoleContext, type ConsoleContextValue } from '../src/admin/components.tsx';
import { parseRoute, routeHash } from '../src/admin/format.ts';
import { IncidentCard, StatusView, stateTone } from '../src/admin/views/StatusView.tsx';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');

function ctx(role: 'admin' | 'moderator'): ConsoleContextValue {
  return {
    api: new AdminApi('https://api.test', tabSessionStore(undefined), vi.fn()),
    actor: { userId: 'u-staff', label: 'Staff#0001', role },
    confirm: vi.fn(),
    toast: vi.fn(),
    go: vi.fn(),
    now: () => NOW,
  };
}

const incident = (over: Partial<PublicIncident> = {}): PublicIncident => ({
  id: '11111111-2222-4333-8444-555555555555',
  title: '<b>Queues</b> are slow',
  impact: 'major',
  status: 'investigating',
  components: ['matchmaking'],
  startedAt: new Date(NOW - 3_600_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  resolvedAt: null,
  updates: [{ status: 'investigating', message: '<script>x</script>', at: new Date(NOW).toISOString() }],
  ...over,
});

const render = (role: 'admin' | 'moderator', node: React.ReactNode) =>
  renderToStaticMarkup(<ConsoleContext.Provider value={ctx(role)}>{node}</ConsoleContext.Provider>);

describe('admin status view', () => {
  it('lets moderators read and only admins open incidents', () => {
    const mod = render('moderator', <StatusView />);
    expect(mod).toContain('Status page');
    expect(mod).toContain('needs the admin role');
    expect(mod).not.toContain('Open an incident');
    const admin = render('admin', <StatusView />);
    expect(admin).toContain('Open an incident');
    expect(admin).toContain('maxLength="120"');
  });

  it('shows update and resolve controls to admins on open incidents only', () => {
    const noop = () => undefined;
    const admin = render('admin', <IncidentCard incident={incident()} components={['api']} onDone={noop} />);
    expect(admin).toContain('Resolve…');
    expect(admin).toContain('Post update…');
    const mod = render(
      'moderator',
      <IncidentCard incident={incident()} components={['api']} onDone={noop} />,
    );
    expect(mod).not.toContain('Resolve…');
    expect(mod).not.toContain('Post update…');
    const done = render(
      'admin',
      <IncidentCard
        incident={incident({ status: 'resolved', resolvedAt: new Date(NOW).toISOString() })}
        components={['api']}
        onDone={noop}
      />,
    );
    expect(done).not.toContain('Resolve…');
    expect(done).toContain('Post update…');
  });

  it('renders incident text as text', () => {
    const html = render(
      'admin',
      <IncidentCard incident={incident()} components={[]} onDone={() => undefined} />,
    );
    expect(html).not.toContain('<b>Queues');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;Queues&lt;/b&gt; are slow');
    expect(html).toContain('Matchmaking');
  });

  it('routes #/status and colours states', () => {
    expect(parseRoute('#/status')).toEqual({ view: 'status' });
    expect(routeHash({ view: 'status' })).toBe('#/status');
    expect(stateTone('major_outage')).toBe('bad');
    expect(stateTone('maintenance')).toBe('info');
    expect(stateTone('unknown')).toBe('neutral');
  });
});
