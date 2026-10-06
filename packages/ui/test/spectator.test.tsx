/**
 * Spectator and broadcast UI states: the watcher's toolbar, the broadcast
 * overlay replacing the personal HUD (round card, timer, counts or team
 * scores, standings, name card), the chroma backdrop, the help card's
 * device-aware bindings, the roster sheet, and the pure rules behind them.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BroadcastLayer, SpectatorBar, SpectatorRosterSheet } from '../src/hud/Spectator.tsx';
import { DEFAULT_HUD, DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import {
  SPECTATOR_MODES,
  broadcastActive,
  initialSpectatorState,
  nextSpectatorMode,
  searchRoster,
} from '../src/store/spectator.ts';
import type { SpectatorRosterEntry, SpectatorState } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

/** Pictographic emoji, as the no-emoji product rule scans for. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

function row(id: number, over: Partial<SpectatorRosterEntry> = {}): SpectatorRosterEntry {
  return {
    id,
    name: `Player ${id}`,
    color: '#ff4f9a',
    isBot: false,
    isParty: false,
    isClub: false,
    team: -1,
    status: 'playing',
    place: id,
    pinned: false,
    following: false,
    ...over,
  };
}

function spectating(over: Partial<SpectatorState> = {}): void {
  ui.setState({
    screen: 'round',
    overlay: 'none',
    spectator: {
      ...initialSpectatorState(),
      live: true,
      roster: [
        row(1, { following: true }),
        row(2),
        row(3, { status: 'qualified' }),
        row(4, { status: 'eliminated' }),
      ],
      ...over,
    },
    spectate: {
      player: {
        id: 1,
        name: 'Player 1',
        colors: { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'plain' },
      },
      detail: 'In the lead',
      qualified: false,
      index: 0,
      count: 3,
    },
    roundIntro: {
      roundId: 'tilt-town',
      name: 'Tilt Town',
      type: 'race',
      theme: 'candy',
      objective: 'Reach the finish',
      rules: [],
      tips: [],
      roundIndex: 1,
      roundCount: 4,
      isFinal: false,
      playerCount: 40,
      qualifyTarget: 20,
    },
    hud: { ...DEFAULT_HUD, roundType: 'race', timeLeft: 83, timeTotal: 120, qualified: 7, qualifyTarget: 20 },
  });
}

beforeEach(() => {
  ui.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    photo: { ...ui.getState().photo, active: false },
  });
});

afterEach(() => {
  ui.setState({ spectator: null, spectate: null, roundIntro: null, screen: 'menu', hud: DEFAULT_HUD });
});

describe('spectator rules', () => {
  it('cycles camera modes follow → free → overview → director → follow', () => {
    expect(SPECTATOR_MODES.map(nextSpectatorMode)).toEqual(['free', 'overview', 'director', 'follow']);
  });

  it('starts every show on the personal HUD, a spectator seat on the broadcast overlay', () => {
    expect(initialSpectatorState()).toMatchObject({
      live: false,
      mode: 'follow',
      broadcast: false,
      pinnedId: null,
    });
    expect(initialSpectatorState(true).broadcast).toBe(true);
  });

  it('shows the broadcast overlay only while spectating a round with broadcast on, never in photo mode', () => {
    spectating({ broadcast: true });
    expect(broadcastActive(ui.getState())).toBe(true);
    ui.setState({ screen: 'roundResults' });
    expect(broadcastActive(ui.getState())).toBe(false);
    spectating({ broadcast: true, live: false });
    expect(broadcastActive(ui.getState())).toBe(false);
    spectating({ broadcast: true });
    ui.setState({ photo: { ...ui.getState().photo, active: true } });
    expect(broadcastActive(ui.getState())).toBe(false);
  });

  it('searches the roster by masked name only', () => {
    const rows = [row(1, { name: 'Tumbler 12' }), row(2, { name: 'Zoë' })];
    expect(searchRoster(rows, 'ZOE').map((r) => r.id)).toEqual([2]);
    expect(searchRoster(rows, 'tumbler').map((r) => r.id)).toEqual([1]);
    expect(searchRoster(rows, '#2').map((r) => r.id)).toEqual([2]);
    // A bare number matches a place or a name containing it.
    expect(searchRoster(rows, '2').map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('watcher toolbar', () => {
  it('shows the camera mode, the tools and their keys while spectating', () => {
    spectating({ mode: 'free' });
    const html = renderToStaticMarkup(<SpectatorBar />);
    expect(html).toContain('data-testid="spectator-bar"');
    expect(html).toContain('Free camera');
    expect(html).toContain('WASD fly');
    expect(html).toContain('Tab');
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    for (const b of buttons) expect(b.replace(/<[^>]+>/g, '')).not.toMatch(EMOJI);
  });

  it('hides in broadcast mode and when not spectating', () => {
    spectating({ broadcast: true });
    expect(renderToStaticMarkup(<SpectatorBar />)).toBe('');
    spectating({ live: false });
    expect(renderToStaticMarkup(<SpectatorBar />)).toBe('');
  });

  it('shows controller buttons on a gamepad', () => {
    spectating();
    ui.setState({ hud: { ...ui.getState().hud, device: 'gamepad' } });
    const html = renderToStaticMarkup(<SpectatorBar />);
    expect(html).toContain('Ⓨ');
    expect(html).toContain('Ⓧ');
  });
});

describe('broadcast overlay', () => {
  it('renders the round card, clock, qualified count, standings and the followed name card', () => {
    spectating({ broadcast: true, mode: 'director', note: 'Neck and neck' });
    const html = renderToStaticMarkup(<BroadcastLayer />);
    expect(html).toContain('data-testid="broadcast-overlay"');
    expect(html).toContain('Tilt Town');
    expect(html).toContain('Round 2 of 4');
    expect(html).toContain('1:23');
    expect(html).toContain('QUALIFIED');
    expect(html).toMatch(/7.*\/ 20/);
    expect(html).toContain('data-testid="broadcast-standings"');
    expect(html).toContain('Player 1');
    expect(html).toContain('Neck and neck');
    expect(html).not.toContain('data-testid="broadcast-chroma"');
  });

  it('shows team scores in team rounds instead of a count', () => {
    spectating({ broadcast: true });
    ui.setState({
      hud: {
        ...ui.getState().hud,
        roundType: 'team',
        teams: [
          { name: 'Pink', color: '#ff4f8b', shape: 'circle', score: 3, isMine: false },
          { name: 'Blue', color: '#3fa9ff', shape: 'square', score: 5, isMine: false },
        ],
      },
    });
    const html = renderToStaticMarkup(<BroadcastLayer />);
    expect(html).toContain('data-testid="broadcast-teams"');
    expect(html).not.toContain('data-testid="broadcast-count"');
    expect(html).toContain('Blue');
  });

  it('names the camera mode when it follows nobody', () => {
    spectating({ broadcast: true, mode: 'overview' });
    const html = renderToStaticMarkup(<BroadcastLayer />);
    expect(html).toContain('Overview');
  });

  it('puts the chroma-key backdrop behind the overlay on request', () => {
    spectating({ broadcast: true, chroma: true });
    const html = renderToStaticMarkup(<BroadcastLayer />);
    expect(html.indexOf('broadcast-chroma')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('broadcast-chroma')).toBeLessThan(html.indexOf('broadcast-overlay'));
  });

  it('renders nothing off the round screen or without broadcast mode', () => {
    spectating();
    expect(renderToStaticMarkup(<BroadcastLayer />)).toBe('');
    spectating({ broadcast: true });
    ui.setState({ screen: 'betweenRounds' });
    expect(renderToStaticMarkup(<BroadcastLayer />)).toBe('');
  });
});

describe('help card', () => {
  it('lists the live keyboard bindings, following rebinding', () => {
    spectating({ help: true });
    ui.getState().updateSettings('controls', {
      keybinds: { ...DEFAULT_KEYBINDS, spectateCamera: ['KeyC', ''] },
    });
    const html = renderToStaticMarkup(<BroadcastLayer />);
    expect(html).toContain('data-testid="broadcast-help"');
    expect(html).toMatch(/<kbd>C<\/kbd>.*Camera: follow, free, overview, director/);
    expect(html).toContain('Chroma-key backdrop');
    expect(html).toContain('<kbd>WASD</kbd>');
  });

  it('shows controller buttons on a gamepad and leaves out keyboard-only tools', () => {
    spectating({ help: true });
    ui.setState({ hud: { ...ui.getState().hud, device: 'gamepad' } });
    const html = renderToStaticMarkup(<BroadcastLayer />);
    expect(html).toContain('<kbd>R3</kbd>');
    expect(html).toContain('<kbd>LT / RT</kbd>');
    expect(html).not.toContain('Chroma-key backdrop');
  });
});

describe('roster sheet', () => {
  it('lists every row with follow and pin controls, statuses and party/club chips', () => {
    spectating({
      pinnedId: 2,
      roster: [
        row(1, { following: true }),
        row(2, { pinned: true, isParty: true }),
        row(3, { isClub: true }),
        row(4, { status: 'eliminated' }),
      ],
    });
    const html = renderToStaticMarkup(<SpectatorRosterSheet />);
    expect(html.match(/data-testid="spectator-roster-row"/g)).toHaveLength(4);
    expect(html).toContain('Unpin Player 2');
    expect(html).toContain('Pin Player 3');
    expect(html).toContain('Party');
    expect(html).toContain('Club');
    expect(html).toContain('aria-label="Eliminated"');
    expect(html).toContain('data-testid="spectator-roster-search"');
  });
});
