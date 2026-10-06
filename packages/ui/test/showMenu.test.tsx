/**
 * The way out of a show from every screen: the "Menu" pill on HUD-less show
 * screens, the HUD gear (Skip in Practice Island), and who owns the keys.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hud, openTutorialSkip } from '../src/hud/Hud.tsx';
import { ShowMenuButton, showMenuButtonScreen } from '../src/hud/ShowMenuButton.tsx';
import { InGameMenu } from '../src/screens/overlays/InGameMenu.tsx';
import { INITIAL_CHAT } from '../src/store/chatChannels.ts';
import {
  isTypingTarget,
  keyboardBusy,
  layerAbove,
  menuOwnsInput,
  overlayAfterScreenChange,
  watchChoiceVisible,
} from '../src/store/inputOwnership.ts';
import { social } from '../src/store/social.ts';
import { SCREEN_IDS } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';
import { TUTORIAL_UI_DEFAULTS, tutorialUi } from '../src/tutorial/store.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(tutorialUi as unknown as { getInitialState: () => unknown }).getInitialState = tutorialUi.getState;

beforeEach(() => {
  ui.setState({ screen: 'preShow', overlay: 'none', showSeat: { online: true, outOfShow: false } });
});

afterEach(() => {
  tutorialUi.setState({ ...TUTORIAL_UI_DEFAULTS });
  social.setState({ chat: INITIAL_CHAT });
  ui.setState({ showSeat: null, screen: 'menu' });
});

describe('show menu pill', () => {
  it('covers the HUD-less show screens: pre-show, loading and the waits between rounds', () => {
    expect(SCREEN_IDS.filter(showMenuButtonScreen)).toEqual([
      'matchFound',
      'preShow',
      'showIntro',
      'roundLoading',
      'roundIntro',
      'rules',
      'betweenRounds',
      'finalHype',
    ]);
  });

  it('shows in a show and hides outside one, under overlays and in Practice Island', () => {
    expect(renderToStaticMarkup(<ShowMenuButton />)).toContain('data-testid="show-menu"');
    ui.setState({ overlay: 'inGameMenu' });
    expect(renderToStaticMarkup(<ShowMenuButton />)).toBe('');
    ui.setState({ overlay: 'none', showSeat: null });
    expect(renderToStaticMarkup(<ShowMenuButton />)).toBe('');
    ui.setState({ showSeat: { online: false, outOfShow: false } });
    tutorialUi.setState({ phase: 'intro' });
    expect(renderToStaticMarkup(<ShowMenuButton />)).toBe('');
  });

  it('has a word label, no emoji', () => {
    expect(renderToStaticMarkup(<ShowMenuButton />)).toMatch(/<\/svg> Menu<\/button>|>Menu</);
  });
});

describe('HUD gear in Practice Island', () => {
  beforeEach(() => ui.setState({ screen: 'round' }));

  it('is the show menu in a show', () => {
    expect(renderToStaticMarkup(<Hud />)).toContain('aria-label="Show menu"');
  });

  it('becomes Skip tutorial and opens the skip prompt', () => {
    tutorialUi.setState({ phase: 'practice' });
    expect(renderToStaticMarkup(<Hud />)).toContain('aria-label="Skip tutorial"');
    openTutorialSkip();
    expect(tutorialUi.getState().skipConfirm).toBe(true);
  });

  it('hides behind the ready card, which has its own way out', () => {
    tutorialUi.setState({
      phase: 'ready',
      ready: { xp: 50, unlock: null, raceLine: '', repeat: false },
    });
    expect(renderToStaticMarkup(<Hud />)).not.toContain('data-testid="hud-menu"');
    openTutorialSkip();
    expect(tutorialUi.getState().skipConfirm).toBe(false);
  });
});

describe('input ownership', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}): EventTarget =>
    ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;

  it('treats text fields and editable content as typing targets', () => {
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: '' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'search' }))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('keeps hotkeys on buttons, sliders, toggles and the page', () => {
    expect(isTypingTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(el('BODY'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });

  it('is busy while the chat is open, wherever focus is', () => {
    expect(keyboardBusy({ target: el('BODY') })).toBe(false);
    social.setState({ chat: { ...INITIAL_CHAT, open: true } });
    expect(keyboardBusy({ target: el('BODY') })).toBe(true);
  });

  it('counts the watch choice on any show screen, but only the sheet in the round', () => {
    const choice = { autoAt: null };
    expect(watchChoiceVisible({ screen: 'betweenRounds', eliminatedSheet: false, watchChoice: choice })).toBe(
      true,
    );
    expect(watchChoiceVisible({ screen: 'round', eliminatedSheet: false, watchChoice: choice })).toBe(false);
    expect(watchChoiceVisible({ screen: 'round', eliminatedSheet: true, watchChoice: null })).toBe(true);
    expect(
      menuOwnsInput({
        inputMode: 'game',
        dialog: null,
        overlay: 'none',
        screen: 'roundLoading',
        eliminatedSheet: false,
        watchChoice: choice,
      }),
    ).toBe(true);
  });

  it('gives the keys and pad to quick chat, the player card and the report dialog in a round', () => {
    const round = {
      inputMode: 'game' as const,
      dialog: null,
      overlay: 'none' as const,
      screen: 'round' as const,
      eliminatedSheet: false,
      watchChoice: null,
    };
    const player = { key: 'u1', name: 'Mallow' };
    try {
      expect(menuOwnsInput(round)).toBe(false);
      social.getState().dispatchChat({ type: 'open', mode: 'quick' });
      expect(menuOwnsInput(round)).toBe(true);
      social.getState().dispatchChat({ type: 'close' });
      // The text field keeps its own keys; the pad is not the menu's then.
      social.getState().dispatchChat({ type: 'open', mode: 'text' });
      expect(menuOwnsInput(round)).toBe(false);
      social.getState().dispatchChat({ type: 'close' });
      social.getState().openPlayerMenu(player);
      expect(menuOwnsInput(round)).toBe(true);
      social.getState().openReport(player);
      expect(menuOwnsInput(round)).toBe(true);
      social.getState().openReport(null);
      expect(menuOwnsInput(round)).toBe(false);
    } finally {
      social.getState().dispatchChat({ type: 'close' });
      social.getState().openPlayerMenu(null);
      social.getState().openReport(null);
    }
  });

  it('leaves Esc to a layer above the news reader or the wallet', () => {
    const none = { dialog: null, overlay: 'none' as const, currencyPanel: 'none' as const };
    expect(layerAbove(none, 'screen')).toBe(false);
    expect(layerAbove({ ...none, currencyPanel: 'gems' }, 'screen')).toBe(true);
    expect(layerAbove({ ...none, currencyPanel: 'gems' }, 'wallet')).toBe(false);
    expect(layerAbove({ ...none, overlay: 'settings' }, 'wallet')).toBe(true);
    expect(layerAbove({ ...none, dialog: { id: 'x', kind: 'info', title: 'x' } }, 'wallet')).toBe(true);
    social.getState().openPlayerMenu({ key: 'u1', name: 'Mallow' });
    try {
      expect(layerAbove(none, 'screen')).toBe(true);
    } finally {
      social.getState().openPlayerMenu(null);
    }
  });

  it('an overlay opening over the wallet closes it instead of sitting under it', () => {
    ui.getState().setCurrencyPanel('gems');
    ui.getState().setOverlay('settings');
    expect(ui.getState().currencyPanel).toBe('none');
    ui.getState().setOverlay('none');
  });
});

describe('show-scoped screen state', () => {
  it('a new show forgets the last show, so the menu names the new one', () => {
    ui.setState({
      showIntro: { showName: 'Last Night Show', roundIndex: 3, roundCount: 4 },
      betweenRounds: null,
      caption: 'old line',
    });
    ui.getState().resetShowScreens();
    const s = ui.getState();
    expect([s.showIntro, s.preShow, s.roundIntro, s.results, s.victory, s.playerWall, s.caption]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    ui.getState().setPreShow({
      showName: 'Fresh Show',
      roundCount: 4,
      playersJoined: 1,
      maxPlayers: 12,
      startsAt: 0,
      joinFeed: [],
    });
    ui.setState({ screen: 'preShow', overlay: 'inGameMenu' });
    const html = renderToStaticMarkup(<InGameMenu />);
    expect(html).toContain('Fresh Show');
    expect(html).not.toContain('Last Night Show');
    expect(html).toContain('Getting ready');
    ui.setState({ preShow: null, overlay: 'none' });
  });
});

describe('overlays across screen changes', () => {
  it('keeps Settings, Friends and the in-game menu open while the show moves on', () => {
    for (const overlay of ['settings', 'friends', 'notifications', 'inGameMenu'] as const) {
      expect(overlayAfterScreenChange(overlay, 'round', 'roundResults')).toBe(overlay);
      expect(overlayAfterScreenChange(overlay, 'betweenRounds', 'roundLoading')).toBe(overlay);
      expect(overlayAfterScreenChange(overlay, 'preShow', 'showIntro')).toBe(overlay);
    }
  });

  it('closes them when the show is over', () => {
    expect(overlayAfterScreenChange('settings', 'playerWall', 'rewards')).toBe('none');
    expect(overlayAfterScreenChange('inGameMenu', 'round', 'menu')).toBe('none');
  });

  it('never carries menu-only overlays into a show', () => {
    expect(overlayAfterScreenChange('privateShow', 'menu', 'matchFound')).toBe('none');
    expect(overlayAfterScreenChange('joinCode', 'matchmaking', 'matchFound')).toBe('none');
  });

  it('keeps the menu overlay on arrival in the menu (the private show reveal)', () => {
    expect(overlayAfterScreenChange('privateShow', 'rewards', 'menu')).toBe('privateShow');
    expect(overlayAfterScreenChange('settings', 'menu', 'menu')).toBe('settings');
  });

  it('applies on a real screen change', () => {
    ui.setState({ screen: 'round', overlay: 'settings' });
    ui.getState().setScreen('roundResults', { transition: 'none' });
    expect(ui.getState().overlay).toBe('settings');
    ui.getState().setScreen('rewards', { transition: 'none' });
    expect(ui.getState().overlay).toBe('none');
  });
});
