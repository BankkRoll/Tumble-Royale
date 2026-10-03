/**
 * One-shot migration runner: `pnpm --filter @tumble/api migrate` (or
 * `node dist/migrate.js` in the container image).
 *
 * Applies pending SQL migrations and exits; status 0 means the schema is
 * current. It needs only the database settings, not the API's secrets, so a
 * deploy pipeline can run it before rolling out new API instances and then
 * start those with `MIGRATE_ON_BOOT=0`. It takes the same advisory lock as
 * an API boot, so running both at once is safe.
 */
import { resolve } from 'node:path';
import { EnvIssues, loadEnvFiles } from '@tumble/shared/env';
import { openDatabase } from './db/client.ts';

loadEnvFiles(resolve(import.meta.dirname, '..'));
const issues = new EnvIssues(process.env);
const databaseUrl = issues.optional('DATABASE_URL');
const pgliteDir = issues.optional('PGLITE_DIR') ?? './.data/pglite';
const poolMax = issues.int('DB_POOL_MAX', 2, { min: 1, max: 500 });
try {
  issues.throwIfAny('api migrate');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const started = Date.now();
const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'unparsable DATABASE_URL';
  }
};
const target = databaseUrl ? `postgres (${host(databaseUrl)})` : `pglite (${pgliteDir})`;
console.log(`[migrate] applying migrations to ${target}`);
const database = await openDatabase({
  databaseUrl,
  pgliteDir,
  poolMax,
  onPoolError: (err) => console.error('[migrate] idle connection error', err.message),
  onLockWait: () => console.log('[migrate] another instance is migrating; waiting for its lock'),
});
try {
  await database.migrate();
  console.log(`[migrate] schema is current (${Date.now() - started} ms)`);
} catch (err) {
  console.error('[migrate] failed; the transaction was rolled back and nothing was applied');
  console.error(err);
  process.exitCode = 1;
} finally {
  await database.close();
}
