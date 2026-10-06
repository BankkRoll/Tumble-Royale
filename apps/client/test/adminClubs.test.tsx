/**
 * The console's Clubs view: routes, the requests each moderation action
 * sends (always with the reason), and the rendered list and club page for a
 * moderator.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminApi, tabSessionStore, type AdminSession } from '../src/admin/api.ts';
import { AdminApp } from '../src/admin/App.tsx';
import { parseRoute, routeHash } from '../src/admin/format.ts';
import { clubActions } from '../src/admin/views/ClubsView.tsx';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

const session: AdminSession = {
  token: 'tra_test',
  expiresAt: new Date(NOW + 600_000).toISOString(),
  actor: { userId: 'u-staff', label: 'Mod#0001', role: 'moderator' },
};

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
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

describe('club routes', () => {
  it('parses and builds the list, search and page hashes', () => {
    expect(parseRoute('#/clubs')).toEqual({ view: 'clubs' });
    expect(parseRoute('#/clubs?q=wob')).toEqual({ view: 'clubs', q: 'wob' });
    expect(parseRoute('#/clubs/c-1')).toEqual({ view: 'clubs', id: 'c-1' });
    expect(routeHash({ view: 'clubs', id: 'c 1' })).toBe('#/clubs/c%201');
    expect(routeHash({ view: 'clubs', q: 'wob' })).toBe('#/clubs?q=wob');
  });
});

describe('club actions', () => {
  it('sends each action to its route with the reason, then reloads', async () => {
    const send = vi.fn(async () => undefined);
    const reload = vi.fn();
    const a = clubActions('Wobble Crew [WOB]', 'c-1', send, reload, { name: 'Fine Name', tag: 'fine' });
    await a.rename.run('offensive name', null);
    await a.resetName.run('again', null);
    await a.clearDescription.run('spam link', null);
    await a.resetEmblem.run('rude', null);
    await a.disband.run('hate club', null);
    expect(send.mock.calls).toEqual([
      ['POST', '/internal/clubs/c-1/rename', { name: 'Fine Name', tag: 'fine', reason: 'offensive name' }],
      ['POST', '/internal/clubs/c-1/reset-name', { reason: 'again' }],
      ['POST', '/internal/clubs/c-1/clear-description', { reason: 'spam link' }],
      ['POST', '/internal/clubs/c-1/reset-emblem', { reason: 'rude' }],
      ['POST', '/internal/clubs/c-1/disband', { reason: 'hate club' }],
    ]);
    expect(reload).toHaveBeenCalledTimes(5);
    expect(a.disband.danger).toBe(true);
    expect(a.rename.body).toContain('[FINE]');
  });
});

describe('clubs view', () => {
  it('is in the moderator navigation and opens on its hash', () => {
    const store = tabSessionStore(memoryStorage(), () => NOW);
    store.set(session);
    const html = renderToStaticMarkup(
      <AdminApp
        api={new AdminApi('https://api.test', store, vi.fn())}
        playerToken={async () => null}
        now={() => NOW}
        initialHash="#/clubs"
      />,
    );
    expect(html).toContain('href="#/clubs"');
    expect(html).toContain('id="clubs-title"');
    expect(html).toContain('Loading');
  });
});
