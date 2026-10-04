/**
 * Announcer captions (Accessibility → Captions) show on every screen the
 * announcer talks over, not only in the round HUD.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { Hud } from '../src/hud/Hud.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import type { ScreenId } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

function captions(on: boolean): void {
  const s = ui.getState().settings;
  ui.setState({ settings: { ...s, accessibility: { ...s.accessibility, captions: on } } });
}

afterEach(() => ui.setState({ settings: DEFAULT_SETTINGS, caption: null, screen: 'boot' }));

describe('caption layer', () => {
  it.each<ScreenId>(['showIntro', 'roundIntro', 'round', 'roundResults', 'victory', 'playerWall'])(
    'shows the caption once on %s',
    (screen) => {
      captions(true);
      ui.setState({ screen, caption: 'And they are off!' });
      const html = renderToStaticMarkup(<App />);
      expect(html.split('And they are off!').length - 1).toBe(1);
    },
  );

  it('stays hidden with captions off', () => {
    captions(false);
    ui.setState({ screen: 'victory', caption: 'And they are off!' });
    expect(renderToStaticMarkup(<App />)).not.toContain('And they are off!');
  });

  it('is not duplicated by the round HUD', () => {
    captions(true);
    ui.setState({ screen: 'round', caption: 'And they are off!' });
    expect(renderToStaticMarkup(<Hud />)).not.toContain('And they are off!');
  });
});
