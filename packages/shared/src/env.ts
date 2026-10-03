/**
 * Environment helpers shared by the Node services (API, matchmaker, game
 * server). Browser code must not import this module: it touches `node:fs`.
 *
 * Responsibilities:
 * - Load the repository's `.env` files at startup (`loadEnvFiles`).
 * - Collect every missing or invalid variable so a service reports them all
 *   at once instead of failing on the first (`EnvIssues`, `EnvConfigError`).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A process environment map (`process.env` or a literal in tests). */
export type Env = Record<string, string | undefined>;

/** Deployment mode, from `NODE_ENV`. */
export type NodeEnv = 'development' | 'test' | 'production';

/** One missing or invalid variable. */
export interface EnvIssue {
  name: string;
  message: string;
}

/**
 * Matches the placeholder values used in `.env.example` files, so a copied
 * example can never pass for a real secret.
 */
const PLACEHOLDER = /change-?me/i;

/**
 * Thrown when a service's environment is unusable; lists every problem.
 *
 * @example
 * try { loadConfig(process.env) } catch (e) { if (e instanceof EnvConfigError) console.error(e.message) }
 */
export class EnvConfigError extends Error {
  /**
   * @param service - Service name shown in the message.
   * @param issues - Every problem found.
   */
  constructor(
    service: string,
    readonly issues: readonly EnvIssue[],
  ) {
    super(
      `${service}: invalid environment\n` +
        issues.map((i) => `  - ${i.name}: ${i.message}`).join('\n') +
        '\nFor local development run `pnpm setup:env`; in production set these variables in the environment.',
    );
    this.name = 'EnvConfigError';
  }
}

/**
 * Accumulates environment problems while a config is parsed, then throws them
 * together.
 *
 * @example
 * const issues = new EnvIssues(process.env);
 * const secret = issues.secret('JWT_SECRET', 32);
 * const port = issues.int('PORT', 7350, { min: 1, max: 65535 });
 * issues.throwIfAny('game-server');
 */
export class EnvIssues {
  readonly list: EnvIssue[] = [];

  /** @param env - The environment being parsed. */
  constructor(readonly env: Env) {}

  /** Records a problem with `name`. */
  add(name: string, message: string): void {
    this.list.push({ name, message });
  }

  /**
   * Records zod-style issues (`path[0]` is the variable name).
   *
   * @param issues - Typically `result.error.issues` from `safeParse`.
   */
  addSchemaIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): void {
    for (const i of issues) this.add(String(i.path[0] ?? '(env)'), i.message);
  }

  /**
   * Returns a non-empty, trimmed value, or undefined when unset or blank.
   *
   * @param name - Variable name.
   */
  optional(name: string): string | undefined {
    const v = this.env[name]?.trim();
    return v ? v : undefined;
  }

  /**
   * Reads a required secret. Missing, too-short and example-placeholder values
   * are recorded as issues.
   *
   * @param name - Variable name.
   * @param minLength - Minimum length.
   * @returns The secret, or an empty string when it is unusable (an issue was recorded).
   */
  secret(name: string, minLength: number): string {
    const v = this.optional(name);
    if (v === undefined) this.add(name, 'is required');
    else if (PLACEHOLDER.test(v)) this.add(name, 'still has the placeholder value from .env.example');
    else if (v.length < minLength) this.add(name, `must be at least ${minLength} characters`);
    else return v;
    return '';
  }

  /**
   * Reads an integer, falling back when unset or blank.
   *
   * @param name - Variable name.
   * @param fallback - Value when unset.
   * @param range - Inclusive bounds.
   */
  int(name: string, fallback: number, range: { min?: number; max?: number } = {}): number {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    const v = Number(raw);
    const { min = -Infinity, max = Infinity } = range;
    if (!Number.isInteger(v) || v < min || v > max) {
      const bounds = [Number.isFinite(min) ? `>= ${min}` : '', Number.isFinite(max) ? `<= ${max}` : '']
        .filter(Boolean)
        .join(' and ');
      this.add(name, `must be an integer${bounds ? ` ${bounds}` : ''} (got "${raw}")`);
      return fallback;
    }
    return v;
  }

  /**
   * Reads a `1`/`0` flag.
   *
   * @param name - Variable name.
   * @param fallback - Value when unset.
   */
  flag(name: string, fallback: boolean): boolean {
    const raw = this.optional(name);
    if (raw === undefined) return fallback;
    if (raw === '1' || raw === '0') return raw === '1';
    this.add(name, `must be 1 or 0 (got "${raw}")`);
    return fallback;
  }

  /**
   * Reads an optional absolute URL.
   *
   * @param name - Variable name.
   * @param protocols - Accepted schemes, e.g. `['http:', 'https:']`.
   * @returns The URL without a trailing slash, or undefined when unset.
   */
  url(name: string, protocols: readonly string[]): string | undefined {
    const raw = this.optional(name);
    if (raw === undefined) return undefined;
    try {
      if (protocols.includes(new URL(raw).protocol)) return raw.replace(/\/$/, '');
    } catch {
      // Reported below together with the wrong-scheme case.
    }
    this.add(name, `must be a ${protocols.map((p) => p.replace(':', '')).join('/')} URL (got "${raw}")`);
    return undefined;
  }

  /**
   * Reads `NODE_ENV`, defaulting to development.
   */
  nodeEnv(): NodeEnv {
    const v = this.optional('NODE_ENV') ?? 'development';
    if (v === 'development' || v === 'test' || v === 'production') return v;
    this.add('NODE_ENV', `must be development, test or production (got "${v}")`);
    return 'development';
  }

  /**
   * Throws an {@link EnvConfigError} when any issue was recorded.
   *
   * @param service - Service name for the message.
   */
  throwIfAny(service: string): void {
    if (this.list.length > 0) throw new EnvConfigError(service, this.list);
  }
}

/**
 * Loads `<appDir>/.env` and then the repository root `.env` into
 * `process.env`. `process.loadEnvFile` never overwrites a variable that is
 * already set, so the precedence is: real environment, then the app's `.env`,
 * then the shared root `.env`. Missing files are skipped.
 *
 * @param appDir - The service's package directory (`apps/<name>`).
 * @returns The files that were loaded.
 * @example
 * loadEnvFiles(resolve(import.meta.dirname, '..'));
 */
export function loadEnvFiles(appDir: string): string[] {
  const files = [join(appDir, '.env'), join(resolve(appDir, '../..'), '.env')];
  const loaded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded.push(file);
  }
  return loaded;
}

/**
 * Service entry-point helper: loads the `.env` files, parses the config and,
 * on an {@link EnvConfigError}, prints the issue list and exits with status 1
 * instead of a stack trace.
 *
 * @param appDir - The service's package directory (`apps/<name>`).
 * @param load - The service's `loadConfig`.
 * @returns The parsed config.
 * @example
 * const config = loadServiceConfig(resolve(import.meta.dirname, '..'), loadConfig);
 */
export function loadServiceConfig<T>(appDir: string, load: (env: Env) => T): T {
  loadEnvFiles(appDir);
  try {
    return load(process.env);
  } catch (err) {
    if (!(err instanceof EnvConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
