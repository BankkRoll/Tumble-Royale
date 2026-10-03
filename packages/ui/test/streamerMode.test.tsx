/**
 * Streamer Mode: other real players' names never reach the screen; you, your
 * party and bots keep theirs.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RaceProgress, SpectateBanner } from '../src/hud/widgets.tsx';
import { streamerSafeName } from '../src/names.ts';
import { VictoryScreen, WinnerCamScreen } from '../src/screens/Results.tsx';
import { DEFAULT_HUD, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { ui } from '../src/store/uiStore.ts';
import type { ShowPlayer } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'plain' as const };
const human: ShowPlayer = { id: 6, name: 'RealPerson99', colors, isBot: false };

function streamer(on: boolean): void {
  const s = ui.getState().settings;
  ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, streamerMode: on } } });
}

describe('streamerSafeName', () => {
  it('masks other real players only', () => {
    expect(streamerSafeName({ id: 4, name: 'Real' }, true)).toBe('Tumbler 5');
    expect(streamerSafeName({ id: 4, name: 'Real' }, false)).toBe('Real');
    expect(streamerSafeName({ id: 4, name: 'Me', isLocal: true }, true)).toBe('Me');
    expect(streamerSafeName({ id: 4, name: 'Pal', isParty: true }, true)).toBe('Pal');
    expect(streamerSafeName({ id: 4, name: 'Sir Wobble', isBot: true }, true)).toBe('Sir Wobble');
  });
});

describe('streamer mode on screen', () => {
  afterEach(() =>
    ui.setState({ settings: DEFAULT_SETTINGS, hud: DEFAULT_HUD, victory: null, spectate: null }),
  );

  it('race leader tooltips hide real players but keep bots', () => {
    streamer(true);
    ui.setState({
      hud: {
        ...DEFAULT_HUD,
        roundType: 'race',
        leaders: [
          { id: 2, name: 'RealPerson99', color: '#fff', progress: 0.8 },
          { id: 3, name: 'Sir Wobble', color: '#fff', progress: 0.7, isBot: true },
        ],
      },
    });
    const html = renderToStaticMarkup(<RaceProgress />);
    expect(html).not.toContain('RealPerson99');
    expect(html).toContain('title="Tumbler 3"');
    expect(html).toContain('title="Sir Wobble"');
  });

  it('the winner banners hide a real winner', () => {
    streamer(true);
    ui.setState({
      victory: { winner: human, isLocalWinner: false, crownsBefore: 0, crownsAfter: 0, showName: 'Show' },
    });
    expect(renderToStaticMarkup(<WinnerCamScreen />)).not.toContain('RealPerson99');
    expect(renderToStaticMarkup(<VictoryScreen />)).not.toContain('RealPerson99');
  });

  it('the spectate banner hides the watched player', () => {
    streamer(true);
    ui.setState({ spectate: { player: human, detail: 'In the lead', qualified: false, index: 0, count: 3 } });
    const html = renderToStaticMarkup(<SpectateBanner />);
    expect(html).not.toContain('RealPerson99');
    expect(html).toContain('Tumbler 7');
  });
});
