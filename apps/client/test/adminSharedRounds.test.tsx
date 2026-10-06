/**
 * Admin console "Shared rounds": routing, the list and detail views' first
 * render, and the contents summary of a round's JSON.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminApi, tabSessionStore } from '../src/admin/api.ts';
import { ConsoleContext, type ConsoleContextValue } from '../src/admin/components.tsx';
import { parseRoute, routeHash } from '../src/admin/format.ts';
import { SharedRoundsView, roundContents } from '../src/admin/views/SharedRoundsView.tsx';

const ctx = (): ConsoleContextValue => ({
  api: new AdminApi('https://api.test', tabSessionStore(undefined), vi.fn()),
  actor: { userId: 'u-staff', label: 'Mod#0001', role: 'moderator' },
  confirm: vi.fn(),
  toast: vi.fn(),
  go: vi.fn(),
  now: () => Date.parse('2026-10-06T12:00:00.000Z'),
});

describe('shared rounds in the console', () => {
  it('routes to the list and to one round', () => {
    expect(parseRoute('#/rounds')).toEqual({ view: 'rounds' });
    expect(parseRoute('#/rounds/K7MQ2X9A')).toEqual({ view: 'rounds', code: 'K7MQ2X9A' });
    expect(routeHash({ view: 'rounds', code: 'K7MQ2X9A' })).toBe('#/rounds/K7MQ2X9A');
    expect(routeHash({ view: 'rounds' })).toBe('#/rounds');
  });

  it('summarises a round definition', () => {
    expect(roundContents({ geometry: [1, 2], obstacles: [1], triggers: [] })).toBe(
      '2 parts · 1 obstacles · 0 triggers',
    );
    expect(roundContents(null)).toBe('0 parts · 0 obstacles · 0 triggers');
  });

  it('renders the list with filters, reported rounds first', () => {
    const html = renderToStaticMarkup(
      <ConsoleContext.Provider value={ctx()}>
        <SharedRoundsView />
      </ConsoleContext.Provider>,
    );
    expect(html).toContain('Shared rounds');
    expect(html).toContain('aria-label="Filter shared rounds"');
    expect(html).toMatch(/<option value="1" selected="">with open reports<\/option>/);
  });
});
