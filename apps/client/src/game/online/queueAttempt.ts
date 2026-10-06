/**
 * The party leader's way into the matchmaking queue: an API queue ticket,
 * then the matchmaker enqueue. Both are network round trips, and Cancel can
 * land during either. A cancelled attempt must stay cancelled: it never
 * spends ready votes or sets presence, an enqueue that still went through is
 * withdrawn, and the stream's `queued` echo of it must not pull the player
 * back to the matchmaking screen.
 */

/**
 * Tracks the leader's in-flight queue attempt.
 *
 * @example
 * const attempts = new QueueAttempts();
 * const outcome = await enqueueParty(attempts, { ticket, queue, cancel });
 * // on Cancel
 * attempts.cancel();
 */
export class QueueAttempts {
  private gen = 0;
  private pending = false;
  private abandoned = 0;

  /** True while a ticket request or enqueue is in flight. */
  get inFlight(): boolean {
    return this.pending;
  }

  /** True while a cancelled attempt may still echo a `queued` event, which must be ignored. */
  get ignoringQueued(): boolean {
    return this.abandoned > 0;
  }

  /**
   * Starts an attempt.
   *
   * @returns Its id, for {@link isCurrent}.
   */
  begin(): number {
    this.pending = true;
    return ++this.gen;
  }

  /**
   * @param id - An id from {@link begin}.
   * @returns True while that attempt is the live one (not cancelled or superseded).
   */
  isCurrent(id: number): boolean {
    return id === this.gen;
  }

  /**
   * Ends an attempt once its requests are done.
   *
   * @param id - An id from {@link begin}.
   */
  settle(id: number): void {
    if (id === this.gen) this.pending = false;
  }

  /**
   * Cancels the in-flight attempt, if any.
   *
   * @returns True when one was in flight.
   */
  cancel(): boolean {
    if (!this.pending) return false;
    this.pending = false;
    this.gen++;
    this.abandoned++;
    return true;
  }

  /** A cancelled attempt has finished unwinding. */
  forget(): void {
    this.abandoned = Math.max(0, this.abandoned - 1);
  }
}

/** The requests behind one queue attempt. */
export interface EnqueueSteps {
  /** Fetches an API queue ticket. */
  ticket(): Promise<string>;
  /** Enqueues the party with the ticket. */
  queue(ticket: string): Promise<unknown>;
  /** Withdraws the party from the queue. */
  cancel(): Promise<void>;
}

/**
 * Runs one queue attempt, bailing out between steps when it was cancelled.
 *
 * @param attempts - The leader's attempt tracker.
 * @param steps - The requests.
 * @returns `queued` when the party is in the queue, `cancelled` when the
 *   attempt was cancelled (anything it enqueued has been withdrawn).
 * @throws The request error, only while the attempt is still current.
 */
export async function enqueueParty(attempts: QueueAttempts, steps: EnqueueSteps): Promise<'queued' | 'cancelled'> {
  const id = attempts.begin();
  try {
    const ticket = await steps.ticket();
    if (!attempts.isCurrent(id)) {
      attempts.forget();
      return 'cancelled';
    }
    await steps.queue(ticket);
    if (!attempts.isCurrent(id)) {
      await steps.cancel().catch(() => undefined);
      attempts.forget();
      return 'cancelled';
    }
    return 'queued';
  } catch (err) {
    if (attempts.isCurrent(id)) throw err;
    attempts.forget();
    return 'cancelled';
  } finally {
    attempts.settle(id);
  }
}
