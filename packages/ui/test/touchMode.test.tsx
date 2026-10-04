import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { TouchControls, isTap } from '../src/hud/TouchControls.tsx';
import { touchMode, type TouchModeInput } from '../src/hud/touchMode.ts';
import { DEFAULT_HUD, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { ui, type UIState } from '../src/store/uiStore.ts';

(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const initial = ui.getState();
const PRESHOW = {
  showName: 'Show',
  roundCount: 5,
  playersJoined: 1,
  maxPlayers: 60,
  startsAt: 0,
  joinFeed: [],
} as unknown as NonNullable<UIState['preShow']>;

function state(patch: Partial<TouchModeInput> = {}, hud: Partial<UIState['hud']> = {}): TouchModeInput {
  const s = ui.getState();
  return {
    ...s,
    isTouch: true,
    screen: 'round',
    overlay: 'none',
    dialog: null,
    ...patch,
    hud: { ...DEFAULT_HUD, device: 'touch', ...hud },
  };
}

describe('touchMode visibility', () => {
  it('needs a touch device that was used last', () => {
    expect(touchMode(state({ isTouch: false }))).toBeNull();
    expect(touchMode(state({}, { device: 'keyboard' }))).toBeNull();
    expect(touchMode(state({}, { device: 'gamepad' }))).toBeNull();
  });

  it('round: full controls with emote and camera drag while playing', () => {
    expect(touchMode(state())).toMatchObject({
      context: 'round',
      controls: true,
      buttons: ['jump', 'dive', 'grab'],
      emote: true,
      look: true,
      done: false,
    });
  });

  it('round: camera drag only once out, or while a menu or dialog is up', () => {
    expect(touchMode(state({}, { localStatus: 'eliminated' }))?.controls).toBe(false);
    expect(touchMode(state({}, { localStatus: 'eliminated' }))?.look).toBe(true);
    expect(touchMode(state({ overlay: 'inGameMenu' }))?.controls).toBe(false);
    expect(touchMode(state({ dialog: { id: 'x' } as UIState['dialog'] }))?.controls).toBe(false);
  });

  it('hidden in photo mode and the replay viewer', () => {
    expect(touchMode(state({ photo: { ...initial.photo, active: true } }))).toBeNull();
    expect(touchMode(state({ replay: {} as UIState['replay'] }))).toBeNull();
  });

  it('pre-show platform: joystick and buttons, no emote wheel or camera', () => {
    expect(touchMode(state({ screen: 'preShow', preShow: PRESHOW }))).toMatchObject({
      context: 'preShow',
      controls: true,
      emote: false,
      look: false,
      done: false,
    });
    expect(touchMode(state({ screen: 'preShow', preShow: null }))).toBeNull();
    expect(touchMode(state({ screen: 'preShow', preShow: PRESHOW, overlay: 'settings' }))?.controls).toBe(
      false,
    );
  });

  it('menu: only while idle play is on, with Done', () => {
    const menu = { screen: 'menu', menuTab: 'play' } as const;
    expect(touchMode(state({ ...menu, idlePlay: false }))).toBeNull();
    expect(touchMode(state({ ...menu, idlePlay: true }))).toMatchObject({
      context: 'menu',
      controls: true,
      emote: false,
      look: true,
      done: true,
    });
  });

  it('menu: steps aside for any menu UI the player opens', () => {
    const on = { screen: 'menu', menuTab: 'play', idlePlay: true } as const;
    expect(touchMode(state({ ...on, menuTab: 'locker' }))).toBeNull();
    expect(touchMode(state({ ...on, overlay: 'settings' }))).toBeNull();
    expect(touchMode(state({ ...on, lobbyGames: { ...initial.lobbyGames, pickerOpen: true } }))).toBeNull();
    expect(touchMode(state({ ...on, currencyPanel: 'gems' }))).toBeNull();
    expect(touchMode(state({ ...on, inspectedProfile: {} as UIState['inspectedProfile'] }))).toBeNull();
  });

  it('nowhere else', () => {
    for (const screen of ['splash', 'matchmaking', 'roundResults', 'rewards', 'roundLoading'] as const)
      expect(touchMode(state({ screen, idlePlay: true }))).toBeNull();
  });
});

describe('TouchControls rendering', () => {
  afterEach(() => ui.setState(initial));

  function render(patch: Partial<UIState>, hud: Partial<UIState['hud']> = {}): string {
    ui.setState({ ...initial, isTouch: true, ...patch, hud: { ...DEFAULT_HUD, device: 'touch', ...hud } });
    return renderToStaticMarkup(<TouchControls />);
  }

  it('round shows every button and the emote wheel button', () => {
    const html = render({ screen: 'round' });
    for (const label of ['Jump', 'Dive', 'Grab', 'Emote']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('data-testid="touch-look"');
    expect(html).not.toContain('touch-done');
  });

  it('menu idle play adds Done and drops the emote button', () => {
    const html = render({ screen: 'menu', menuTab: 'play', idlePlay: true });
    expect(html).toContain('data-testid="touch-done"');
    expect(html).toContain('>Done<');
    expect(html).toContain('data-testid="touch-stick"');
    expect(html).not.toContain('aria-label="Emote"');
  });

  it('pre-show has the joystick but no camera surface', () => {
    const html = render({ screen: 'preShow', preShow: PRESHOW });
    expect(html).toContain('data-testid="touch-stick"');
    expect(html).not.toContain('touch-look');
  });

  it('honours the layout side and button size settings', () => {
    const html = render({
      screen: 'round',
      settings: {
        ...DEFAULT_SETTINGS,
        controls: { ...DEFAULT_SETTINGS.controls, touchLayout: 'left', touchButtonScale: 1.3 },
      },
    });
    expect(html).toContain('tr-touch is-left is-round');
    expect(html).toContain('--tb:1.3');
  });

  it('renders nothing for a mouse player', () => {
    expect(render({ screen: 'round' }, { device: 'keyboard' })).toBe('');
  });

  it('the app marks menu touch play so the menu chrome steps aside', () => {
    ui.setState({
      ...initial,
      isTouch: true,
      screen: 'menu',
      menuTab: 'play',
      idlePlay: true,
      hud: { ...DEFAULT_HUD, device: 'touch' },
    });
    expect(renderToStaticMarkup(<App />)).toContain('data-touch-play="menu"');
  });
});

describe('isTap', () => {
  it('separates taps from camera drags', () => {
    expect(isTap(0, 80)).toBe(true);
    expect(isTap(9, 300)).toBe(true);
    expect(isTap(30, 100)).toBe(false);
    expect(isTap(2, 900)).toBe(false);
  });
});
