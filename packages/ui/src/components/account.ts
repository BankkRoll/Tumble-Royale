/**
 * Account confirmations shared by Settings and Profile.
 */
import { uiEvents } from '../store/events.ts';
import { ui } from '../store/uiStore.ts';

/**
 * Asks before signing out, then emits `accountAction: signOut`. A guest
 * Tumbler lives only on this device, so the warning says it will be gone.
 */
export function confirmSignOut(): void {
  const guest = ui.getState().profile?.isGuest ?? true;
  ask(
    'signOut',
    'Sign out?',
    guest
      ? "You're playing as a guest, so this Tumbler, its items and Crowns are only saved on this device. Signing out erases them and you'll pick a new name."
      : "You'll need to sign in again to get back to this Tumbler.",
    guest ? 'Erase and sign out' : 'Sign out',
  );
}

/** Asks before erasing the Tumbler, then emits `accountAction: deleteAccount`. */
export function confirmDeleteAccount(): void {
  ask(
    'deleteAccount',
    'Delete this Tumbler?',
    'This removes your Tumbler, items and Crowns from this device and signs you out. There is no undo.',
    'Delete',
  );
}

// NOTE: a dialog dismissed without a button never reports back, so a stale
// listener is dropped when the next confirmation opens.
let pending: (() => void) | null = null;

function ask(id: 'signOut' | 'deleteAccount', title: string, body: string, confirm: string): void {
  ui.getState().showDialog({
    id,
    kind: 'confirm',
    title,
    body,
    buttons: [
      { id: 'cancel', label: 'Keep playing', variant: 'secondary', autofocus: true },
      { id: 'confirm', label: confirm, variant: 'danger' },
    ],
  });
  pending?.();
  const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (dialogId !== id) return;
    off();
    pending = null;
    if (buttonId === 'confirm') uiEvents.emit('accountAction', { action: id });
  });
  pending = off;
}
