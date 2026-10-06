/**
 * Decides what the Gems popover may offer from what `/gems/packs` reports.
 * Gems are only ever sold through Stripe; the API's fake provider (never
 * used in production) is allowed through so checkout can be tested, but the
 * UI labels it "Test purchase (dev)". Anything else is "Coming soon".
 *
 * Also explains checkouts the API refuses for the account itself: guests must
 * link a sign-in method first, and accounts owing Gems after a refund or
 * chargeback are paused.
 */
import { openAccountSettings, ui, uiEvents, type StoreData } from '@tumble/ui';

/** UI checkout state. */
export type GemCheckoutMode = NonNullable<StoreData['gemCheckout']>;

/**
 * Maps the API's pack listing to a checkout state.
 *
 * @param packs - `/gems/packs` response, or null when it failed / offline.
 * @returns `enabled` for Stripe, `test` for the dev fake provider, else `comingSoon`.
 * @example
 * gemCheckoutMode({ provider: 'fake', checkout: 'test' }); // 'test'
 */
export function gemCheckoutMode(
  packs: { provider?: string | null; checkout?: string | null } | null | undefined,
): GemCheckoutMode {
  if (!packs) return 'comingSoon';
  // Older APIs do not send `checkout`; their provider id is the only signal.
  const checkout =
    packs.checkout ??
    (packs.provider === 'stripe' ? 'live' : packs.provider === 'fake' ? 'test' : 'unavailable');
  if (checkout === 'live' && packs.provider === 'stripe') return 'enabled';
  if (checkout === 'test' && packs.provider === 'fake') return 'test';
  return 'comingSoon';
}

/** Dialog id of the "link an account first" prompt. */
export const LINK_FOR_GEMS_DIALOG = 'gems-account-required';

let stopListening: (() => void) | null = null;

/**
 * Explains a Gem checkout the API refused for the account itself and offers
 * the way forward: guests (`account_required`) are asked to link a sign-in
 * method and taken to Settings → Account; accounts left owing Gems by a
 * refund or chargeback (`payment_debt`) are told why purchases are paused.
 *
 * @param code - The API error code.
 * @param details - The error's details (`gemDebt` for `payment_debt`).
 * @param openAccount - Opens the link-account UI (injected for tests).
 * @returns True when the code was handled here.
 * @example
 * if (!explainGemCheckoutRefusal(err.code, err.details)) showGenericError(err);
 */
export function explainGemCheckoutRefusal(
  code: string | undefined,
  details?: unknown,
  openAccount: () => void = openAccountSettings,
): boolean {
  const s = ui.getState();
  if (code === 'account_required') {
    s.showDialog({
      id: LINK_FOR_GEMS_DIALOG,
      kind: 'confirm',
      title: 'Link an account to buy Gems',
      body: 'Guest Tumblers live only on this device, so Gems bought here could be lost with it. Link a login in Settings first and your Gems stay safe on any device.',
      buttons: [
        { id: 'cancel', label: 'Not now', variant: 'secondary' },
        { id: 'link', label: 'Link an account', variant: 'primary', autofocus: true },
      ],
    });
    // NOTE: a dialog dismissed without a button never reports back, so a stale
    // listener is dropped when the prompt opens again.
    stopListening?.();
    const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
      if (dialogId !== LINK_FOR_GEMS_DIALOG) return;
      off();
      stopListening = null;
      if (buttonId === 'link') openAccount();
    });
    stopListening = off;
    return true;
  }
  if (code === 'payment_debt') {
    const owed = (details as { gemDebt?: unknown } | undefined)?.gemDebt;
    s.showDialog({
      id: 'gems-payment-debt',
      kind: 'info',
      title: 'Gem purchases are paused',
      body: `A Gem payment on this account was refunded or disputed after the Gems were spent${
        typeof owed === 'number' ? `, leaving ${owed} Gems owed` : ''
      }. Gems you earn pay that back first, and purchases reopen once it is cleared. Contact support if this looks wrong.`,
    });
    return true;
  }
  return false;
}
