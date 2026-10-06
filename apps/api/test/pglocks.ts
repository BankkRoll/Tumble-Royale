/**
 * Deterministic lock interleavings for race tests on real Postgres.
 *
 * PGlite runs one transaction at a time, so races between API requests can
 * only happen on Postgres. Instead of hoping two requests overlap, a test
 * holds a lock on a connection of its own ({@link holdLocks}), starts the
 * requests, waits until Postgres reports them blocked on that lock
 * ({@link waitForLockWaiters}), checks which other locks are still free
 * ({@link isLockFree}), and then releases.
 */
import pg from 'pg';
import type { TestApi } from './helpers.ts';

/** A transaction on its own connection, holding whatever its statements locked. */
export interface HeldLocks {
  /** Runs one more statement inside the held transaction. */
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  /** Commits (keeping the statements' effects) and closes the connection. */
  commit(): Promise<void>;
  /** Rolls back and closes the connection. */
  release(): Promise<void>;
}

/** The scratch Postgres database of a test API, or null on PGlite. */
export function postgresUrl(api: TestApi): string | null {
  return api.ctx.config.databaseUrl ?? null;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Opens a transaction and runs `statements` in it, keeping their locks.
 *
 * @param url - Database (see {@link postgresUrl}).
 * @param statements - SQL with `$n` parameters, e.g. `select 1 from profiles where user_id = $1 for update`.
 */
export async function holdLocks(url: string, statements: [string, unknown[]?][]): Promise<HeldLocks> {
  const client = await connect(url);
  await client.query('begin');
  for (const [sql, params] of statements) await client.query(sql, params);
  let open = true;
  const end = async (verb: 'commit' | 'rollback') => {
    if (!open) return;
    open = false;
    try {
      await client.query(verb);
    } finally {
      await client.end();
    }
  };
  return {
    query: (sql, params) => client.query(sql, params),
    commit: () => end('commit'),
    release: () => end('rollback'),
  };
}

/** Sessions of this database currently waiting for a lock. */
export async function lockWaiters(url: string): Promise<number> {
  const client = await connect(url);
  try {
    const { rows } = await client.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    return Number(rows[0]!.n);
  } finally {
    await client.end();
  }
}

/**
 * Resolves once at least `n` sessions wait for a lock.
 *
 * @throws When that does not happen within `timeoutMs` (the request under
 *   test did not block where the test expected it to).
 */
export async function waitForLockWaiters(url: string, n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await lockWaiters(url)) >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} session(s) waiting for a lock`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Whether a row lock is free right now: tries `select … for update nowait` in
 * a throwaway transaction.
 *
 * @param sql - A `select … for update nowait` statement.
 */
export async function isLockFree(url: string, sql: string, params: unknown[] = []): Promise<boolean> {
  const client = await connect(url);
  try {
    await client.query('begin');
    await client.query(sql, params);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') return false;
    throw err;
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
}

/** `select … for update nowait` on a player's profile row (the wallet lock). */
export const PROFILE_NOWAIT = 'select 1 from profiles where user_id = $1 for update nowait';
/** `select … for update` on a player's profile row (the wallet lock). */
export const PROFILE_LOCK = 'select 1 from profiles where user_id = $1 for update';
