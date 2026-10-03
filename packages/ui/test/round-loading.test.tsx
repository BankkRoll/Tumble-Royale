/**
 * Round loading screen states, server-rendered from the store: own build
 * progress, waiting for other players (with Streamer Mode masking names) and
 * the "Everyone's in!" beat.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoundLoadingScreen } from '../src/screens/ShowFlow.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import type { ShowPlayer } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };
const player = (id: number, name: string, isBot = false): ShowPlayer => ({ id, name, colors, isBot });

/** Rendered text without tags, entities decoded. */
function text(): string {
  return renderToStaticMarkup(<RoundLoadingScreen />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('RoundLoadingScreen', () => {
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

  it('shows real build progress while this machine loads', () => {
    ui.getState().setRoundLoading({ progress: 0.42 });
    const html = renderToStaticMarkup(<RoundLoadingScreen />);
    expect(text()).toContain('Loading Tilt Town…');
    expect(text()).toContain('42%');
    expect(html).toContain('scaleX(0.42)');
    expect(html).toContain('aria-valuenow="42"');
    // Every tip is in the DOM; WAAPI cross-fades them without React.
    expect(text()).toContain('Grab the edge to pull yourself up.');
  });

  it('lists who the round is waiting on once this machine is ready', () => {
    ui.getState().setRoundLoading({
      progress: 1,
      ready: true,
      loaded: 24,
      total: 26,
      waiting: [player(3, 'SlowPoke'), player(17, 'Dial-Up Dan')],
    });
    const t = text();
    expect(t).toContain('Waiting for 2 players…');
    expect(t).toContain('24 / 26 ready');
    expect(t).toContain('SlowPoke');
    expect(t).toContain('Dial-Up Dan');
    expect(t).not.toContain('%');
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
});
