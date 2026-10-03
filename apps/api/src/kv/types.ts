/**
 * Key-value contract used for ephemeral and fast-changing state: parties,
 * presence, OAuth state, replay nonces, leaderboards (sorted sets) and the
 * realtime fan-out (pub/sub). Redis implements it in production; an in-process
 * map implements it for local dev and tests.
 */

/** One member of a sorted set with its score. */
export interface ScoredMember {
  member: string;
  score: number;
}

/** Callback for pub/sub messages. */
export type MessageHandler = (message: string) => void;

/** Key-value + sorted-set + pub/sub store. All TTLs are in milliseconds. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Sets only when the key is absent. Returns true when the value was written. */
  setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  /** Atomically reads and deletes a key (one-time tokens). */
  getDel(key: string): Promise<string | null>;
  /** Atomic increment; sets the TTL when the key is created. */
  incr(key: string, ttlMs?: number): Promise<number>;

  zadd(key: string, score: number, member: string): Promise<void>;
  zincrby(key: string, delta: number, member: string): Promise<number>;
  zrem(key: string, member: string): Promise<void>;
  zscore(key: string, member: string): Promise<number | null>;
  /** Zero-based rank, highest score first; null when absent. */
  zrevrank(key: string, member: string): Promise<number | null>;
  /** Members by descending score, inclusive indices like Redis ZREVRANGE. */
  zrevrange(key: string, start: number, stop: number): Promise<ScoredMember[]>;
  zcard(key: string): Promise<number>;

  publish(channel: string, message: string): Promise<void>;
  /** Subscribes to a channel; the returned function unsubscribes this handler. */
  subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>>;

  close(): Promise<void>;
}
