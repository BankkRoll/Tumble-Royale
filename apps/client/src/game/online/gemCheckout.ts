/**
 * Decides what the Gems popover may offer from what `/gems/packs` reports.
 * Gems are only ever sold through Stripe; the API's fake provider (never
 * used in production) is allowed through so checkout can be tested, but the
 * UI labels it "Test purchase (dev)". Anything else is "Coming soon".
 */
import type { StoreData } from '@tumble/ui';

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
