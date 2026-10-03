import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { controlGlyph } from '../src/hud/glyphs.ts';
import { ControlsHint } from '../src/hud/widgets.tsx';
import { DEFAULT_HUD, DEFAULT_KEYBINDS } from '../src/store/defaults.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

describe('control glyphs', () => {
  afterEach(() => ui.setState({ hud: DEFAULT_HUD }));

  it('follows the last-used device', () => {
    expect(controlGlyph('jump', 'gamepad', DEFAULT_KEYBINDS)).toBe('Ⓐ');
    expect(controlGlyph('pause', 'gamepad', DEFAULT_KEYBINDS)).toBe('Start');
    expect(controlGlyph('jump', 'keyboard', DEFAULT_KEYBINDS)).toBe('Space');
    expect(controlGlyph('jump', 'touch', DEFAULT_KEYBINDS)).toBe('');
  });

  it('uses the secondary key when the primary is unbound', () => {
    expect(controlGlyph('jump', 'keyboard', { ...DEFAULT_KEYBINDS, jump: ['', 'KeyJ'] })).toBe('J');
  });

  it('switches the HUD hint to pad buttons once a controller is used', () => {
    ui.setState({ hud: { ...DEFAULT_HUD, controlsHint: true, device: 'gamepad' } });
    const pad = renderToStaticMarkup(<ControlsHint />);
    expect(pad).toContain('<kbd>Ⓐ</kbd>Jump');
    expect(pad).toContain('<kbd>RT</kbd>Grab');
    ui.setState({ hud: { ...DEFAULT_HUD, controlsHint: true, device: 'keyboard' } });
    expect(renderToStaticMarkup(<ControlsHint />)).toContain('<kbd>Space</kbd>Jump');
  });
});
