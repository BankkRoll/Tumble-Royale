/**
 * Show-flow UI copy and states: the reconnect curtain, the knocked-out
 * "Keep watching / Leave show" choice, leave-show copy per mode and the
 * spectate banner.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionLayer, reconnectStatusLine } from '../src/components/system.tsx';
import { EliminatedSheet, SpectateBanner } from '../src/hud/widgets.tsx';
import { onlineTileSub } from '../src/screens/menu/PlayTab.tsx';
import { InGameMenu, leaveShowBody } from '../src/screens/overlays/InGameMenu.tsx';
import { FinalHypeScreen, RoundResultsScreen } from '../src/screens/Results.tsx';
import { WatchChoiceLayer, watchChoiceRewardsNote } from '../src/screens/overlays/WatchChoice.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };

beforeEach(() => {
  ui.setState({
    settings: DEFAULT_SETTINGS,
    connection: { status: 'online' },
    watchChoice: null,
    showSeat: null,
    eliminatedSheet: false,
    spectate: null,
    screen: 'round',
    overlay: 'none',
  });
});

describe('reconnect curtain', () => {
  it('shows the real attempt and a countdown to the next one', () => {
    const now = 1_000_000;
    expect(
      reconnectStatusLine(
        { status: 'reconnecting', attempt: 3, maxAttempts: 5, nextAttemptAt: now + 1800 },
        now,
      ),
    ).toBe('Attempt 3 of 5 in 2s');
    expect(
      reconnectStatusLine({ status: 'reconnecting', attempt: 3, maxAttempts: 5, nextAttemptAt: now }, now),
    ).toBe('Attempt 3 of 5…');
    expect(reconnectStatusLine({ status: 'reconnecting' }, now)).toBeNull();
  });

  it('has no Leave while attempts are still running', () => {
    ui.setState({ connection: { status: 'reconnecting', attempt: 1, maxAttempts: 5 } });
    const html = renderToStaticMarkup(<ConnectionLayer />);
    expect(html).toContain('Attempt 1 of 5');
    expect(html).not.toContain('Leave');
  });

  it('offers Try again and Leave once every attempt failed', () => {
    ui.setState({ connection: { status: 'lost', maxAttempts: 5 } });
    const html = renderToStaticMarkup(<ConnectionLayer />);
    expect(html).toContain('Connection lost');
    expect(html).toContain('data-testid="connection-retry"');
    expect(html).toContain('data-testid="connection-leave"');
    expect(html).toContain('Tried 5 times');
  });
});

describe('knocked out', () => {
  it('the in-round sheet offers Keep watching (with its auto countdown) and Leave show', () => {
    ui.setState({ eliminatedSheet: true, watchChoice: { autoAt: Date.now() + 5000, remaining: 12 } });
    const html = renderToStaticMarkup(<EliminatedSheet />);
    expect(html).toContain('Keep watching');
    expect(html).toContain('Leave show');
    expect(html).toContain('(5)');
    expect(html).toContain('12 still in the show');
    expect(html).not.toContain('Play again');
  });

  it('the results-wall card appears off the round screen only', () => {
    ui.setState({ watchChoice: { autoAt: null }, screen: 'roundResults' });
    expect(renderToStaticMarkup(<WatchChoiceLayer />)).toContain('data-testid="watch-choice"');
    ui.setState({ screen: 'round' });
    expect(renderToStaticMarkup(<WatchChoiceLayer />)).toBe('');
  });

  it('rewards copy matches the mode', () => {
    expect(watchChoiceRewardsNote(false)).toContain('the rounds you played still count');
    expect(watchChoiceRewardsNote(true)).toContain('once the show ends');
  });
});

describe('leave show copy', () => {
  it('offline banks played rounds at once', () => {
    expect(leaveShowBody({ online: false, outOfShow: false })).toContain('saved now');
  });

  it('online grants them when the server reports the show', () => {
    expect(leaveShowBody({ online: true, outOfShow: true })).toContain('when the show finishes');
  });

  it('the in-game menu says Eliminated · Spectating once out of the show', () => {
    ui.setState({
      showSeat: { online: false, outOfShow: true },
      roundIntro: {
        roundId: 'gumdrop-gauntlet',
        name: 'Gumdrop Gauntlet',
        type: 'race',
        theme: 'candy',
        objective: 'Reach the finish',
        rules: [],
        tips: [],
        roundIndex: 1,
        roundCount: 4,
        isFinal: false,
        playerCount: 20,
        qualifyTarget: 12,
      },
    });
    const html = renderToStaticMarkup(<InGameMenu />);
    expect(html).toContain('Eliminated · Spectating');
  });
});

describe('bot tags', () => {
  it('marks bots (not humans) on round results', () => {
    ui.setState({
      results: {
        roundName: 'Gumdrop Gauntlet',
        roundType: 'race',
        roundIndex: 0,
        render3D: false,
        entries: [
          { player: { id: 1, name: 'Bolt', colors, isBot: true }, qualified: true, place: 1 },
          { player: { id: 2, name: 'Human', colors, isBot: false }, qualified: false, place: 0 },
        ],
      },
    });
    const html = renderToStaticMarkup(<RoundResultsScreen />);
    expect(html.match(/tr-bot-tag/g)).toHaveLength(1);
  });

  it('marks bots in the final lineup', () => {
    ui.setState({
      finalHype: {
        roundName: 'Crown Climb',
        finalists: [
          { id: 1, name: 'Bolt', colors, isBot: true },
          { id: 2, name: 'Human', colors, isBot: false },
        ],
      },
    });
    expect(renderToStaticMarkup(<FinalHypeScreen />).match(/>BOT</g)).toHaveLength(1);
  });
});

describe('Play Online tile', () => {
  it('shows only counts the servers report', () => {
    expect(onlineTileSub({ state: 'online', playersOnline: 1234, inQueue: 7 })).toBe(
      '1,234 online · 7 in queue',
    );
    expect(onlineTileSub({ state: 'online', inQueue: 3 })).toBe('3 in queue');
    expect(onlineTileSub({ state: 'online' })).toBe('Real players + bot fill');
    expect(onlineTileSub({ state: 'offline' })).toBe('Servers offline');
    expect(onlineTileSub({ state: 'checking' })).toBe('Checking servers…');
  });
});

describe('spectate banner', () => {
  it('shows who you watch, a BOT tag, the count still in and rebind-aware hints', () => {
    ui.setState({
      showSeat: { online: false, outOfShow: true },
      spectate: {
        player: { id: 4, name: 'Gizmo', colors, isBot: true },
        detail: 'In the lead',
        qualified: false,
        index: 0,
        count: 9,
        remaining: 14,
      },
    });
    const html = renderToStaticMarkup(<SpectateBanner />);
    expect(html).toContain('Gizmo');
    expect(html).toContain('BOT');
    expect(html).toContain('14 still in');
    expect(html).toContain('Eliminated · Spectating');
    expect(html).toContain('>Q<');
  });

  it('hides the BOT tag when Show bot tags is off', () => {
    ui.setState({
      settings: { ...DEFAULT_SETTINGS, gameplay: { ...DEFAULT_SETTINGS.gameplay, botTags: false } },
      spectate: {
        player: { id: 4, name: 'Gizmo', colors, isBot: true },
        detail: 'In the lead',
        qualified: false,
        index: 0,
        count: 9,
      },
    });
    expect(renderToStaticMarkup(<SpectateBanner />)).not.toContain('BOT');
  });
});
