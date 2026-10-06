/**
 * Runs account sign-ins one at a time. Boot, the welcome screen, Retry and
 * the browser coming back online can all ask at once, and two sign-ins
 * racing would mint two guests and bind the realtime and matchmaker
 * handlers twice.
 */

/**
 * A one-at-a-time queue where repeat requests of the same kind fold into the
 * one still waiting.
 *
 * @example
 * const signIns = new SignInQueue();
 * void signIns.run(() => connect(null), true); // reconnects share a waiting run
 * void signIns.run(() => connect(welcome), false); // always runs, after the others
 */
export class SignInQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting: Promise<void> | null = null;

  /**
   * Queues a task behind the ones already running or waiting.
   *
   * @param task - The sign-in attempt.
   * @param shareable - A plain reconnect: joins one already waiting to start
   *   instead of queueing another (one that already started may have failed
   *   before the reason to retry arrived, so it is not joined).
   * @returns Settles when the task (or the one joined) has run.
   */
  run(task: () => Promise<void>, shareable: boolean): Promise<void> {
    if (shareable && this.waiting) return this.waiting;
    const run: Promise<void> = this.tail
      .catch(() => undefined)
      .then(() => {
        if (this.waiting === run) this.waiting = null;
        return task();
      });
    if (shareable) this.waiting = run;
    this.tail = run;
    return run;
  }
}
