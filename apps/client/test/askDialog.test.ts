/** A question dialog always settles: with the answer, or null when it went away unanswered. */
import { describe, expect, it } from 'vitest';
import { ui, uiEvents } from '@tumble/ui';
import { askDialog } from '../src/game/askDialog.ts';

describe('askDialog', () => {
  it('settles with the pressed button', async () => {
    const answer = askDialog({ id: 'solo-confirm', kind: 'confirm', title: 'Play solo?' });
    expect(ui.getState().dialog?.id).toBe('solo-confirm');
    uiEvents.emit('dialogResult', { dialogId: 'solo-confirm', buttonId: 'confirm' });
    ui.getState().closeDialog();
    await expect(answer).resolves.toBe('confirm');
  });

  it('settles with null when another dialog replaces it', async () => {
    const answer = askDialog({ id: 'rejoin-show', kind: 'confirm', title: 'Rejoin show' });
    ui.getState().showDialog({ id: 'net-failed', kind: 'error', title: 'Connection lost' });
    await expect(answer).resolves.toBeNull();
    // The replacement's answer is not taken for this one's.
    uiEvents.emit('dialogResult', { dialogId: 'rejoin-show', buttonId: 'rejoin' });
    ui.getState().closeDialog();
  });

  it('settles with null when the app closes it', async () => {
    const answer = askDialog({ id: 'watch-started-show', kind: 'confirm', title: 'Watch?' });
    ui.getState().closeDialog();
    await expect(answer).resolves.toBeNull();
  });
});
