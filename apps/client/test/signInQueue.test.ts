/**
 * Sign-ins never overlap: boot, the welcome screen, Retry and the browser
 * coming back online asking at once make one guest, not several.
 */
import { describe, expect, it } from 'vitest';
import { SignInQueue } from '../src/game/online/signInQueue.ts';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

/** Lets queued runs start. */
const started = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('SignInQueue', () => {
  it('runs one sign-in at a time and folds repeat reconnects into the waiting one', async () => {
    const q = new SignInQueue();
    const first = gate();
    let running = 0;
    let most = 0;
    let runs = 0;
    const attempt = (wait?: Promise<void>) => async () => {
      runs++;
      running++;
      most = Math.max(most, running);
      await wait;
      running--;
    };
    const boot = q.run(attempt(first.opened), true);
    await started();
    const retryA = q.run(attempt(), true);
    const retryB = q.run(attempt(), true);
    const online = q.run(attempt(), true);
    expect(retryB).toBe(retryA);
    expect(online).toBe(retryA);
    first.open();
    await Promise.all([boot, retryA]);
    expect(runs).toBe(2);
    expect(most).toBe(1);
  });

  it('a welcome sign-in always runs, after the one in flight', async () => {
    const q = new SignInQueue();
    const order: string[] = [];
    const first = gate();
    const boot = q.run(async () => {
      await first.opened;
      order.push('boot');
    }, true);
    await started();
    const welcome = q.run(async () => {
      order.push('welcome');
    }, false);
    const retry = q.run(async () => {
      order.push('retry');
    }, true);
    first.open();
    await Promise.all([boot, welcome, retry]);
    expect(order).toEqual(['boot', 'welcome', 'retry']);
  });

  it('a failed sign-in does not block the next', async () => {
    const q = new SignInQueue();
    const failed = q.run(() => Promise.reject(new Error('network')), true);
    let ran = false;
    const next = q.run(async () => {
      ran = true;
    }, false);
    await expect(failed).rejects.toThrow('network');
    await next;
    expect(ran).toBe(true);
  });
});
