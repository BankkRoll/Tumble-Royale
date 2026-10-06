/**
 * Keeps the environment examples and docs in step with the code.
 *
 * Every variable a service, script or deploy file reads is found by scanning
 * the source (config loaders, `process.env`, `import.meta.env`, compose and
 * Caddy interpolation, the backup script), then checked against:
 * - `deploy/.env.example` (the whole compose stack) and
 *   `deploy/game-server/.env.example` (a standalone game server), where it may
 *   be set or commented out;
 * - the development examples (`.env.example` plus `apps/<name>/.env.example`);
 * - the reference table in `docs/SELF_HOSTING.md`.
 * It also fails on example entries that nothing reads any more.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

/** Non-test TypeScript sources under `dir`. */
function sources(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(join(root, d))) {
      const rel = `${d}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

const KEY = '[A-Z][A-Z0-9_]*';

/**
 * Environment variable names a TypeScript file reads.
 *
 * Recognises `EnvIssues` reads (`issues.secret('X')` …), `process.env.X`, the
 * `TRUST_PROXY`/`NODE_ENV` helpers and, in config loaders, zod schema keys and
 * `'PREFIX_NAME'` string literals (the OAuth and Apple key lists).
 *
 * @param {string} file - Path relative to the repository root.
 * @returns {Set<string>}
 */
function tsEnvKeys(file) {
  // Comments hold examples (`issues.secret('JWT_SECRET', 32)`) that read nothing.
  const text = read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const keys = new Set();
  const add = (re) => {
    for (const m of text.matchAll(re)) keys.add(m[1]);
  };
  add(new RegExp(`\\bissues\\.(?:secret|optional|int|flag|url)\\(\\s*['"\`](${KEY})['"\`]`, 'g'));
  add(new RegExp(`process\\.env\\.(${KEY})`, 'g'));
  // Vite's own flags (MODE, DEV, BASE_URL) are not configuration; only VITE_* is.
  add(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g);
  if (/\.trustProxy\(\)/.test(text) || /trustProxy\(name = 'TRUST_PROXY'\)/.test(text))
    keys.add('TRUST_PROXY');
  if (/\.nodeEnv\(\)/.test(text)) keys.add('NODE_ENV');
  if (/(^|\/)config\.ts$/.test(file)) {
    add(new RegExp(`^ {2}(${KEY}): `, 'gm'));
    add(new RegExp(`'([A-Z][A-Z0-9]*_[A-Z0-9_]+)'`, 'g'));
    // `pair(issues, 'GITHUB')` reads GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.
    for (const m of text.matchAll(/\bpair\(issues, '([A-Z]+)'\)/g)) {
      keys.add(`${m[1]}_CLIENT_ID`);
      keys.add(`${m[1]}_CLIENT_SECRET`);
    }
  }
  return keys;
}

/** `${VAR}` / `${VAR:-x}` in a compose file or shell script (not `$${VAR}`, which compose escapes). */
function interpolatedKeys(file) {
  const keys = new Set();
  for (const m of read(file).matchAll(new RegExp(`(?<!\\$)\\$\\{(${KEY})`, 'g'))) keys.add(m[1]);
  return keys;
}

/** `{$VAR}` / `{$VAR:default}` in a Caddyfile. */
function caddyKeys(file) {
  return new Set([...read(file).matchAll(new RegExp(`\\{\\$(${KEY})`, 'g'))].map((m) => m[1]));
}

/** `env.X` reads in a plain script. */
function scriptKeys(file) {
  return new Set([...read(file).matchAll(new RegExp(`\\benv\\.(${KEY})`, 'g'))].map((m) => m[1]));
}

const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
const shared = union(...sources('packages/shared/src').map(tsEnvKeys));
const service = (dir) => union(shared, ...sources(dir).map(tsEnvKeys));

/** What each consumer reads. */
const READS = {
  api: service('apps/api/src'),
  matchmaker: service('apps/matchmaker/src'),
  'game-server': service('apps/game-server/src'),
  client: union(...sources('apps/client/src').map(tsEnvKeys), scriptKeys('apps/client/vite.config.ts')),
  'pnpm admin': scriptKeys('scripts/admin.mjs'),
  compose: union(interpolatedKeys('deploy/docker-compose.yml'), caddyKeys('deploy/Caddyfile')),
  backup: interpolatedKeys('deploy/backup.sh'),
  'game-server compose': union(
    interpolatedKeys('deploy/game-server/docker-compose.yml'),
    caddyKeys('deploy/game-server/Caddyfile'),
  ),
};

/**
 * Names in an env file, set (`KEY=`) or commented out (`# KEY=`).
 *
 * @param {string} file
 * @returns {Set<string>}
 */
function exampleKeys(file) {
  return new Set([...read(file).matchAll(new RegExp(`^(?:# ?)?(${KEY})=`, 'gm'))].map((m) => m[1]));
}

// Standard libpq variables the compose file sets for the backup container from POSTGRES_*.
const LIBPQ = new Set(['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']);

const missing = (needed, have) => [...needed].filter((k) => !have.has(k)).sort();

describe('environment variable coverage', () => {
  it('finds the variables (the scanner still understands the config loaders)', () => {
    for (const [who, keys] of Object.entries(READS)) assert.ok(keys.size > 0, `${who}: nothing found`);
    for (const k of [
      'JWT_SECRET',
      'GITHUB_CLIENT_SECRET',
      'APPLE_PRIVATE_KEY',
      'TRUST_PROXY',
      'METRICS_TOKEN',
    ])
      assert.ok(READS.api.has(k), `api: ${k}`);
    for (const k of ['GAME_TICKET_SECRET', 'ROOM_CAPACITY', 'NODE_ENV', 'INTERNAL_PORT'])
      assert.ok(READS['game-server'].has(k), `game-server: ${k}`);
    assert.ok(READS.client.has('VITE_API_URL') && READS.client.has('GAME_SERVER_URL'));
  });

  it('lists everything the compose stack reads in deploy/.env.example', () => {
    const needed = union(
      READS.api,
      READS.matchmaker,
      READS['game-server'],
      READS['pnpm admin'],
      READS.compose,
      READS.backup,
    );
    for (const k of LIBPQ) needed.delete(k);
    assert.deepEqual(missing(needed, exampleKeys('deploy/.env.example')), []);
  });

  it('lists everything a standalone game server reads in deploy/game-server/.env.example', () => {
    const needed = union(READS['game-server'], READS['game-server compose']);
    assert.deepEqual(missing(needed, exampleKeys('deploy/game-server/.env.example')), []);
  });

  it('lists every variable of each service in its development examples', () => {
    const rootKeys = exampleKeys('.env.example');
    for (const [who, dir] of [
      ['api', 'apps/api'],
      ['matchmaker', 'apps/matchmaker'],
      ['game-server', 'apps/game-server'],
    ]) {
      const have = union(rootKeys, exampleKeys(`${dir}/.env.example`));
      assert.deepEqual(missing(READS[who], have), [], `${dir}/.env.example (or .env.example)`);
    }
    assert.deepEqual(missing(READS.client, exampleKeys('apps/client/.env.example')), []);
  });

  it('has no example entries that nothing reads', () => {
    const everything = union(...Object.values(READS));
    for (const file of [
      '.env.example',
      'apps/api/.env.example',
      'apps/matchmaker/.env.example',
      'apps/game-server/.env.example',
      'apps/client/.env.example',
      'deploy/.env.example',
      'deploy/game-server/.env.example',
    ]) {
      assert.deepEqual(missing(exampleKeys(file), everything), [], `${file} has stale entries`);
    }
  });

  it('documents every variable in the docs/SELF_HOSTING.md reference', () => {
    const doc = read('docs/SELF_HOSTING.md');
    const everything = union(...Object.values(READS));
    for (const k of LIBPQ) everything.delete(k);
    const undocumented = [...everything].filter((k) => !doc.includes(`| \`${k}\``)).sort();
    assert.deepEqual(undocumented, [], 'add a row to the "Environment reference" tables');
  });

  it('keeps deploy/client-config/config.json.example in step with the runtime config', () => {
    const source = read('apps/client/src/runtimeConfig.ts');
    const block = /export interface RuntimeConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const fields = [...block.matchAll(/^ {2}(\w+)\?: /gm)].map((m) => m[1]);
    const example = Object.keys(JSON.parse(read('deploy/client-config/config.json.example')));
    assert.deepEqual(example.sort(), [...new Set(fields)].sort());
  });
});
