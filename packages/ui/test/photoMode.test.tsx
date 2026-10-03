import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { InGameMenu } from '../src/screens/overlays/InGameMenu.tsx';
import { DEFAULT_HUD } from '../src/store/defaults.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

describe('photo mode UI', () => {
  afterEach(() => {
    ui.getState().setPhoto({ active: false });
    ui.setState({ hud: DEFAULT_HUD });
  });

  it('hides the rest of the UI and shows only the photo bar', () => {
    ui.getState().setPhoto({ active: true, fov: 62, filter: 'mono' });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('data-photo="true"');
    expect(html).toContain('data-testid="photo-mode"');
    expect(html).toContain('62°');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Mono/);
    expect(html).toContain('Take photo');
  });

  it('is offered in the round menu only while out of play', () => {
    ui.setState({ hud: { ...DEFAULT_HUD, localStatus: 'playing' } });
    expect(renderToStaticMarkup(<InGameMenu />)).not.toContain('igm-photo');
    ui.setState({ hud: { ...DEFAULT_HUD, localStatus: 'eliminated' } });
    expect(renderToStaticMarkup(<InGameMenu />)).toContain('igm-photo');
  });
});
