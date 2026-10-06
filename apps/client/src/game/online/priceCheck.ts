/**
 * The price the player confirmed, checked at purchase time.
 *
 * Purchases and gifts send the price the confirmation showed; when the
 * shelves rotated meanwhile the API answers 409 `price_changed` with the new
 * quote and charges nothing. Offline, the local profile compares the same way.
 * Kept free of DOM and network so it is unit-tested on its own.
 */
import { ApiError } from '../api.ts';

/** A price in a spendable currency. */
export interface Quote {
  currency: 'gumballs' | 'gems';
  amount: number;
}

const NAMES: Readonly<Record<Quote['currency'], string>> = { gumballs: 'Gumballs', gems: 'Gems' };

function isQuote(v: unknown): v is Quote {
  const q = v as Partial<Quote> | null;
  return !!q && (q.currency === 'gumballs' || q.currency === 'gems') && typeof q.amount === 'number';
}

/**
 * The new quote carried by a `price_changed` refusal.
 *
 * @param err - What the purchase threw.
 * @returns The new price, or null for any other error.
 */
export function changedPrice(err: unknown): Quote | null {
  if (!(err instanceof ApiError) || err.code !== 'price_changed') return null;
  const price = (err.details as { price?: unknown } | undefined)?.price;
  return isQuote(price) ? price : null;
}

/**
 * Explains a price that moved between the confirmation and the purchase.
 *
 * @param price - The new price.
 * @example
 * priceChangedText({ currency: 'gems', amount: 400 });
 * // 'The price changed to 400 Gems while you were deciding. Nothing was charged; …'
 */
export function priceChangedText(price: Quote): string {
  return (
    `The price changed to ${price.amount.toLocaleString()} ${NAMES[price.currency]} while you were ` +
    'deciding (the shelves restocked). Nothing was charged; check the new price and try again.'
  );
}

/**
 * Whether a quote still holds.
 *
 * @param expected - What the player confirmed, if the caller knows.
 * @param actual - What would be charged now.
 */
export function quoteHolds(expected: Quote | undefined, actual: Quote): boolean {
  return !expected || (expected.currency === actual.currency && expected.amount === actual.amount);
}
