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
 * Opens the database.
 *
 * @param opts.databaseUrl - Postgres URL; when absent PGlite is used.
 * @param opts.pgliteDir - PGlite directory, or `memory://` for an ephemeral database.
 */
export async function openDatabase(opts: {
  databaseUrl: string | undefined;
  pgliteDir: string;
}): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    const db = drizzlePg({ client: pool, schema });
    return {
      db: db as unknown as Db,
      driver: 'postgres',
      migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_DIR }),
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
