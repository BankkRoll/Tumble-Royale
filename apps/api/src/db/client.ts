/**
 * Database bootstrap: node-postgres when `DATABASE_URL` is set, embedded PGlite
 * otherwise. Both run the same Drizzle schema and the same SQL migrations.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema.ts';

/** The schema module, for typed relational access. */
export type Schema = typeof schema;

/** Driver-agnostic Drizzle database handle. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

/** A transaction handle; every service function accepts either. */
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** A database or an open transaction. */
export type DbOrTx = Db | Tx;

/** An open database with its lifecycle hooks. */
export interface Database {
  db: Db;
  /** Which driver is in use, for logs and `/health`. */
  driver: 'postgres' | 'pglite';
  /** Applies pending migrations from `apps/api/drizzle`. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

// NOTE: this module runs from `src/db/` under tsx and from the `dist/` bundle in
// production, so the migrations folder is one or two levels up.
const MIGRATIONS_DIR =
  ['../../drizzle', '../drizzle']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((dir) => existsSync(join(dir, 'meta', '_journal.json'))) ??
  fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Key of the session-level advisory lock held while migrating. Any constant
 * works as long as every API version uses the same one.
 */
export const MIGRATION_LOCK_KEY = 7_360_001;

/** Options for {@link openDatabase}. */
export interface OpenDatabaseOptions {
  /** Postgres URL; when absent PGlite is used. */
  databaseUrl: string | undefined;
  /** PGlite directory, or `memory://` for an ephemeral database. */
  pgliteDir: string;
  /** Postgres pool size (default 10). */
  poolMax?: number;
  /** Errors of idle pooled connections (server restart, network blip). */
  onPoolError?: (err: Error) => void;
  /** Called once when another instance holds the migration lock. */
  onLockWait?: () => void;
}

/**
 * Applies pending migrations while holding a Postgres advisory lock, so API
 * replicas (or a `migrate` job and an API) starting together run them once
 * instead of racing on the same DDL.
 *
 * The lock and the migration share one dedicated connection: the lock is
 * session-scoped and dies with that connection, so a crashed or killed
 * migrator never leaves it held. Drizzle applies all pending migrations in
 * one transaction, so an interrupted run rolls back completely and the next
 * run retries it.
 */
async function migrateWithLock(pool: pg.Pool, onLockWait?: () => void): Promise<void> {
  const client = await pool.connect();
  let failed = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [
      MIGRATION_LOCK_KEY,
    ]);
    if (!rows[0]?.locked) {
      onLockWait?.();
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    }
    try {
      await migratePg(drizzlePg({ client, schema }), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
        failed = true;
      });
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // A connection that failed mid-migration may still hold the lock or be broken; destroy it, never reuse it.
    client.release(failed);
  }
}

/**
 * Opens the database.
 *
 * @param opts - Connection settings.
 */
export async function openDatabase(opts: OpenDatabaseOptions): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: opts.poolMax ?? 10 });
    // IMPORTANT: without a listener, an idle client's error (Postgres restart) is an uncaught exception.
    pool.on('error', (err) => opts.onPoolError?.(err));
    const db = drizzlePg({ client: pool, schema });
    return {
      db: db as unknown as Db,
      driver: 'postgres',
      migrate: () => migrateWithLock(pool, opts.onLockWait),
      close: () => pool.end(),
    };
  }
  if (!opts.pgliteDir.startsWith('memory://')) mkdirSync(opts.pgliteDir, { recursive: true });
  const client = await PGlite.create(opts.pgliteDir);
  const db = drizzlePglite({ client, schema });
  return {
    // Driver-specific result HKTs differ only in raw `execute()` row typing,
    // which this codebase never relies on; the query builder API is identical.
    db: db as unknown as Db,
    driver: 'pglite',
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.close(),
  };
}
