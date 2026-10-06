import { ui, uiEvents, type DialogSpec } from '@tumble/ui';

/**
 * Shows a dialog and waits for the player's answer.
 *
 * Only one dialog is on screen at a time, so another one can replace this
 * one (or the app can close it) before it is answered; the promise then
 * settles with null instead of waiting forever.
 *
 * @param spec - The dialog.
 * @returns The pressed button id, or null when the dialog went away unanswered.
 * @example
 * if ((await askDialog({ id: 'solo-confirm', kind: 'confirm', title: 'Play solo?' })) === 'confirm') start();
 */
export function askDialog(spec: DialogSpec): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      offResult();
      offStore();
      resolve(answer);
    };
    const offResult = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
      if (dialogId === spec.id) settle(buttonId);
    });
    const offStore = ui.subscribe((s) => {
      if (s.dialog !== spec) settle(null);
    });
    ui.getState().showDialog(spec);
  });
}
