/**
 * Abuse protection for client connections: token-bucket rate limits and input
 * sequence sanity. The server never accepts client positions or results; these
 * checks bound what a client CAN send (inputs, chat, acks).
 */

/** Classic token bucket. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  /**
   * @param ratePerSec - Refill rate.
   * @param burst - Bucket size.
   * @param now - Current time (ms).
   */
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /**
   * Takes `cost` tokens if available.
   *
   * @returns False when the bucket is empty (rate limited).
   */
  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Limits applied per connection. */
export interface ConnectionLimits {
  /** Messages per second (inputs are 60/s, plus pings and acks). */
  messagesPerSec: number;
  messageBurst: number;
  /** Inbound bytes per second. */
  bytesPerSec: number;
  bytesBurst: number;
  /** Chat messages per second. */
  chatPerSec: number;
  chatBurst: number;
  /** Round-vote ballots per second (a player changing their mind is a handful, not a stream). */
  votesPerSec: number;
  voteBurst: number;
  /** Violations tolerated within `violationWindowMs` before a kick. */
  maxViolations: number;
  violationWindowMs: number;
}

/** Defaults sized for a 60 Hz input stream with redundancy. */
export const DEFAULT_LIMITS: ConnectionLimits = {
  messagesPerSec: 150,
  messageBurst: 120,
  bytesPerSec: 24 * 1024,
  bytesBurst: 32 * 1024,
  chatPerSec: 1,
  chatBurst: 4,
  votesPerSec: 2,
  voteBurst: 4,
  maxViolations: 60,
  violationWindowMs: 10_000,
};

/** Per-connection limiter state. */
export class ConnectionGuard {
  private readonly messages: TokenBucket;
  private readonly bytes: TokenBucket;
  private readonly chat: TokenBucket;
  private readonly votes: TokenBucket;
  private violations = 0;
  private windowStart: number;

  /**
   * @param limits - Limits to enforce.
   * @param now - Current time (ms).
   */
  constructor(
    private readonly limits: ConnectionLimits,
    now: number,
  ) {
    this.messages = new TokenBucket(limits.messagesPerSec, limits.messageBurst, now);
    this.bytes = new TokenBucket(limits.bytesPerSec, limits.bytesBurst, now);
    this.chat = new TokenBucket(limits.chatPerSec, limits.chatBurst, now);
    this.votes = new TokenBucket(limits.votesPerSec, limits.voteBurst, now);
    this.windowStart = now;
  }

  /** @returns False if this message exceeds the message or byte rate. */
  admit(now: number, size: number): boolean {
    return this.messages.take(now) && this.bytes.take(now, size);
  }

  /** @returns False if a chat message would exceed the chat rate. */
  admitChat(now: number): boolean {
    return this.chat.take(now);
  }

  /** @returns False if a round-vote ballot would exceed the vote rate. */
  admitVote(now: number): boolean {
    return this.votes.take(now);
  }

  /**
   * Records a violation.
   *
   * @returns True when the client crossed the kick threshold.
   */
  violation(now: number): boolean {
    if (now - this.windowStart > this.limits.violationWindowMs) {
      this.windowStart = now;
      this.violations = 0;
    }
    return ++this.violations > this.limits.maxViolations;
  }
}

/**
 * Rejects input sequence numbers a real client cannot have produced: a client
 * makes one input per 60 Hz step, so its newest sequence can't run ahead of
 * the wall clock (with slack for a fast clock, bursts and a startup backlog).
 */
export class InputSequenceGuard {
  private baseSeq = -1;
  private baseAt = 0;

  /**
   * @param stepMs - Client step length.
   * @param slackSteps - Extra steps tolerated beyond wall-clock pacing.
   */
  constructor(
    private readonly stepMs = 1000 / 60,
    private readonly slackSteps = 180,
  ) {}

  /** @returns True if `newestSeq` is plausible at time `now`. */
  check(newestSeq: number, now: number): boolean {
    if (this.baseSeq < 0) {
      this.baseSeq = newestSeq;
      this.baseAt = now;
      return true;
    }
    const allowed = this.baseSeq + ((now - this.baseAt) / this.stepMs) * 1.1 + this.slackSteps;
    if (newestSeq > allowed) return false;
    // A client whose clock ran slow (tab hidden) keeps a stale base forever; re-anchor once it lags far behind.
    if (newestSeq < allowed - 2 * this.slackSteps - 600) {
      this.baseSeq = newestSeq;
      this.baseAt = now;
    }
    return true;
  }

  /** Forgets the anchor (session resumed). */
  reset(): void {
    this.baseSeq = -1;
  }
}

/** Clamps an untrusted display name. */
export function sanitizeName(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 20);
  return clean.length > 0 ? clean : 'Tumbler';
}
