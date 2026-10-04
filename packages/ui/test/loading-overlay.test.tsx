/**
 * The loading overlay on the held Tumble Wipe, server-rendered from the
 * store: round card and real build progress, waiting for other players
 * (with Streamer Mode masking names), the "Everyone's in!" beat, the
 * tutorial's progress-less load, and the Reduce Motion screen fallback.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { uiEvents } from '../src/store/events.ts';
import type { ShowPlayer } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';
import { LoadingCoverScreen, LoadingOverlay } from '../src/transitions/LoadingOverlay.tsx';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };
const player = (id: number, name: string, isBot = false): ShowPlayer => ({ id, name, colors, isBot });

/** Rendered text without tags, entities decoded. */
function text(html = renderToStaticMarkup(<LoadingOverlay />)): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('LoadingOverlay', () => {
  beforeEach(() => {
    const s = ui.getState();
    s.setSettings(DEFAULT_SETTINGS);
    s.setRoundIntro({
      roundId: 'tilt-town',
      name: 'Tilt Town',
      type: 'race',
      theme: 'candy',
      objective: 'Reach the finish line!',
      rules: [],
      tips: ['Dive mid-jump to cover more ground!', 'Grab the edge to pull yourself up.'],
      roundIndex: 1,
      roundCount: 4,
      isFinal: false,
      playerCount: 26,
      qualifyTarget: 17,
    });
    s.setRoundLoading(null);
  });

  it('shows the round card and real build progress while this machine loads', () => {
    ui.getState().setRoundLoading({ progress: 0.42 });
    const html = renderToStaticMarkup(<LoadingOverlay />);
    const t = text(html);
    expect(t).toContain('Tilt Town');
    expect(t).toContain('Reach the finish line!');
    expect(html).toContain('tr-type-badge');
    expect(html).toContain('scaleX(0.42)');
    expect(html).toContain('aria-valuenow="42"');
    // Every tip is in the DOM; WAAPI cross-fades them without React.
    expect(t).toContain('Dive mid-jump to cover more ground!');
    expect(t).toContain('Grab the edge to pull yourself up.');
    expect(t).not.toContain('Waiting for');
  });

  it('fills the bar and names who the round is waiting on once this machine is ready', () => {
    ui.getState().setRoundLoading({
      progress: 0.97,
      ready: true,
      loaded: 24,
      total: 26,
      waiting: [player(3, 'SlowPoke'), player(17, 'Dial-Up Dan')],
    });
    const html = renderToStaticMarkup(<LoadingOverlay />);
    const t = text(html);
    expect(html).toContain('scaleX(1)');
    expect(t).toContain('Waiting for 2 players…');
    expect(t).toContain('SlowPoke');
    expect(t).toContain('Dial-Up Dan');
  });

  it('says nothing about others when this machine is ready and nobody else loads (offline)', () => {
    ui.getState().setRoundLoading({ progress: 1, ready: true });
    expect(text()).not.toContain('Waiting for');
  });

  it('masks other players in Streamer Mode', () => {
    const s = ui.getState();
    s.setSettings({ ...DEFAULT_SETTINGS, gameplay: { ...DEFAULT_SETTINGS.gameplay, streamerMode: true } });
    s.setRoundLoading({
      ready: true,
      loaded: 1,
      total: 3,
      waiting: [player(3, 'SlowPoke'), player(9, 'Gummy B', true)],
    });
    const t = text();
    expect(t).toContain('Waiting for 2 players…');
    expect(t).not.toContain('SlowPoke');
    expect(t).toContain('Tumbler 4');
    // Bot names are generated, not personal: they stay.
    expect(t).toContain('Gummy B');
  });

  it('counts past the eight named players from the roster totals', () => {
    ui.getState().setRoundLoading({
      ready: true,
      loaded: 20,
      total: 32,
      waiting: Array.from({ length: 8 }, (_, i) => player(i, `P${i}`)),
    });
    expect(text()).toContain('Waiting for 12 players…');
  });

  it("plays the Everyone's in! beat", () => {
    ui.getState().setRoundLoading({ ready: true, loaded: 26, total: 26, everyoneIn: true });
    const t = text();
    expect(t).toContain("Everyone's in!");
    expect(t).not.toContain('Waiting for');
  });

  it('shows an indeterminate bar when the load reports no progress (tutorial)', () => {
    const html = renderToStaticMarkup(<LoadingOverlay />);
    expect(html).toContain('is-indeterminate');
    expect(html).not.toContain('aria-valuenow');
  });

  it('fades out while the wipe reveals the round', () => {
    expect(renderToStaticMarkup(<LoadingOverlay leaving />)).toContain('tr-loadcover is-leaving');
  });
});

describe('LoadingCoverScreen', () => {
  it('leaves the overlay to the wipe while it holds, and shows it itself when there is no wipe', () => {
    const s = ui.getState();
    s.setRoundLoading({ progress: 0.5 });
    ui.setState({ wipe: { phase: 'covered', target: null, hold: true, seq: 1 } });
    expect(renderToStaticMarkup(<LoadingCoverScreen />)).not.toContain('tr-loadcover-card');
    ui.setState({ wipe: { phase: 'idle', target: null, hold: false, seq: 1 } });
    expect(renderToStaticMarkup(<LoadingCoverScreen />)).toContain('tr-loadcover-card');
  });
});

describe('setScreen under a held wipe', () => {
  it('lets swaps waiting for the cover run before it reveals', () => {
    ui.setState({ wipe: { phase: 'covered', target: null, hold: true, seq: 2 } });
    const covered: string[] = [];
    const off = uiEvents.on('transitionCovered', ({ to }) => covered.push(to));
    ui.getState().setScreen('menu', { transition: 'wipe' });
    off();
    expect(covered).toEqual(['menu']);
    expect(ui.getState().screen).toBe('menu');
    expect(ui.getState().wipe.phase).toBe('revealing');
  });
});
