/**
 * The Menu key is rebindable; the in-round menu and the camera-lock hint must
 * show the bound key rather than a hard-coded Esc.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CameraLockHint } from '../src/hud/widgets.tsx';
import { InGameMenu } from '../src/screens/overlays/InGameMenu.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

function bindMenu(code: string): void {
  const s = ui.getState().settings;
  ui.setState({
    settings: {
      ...s,
      controls: { ...s.controls, keybinds: { ...s.controls.keybinds, pause: [code, ''] } },
    },
  });
}

describe('menu key labels', () => {
  afterEach(() => ui.setState({ settings: DEFAULT_SETTINGS }));

  it('in-game menu lists the bound Menu key', () => {
    bindMenu('KeyP');
    const html = renderToStaticMarkup(<InGameMenu />);
    expect(html).toMatch(/data-testid="igm-menu-key"><kbd>P<\/kbd>Menu/);
  });

  it('camera-lock hint names the bound Menu key while the mouse is locked', () => {
    bindMenu('KeyP');
    ui.setState({ cameraLock: 'locked', hud: { ...ui.getState().hud, device: 'keyboard' } });
    const html = renderToStaticMarkup(<CameraLockHint />);
    expect(html).toContain('<kbd>P</kbd> menu');
    expect(html).toContain('<kbd>Esc</kbd> frees the mouse');
  });
});
