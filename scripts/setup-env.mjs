#!/usr/bin/env node
/**
 * Creates local `.env` files from the repository's `.env.example` files.
 *
 * - The root `.env` gets freshly generated secrets for every `NAME=change-me`
 *   line; the API, matchmaker and game server all load it, so they share them.
 * - Each app's `.env.example` is copied to its `.env` as-is (all overrides
 *   start commented out).
 * - An existing `.env` is never overwritten.
 *
 * Usage: `pnpm setup:env` (reports each file) or `--if-missing` (quiet unless
 * it creates something; runs before every `pnpm dev`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directories, relative to the repository root, that have a `.env.example`. */
export const ENV_DIRS = ['.', 'apps/api', 'apps/matchmaker', 'apps/game-server', 'apps/client'];

// The lookahead keeps CRLF checkouts (Windows autocrlf) working.
const PLACEHOLDER_LINE = /^([A-Z][A-Z0-9_]*)=change-me(?=\r?$)/gm;

/**
 * Replaces every `NAME=change-me` line with a random 256-bit secret.
 *
 * @param {string} text - `.env.example` contents.
 * @param {(bytes: number) => Buffer} [random] - Byte source (tests inject one).
 * @returns {string} The text with secrets filled in.
 */
export function fillSecrets(text, random = randomBytes) {
  return text.replace(PLACEHOLDER_LINE, (_, name) => `${name}=${random(32).toString('base64url')}`);
}

/**
 * Writes every missing `.env` next to its `.env.example`.
 *
 * @param {string} root - Repository root.
 * @returns {{ file: string, status: 'created' | 'exists' | 'no-example' }[]} One entry per directory.
 */
export function setupEnv(root) {
  return ENV_DIRS.map((dir) => {
    const example = join(root, dir, '.env.example');
    const file = join(root, dir, '.env');
    if (existsSync(file)) return { file, status: 'exists' };
    if (!existsSync(example)) return { file, status: 'no-example' };
    writeFileSync(file, fillSecrets(readFileSync(example, 'utf8')), { flag: 'wx' });
    return { file, status: 'created' };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const quiet = process.argv.includes('--if-missing');
  for (const { file, status } of setupEnv(root)) {
    if (quiet && status !== 'created') continue;
    console.log(
      `[setup:env] ${relative(root, file)}: ${status === 'exists' ? 'kept existing file' : status}`,
    );
  }
}
