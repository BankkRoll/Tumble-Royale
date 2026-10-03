import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvConfigError, EnvIssues, loadEnvFiles } from '../src/env.ts';

describe('EnvIssues', () => {
  it('collects every problem and throws them together', () => {
    const issues = new EnvIssues({
      A: 'change-me-please-0123',
      B: 'short',
      N: '1.5',
      F: 'yes',
      U: 'ftp://x',
    });
    expect(issues.secret('A', 8)).toBe('');
    expect(issues.secret('B', 8)).toBe('');
    expect(issues.secret('MISSING', 8)).toBe('');
    expect(issues.int('N', 3)).toBe(3);
    expect(issues.flag('F', true)).toBe(true);
    expect(issues.url('U', ['http:', 'https:'])).toBeUndefined();
    expect(() => issues.throwIfAny('svc')).toThrow(EnvConfigError);
    expect(issues.list.map((i) => i.name)).toEqual(['A', 'B', 'MISSING', 'N', 'F', 'U']);
  });

  it('parses valid values', () => {
    const issues = new EnvIssues({ S: ' a-real-secret ', N: '42', F: '0', U: 'https://x.test/' });
    expect(issues.secret('S', 8)).toBe('a-real-secret');
    expect(issues.int('N', 1, { min: 1, max: 50 })).toBe(42);
    expect(issues.flag('F', true)).toBe(false);
    expect(issues.url('U', ['https:'])).toBe('https://x.test');
    expect(issues.optional('UNSET')).toBeUndefined();
    expect(() => issues.throwIfAny('svc')).not.toThrow();
  });
});

describe('loadEnvFiles', () => {
  let root = '';
  const keys = ['TR_ENV_SHARED', 'TR_ENV_APP', 'TR_ENV_REAL'];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('prefers the real environment, then the app .env, then the root .env', () => {
    root = mkdtempSync(join(tmpdir(), 'tumble-env-'));
    const app = join(root, 'apps', 'svc');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(root, '.env'), 'TR_ENV_SHARED=root\nTR_ENV_APP=root\nTR_ENV_REAL=root\n');
    writeFileSync(join(app, '.env'), 'TR_ENV_APP=app\n');
    process.env.TR_ENV_REAL = 'real';
    expect(loadEnvFiles(app)).toHaveLength(2);
    expect([process.env.TR_ENV_SHARED, process.env.TR_ENV_APP, process.env.TR_ENV_REAL]).toEqual([
      'root',
      'app',
      'real',
    ]);
  });

  it('skips missing files', () => {
    root = mkdtempSync(join(tmpdir(), 'tumble-env-'));
    expect(loadEnvFiles(join(root, 'apps', 'svc'))).toEqual([]);
  });
});
