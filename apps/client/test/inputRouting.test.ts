/**
 * Pad and Menu-key routing: the watch choice owns the pad on every show
 * screen, Esc / Start reach the in-game menu from the whole show flow, and
 * Practice Island keeps Start to itself.
 */
import { describe, expect, it } from 'vitest';
import { SCREEN_IDS, SHOW_MENU_SCREENS, ui, type ScreenId } from '@tumble/ui';
import {
  menuOwnsPad,
  padStartAction,
  showMenuKeyAction,
  type RoutingContext,
  type RoutingState,
} from '../src/game/inputRouting.ts';

const base = ui.getState();

function state(patch: Partial<RoutingState> = {}): RoutingState {
  return {
    inputMode: 'game',
    dialog: null,
    overlay: 'none',
    screen: 'round',
    eliminatedSheet: false,
    watchChoice: null,
    photo: base.photo,
    replay: null,
    ...patch,
  };
}

const show: RoutingContext = { idlePlaying: false, inShow: true, sessionOwnsMenu: false };
const menus: RoutingContext = { idlePlaying: false, inShow: false, sessionOwnsMenu: false };
const tutorial: RoutingContext = { idlePlaying: false, inShow: true, sessionOwnsMenu: true };
const choice = { autoAt: null, remaining: 5 };

describe('menuOwnsPad', () => {
  it('leaves the pad to gameplay during a plain round', () => {
    expect(menuOwnsPad(state(), false)).toBe(false);
  });

  it('gives the pad to the watch choice on every between-round show screen', () => {
    // Leaving `round` clears eliminatedSheet, and these screens are not menu-input screens.
    for (const screen of ['betweenRounds', 'roundLoading', 'showIntro', 'finalHype', 'roundIntro'] as const)
      expect(menuOwnsPad(state({ screen, watchChoice: choice }), false), screen).toBe(true);
  });

  it('follows the in-round sheet on the round itself', () => {
    expect(menuOwnsPad(state({ watchChoice: choice, eliminatedSheet: true }), false)).toBe(true);
    // The offer can outlive a dismissed sheet in the round; it is not on screen then.
    expect(menuOwnsPad(state({ watchChoice: choice, eliminatedSheet: false }), false)).toBe(false);
  });

  it('gives the pad to overlays, dialogs and menu screens unless idle play has it', () => {
    expect(menuOwnsPad(state({ overlay: 'inGameMenu' }), false)).toBe(true);
    expect(menuOwnsPad(state({ dialog: { id: 'x', kind: 'info', title: 'x' } }), false)).toBe(true);
    expect(menuOwnsPad(state({ screen: 'menu', inputMode: 'menu' }), false)).toBe(true);
    expect(menuOwnsPad(state({ screen: 'menu', inputMode: 'menu' }), true)).toBe(false);
  });

  it('always gives the pad to photo mode and the replay viewer', () => {
    expect(menuOwnsPad(state({ photo: { ...base.photo, active: true } }), true)).toBe(true);
    expect(menuOwnsPad(state({ replay: {} as RoutingState['replay'] }), true)).toBe(true);
  });
});

describe('padStartAction', () => {
  it('opens the in-game menu on every show screen, not only the round', () => {
    for (const screen of SHOW_MENU_SCREENS)
      expect(padStartAction(state({ screen }), show), screen).toBe('openShowMenu');
  });

  it('closes whatever is open on a show screen', () => {
    expect(padStartAction(state({ screen: 'preShow', overlay: 'inGameMenu' }), show)).toBe('closeOverlay');
    expect(padStartAction(state({ screen: 'preShow', overlay: 'settings' }), show)).toBe('closeOverlay');
  });

  it('does nothing in Practice Island, whose own Start toggles the skip prompt', () => {
    for (const screen of ['round', 'roundLoading', 'roundIntro'] as const)
      expect(padStartAction(state({ screen }), tutorial)).toBe('none');
    expect(padStartAction(state({ overlay: 'inGameMenu' }), tutorial)).toBe('none');
  });

  it('keeps Settings in the menus and stays out of dialogs', () => {
    expect(padStartAction(state({ screen: 'menu', inputMode: 'menu' }), menus)).toBe('openSettings');
    expect(padStartAction(state({ screen: 'menu', inputMode: 'menu', overlay: 'settings' }), menus)).toBe(
      'closeOverlay',
    );
    expect(padStartAction(state({ screen: 'splash', inputMode: 'menu' }), menus)).toBe('none');
    expect(padStartAction(state({ dialog: { id: 'x', kind: 'info', title: 'x' } }), show)).toBe('none');
  });

  it('leaves Start to the elimination replay, which takes it as a skip', () => {
    const elimReplay = { mode: 'playing', cause: 'x', progress: 0, slow: false } as const;
    expect(padStartAction(state({ elimReplay }), show)).toBe('none');
    expect(padStartAction(state({ screen: 'roundResults', elimReplay }), show)).toBe('none');
  });

  it('keeps the show menu shut while the connection curtain is up', () => {
    for (const status of ['connecting', 'reconnecting', 'lost'] as const) {
      const connection = { status };
      expect(padStartAction(state({ connection }), show), status).toBe('none');
      expect(showMenuKeyAction({ screen: 'round', overlay: 'none', dialog: null, connection }), status).toBeNull();
    }
    expect(padStartAction(state({ connection: { status: 'online' } }), show)).toBe('openShowMenu');
  });

  it('a reconnect closes the dialog that was up, so nothing waits behind the curtain', () => {
    ui.getState().showDialog({ id: 'leave-confirm', kind: 'confirm', title: 'Leave show?' });
    ui.getState().setConnection({ status: 'connecting' });
    expect(ui.getState().dialog?.id).toBe('leave-confirm');
    ui.getState().setConnection({ status: 'reconnecting', attempt: 1, maxAttempts: 5 });
    expect(ui.getState().dialog).toBeNull();
    ui.getState().setConnection({ status: 'online' });
  });

  it('never opens the show menu without a show', () => {
    expect(padStartAction(state({ screen: 'preShow' }), menus)).toBe('none');
  });

  it('exits photo mode and idle play first', () => {
    expect(padStartAction(state({ photo: { ...base.photo, active: true } }), show)).toBe('exitPhoto');
    expect(
      padStartAction(state({ screen: 'menu', inputMode: 'menu' }), { ...menus, idlePlaying: true }),
    ).toBe('leaveIdlePlay');
  });
});

describe('showMenuKeyAction', () => {
  it('opens the menu from matchFound to the wall, and nowhere else', () => {
    const open = SCREEN_IDS.filter(
      (screen: ScreenId) => showMenuKeyAction({ screen, overlay: 'none', dialog: null }) === 'open',
    );
    expect(open).toEqual([
      'matchFound',
      'preShow',
      'showIntro',
      'roundLoading',
      'roundIntro',
      'rules',
      'round',
      'roundResults',
      'betweenRounds',
      'finalHype',
      'victory',
      'winnerCam',
      'playerWall',
    ]);
  });

  it('toggles the menu closed and leaves other overlays and dialogs alone', () => {
    expect(showMenuKeyAction({ screen: 'preShow', overlay: 'inGameMenu', dialog: null })).toBe('close');
    expect(showMenuKeyAction({ screen: 'preShow', overlay: 'settings', dialog: null })).toBeNull();
    expect(
      showMenuKeyAction({
        screen: 'preShow',
        overlay: 'none',
        dialog: { id: 'x', kind: 'info', title: 'x' },
      }),
    ).toBeNull();
  });
});
