/**
 * Storage backends for suites that should also prove themselves on real
 * infrastructure: the in-memory pair (MemoryKV + PGlite) always, plus Redis
 * and Postgres when `REDIS_URL` and `DATABASE_URL` are set (CI service
 * containers). Locally without them the real-infra rows are simply absent.
 */

/** One storage setup a suite runs against. */
export interface Backend {
  /** Label used in the `describe.each` title. */
  name: string;
  /** Extra environment for `createTestApi`. */
  env: Record<string, string>;
  /** Waits for pub/sub delivery: synchronous in memory, a network hop on Redis. */
  settle(): Promise<void>;
}

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;

/** The memory backend plus, when configured, Redis + Postgres. */
export const BACKENDS: readonly Backend[] = [
  // Empty URLs keep this row on memory even when the whole suite runs on real servers.
  { name: 'memory', env: { DATABASE_URL: '', REDIS_URL: '' }, settle: () => Promise.resolve() },
  ...(redisUrl && databaseUrl
    ? [
        {
          name: 'redis+postgres',
          env: { REDIS_URL: redisUrl, DATABASE_URL: databaseUrl },
          settle: () => new Promise<void>((r) => setTimeout(r, 100)),
        },
      ]
    : []),
];
