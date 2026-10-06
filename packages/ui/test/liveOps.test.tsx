import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MaintenanceBanner } from '../src/screens/menu/MainMenu.tsx';
import { ServerStatusLink, StartCluster } from '../src/screens/menu/PlayTab.tsx';
import { StoreTab } from '../src/screens/menu/StoreTab.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import {
  analyticsAllowed,
  featureOn,
  maintenanceHeadline,
  privacySignal,
  STATUS_PAGE_URL,
} from '../src/store/liveOps.ts';
import { ui } from '../src/store/uiStore.ts';
import type { Playlist } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const NOW = Date.now();

const card = (over: Partial<Playlist>): Playlist => ({
  id: 'main-show',
  name: 'Main Show',
  description: '',
  players: 100,
  teamSize: 1,
  art: ['#ff6fae', '#ffd23f'],
  icon: '',
  ...over,
});

describe('live-ops helpers', () => {
  it('treats missing flags as on', () => {
    expect(featureOn({}, 'store.enabled')).toBe(true);
    expect(featureOn({ 'store.enabled': false }, 'store.enabled')).toBe(false);
  });

  it('follows Do Not Track and Global Privacy Control unless the player chose', () => {
    expect(privacySignal(undefined)).toBe(false);
    expect(privacySignal({ doNotTrack: '1' })).toBe(true);
    expect(privacySignal({ globalPrivacyControl: true })).toBe(true);
    expect(privacySignal({ doNotTrack: '0' })).toBe(false);
    expect(analyticsAllowed(null, {})).toBe(true);
    expect(analyticsAllowed(null, { doNotTrack: '1' })).toBe(false);
    expect(analyticsAllowed(true, { globalPrivacyControl: true })).toBe(true);
    expect(analyticsAllowed(false, {})).toBe(false);
    expect(DEFAULT_SETTINGS.gameplay.analytics).toBeNull();
  });

  it('words the maintenance headline for each phase', () => {
    const base = { message: 'm', startsAt: null, endsAt: null };
    expect(maintenanceHeadline({ ...base, phase: 'scheduled', startsAt: NOW + 600_000 }, NOW)).toBe(
      'Maintenance in 10 min',
    );
    expect(maintenanceHeadline({ ...base, phase: 'scheduled', startsAt: NOW + 5_400_000 }, NOW)).toBe(
      'Maintenance in 1 h 30 min',
    );
    expect(maintenanceHeadline({ ...base, phase: 'scheduled', startsAt: NOW + 1 }, NOW)).toBe(
      'Maintenance in 1 min',
    );
    expect(maintenanceHeadline({ ...base, phase: 'active', endsAt: NOW + 7_200_000 }, NOW)).toBe(
      'Down for maintenance · back in about 2 h',
    );
    expect(maintenanceHeadline({ ...base, phase: 'active', endsAt: NOW - 1 }, NOW)).toBe(
      'Down for maintenance',
    );
  });
});

describe('maintenance banner', () => {
  afterEach(() => ui.getState().setLiveOps({ maintenance: null, flags: {} }));

  it('renders nothing without a notice', () => {
    expect(renderToStaticMarkup(<MaintenanceBanner />)).toBe('');
  });

  it('announces scheduled maintenance and explains an active one', () => {
    ui.getState().setLiveOps({
      maintenance: {
        phase: 'scheduled',
        message: 'New rounds incoming.',
        startsAt: NOW + 600_000,
        endsAt: null,
      },
    });
    const soon = renderToStaticMarkup(<MaintenanceBanner />);
    expect(soon).toMatch(/Maintenance in (9|10) min/);
    expect(soon).toContain('New rounds incoming.');
    ui.getState().setLiveOps({
      maintenance: { phase: 'active', message: 'Back shortly.', startsAt: null, endsAt: null },
    });
    const now = renderToStaticMarkup(<MaintenanceBanner />);
    expect(now).toContain('is-active');
    expect(now).toContain('Vs Bots still works');
    expect(now).toContain(`href="${STATUS_PAGE_URL}"`);
    expect(now).toContain('rel="noopener"');
  });
});

describe('status page link when the servers are down', () => {
  afterEach(() => ui.getState().setOnlineStatus({ state: 'checking' }));

  it('appears only when the device is online but the servers are not', () => {
    ui.getState().setOnlineStatus({ state: 'offline' });
    const html = renderToStaticMarkup(<ServerStatusLink />);
    expect(html).toContain('data-testid="server-status-link"');
    expect(html).toContain('href="/status"');
    for (const s of [
      { state: 'offline' as const, noNetwork: true },
      { state: 'online' as const },
      { state: 'checking' as const },
    ]) {
      ui.getState().setOnlineStatus(s);
      expect(renderToStaticMarkup(<ServerStatusLink />), JSON.stringify(s)).toBe('');
    }
  });
});

describe('scheduled playlists in the picker', () => {
  afterEach(() => ui.getState().setPlaylists([]));

  it('shows an Ends in timer on a live limited-time playlist', () => {
    ui.getState().setPlaylists(
      [card({ id: 'chaos-mode', name: 'Chaos Mode', endsAt: NOW + 3_600_000 })],
      'chaos-mode',
    );
    const html = renderToStaticMarkup(<StartCluster />).replace(/<!-- -->/g, '');
    expect(html).toContain('data-testid="playlist-ends"');
    expect(html).toMatch(/Ends in (59:\d\d|01:00:00)/);
  });

  it('shows Coming soon with a countdown and cannot be played', () => {
    ui.getState().setPlaylists(
      [
        card({}),
        card({ id: 'squads', name: 'Squads', comingSoon: true, startsAt: NOW + 2 * 86_400_000 + 1000 }),
      ],
      'squads',
    );
    const html = renderToStaticMarkup(<StartCluster />).replace(/<!-- -->/g, '');
    expect(html).toContain('Coming soon · 2d 0h');
    expect(html).toMatch(/data-testid="play"[^>]*disabled|disabled[^>]*data-testid="play"/);
    expect(html).not.toContain('data-testid="playlist-ends"');
  });
});

describe('store kill switch', () => {
  afterEach(() => ui.getState().setLiveOps({ flags: {} }));

  it('shows a closed sign while store.enabled is off', () => {
    ui.getState().setLiveOps({ flags: { 'store.enabled': false } });
    expect(renderToStaticMarkup(<StoreTab />)).toContain('data-testid="store-closed"');
  });
});
