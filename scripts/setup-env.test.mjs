import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENV_DIRS, fillSecrets, setupEnv } from './setup-env.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = ['JWT_SECRET', 'INTERNAL_HMAC_SECRET', 'GAME_TICKET_SECRET', 'GAME_SERVER_SECRET'];

describe('fillSecrets', () => {
  it('replaces only NAME=change-me lines, keeping CRLF line endings', () => {
    const out = fillSecrets('A=change-me\r\n# B=change-me\nC=keep\nD=change-me', (n) => Buffer.alloc(n, 1));
    const secret = Buffer.alloc(32, 1).toString('base64url');
    assert.equal(out, `A=${secret}\r\n# B=change-me\nC=keep\nD=${secret}`);
  });
});

describe('setupEnv', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tumble-setup-env-'));
    for (const dir of ENV_DIRS) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, '.env.example'), readFileSync(join(repo, dir, '.env.example')));
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes every .env with fresh, distinct secrets the services accept', () => {
    assert.ok(setupEnv(root).every((r) => r.status === 'created'));
    const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
    const values = SECRETS.map((k) => env[k] ?? '');
    for (const v of values) assert.match(v, /^[\w-]{43}$/);
    assert.equal(new Set(values).size, SECRETS.length);
    for (const v of Object.values(env)) assert.doesNotMatch(v ?? '', /change-?me/i);
    assert.deepEqual(parseEnv(readFileSync(join(root, 'apps/api/.env'), 'utf8')), {});
  });

  it('never overwrites an existing .env', () => {
    writeFileSync(join(root, '.env'), 'JWT_SECRET=mine\n');
    const results = setupEnv(root);
    assert.equal(results[0]?.status, 'exists');
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'JWT_SECRET=mine\n');
    assert.ok(setupEnv(root).every((r) => r.status === 'exists'));
  });
});

describe('.env.example files', () => {
  it('give every root secret a placeholder and leave app secrets to the root file', () => {
    const root = parseEnv(readFileSync(join(repo, '.env.example'), 'utf8'));
    for (const k of SECRETS) assert.equal(root[k], 'change-me');
    for (const dir of ENV_DIRS.slice(1)) {
      const app = parseEnv(readFileSync(join(repo, dir, '.env.example'), 'utf8'));
      for (const k of SECRETS) assert.equal(app[k], undefined, `${dir} must not set ${k}`);
    }
  });
});
