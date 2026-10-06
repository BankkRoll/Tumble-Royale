import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { bindPadButton, PadRebinder } from '../src/screens/overlays/PadRebinder.tsx';
import { DEFAULT_PAD_BINDS, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { PAD_INDEX as P, PadCapture, assignPadButton, padButtonLabel } from '../src/store/padBinds.ts';
import { ui } from '../src/store/uiStore.ts';

(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const pad = (...down: number[]): { buttons: { pressed: boolean; value: number }[] } => ({
  buttons: Array.from({ length: 17 }, (_, i) => ({
    pressed: down.includes(i),
    value: down.includes(i) ? 1 : 0,
  })),
});

describe('assignPadButton', () => {
  it('binds a free button without touching anything else', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'jump', 1, P.LT);
    expect(r.rejected).toBeNull();
    expect(r.swappedWith).toBeNull();
    expect(r.binds.jump).toEqual([P.A, P.LT]);
    expect(r.binds.dive).toEqual(DEFAULT_PAD_BINDS.dive);
  });

  it('swaps with a gameplay action that already had the button', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'jump', 0, P.B);
    expect(r.swappedWith).toBe('dive');
    expect(r.binds.jump).toEqual([P.B, -1]);
    expect(r.binds.dive).toEqual([P.X, P.A]);
  });

  it('lets gameplay and spectating share a button', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'spectatePrev', 0, P.RT);
    expect(r.swappedWith).toBeNull();
    expect(r.binds.spectatePrev).toEqual([P.RT, -1]);
    expect(r.binds.grab).toEqual([P.RT, P.RB]);
  });

  it('moves a button between the two slots of the same action', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'dive', 0, P.B);
    expect(r.binds.dive).toEqual([P.B, P.X]);
  });

  it('refuses Menu on a menu navigation button', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'pause', 0, P.A);
    expect(r.rejected).toMatch(/menus/);
    expect(r.binds).toBe(DEFAULT_PAD_BINDS);
  });

  it('refuses taking Menu’s only button when Menu could not take the old one', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'jump', 0, P.Start);
    expect(r.rejected).toMatch(/opens the menu/);
  });

  it('swaps with Menu when Menu can take the old button', () => {
    const r = assignPadButton(DEFAULT_PAD_BINDS, 'emoteWheel', 0, P.Start);
    expect(r.rejected).toBeNull();
    expect(r.binds.pause).toEqual([P.Y, -1]);
    expect(r.binds.emoteWheel).toEqual([P.Start, -1]);
  });

  it('lets Menu give up one of two buttons', () => {
    const two = { ...DEFAULT_PAD_BINDS, pause: [P.Start, P.Back] as [number, number] };
    const r = assignPadButton(two, 'jump', 0, P.Back);
    expect(r.rejected).toBeNull();
    expect(r.binds.pause).toEqual([P.Start, -1]);
  });

  it('refuses Home and invalid indices', () => {
    expect(assignPadButton(DEFAULT_PAD_BINDS, 'jump', 0, P.Home).rejected).not.toBeNull();
    expect(assignPadButton(DEFAULT_PAD_BINDS, 'jump', 0, -1).rejected).not.toBeNull();
  });

  it('labels buttons', () => {
    expect(padButtonLabel(P.A)).toBe('Ⓐ');
    expect(padButtonLabel(P.RT)).toBe('RT');
    expect(padButtonLabel(-1)).toBe('—');
  });
});

describe('PadCapture', () => {
  it('ignores the button held when capture starts', () => {
    const cap = new PadCapture(pad(P.A));
    expect(cap.update(pad(P.A))).toBeNull();
    expect(cap.update(pad())).toBeNull();
    expect(cap.update(pad(P.A))).toBe(P.A);
  });

  it('reports a new press, triggers past half travel included', () => {
    const cap = new PadCapture(pad());
    const trigger = pad();
    trigger.buttons[P.LT] = { pressed: false, value: 0.8 };
    expect(cap.update(trigger)).toBe(P.LT);
  });

  it('survives the pad disconnecting', () => {
    const cap = new PadCapture(null);
    expect(cap.update(null)).toBeNull();
    expect(cap.update(pad(P.X))).toBe(P.X);
  });
});

describe('controller settings', () => {
  afterEach(() => ui.setState({ settings: DEFAULT_SETTINGS, toasts: [] }));

  it('applies a capture to settings and warns about the swap', () => {
    bindPadButton(DEFAULT_PAD_BINDS, 'grab', 0, P.Y);
    const s = ui.getState();
    expect(s.settings.controls.padBinds.grab).toEqual([P.Y, P.RB]);
    expect(s.settings.controls.padBinds.emoteWheel).toEqual([P.RT, -1]);
    expect(s.toasts.at(-1)?.title).toContain('Emote wheel');
  });

  it('leaves settings alone when refused', () => {
    bindPadButton(DEFAULT_PAD_BINDS, 'pause', 0, P.B);
    expect(ui.getState().settings.controls.padBinds).toEqual(DEFAULT_PAD_BINDS);
    expect(ui.getState().toasts.at(-1)?.kind).toBe('warning');
  });

  it('lists every remappable action with its current button', () => {
    ui.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        controls: { ...DEFAULT_SETTINGS.controls, padBinds: { ...DEFAULT_PAD_BINDS, jump: [P.B, -1] } },
      },
    });
    const html = renderToStaticMarkup(<PadRebinder />);
    for (const label of ['Jump', 'Dive', 'Grab', 'Emote wheel', 'Emote 4', 'Menu', 'Spectate next'])
      expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('aria-label="Jump primary button">Ⓑ<');
  });
});
