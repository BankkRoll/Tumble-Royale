/**
 * Cancel while the leader's queue request is still in flight: the attempt
 * stays cancelled whichever step it lands in, and its `queued` echo is ignored.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueueAttempts, enqueueParty } from '../src/game/online/queueAttempt.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('queue attempts', () => {
  it('queues when nobody cancels', async () => {
    const attempts = new QueueAttempts();
    const queue = vi.fn(() => Promise.resolve());
    const outcome = await enqueueParty(attempts, {
      ticket: () => Promise.resolve('t'),
      queue,
      cancel: () => Promise.resolve(),
    });
    expect(outcome).toBe('queued');
    expect(queue).toHaveBeenCalledWith('t');
    expect(attempts.inFlight).toBe(false);
  });

  it('Cancel during the ticket request never enqueues', async () => {
    const attempts = new QueueAttempts();
    const ticket = deferred<string>();
    const queue = vi.fn(() => Promise.resolve());
    const run = enqueueParty(attempts, { ticket: () => ticket.promise, queue, cancel: () => Promise.resolve() });
    expect(attempts.inFlight).toBe(true);
    expect(attempts.cancel()).toBe(true);
    expect(attempts.ignoringQueued).toBe(true);
    ticket.resolve('t');
    expect(await run).toBe('cancelled');
    expect(queue).not.toHaveBeenCalled();
    expect(attempts.ignoringQueued).toBe(false);
  });

  it('Cancel during the enqueue withdraws it and ignores its queued echo until then', async () => {
    const attempts = new QueueAttempts();
    const enq = deferred<void>();
    const cancel = vi.fn(() => Promise.resolve());
    const run = enqueueParty(attempts, { ticket: () => Promise.resolve('t'), queue: () => enq.promise, cancel });
    await Promise.resolve();
    attempts.cancel();
    expect(attempts.ignoringQueued).toBe(true);
    enq.resolve();
    expect(await run).toBe('cancelled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(attempts.ignoringQueued).toBe(false);
  });

  it('a refusal after Cancel is swallowed; a live refusal is thrown', async () => {
    const attempts = new QueueAttempts();
    const ticket = deferred<string>();
    const run = enqueueParty(attempts, {
      ticket: () => ticket.promise,
      queue: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    });
    attempts.cancel();
    ticket.reject(new Error('offline'));
    expect(await run).toBe('cancelled');
    await expect(
      enqueueParty(attempts, {
        ticket: () => Promise.reject(new Error('offline')),
        queue: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
      }),
    ).rejects.toThrow('offline');
  });

  it('Cancel with nothing in flight is a no-op', () => {
    const attempts = new QueueAttempts();
    expect(attempts.cancel()).toBe(false);
    expect(attempts.ignoringQueued).toBe(false);
  });
});
