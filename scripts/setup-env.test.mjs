import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ENV_DIRS,
  fillSecrets,
  parseCliArgs,
  PRODUCTION_ENV_FILE,
  PRODUCTION_SECRETS,
  productionEnv,
  setupEnv,
  setupProductionEnv,
  UsageError,
} from './setup-env.mjs';

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

describe('parseCliArgs', () => {
  it('reads production options in both spellings', () => {
    assert.deepEqual(
      parseCliArgs(['--production', '--domain', 'Play.Example.com', '--email=Me@Example.com']),
      {
        production: true,
        ifMissing: false,
        force: false,
        domain: 'play.example.com',
        email: 'me@example.com',
      },
    );
    assert.equal(parseCliArgs(['--if-missing']).ifMissing, true);
  });

  it('rejects unknown, incomplete and misplaced options', () => {
    assert.throws(() => parseCliArgs(['--prod']), UsageError);
    assert.throws(() => parseCliArgs(['--production']), /--domain/);
    assert.throws(() => parseCliArgs(['--production', '--domain']), /needs a value/);
    assert.throws(() => parseCliArgs(['--production', '--domain', '--force']), /needs a value/);
    assert.throws(() => parseCliArgs(['--domain', 'example.com']), /only apply with --production/);
    assert.throws(() => parseCliArgs(['--force']), /only apply with --production/);
  });
});

describe('setupProductionEnv', () => {
  let root = '';
  let n = 0;
  // Distinct, recognisable bytes per call.
  const random = (bytes) => Buffer.alloc(bytes, ++n);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tumble-setup-env-prod-'));
    n = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const read = () => parseEnv(readFileSync(join(root, PRODUCTION_ENV_FILE), 'utf8'));

  it('writes deploy/.env with fresh secrets and the URLs for the domain', () => {
    const result = setupProductionEnv(root, { domain: 'play.example.com', email: 'ops@example.com' });
    assert.equal(result.status, 'created');
    const env = read();
    const pick = (keys) => Object.fromEntries(keys.map((k) => [k, env[k]]));
    assert.deepEqual(
      pick([
        'DOMAIN',
        'ACME_EMAIL',
        'NODE_ENV',
        'PUBLIC_WEB_URL',
        'PUBLIC_API_URL',
        'PUBLIC_WS_URL',
        'CORS_ORIGINS',
        'ALLOWED_ORIGINS',
        'TRUST_PROXY',
      ]),
      {
        DOMAIN: 'play.example.com',
        ACME_EMAIL: 'ops@example.com',
        NODE_ENV: 'production',
        PUBLIC_WEB_URL: 'https://play.example.com',
        PUBLIC_API_URL: 'https://play.example.com/api',
        PUBLIC_WS_URL: 'wss://play.example.com/gs/ws',
        CORS_ORIGINS: 'https://play.example.com',
        ALLOWED_ORIGINS: 'https://play.example.com',
        TRUST_PROXY: '1',
      },
    );
    const secrets = PRODUCTION_SECRETS.map((k) => env[k] ?? '');
    for (const v of secrets) assert.match(v, /^[\w-]{43}$/);
    assert.equal(new Set(secrets).size, PRODUCTION_SECRETS.length);
    assert.equal(env.DATABASE_URL, `postgres://tumble:${env.POSTGRES_PASSWORD}@postgres:5432/tumble`);
    assert.equal(new URL(env.DATABASE_URL ?? '').password, env.POSTGRES_PASSWORD);
    // Redis gets a password of its own, carried in the URL the services connect with.
    assert.equal(env.REDIS_URL, `redis://:${env.REDIS_PASSWORD}@redis:6379`);
    assert.equal(new URL(env.REDIS_URL ?? '').password, env.REDIS_PASSWORD);
    assert.notEqual(env.GAME_SERVER_HMAC_SECRET, env.INTERNAL_HMAC_SECRET);
    for (const v of Object.values(env)) assert.doesNotMatch(v ?? '', /change-?me/i);
  });

  it('never replaces deploy/.env without --force', () => {
    setupProductionEnv(root, { domain: 'a.example.com', random });
    const before = readFileSync(join(root, PRODUCTION_ENV_FILE), 'utf8');
    assert.equal(setupProductionEnv(root, { domain: 'b.example.com', random }).status, 'exists');
    assert.equal(readFileSync(join(root, PRODUCTION_ENV_FILE), 'utf8'), before);
  });

  it('with --force, renews the secrets but keeps the database password', () => {
    setupProductionEnv(root, { domain: 'a.example.com', random });
    const first = read();
    const result = setupProductionEnv(root, { domain: 'b.example.com', force: true, random });
    assert.deepEqual([result.status, result.keptPostgresPassword], ['replaced', true]);
    const second = read();
    assert.equal(second.DOMAIN, 'b.example.com');
    assert.equal(second.POSTGRES_PASSWORD, first.POSTGRES_PASSWORD);
    assert.equal(second.DATABASE_URL, first.DATABASE_URL);
    assert.notEqual(second.JWT_SECRET, first.JWT_SECRET);
  });

  it('rejects a URL or a malformed email before touching any file', () => {
    for (const domain of ['https://example.com', 'example.com/x', 'exa mple.com', '-x.com', '']) {
      assert.throws(() => setupProductionEnv(root, { domain }), UsageError, domain);
    }
    assert.throws(() => setupProductionEnv(root, { domain: 'example.com', email: 'a b@c.d' }), UsageError);
    assert.throws(() => setupProductionEnv(root, { domain: 'example.com', email: 'nobody' }), UsageError);
    assert.throws(() => readFileSync(join(root, PRODUCTION_ENV_FILE)), { code: 'ENOENT' });
  });

  it('matches the committed deploy/.env.example layout', () => {
    const example = productionEnv({ domain: 'example.com', secret: () => 'change-me' });
    assert.equal(readFileSync(join(repo, 'deploy/.env.example'), 'utf8').replace(/\r\n/g, '\n'), example);
  });
});
