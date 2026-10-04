/**
 * Stores for suites that should also prove themselves on real
 * infrastructure: the in-memory store always, plus Redis when `REDIS_URL` is
 * set (CI service container). Locally without it the Redis row is absent.
 */

/** One store setup a suite runs against. */
export interface Backend {
  /** Label used in the `describe.each` title. */
  name: string;
  /** Extra environment for `loadConfig`. */
  env: Record<string, string>;
}

const redisUrl = process.env.REDIS_URL;

/** The memory store plus, when configured, Redis. */
export const BACKENDS: readonly Backend[] = [
  { name: 'memory', env: {} },
  ...(redisUrl ? [{ name: 'redis', env: { REDIS_URL: redisUrl } }] : []),
];
