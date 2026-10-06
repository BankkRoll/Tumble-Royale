/**
 * "How you went out" and the highlight reel in the UI: the replay layer's
 * states (loading with the cause, playing with slow motion, the Reduce
 * Motion still), the watch choice waiting behind it, the reel on the rewards
 * screen (hidden while replays are off, empty, full, Streamer Mode names,
 * Share only where a clip can be made), the share sheet opening on a
 * highlight's window, and the default setting.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EliminatedSheet } from '../src/hud/widgets.tsx';
import { ElimReplayLayer } from '../src/screens/ElimReplay.tsx';
import { HighlightsReel } from '../src/screens/Highlights.tsx';
import { initialClipWindow } from '../src/screens/overlays/ShareSheet.tsx';
import { WatchChoiceLayer } from '../src/screens/overlays/WatchChoice.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { highlightPlace, highlightTitle } from '../src/store/highlights.ts';
import { menuOwnsInput, watchChoiceVisible } from '../src/store/inputOwnership.ts';
import { shareUI, type ShareOffer } from '../src/store/share.ts';
import type { HighlightEntry, HighlightPlayer } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(shareUI as unknown as { getInitialState: () => unknown }).getInitialState = shareUI.getState;

const ME: HighlightPlayer = { id: 0, name: 'Sprinkles', isBot: false, isLocal: true };
const HUMAN: HighlightPlayer = { id: 4, name: 'xXRealNameXx', isBot: false, isLocal: false };
const BOT: HighlightPlayer = { id: 7, name: 'Jellybot', isBot: true, isLocal: false };

function hl(over: Partial<HighlightEntry>): HighlightEntry {
  return {
    id: 'k:closeFinish:3000:4',
    key: '1:0',
    roundIndex: 0,
    roundName: 'Gumdrop Gauntlet',
    isFinal: false,
    kind: 'closeFinish',
    start: 27,
    length: 4,
    player: HUMAN,
    other: ME,
    value: 0.12,
    ...over,
  };
}

function offer(over: Partial<ShareOffer> = {}): ShareOffer {
  return {
    card: false,
    headline: 'Out in round 2',
    playerName: 'Sprinkles',
    clips: [
      {
        key: '1:0',
        roundIndex: 0,
        name: 'Gumdrop Gauntlet',
        isFinal: false,
        outcome: 'qualified',
        duration: 64,
        defaultStart: 37.5,
        defaultLength: 10,
      },
    ],
    defaultClipKey: '1:0',
    clipSupport: 'webcodecs',
    clipQuality: '720p',
    ...over,
  };
}

function flags(replays: boolean): void {
  const s = ui.getState();
  ui.setState({ liveOps: { ...s.liveOps, flags: { ...s.liveOps.flags, 'replays.enabled': replays } } });
}

function streamer(on: boolean): void {
  const s = ui.getState().settings;
  ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, streamerMode: on } } });
}

function recorded(n: number): void {
  ui.getState().setReplays(
    Array.from({ length: n }, (_, i) => ({
      key: `1:${i}`,
      roundIndex: i,
      name: `Round ${i + 1}`,
      type: 'race' as const,
      isFinal: false,
      outcome: 'qualified' as const,
      duration: 60,
    })),
  );
}

afterEach(() => {
  ui.getState().setElimReplay(null);
  ui.getState().setHighlights([]);
  ui.getState().setReplays([]);
  ui.getState().setWatchChoice(null);
  ui.getState().setEliminatedSheet(false);
  shareUI.getState().setOffer(null);
  shareUI.getState().closeSheet();
  flags(true);
  streamer(false);
});

describe('elimination replay layer', () => {
  it('renders nothing while no replay is showing', () => {
    expect(renderToStaticMarkup(<ElimReplayLayer />)).toBe('');
  });

  it('shows the cause at once while the replay loads', () => {
    ui.getState().setElimReplay({ mode: 'loading', cause: 'Grabbed by Tumbler 5', progress: 0, slow: false });
    const html = renderToStaticMarkup(<ElimReplayLayer />);
    expect(html).toContain('data-mode="loading"');
    expect(html).toContain('Grabbed by Tumbler 5');
    expect(html).toContain('Loading replay');
    expect(html).toContain('aria-live="polite"');
  });

  it('playing: title, progress, slow-motion tag, skip hint and button', () => {
    ui.getState().setElimReplay({
      mode: 'playing',
      cause: 'Knocked off by a sweeper',
      progress: 0.5,
      slow: true,
    });
    const html = renderToStaticMarkup(<ElimReplayLayer />);
    expect(html).toContain('How you went out');
    expect(html).toContain('Slow-mo');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('Press any key to skip');
    expect(html).toContain('data-testid="elim-replay-skip"');
  });

  it('Reduce Motion still: no slow-motion tag, labelled as a still', () => {
    ui.getState().setElimReplay({ mode: 'still', cause: 'Fell off the course', progress: 0.2, slow: true });
    const html = renderToStaticMarkup(<ElimReplayLayer />);
    expect(html).toContain('Replay still');
    expect(html).not.toContain('Slow-mo');
  });

  it('the watch choice waits behind it, and menus do not take the input meanwhile', () => {
    const choice = { autoAt: null, remaining: 12 };
    ui.getState().setWatchChoice(choice);
    ui.getState().setEliminatedSheet(true);
    ui.setState({ screen: 'roundResults' });
    expect(renderToStaticMarkup(<WatchChoiceLayer />)).toContain('watch-choice');
    ui.getState().setElimReplay({ mode: 'playing', cause: 'x', progress: 0, slow: false });
    expect(renderToStaticMarkup(<WatchChoiceLayer />)).toBe('');
    ui.setState({ screen: 'round' });
    expect(renderToStaticMarkup(<EliminatedSheet />)).toBe('');
    const s = ui.getState();
    expect(watchChoiceVisible(s)).toBe(false);
    expect(menuOwnsInput({ ...s, inputMode: 'game' })).toBe(false);
    ui.getState().setElimReplay(null);
    expect(renderToStaticMarkup(<EliminatedSheet />)).toContain('watch-choice');
    expect(watchChoiceVisible(ui.getState())).toBe(true);
  });

  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.gameplay.eliminationReplay).toBe(true);
  });
});

describe('highlight words', () => {
  it('one line per kind, "you" for the local player', () => {
    expect(highlightTitle(hl({ kind: 'finalWin', player: ME, other: null }), false)).toBe(
      'You won the Crown!',
    );
    expect(highlightTitle(hl({}), false)).toBe('Photo finish: xXRealNameXx edged you by 0.12 s');
    expect(highlightTitle(hl({ kind: 'lastSecondQualify', player: BOT, value: 1.26 }), false)).toBe(
      'Jellybot qualified with 1.3 s left',
    );
    expect(highlightTitle(hl({ kind: 'lastSecondQualify', player: ME, value: 0 }), false)).toBe(
      'You took the last spot',
    );
    expect(highlightTitle(hl({ kind: 'bigFall', player: ME }), false)).toBe('Big fall for you');
    expect(highlightTitle(hl({ kind: 'chainGrab', player: BOT, value: 4 }), false)).toBe(
      '4-Tumbler grab chain started by Jellybot',
    );
    expect(highlightTitle(hl({ kind: 'comeback', player: ME, value: 3 }), false)).toBe(
      'You came back from 3 setbacks to qualify',
    );
    expect(highlightTitle(hl({ kind: 'clutchSurvival', player: BOT, value: 0 }), false)).toBe(
      'Jellybot saved it with a ledge grab',
    );
    expect(highlightTitle(hl({ kind: 'decisiveScore', player: BOT, value: 15 }), false)).toBe(
      'Jellybot scored the decider (15)',
    );
    expect(highlightPlace(hl({ isFinal: true, roundName: 'Crown Climb' }))).toBe('Final · Crown Climb');
  });

  it('Streamer Mode masks other real players, never you or bots', () => {
    const line = highlightTitle(hl({}), true);
    expect(line).toBe('Photo finish: Tumbler 5 edged you by 0.12 s');
    expect(line).not.toContain('xXRealNameXx');
    expect(highlightTitle(hl({ kind: 'bigFall', player: BOT }), true)).toBe('Big fall for Jellybot');
  });
});

describe('highlight reel', () => {
  beforeEach(() => {
    flags(true);
    shareUI.getState().setOffer(offer());
  });

  it('is hidden while replays are off, and when nothing was recorded', () => {
    recorded(2);
    ui.getState().setHighlights([hl({})]);
    flags(false);
    expect(renderToStaticMarkup(<HighlightsReel />)).toBe('');
    flags(true);
    recorded(0);
    ui.getState().setHighlights([]);
    expect(renderToStaticMarkup(<HighlightsReel />)).toBe('');
  });

  it('empty: says so when rounds were recorded but nothing stood out', () => {
    recorded(2);
    const html = renderToStaticMarkup(<HighlightsReel />);
    expect(html).toContain('data-testid="highlights-empty"');
    expect(html).not.toContain('highlights-play-all');
  });

  it('full: every highlight with Watch, Share where a clip can be made, and Play all', () => {
    recorded(2);
    ui.getState().setHighlights([
      hl({ id: 'a', kind: 'finalWin', player: ME, other: null, isFinal: true, key: '1:0' }),
      hl({ id: 'b', key: '1:9' }),
    ]);
    const html = renderToStaticMarkup(<HighlightsReel />);
    expect(html.match(/data-testid="highlight"/g)).toHaveLength(2);
    expect(html.match(/data-testid="highlight-watch"/g)).toHaveLength(2);
    // '1:9' is not in the share offer, so only the first can be clipped.
    expect(html.match(/data-testid="highlight-share"/g)).toHaveLength(1);
    expect(html).toContain('highlights-play-all');
    expect(html).toContain('You won the Crown!');
    shareUI.getState().setOffer(offer({ clipSupport: 'none' }));
    expect(renderToStaticMarkup(<HighlightsReel />)).not.toContain('highlight-share');
  });

  it('follows Streamer Mode', () => {
    recorded(1);
    ui.getState().setHighlights([hl({})]);
    streamer(true);
    const html = renderToStaticMarkup(<HighlightsReel />);
    expect(html).toContain('Tumbler 5');
    expect(html).not.toContain('xXRealNameXx');
  });
});

describe('sharing a highlight', () => {
  it('opens the clip tab on the highlight, centred in the nearest clip length', () => {
    shareUI.getState().setOffer(offer());
    shareUI.getState().openSheet('card', { key: '1:0', start: 27, length: 4 });
    const sheet = shareUI.getState().sheet;
    expect(sheet.tab).toBe('clip');
    expect(initialClipWindow(offer(), sheet.prefill)).toEqual({ key: '1:0', length: 5, start: 26.5 });
  });

  it('without a prefill (or for a round no longer offered) starts on the default round', () => {
    expect(initialClipWindow(offer(), null)).toEqual({ key: '1:0', length: 10, start: 37.5 });
    expect(initialClipWindow(offer(), { key: 'gone', start: 3, length: 4 })).toEqual({
      key: '1:0',
      length: 10,
      start: 37.5,
    });
  });
});
