/**
 * Schema drift: the Drizzle schema (`src/db/schema.ts`), the latest
 * drizzle-kit snapshot and the database the SQL migrations actually build must
 * all describe the same tables, columns, indexes and constraints. A schema
 * change without `drizzle-kit generate`, or a hand-edited migration that does
 * not match the schema, fails here.
 *
 * The migrated database is compared with one created straight from the schema
 * (drizzle-kit's SQL for "nothing → schema"), through the Postgres catalog.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';

type Snapshot = Parameters<typeof generateMigration>[0];

const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

function latestSnapshot(): Snapshot {
  const journal = JSON.parse(readFileSync(`${drizzleDir}meta/_journal.json`, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const last = journal.entries.at(-1)!;
  const file = `${drizzleDir}meta/${String(last.idx).padStart(4, '0')}_snapshot.json`;
  return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
}

/** Tables, columns, indexes and constraints of the `public` schema, normalised for comparison. */
async function catalog(query: (sql: string) => Promise<Record<string, unknown>[]>): Promise<string[]> {
  const columns = await query(`
    select table_name, column_name, data_type, udt_name, is_nullable, column_default
    from information_schema.columns where table_schema = 'public'
    order by table_name, column_name`);
  const indexes = await query(`
    select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
    order by tablename, indexname`);
  const constraints = await query(`
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where connamespace = 'public'::regnamespace and contype in ('p','f','u','c')
    order by 1, 2`);
  return [
    ...columns.map(
      (c) =>
        `column ${c.table_name}.${c.column_name} ${c.data_type}/${c.udt_name} null=${c.is_nullable} default=${String(c.column_default)}`,
    ),
    ...indexes.map((i) => `index ${i.tablename}.${i.indexname}: ${i.indexdef}`),
    ...constraints.map((c) => `constraint ${c.tbl}.${c.conname}: ${c.def}`),
  ];
}

describe('schema drift', () => {
  let migrated: Database;
  let fromSchema: PGlite;
  beforeAll(async () => {
    migrated = await openDatabase({ databaseUrl: undefined, pgliteDir: 'memory://' });
    await migrated.migrate();
    fromSchema = await PGlite.create('memory://');
    const create = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
    for (const statement of create) await fromSchema.exec(statement);
  });
  afterAll(async () => {
    await migrated?.close();
    await fromSchema?.close();
  });

  it('the latest snapshot matches the Drizzle schema', async () => {
    const statements = await generateMigration(latestSnapshot(), generateDrizzleJson(schema));
    expect(statements).toEqual([]);
  });

  it('the migrated database matches the Drizzle schema', async () => {
    const actual = await catalog(async (sql) => {
      const r = await migrated.db.execute(sql);
      return (Array.isArray(r) ? r : (r as { rows: Record<string, unknown>[] }).rows) as Record<
        string,
        unknown
      >[];
    });
    const expected = await catalog(
      async (sql) => (await fromSchema.query<Record<string, unknown>>(sql)).rows,
    );
    // Drizzle's own bookkeeping lives in the `drizzle` schema, so neither side lists it.
    expect(actual).toEqual(expected);
  });
});
