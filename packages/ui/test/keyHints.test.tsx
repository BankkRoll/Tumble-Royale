/**
 * Every control hint follows the live keyboard and controller bindings and
 * the last-used device instead of hard-coded keys.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { controlGlyph, emoteGlyph, movementGlyph, padGlyph } from '../src/hud/glyphs.ts';
import { ControlsHint, GrabStatus } from '../src/hud/widgets.tsx';
import { InGameMenu } from '../src/screens/overlays/InGameMenu.tsx';
import { PreShowHint } from '../src/screens/PreShowHint.tsx';
import { DEFAULT_HUD, DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { PAD_INDEX as P } from '../src/store/padBinds.ts';
import type { HudState, Keybinds, PadBinds } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const AZERTY: Keybinds = {
  ...DEFAULT_KEYBINDS,
  moveForward: ['KeyZ', ''],
  moveLeft: ['KeyQ', ''],
  jump: ['KeyJ', ''],
  emote1: ['KeyU', ''],
  emote2: ['KeyI', ''],
  emote3: ['KeyO', ''],
  emote4: ['KeyP', ''],
};
const SOUTHPAW: PadBinds = {
  ...DEFAULT_PAD_BINDS,
  jump: [P.B, -1],
  dive: [P.X, -1],
  grab: [P.LT, -1],
  pause: [P.Back, -1],
  emote1: [P.LS, -1],
};

function setup(device: HudState['device'], keybinds = DEFAULT_KEYBINDS, padBinds = DEFAULT_PAD_BINDS): void {
  ui.setState({
    hud: { ...DEFAULT_HUD, controlsHint: true, device },
    settings: { ...DEFAULT_SETTINGS, controls: { ...DEFAULT_SETTINGS.controls, keybinds, padBinds } },
  });
}

describe('glyph helpers', () => {
  it('pad glyphs follow remapping', () => {
    expect(controlGlyph('jump', 'gamepad', DEFAULT_KEYBINDS, SOUTHPAW)).toBe('Ⓑ');
    expect(controlGlyph('grab', 'gamepad', DEFAULT_KEYBINDS, SOUTHPAW)).toBe('LT');
    expect(controlGlyph('moveForward', 'gamepad', DEFAULT_KEYBINDS, SOUTHPAW)).toBe('Ⓛ');
    expect(padGlyph('pause', SOUTHPAW)).toBe('View');
    expect(padGlyph('dive', { ...DEFAULT_PAD_BINDS, dive: [-1, P.RS] })).toBe('R3');
  });

  it('movement reads the bound keys', () => {
    expect(movementGlyph('keyboard', DEFAULT_KEYBINDS)).toBe('WASD');
    expect(movementGlyph('keyboard', AZERTY)).toBe('ZQSD');
    const arrows: Keybinds = {
      ...DEFAULT_KEYBINDS,
      moveForward: ['ArrowUp', ''],
      moveLeft: ['ArrowLeft', ''],
      moveBack: ['ArrowDown', ''],
      moveRight: ['ArrowRight', ''],
    };
    expect(movementGlyph('keyboard', arrows)).toBe('↑ ← ↓ →');
    expect(movementGlyph('gamepad', AZERTY)).toBe('Ⓛ');
    expect(movementGlyph('touch', AZERTY)).toBe('');
  });

  it('emotes collapse to 1–4 and D-pad only on the defaults', () => {
    expect(emoteGlyph('keyboard', DEFAULT_KEYBINDS)).toBe('1–4');
    expect(emoteGlyph('keyboard', AZERTY)).toBe('U/I/O/P');
    expect(emoteGlyph('gamepad', DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS)).toBe('D-pad');
    expect(emoteGlyph('gamepad', DEFAULT_KEYBINDS, SOUTHPAW)).toBe('L3/D-pad right/D-pad down/D-pad left');
  });
});

describe('hints on screen', () => {
  afterEach(() => ui.setState({ hud: DEFAULT_HUD, settings: DEFAULT_SETTINGS }));

  it('controls hint shows rebound keys and remapped buttons', () => {
    setup('keyboard', AZERTY);
    const kb = renderToStaticMarkup(<ControlsHint />);
    expect(kb).toContain('<kbd>ZQSD</kbd>Move');
    expect(kb).toContain('<kbd>J</kbd>Jump');
    setup('gamepad', AZERTY, SOUTHPAW);
    const pad = renderToStaticMarkup(<ControlsHint />);
    expect(pad).toContain('<kbd>Ⓑ</kbd>Jump');
    expect(pad).toContain('<kbd>LT</kbd>Grab');
  });

  it('pre-show hint follows bindings and device', () => {
    setup('keyboard');
    expect(renderToStaticMarkup(<PreShowHint />)).toContain(
      '<kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>1–4</kbd> emote',
    );
    setup('keyboard', AZERTY);
    const az = renderToStaticMarkup(<PreShowHint />);
    expect(az).toContain('<kbd>ZQSD</kbd> move');
    expect(az).toContain('<kbd>J</kbd> jump');
    expect(az).toContain('<kbd>U/I/O/P</kbd> emote');
    setup('gamepad', DEFAULT_KEYBINDS, SOUTHPAW);
    expect(renderToStaticMarkup(<PreShowHint />)).toContain('<kbd>Ⓑ</kbd> jump');
    setup('touch');
    const touch = renderToStaticMarkup(<PreShowHint />);
    expect(touch).toContain('Joystick');
    expect(touch).not.toContain('<kbd>');
  });

  it('in-game menu lists the remapped Menu button on a pad', () => {
    setup('gamepad', DEFAULT_KEYBINDS, SOUTHPAW);
    expect(renderToStaticMarkup(<InGameMenu />)).toMatch(/data-testid="igm-menu-key"><kbd>View<\/kbd>Menu/);
  });

  it('grab mash prompt names the bound jump', () => {
    setup('keyboard', AZERTY);
    ui.setState({ hud: { ...ui.getState().hud, grab: { mode: 'held', name: 'Bo', meter: 0.5 } } });
    expect(renderToStaticMarkup(<GrabStatus />)).toContain('Mash J to break free');
    setup('gamepad', DEFAULT_KEYBINDS, SOUTHPAW);
    ui.setState({ hud: { ...ui.getState().hud, grab: { mode: 'held', name: 'Bo', meter: 0.5 } } });
    expect(renderToStaticMarkup(<GrabStatus />)).toContain('Mash Ⓑ to break free');
  });
});
