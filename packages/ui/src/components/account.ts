/**
 * Account confirmations shared by Settings and Profile. Each one says exactly
 * what will happen to the Tumbler before emitting its `accountAction`.
 */
import { AUTH_PROVIDER_LABELS, AUTH_PROVIDERS, accountUi, type AuthProviderId } from '../store/account.ts';
import { uiEvents, type UIIntents } from '../store/events.ts';
import { ui } from '../store/uiStore.ts';

/** Portable sign-in methods linked to the current Tumbler. */
function linkedMethods(): AuthProviderId[] {
  const linked = ui.getState().profile?.linkedProviders ?? [];
  return AUTH_PROVIDERS.filter((p) => linked.includes(p));
}

/** "Discord", "Discord or Google", "Discord, Google or Email". */
function orList(ids: readonly AuthProviderId[]): string {
  const names = ids.map((p) => AUTH_PROVIDER_LABELS[p]);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/**
 * Asks before signing out, then emits `accountAction: signOut`. A guest
 * Tumbler lives only on this device, so the warning says it will be gone.
 */
export function confirmSignOut(): void {
  const guest = ui.getState().profile?.isGuest ?? true;
  const methods = linkedMethods();
  ask(
    'signOut',
    'signOut',
    'Sign out?',
    guest
      ? "You're playing as a guest, so this Tumbler, its items and Crowns are only saved on this device. Signing out erases them and you'll pick a new name."
      : methods.length > 0
        ? `Your Tumbler stays safe on your account. Sign back in any time with ${orList(methods)}.`
        : "You'll need to sign in again to get back to this Tumbler.",
    guest ? 'Erase and sign out' : 'Sign out',
  );
}

/**
 * Asks before deleting the Tumbler, then emits `accountAction: deleteAccount`.
 * The copy depends on where the Tumbler lives: only on this device, or on the
 * servers too (which needs a connection, so an unreachable server is refused up front).
 */
export function confirmDeleteAccount(): void {
  const { session } = accountUi.getState();
  const p = ui.getState().profile;
  const who = p ? `${p.name}#${p.tag}` : 'this Tumbler';
  if (session === 'unreachable') {
    ui.getState().showDialog({
      id: 'deleteAccount-offline',
      kind: 'info',
      title: "Can't delete right now",
      body: `${who} is saved on the Tumble Royale servers, and they can't be reached right now. Nothing was deleted. Try again when you're back online.`,
    });
    return;
  }
  ask(
    'deleteAccount',
    'deleteAccount',
    'Delete this Tumbler?',
    session === 'online'
      ? `This permanently deletes ${who} from the Tumble Royale servers, including its items, Crowns, Gems, stats and linked logins, then erases it from this device. You won't be able to sign in to it again from any device. There is no undo.`
      : `${who} only lives on this device. Deleting it erases its items, Crowns and progress here and starts you fresh. There is no undo.`,
    session === 'online' ? 'Delete forever' : 'Delete',
  );
}

/**
 * Asks before unlinking a sign-in method, then emits `accountAction: unlink-<provider>`.
 *
 * @param provider - Method to remove.
 */
export function confirmUnlink(provider: AuthProviderId): void {
  const rest = linkedMethods().filter((p) => p !== provider);
  const label = AUTH_PROVIDER_LABELS[provider];
  ask(
    `unlink-${provider}`,
    `unlink-${provider}`,
    `Unlink ${label}?`,
    `You won't be able to sign in with ${label} any more.${rest.length ? ` You can still sign in with ${orList(rest)}.` : ''}`,
    'Unlink',
    'Keep it linked',
  );
}

// NOTE: a dialog dismissed without a button never reports back, so a stale
// listener is dropped when the next confirmation opens.
let pending: (() => void) | null = null;

function ask(
  id: string,
  action: UIIntents['accountAction']['action'],
  title: string,
  body: string,
  confirm: string,
  cancel = 'Keep playing',
): void {
  ui.getState().showDialog({
    id,
    kind: 'confirm',
    title,
    body,
    buttons: [
      { id: 'cancel', label: cancel, variant: 'secondary', autofocus: true },
      { id: 'confirm', label: confirm, variant: 'danger' },
    ],
  });
  pending?.();
  const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (dialogId !== id) return;
    off();
    pending = null;
    if (buttonId === 'confirm') uiEvents.emit('accountAction', { action });
  });
  pending = off;
}
