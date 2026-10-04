/**
 * The knocked-out "Keep watching / Leave show" choice: Back (Esc, pad B)
 * keeps watching, and leaving always asks first, so a stray Esc pressed to
 * free the mouse never drops the player out of the show.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmLeaveShow } from '../src/screens/overlays/InGameMenu.tsx';
import { WatchChoiceLayer } from '../src/screens/overlays/WatchChoice.tsx';
import { uiEvents } from '../src/store/events.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

/** Every opening tag carrying `data-nav-back`, i.e. what Back would click. */
function backTargets(html: string): string[] {
  return html.match(/<[^>]*data-nav-back[^>]*>/g) ?? [];
}

let leaves = 0;
let offLeave: () => void = () => undefined;

beforeEach(() => {
  leaves = 0;
  offLeave = uiEvents.on('leaveShow', () => leaves++);
  ui.setState({
    screen: 'betweenRounds',
    overlay: 'none',
    dialog: null,
    showSeat: null,
    watchChoice: { autoAt: null, remaining: 12 },
  });
});

afterEach(() => {
  // Answer any dialog a test left open so its listener can't leak into the next test.
  if (ui.getState().dialog) uiEvents.emit('dialogResult', { dialogId: 'leaveShow', buttonId: 'cancel' });
  offLeave();
  ui.setState({ watchChoice: null, dialog: null });
});

describe('watch choice back target', () => {
  it('Back clicks Keep watching, never Leave show', () => {
    const html = renderToStaticMarkup(<WatchChoiceLayer />);
    const back = backTargets(html);
    expect(back).toHaveLength(1);
    expect(back[0]).toContain('data-testid="watch-keep"');
    expect(html).not.toMatch(
      /data-testid="watch-leave"[^>]*data-nav-back|data-nav-back[^>]*data-testid="watch-leave"/,
    );
  });
});

describe('confirmLeaveShow', () => {
  it('asks first and does not leave on its own', () => {
    confirmLeaveShow();
    expect(ui.getState().dialog?.id).toBe('leaveShow');
    expect(leaves).toBe(0);
  });

  it('cancel (the dialog Back) keeps the player in the show', () => {
    confirmLeaveShow();
    uiEvents.emit('dialogResult', { dialogId: 'leaveShow', buttonId: 'cancel' });
    expect(leaves).toBe(0);
  });

  it('defaults to staying: the cancel button holds focus and the Back slot', () => {
    ui.setState({ showSeat: { online: false, outOfShow: true } });
    confirmLeaveShow();
    const cancel = ui.getState().dialog?.buttons?.find((b) => b.id === 'cancel');
    expect(cancel?.autofocus).toBe(true);
    expect(cancel?.label).toBe('Keep watching');
  });

  it('leaves once on confirm, even when opened twice', () => {
    confirmLeaveShow();
    confirmLeaveShow();
    uiEvents.emit('dialogResult', { dialogId: 'leaveShow', buttonId: 'confirm' });
    expect(leaves).toBe(1);
    uiEvents.emit('dialogResult', { dialogId: 'leaveShow', buttonId: 'confirm' });
    expect(leaves).toBe(1);
  });

  it('ignores other dialogs', () => {
    confirmLeaveShow();
    uiEvents.emit('dialogResult', { dialogId: 'somethingElse', buttonId: 'confirm' });
    expect(leaves).toBe(0);
  });
});
