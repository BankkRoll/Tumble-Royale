/**
 * Stripe Checkout return: after Stripe sends the player back, the Gems arrive
 * only once the webhook lands, which can be a few seconds later. The wallet's
 * ledger names the purchase that credited them, so polling it tells exactly
 * when this purchase (not some other grant) went through.
 */
import { ui } from '@tumble/ui';
import type { ApiClient } from '../api.ts';
import type { OnlineAccount } from './account.ts';
import type { BootReturn } from './returnUrl.ts';

/** The slice of `GET /wallet` this reads. */
export interface WalletLedger {
  recent: { currency: string; delta: number; reason: string; ref: string | null }[];
}

/** Polling options. */
export interface CreditWaitOptions {
  /** Delay between polls. */
  intervalMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Polls the wallet until the purchase's Gem credit shows up.
 *
 * @param readWallet - Fetches `GET /wallet` (errors count as "not yet").
 * @param purchaseId - Purchase id from the return URL.
 * @param opts - Interval, timeout and test hooks.
 * @returns Gems credited, or null when it did not arrive in time.
 * @example
 * const gems = await waitForGemCredit(() => api.wallet(), purchaseId);
 */
export async function waitForGemCredit(
  readWallet: () => Promise<WalletLedger>,
  purchaseId: string,
  opts: CreditWaitOptions = {},
): Promise<number | null> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeout;
  for (;;) {
    try {
      const w = await readWallet();
      const hit = w.recent.find((e) => e.ref === purchaseId && e.currency === 'gems' && e.delta > 0);
      if (hit) return hit.delta;
    } catch {
      // A failed poll is retried until the deadline; the webhook may still land.
    }
    if (now() + interval > deadline) return null;
    await sleep(interval);
  }
}

/**
 * Finishes a `/store?checkout=…` return once the account connect settled:
 * opens the Store tab, then reports a cancellation, or waits for the Gems and
 * celebrates (or explains that they are still on the way).
 *
 * @param ret - The launch's return, if any (anything but a checkout is ignored).
 * @param api - Account API.
 * @param account - The signed-in account, or null when it could not connect.
 * @param wait - Credit poller (tests shorten it).
 */
export async function finishCheckoutReturn(
  ret: BootReturn | null,
  api: Pick<ApiClient, 'wallet'>,
  account: Pick<OnlineAccount, 'refreshProgress'> | null,
  wait: typeof waitForGemCredit = waitForGemCredit,
): Promise<void> {
  if (ret?.kind !== 'checkout') return;
  const s = ui.getState();
  s.setMenuTab('store');
  if (ret.status === 'cancel') {
    s.pushToast({ kind: 'info', title: 'Checkout cancelled', body: 'No payment was taken.', icon: '💎' });
    return;
  }
  if (!account || !ret.purchaseId) {
    s.pushToast({
      kind: 'info',
      title: 'Payment received',
      body: 'Your Gems will appear once the game reconnects to your account.',
      icon: '💎',
    });
    return;
  }
  s.pushToast({ kind: 'info', title: 'Payment received', body: 'Adding your Gems…', icon: '💎' });
  const gems = await wait(() => api.wallet(), ret.purchaseId);
  if (gems !== null) {
    await account.refreshProgress();
    s.pushToast({
      kind: 'reward',
      title: `+${gems} Gems!`,
      body: 'Thanks for supporting the show!',
      icon: '💎',
    });
    return;
  }
  s.showDialog({
    id: 'gems-pending',
    kind: 'info',
    title: 'Your Gems are on the way',
    body: 'Your payment went through, but the Gems haven’t landed yet. They’ll appear in your wallet shortly. If they don’t, contact support with this purchase id.',
    code: ret.purchaseId,
  });
}
