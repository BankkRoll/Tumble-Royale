/**
 * Real backing services for the test suite.
 *
 * CI runs this suite a second time against Postgres and Redis service
 * containers by setting `DATABASE_URL` and `REDIS_URL`; locally both are
 * normally unset and every test API gets in-memory PGlite and the in-process
 * KV. These are the only environment variables the tests read.
 *
 * - Postgres: each test API gets its own freshly created database, so tests
 *   (and the two vitest workers) never see each other's rows, exactly like a
 *   fresh PGlite.
 * - Redis: each test API gets its own key prefix for the same reason.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { RedisKV } from '../src/kv/redis.ts';

/** Postgres server for the suite, or undefined to use PGlite. */
export const TEST_DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;

/** Redis server for the suite, or undefined to use the in-process KV. */
export const TEST_REDIS_URL = process.env.REDIS_URL?.trim() || undefined;

/** A database created for one test API. */
export interface ScratchDatabase {
  /** Connection string of the new database. */
  url: string;
  /** Drops the database, closing any connection still open to it. */
  drop(): Promise<void>;
}

async function admin<T>(serverUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates an empty database on the server `serverUrl` points at.
 *
 * @param serverUrl - Any database on the server the account may create databases from.
 * @returns The new database's URL and a way to drop it.
 */
export async function createScratchDatabase(serverUrl: string): Promise<ScratchDatabase> {
  const name = `tumble_test_${randomBytes(6).toString('hex')}`;
  await admin(serverUrl, (c) => c.query(`create database ${name}`));
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    // `with (force)` (Postgres 13+) ends connections a test left open instead of failing.
    drop: () =>
      admin(serverUrl, (c) => c.query(`drop database if exists ${name} with (force)`)).then(() => {}),
  };
}

/**
 * A Redis KV whose keys cannot collide with another test API's.
 *
 * @param url - Redis server.
 */
export function isolatedRedisKV(url: string): RedisKV {
  return new RedisKV(url, `tumble-test:${randomBytes(6).toString('hex')}:`);
}
