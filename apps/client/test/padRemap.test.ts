import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAD_BINDS, type PadBinds } from '@tumble/ui';
import { Button, type CharacterInput } from '@tumble/sim/character';
import { padMenuButtons, padSpectateButtons, padmapFromPadBinds } from '../src/game/bindings.ts';
import { GamepadNavigator, PAD_BUTTON } from '../src/input/gamepadNav.ts';
import { InputSystem } from '../src/input/inputSystem.ts';
import { DEFAULT_PADMAP } from '../src/input/padmap.ts';
import { fakePad, installFakeDom, setButton, type FakeDom, type FakePad } from './fakeDom.ts';

const blank = (): CharacterInput => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 });

describe('padmapFromPadBinds', () => {
  it('maps the default controller layout to the input defaults', () => {
    expect(padmapFromPadBinds(DEFAULT_PAD_BINDS)).toEqual(DEFAULT_PADMAP);
  });

  it('drops empty slots, duplicates and junk from saved settings', () => {
    const saved = {
      ...DEFAULT_PAD_BINDS,
      jump: [PAD_BUTTON.B, PAD_BUTTON.B],
      dive: [-1, 99],
      grab: 'nope',
    } as unknown as PadBinds;
    const map = padmapFromPadBinds(saved);
    expect(map.jump).toEqual([PAD_BUTTON.B]);
    expect(map.dive).toEqual([]);
    expect(map.grab).toEqual(DEFAULT_PADMAP.grab);
    expect(padmapFromPadBinds(undefined)).toEqual(DEFAULT_PADMAP);
  });

  it('reads the menu and spectate buttons', () => {
    expect(padMenuButtons(DEFAULT_PAD_BINDS)).toEqual([PAD_BUTTON.Start]);
    expect(padSpectateButtons({ ...DEFAULT_PAD_BINDS, spectateNext: [PAD_BUTTON.RS, -1] })).toEqual({
      prev: [PAD_BUTTON.LB],
      next: [PAD_BUTTON.RS],
    });
  });
});

describe('InputSystem pad mapping', () => {
  let dom: FakeDom;
  let input: InputSystem;
  let pad: FakePad;
  const buttons = (): number => input.sample(0, blank()).buttons;

  beforeEach(() => {
    dom = installFakeDom();
    pad = fakePad();
    dom.pads.push(pad);
    input = new InputSystem({ element: dom.element, settings: { pointerLock: false } });
  });
  afterEach(() => {
    input.dispose();
    vi.unstubAllGlobals();
  });

  it('applies a remap live', () => {
    expect(
      input.setPadMap(
        padmapFromPadBinds({ ...DEFAULT_PAD_BINDS, jump: [PAD_BUTTON.B, -1], dive: [PAD_BUTTON.X, -1] }),
      ),
    ).toBe(true);
    setButton(pad, PAD_BUTTON.B, true);
    expect(buttons() & Button.Jump).toBeTruthy();
    expect(buttons() & Button.Dive).toBeFalsy();
    setButton(pad, PAD_BUTTON.B, false);
    buttons();
    setButton(pad, PAD_BUTTON.A, true);
    expect(buttons() & Button.Jump).toBeFalsy();
  });

  it('back to defaults restores A as jump', () => {
    input.setPadMap(padmapFromPadBinds({ ...DEFAULT_PAD_BINDS, jump: [PAD_BUTTON.LS, -1] }));
    input.setPadMap(padmapFromPadBinds(DEFAULT_PAD_BINDS));
    setButton(pad, PAD_BUTTON.A, true);
    expect(buttons() & Button.Jump).toBeTruthy();
  });

  it('a button held through a remap does not fire its new action until pressed again', () => {
    setButton(pad, PAD_BUTTON.Y, true);
    buttons();
    input.setPadMap({ ...DEFAULT_PADMAP, jump: [PAD_BUTTON.Y], emoteWheel: [] });
    expect(buttons() & Button.Jump).toBeFalsy();
    setButton(pad, PAD_BUTTON.Y, false);
    buttons();
    setButton(pad, PAD_BUTTON.Y, true);
    expect(buttons() & Button.Jump).toBeTruthy();
  });

  it('remapped emotes fire on the press edge', () => {
    input.setPadMap({ ...DEFAULT_PADMAP, emote1: [PAD_BUTTON.LS] });
    setButton(pad, PAD_BUTTON.LS, true);
    expect(input.sample(0, blank()).emote).toBe(1);
    expect(input.sample(0, blank()).emote).toBe(0);
  });

  it('unchanged maps are a no-op', () => {
    expect(input.setPadMap(DEFAULT_PADMAP)).toBe(false);
  });
});

describe('GamepadNavigator menu button', () => {
  it('opens the menu from the remapped button only', () => {
    const nav = new GamepadNavigator();
    nav.setStartButtons([PAD_BUTTON.Back]);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.Start, true);
    expect(nav.update(pad, 0, false)).toEqual([]);
    setButton(pad, PAD_BUTTON.Back, true);
    expect(nav.update(pad, 16, false)).toEqual(['start']);
  });

  it('ignores navigation buttons and falls back to Start', () => {
    const nav = new GamepadNavigator();
    nav.setStartButtons([PAD_BUTTON.A]);
    const pad = fakePad();
    setButton(pad, PAD_BUTTON.A, true);
    expect(nav.update(pad, 0, true)).toEqual(['accept']);
    setButton(pad, PAD_BUTTON.Start, true);
    expect(nav.update(pad, 16, true)).toEqual(['start']);
  });
});
