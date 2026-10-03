import { ui } from '@tumble/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finishCheckoutReturn, waitForGemCredit, type WalletLedger } from '../src/game/online/checkout.ts';

describe('finishCheckoutReturn', () => {
  const api = {
    wallet: vi.fn(async () => ({ wallet: { gumballs: 0, gems: 0, crownShards: 0 }, recent: [] })),
  };
  const titles = (): string[] => ui.getState().toasts.map((t) => t.title);

  beforeEach(() => {
    ui.setState({ menuTab: 'play', toasts: [], dialog: null });
  });

  it('ignores launches that are not checkout returns', async () => {
    await finishCheckoutReturn({ kind: 'email', token: 't' }, api, null);
    expect(ui.getState().menuTab).toBe('play');
  });

  it('opens the Store and says nothing was charged on cancel', async () => {
    await finishCheckoutReturn({ kind: 'checkout', status: 'cancel', purchaseId: 'p' }, api, null);
    expect(ui.getState().menuTab).toBe('store');
    expect(titles()).toContain('Checkout cancelled');
  });

  it('celebrates once the Gems are credited', async () => {
    const account = { refreshProgress: vi.fn(async () => undefined) };
    await finishCheckoutReturn(
      { kind: 'checkout', status: 'success', purchaseId: 'p' },
      api,
      account,
      async () => 1200,
    );
    expect(account.refreshProgress).toHaveBeenCalled();
    expect(titles()).toContain('+1200 Gems!');
  });

  it('explains a slow webhook instead of claiming failure', async () => {
    const account = { refreshProgress: vi.fn(async () => undefined) };
    await finishCheckoutReturn(
      { kind: 'checkout', status: 'success', purchaseId: 'p-9' },
      api,
      account,
      async () => null,
    );
    expect(ui.getState().dialog).toMatchObject({ title: 'Your Gems are on the way', code: 'p-9' });
    expect(account.refreshProgress).not.toHaveBeenCalled();
  });
});

describe('waitForGemCredit', () => {
  const entry = (ref: string, delta = 500) => ({ currency: 'gems', delta, reason: 'gem_pack', ref });

  it('resolves with the credit once the purchase shows up in the ledger', async () => {
    const polls: WalletLedger[] = [
      { recent: [] },
      { recent: [entry('other')] },
      { recent: [entry('other'), entry('p-1', 1200)] },
    ];
    let i = 0;
    let t = 0;
    const gems = await waitForGemCredit(async () => polls[Math.min(i++, 2)]!, 'p-1', {
      intervalMs: 10,
      timeoutMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(gems).toBe(1200);
    expect(i).toBe(3);
  });

  it('keeps polling through errors and gives up at the deadline', async () => {
    let t = 0;
    let calls = 0;
    const gems = await waitForGemCredit(
      async () => {
        calls++;
        if (calls % 2) throw new Error('flaky');
        return { recent: [] };
      },
      'p-2',
      { intervalMs: 100, timeoutMs: 450, now: () => t, sleep: async (ms) => void (t += ms) },
    );
    expect(gems).toBeNull();
    expect(calls).toBe(5);
  });
});
