/**
 * Admin console: session storage, the API client's auth handling, the view
 * helpers and server-rendered markup of the views (states, role gating,
 * accessible controls).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminApi, AdminApiError, tabSessionStore, type AdminSession } from '../src/admin/api.ts';
import { AdminApp, SignIn } from '../src/admin/App.tsx';
import {
  ConfirmDialog,
  ConsoleContext,
  StateBlock,
  loadStarting,
  type ConsoleContextValue,
} from '../src/admin/components.tsx';
import { AUDIT_INITIAL, auditReducer, type AuditState } from '../src/admin/views/AuditView.tsx';
import {
  banState,
  BAN_DURATIONS,
  fromLocalInput,
  parseRoute,
  relativeTime,
  reportActionBody,
  routeHash,
  toLocalInput,
} from '../src/admin/format.ts';
import type { ReportRow } from '../src/admin/types.ts';
import { flagList, LiveOpsView } from '../src/admin/views/LiveOpsView.tsx';
import { playerActions } from '../src/admin/views/PlayerView.tsx';
import { BulkBar, describeAction, ReportRowView } from '../src/admin/views/ReportsView.tsx';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const session = (
  role: 'admin' | 'moderator',
  expiresAt = new Date(NOW + 600_000).toISOString(),
): AdminSession => ({
  token: 'tra_test',
  expiresAt,
  actor: { userId: 'u-staff', label: 'Mod#0001', role },
});

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('tab session store', () => {
  it('keeps the session in the tab store and drops it once expired', () => {
    let now = NOW;
    const storage = memoryStorage();
    const store = tabSessionStore(storage, () => now);
    store.set(session('admin'));
    expect([...storage.data.keys()]).toEqual(['tumble.admin.session']);
    expect(tabSessionStore(storage, () => now).get()?.actor.role).toBe('admin');
    now += 700_000;
    expect(store.get()).toBeNull();
    store.set(null);
    expect(storage.data.size).toBe(0);
  });

  it('works without storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    } as unknown as Storage;
    const store = tabSessionStore(broken, () => NOW);
    store.set(session('moderator'));
    expect(store.get()?.actor.role).toBe('moderator');
  });
});

describe('admin API client', () => {
  it('needs a signed-in player to open a session', async () => {
    const api = new AdminApi(
      'https://api.test',
      tabSessionStore(memoryStorage(), () => NOW),
      vi.fn(),
    );
    await expect(api.signIn(null)).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('trades the player token, then sends only the console token, without cookies', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return calls.length === 1
        ? jsonResponse(201, session('moderator'))
        : jsonResponse(200, { reports: [] });
    });
    const api = new AdminApi(
      'https://api.test',
      tabSessionStore(memoryStorage(), () => NOW),
      fetchFn as typeof fetch,
    );
    await api.signIn('player-access-token');
    expect(calls[0]!.url).toBe('https://api.test/admin/session');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer player-access-token',
    );
    await api.request('GET', '/internal/reports');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tra_test');
    expect(calls[1]!.init.credentials).toBe('omit');
  });

  it('ends the session on a 401 and tells the shell', async () => {
    const store = tabSessionStore(memoryStorage(), () => NOW);
    store.set(session('admin'));
    const api = new AdminApi('https://api.test', store, (async () =>
      jsonResponse(401, { error: 'unauthorized', message: 'expired' })) as typeof fetch);
    const ended = vi.fn();
    api.onSignedOut(ended);
    await expect(api.request('GET', '/internal/audit')).rejects.toBeInstanceOf(AdminApiError);
    expect(api.session).toBeNull();
    expect(ended).toHaveBeenCalledOnce();
  });

  it('surfaces the API error code and network failures', async () => {
    const store = tabSessionStore(memoryStorage(), () => NOW);
    store.set(session('admin'));
    const refusing = new AdminApi('https://api.test', store, (async () =>
      jsonResponse(403, { error: 'insufficient_role', message: 'needs admin' })) as typeof fetch);
    await expect(refusing.request('GET', '/internal/flags')).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_role',
    });
    expect(store.get()).not.toBeNull();
    const offline = new AdminApi('https://api.test', store, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(offline.request('GET', '/internal/flags')).rejects.toMatchObject({
      status: 0,
      code: 'network',
    });
  });
});

describe('view helpers', () => {
  it('formats relative times', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
    expect(relativeTime(new Date(NOW + 3 * 3_600_000).toISOString(), NOW)).toBe('in 3 h');
    expect(relativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime(null, NOW)).toBe('—');
  });

  it('round-trips hash routes', () => {
    expect(parseRoute('')).toEqual({ view: 'reports' });
    expect(parseRoute('#/players/abc')).toEqual({ view: 'players', id: 'abc' });
    expect(parseRoute('#/players?q=Name%231234')).toEqual({ view: 'players', q: 'Name#1234' });
    expect(parseRoute('#/audit?target=u1')).toEqual({ view: 'audit', target: 'u1' });
    for (const r of [
      { view: 'players', id: 'a b' },
      { view: 'audit', target: 'x' },
      { view: 'liveops' },
    ] as const)
      expect(parseRoute(routeHash(r))).toEqual(r);
  });

  it('builds bulk action bodies with lengths only where they apply', () => {
    expect(reportActionBody(['r1'], 'mute', '  spam  ', 24)).toEqual({
      reportIds: ['r1'],
      action: 'mute',
      reason: 'spam',
      durationHours: 24,
    });
    expect(reportActionBody(['r1'], 'ban', 'cheats', null)).not.toHaveProperty('durationHours');
    expect(reportActionBody(['r1'], 'warn', 'rude', 24)).not.toHaveProperty('durationHours');
  });

  it('tells active, lifted and expired bans apart', () => {
    const past = new Date(NOW - 1).toISOString();
    expect(banState({ expiresAt: null, revokedAt: null }, NOW)).toBe('active');
    expect(banState({ expiresAt: past, revokedAt: null }, NOW)).toBe('expired');
    expect(banState({ expiresAt: null, revokedAt: past }, NOW)).toBe('lifted');
  });

  it('converts datetime-local values', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('nonsense')).toBeUndefined();
    const iso = '2026-12-01T18:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it('lists every known flag, defaulting to on, and hides maintenance', () => {
    const list = flagList([
      { key: 'store.enabled', enabled: false, rolloutPercent: 100, payload: null, updatedAt: 'x' },
      { key: 'maintenance', enabled: true, rolloutPercent: 100, payload: null, updatedAt: 'x' },
      { key: 'custom.thing', enabled: true, rolloutPercent: 25, payload: null, updatedAt: 'x' },
    ]);
    expect(list.find((f) => f.key === 'store.enabled')).toMatchObject({ enabled: false, stored: true });
    expect(list.find((f) => f.key === 'chat.global')).toMatchObject({ enabled: true, stored: false });
    expect(list.some((f) => f.key === 'maintenance')).toBe(false);
    expect(list.some((f) => f.key === 'custom.thing')).toBe(true);
  });

  it('describes what each bulk decision does', () => {
    expect(describeAction('ban', 3, 2)).toMatch(/Suspend 2 players/);
    expect(describeAction('dismiss', 1, 1)).toMatch(/Nobody is sanctioned/);
  });

  it('sends player actions to the right routes', async () => {
    const send = vi.fn(async () => ({}));
    const reload = vi.fn();
    const a = playerActions('Bob#0001', 'u1', send, reload);
    await a.suspend.run('cheating', null);
    expect(send).toHaveBeenLastCalledWith('POST', '/internal/bans', {
      userId: 'u1',
      scope: 'all',
      reason: 'cheating',
    });
    await a.mute.run('spam', 24);
    expect(send).toHaveBeenLastCalledWith('POST', '/internal/bans', {
      userId: 'u1',
      scope: 'chat',
      reason: 'spam',
      durationHours: 24,
    });
    await a.resetName.run('rude', null);
    expect(send).toHaveBeenLastCalledWith('POST', '/internal/users/u1/reset-name', { reason: 'rude' });
    expect(reload).toHaveBeenCalledTimes(3);
  });
});

function ctx(role: 'admin' | 'moderator'): ConsoleContextValue {
  return {
    api: new AdminApi('https://api.test', tabSessionStore(undefined), vi.fn()),
    actor: session(role).actor,
    confirm: vi.fn(),
    toast: vi.fn(),
    go: vi.fn(),
    now: () => NOW,
  };
}

describe('views', () => {
  const report: ReportRow = {
    id: 'r1',
    reason: 'harassment',
    details: 'kept insulting me',
    status: 'open',
    matchId: 'm_42',
    createdAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    evidence: [{ channel: 'global', text: 'you are all terrible', at: NOW - 3 * 3_600_000 }],
    reporter: { id: 'u-rep', displayName: 'Kind', tag: '0002' },
    target: {
      id: 'u-tgt',
      displayName: 'Loud',
      tag: '0003',
      openReports: 4,
      activeSanctions: [{ id: 'b1', scope: 'chat', expiresAt: null }],
    },
  };

  it('renders a report row with names, counts, sanctions and evidence', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <ReportRowView report={report} selected={false} onToggle={() => undefined} now={NOW} />
        </tbody>
      </table>,
    );
    expect(html).toContain('Loud#0003');
    expect(html).toContain('href="#/players/u-tgt"');
    expect(html).toContain('4 open');
    expect(html).toContain('Muted');
    expect(html).toContain('Chat evidence (1)');
    expect(html).toContain('you are all terrible');
    expect(html).toContain('aria-label="Select report against Loud#0003"');
    expect(html).toContain('2 h ago');
  });

  it('shows bulk actions only with a selection', () => {
    expect(renderToStaticMarkup(<BulkBar count={0} onAction={vi.fn()} onClear={vi.fn()} />)).toBe('');
    const html = renderToStaticMarkup(<BulkBar count={3} onAction={vi.fn()} onClear={vi.fn()} />);
    expect(html).toContain('role="toolbar"');
    for (const label of ['Dismiss', 'Resolve', 'Warn', 'Mute chat…', 'Ban…']) expect(html).toContain(label);
  });

  it('renders loading, error and empty states', () => {
    const base = { reload: () => undefined };
    const render = (state: { data: string[] | null; error: string | null; loading: boolean }) =>
      renderToStaticMarkup(
        <StateBlock state={{ ...base, ...state }} empty="Nothing here" isEmpty={(d) => d.length === 0}>
          {(d) => <p>{d.join(',')}</p>}
        </StateBlock>,
      );
    expect(render({ data: null, error: null, loading: true })).toContain('Loading');
    expect(render({ data: null, error: 'boom', loading: false })).toContain('role="alert"');
    expect(render({ data: [], error: null, loading: false })).toContain('Nothing here');
    expect(render({ data: ['a'], error: null, loading: false })).toContain('<p>a</p>');
  });

  it('asks for a reason and a length before a ban', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        action={{
          title: 'Ban 2 players',
          body: 'x',
          confirmLabel: 'Ban',
          danger: true,
          durations: BAN_DURATIONS,
          run: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('Ban 2 players');
    expect(html).toContain('required');
    expect(html).toContain('Permanent');
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
  });

  it('keeps live ops from moderators', () => {
    const mod = renderToStaticMarkup(
      <ConsoleContext.Provider value={ctx('moderator')}>
        <LiveOpsView />
      </ConsoleContext.Provider>,
    );
    expect(mod).toContain('need the admin role');
    const admin = renderToStaticMarkup(
      <ConsoleContext.Provider value={ctx('admin')}>
        <LiveOpsView />
      </ConsoleContext.Provider>,
    );
    expect(admin).toContain('Maintenance');
    expect(admin).toContain('Feature flags');
  });

  it('shows sign-in until there is a session, then the role-filtered navigation', () => {
    const signedOut = new AdminApi(
      'https://api.test',
      tabSessionStore(memoryStorage(), () => NOW),
      vi.fn(),
    );
    expect(
      renderToStaticMarkup(<AdminApp api={signedOut} playerToken={async () => null} now={() => NOW} />),
    ).toContain('Open the console');
    expect(renderToStaticMarkup(<SignIn onSignIn={vi.fn()} busy={false} error="no access" />)).toContain(
      'no access',
    );

    const store = tabSessionStore(memoryStorage(), () => NOW);
    store.set(session('moderator'));
    const asMod = renderToStaticMarkup(
      <AdminApp
        api={new AdminApi('https://api.test', store, vi.fn())}
        playerToken={async () => null}
        now={() => NOW}
        initialHash="#/sanctions"
      />,
    );
    expect(asMod).toContain('Mod#0001');
    expect(asMod).toContain('aria-current="page"');
    expect(asMod).not.toContain('Live ops');
    expect(asMod).toContain('Sanctions');

    const adminStore = tabSessionStore(memoryStorage(), () => NOW);
    adminStore.set(session('admin'));
    const asAdmin = renderToStaticMarkup(
      <AdminApp
        api={new AdminApi('https://api.test', adminStore, vi.fn())}
        playerToken={async () => null}
        now={() => NOW}
        initialHash="#/reports"
      />,
    );
    expect(asAdmin).toContain('Live ops');
  });
});

describe('loads across filters', () => {
  it('a new filter drops the old rows; a reload keeps them up', () => {
    const shown = { data: ['old row'], error: null, loading: false };
    expect(loadStarting(shown, true)).toEqual({ data: null, error: null, loading: true });
    expect(loadStarting(shown, false)).toEqual({ data: ['old row'], error: null, loading: true });
  });

  it('shows a reload in progress next to the rows it keeps', () => {
    const html = renderToStaticMarkup(
      <StateBlock
        state={{ data: ['a'], error: null, loading: true, reload: () => undefined }}
        empty="none"
        isEmpty={(d) => d.length === 0}
      >
        {(d) => <p>{d.join()}</p>}
      </StateBlock>,
    );
    expect(html).toContain('Refreshing');
    expect(html).toContain('<p>a</p>');
  });
});

describe('audit log paging', () => {
  const entry = (id: string) => ({ id }) as unknown as AuditState['entries'][number];
  const loaded = (key: string, ids: string[], next: number | null): AuditState =>
    auditReducer(auditReducer(AUDIT_INITIAL, { type: 'load', key }), {
      type: 'loaded',
      key,
      page: { entries: ids.map(entry), nextBefore: next },
    });

  it('a page asked for under the old filter never lands under the new one', () => {
    let s = loaded('?action=player.', ['p1'], 40);
    s = auditReducer(s, { type: 'more', key: '?action=player.' });
    s = auditReducer(s, { type: 'load', key: '?action=flag.' });
    expect(s.entries).toEqual([]);
    expect(s.next).toBeNull();
    s = auditReducer(s, {
      type: 'appended',
      key: '?action=player.',
      before: 40,
      page: { entries: [entry('p2')], nextBefore: null },
    });
    expect(s.entries).toEqual([]);
    s = auditReducer(s, { type: 'loaded', key: '?action=flag.', page: { entries: [entry('f1')], nextBefore: null } });
    expect(s.entries.map((e) => e.id)).toEqual(['f1']);
  });

  it('appends the next page of the same filter', () => {
    let s = loaded('', ['a'], 10);
    s = auditReducer(s, { type: 'more', key: '' });
    s = auditReducer(s, { type: 'appended', key: '', before: 10, page: { entries: [entry('b')], nextBefore: null } });
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(s.next).toBeNull();
    expect(s.loading).toBe(false);
  });
});
