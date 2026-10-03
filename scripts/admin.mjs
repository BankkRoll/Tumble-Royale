#!/usr/bin/env node
/**
 * Admin CLI for a running Tumble Royale API: `pnpm admin <command>`.
 *
 * Calls the API's `/internal/*` admin routes with `ADMIN_TOKEN`. The API URL
 * and token come from `--api-url` / `--token`, else `ADMIN_API_URL` /
 * `ADMIN_TOKEN`, else `PUBLIC_API_URL` / `API_URL`, reading the repository's
 * `.env` and `apps/api/.env` when present (real environment variables win).
 *
 * Exit codes: 0 ok, 1 the API refused or failed, 2 usage error, 3 the API
 * could not be reached.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Usage text. */
export const USAGE = `Usage: pnpm admin <command> [options]

Bans
  bans list [--user <userId>] [--all] [--limit N]   active bans (--all includes expired/revoked)
  bans add <userId> --reason <text> [--scope all|ranked|chat] [--hours N]
  bans remove <banId>
Reports
  reports list                                      open reports, oldest first
  reports resolve <reportId> [--status resolved|dismissed|actioned|open]
News
  news publish <post.json>                          create or replace a live post
  news hide <postId> | news show <postId>           withdraw or restore (bundled posts too)
Feature flags
  flags get [key]
  flags set <key> on|off [--rollout 0-100] [--payload <json>]
Economy
  ledger check <userId>                             verify cached balances against the ledger
Users
  user lookup <userId | name#1234 | email | name>
  user rename <userId> <new display name>

Options
  --api-url <url>   API base URL (default: ADMIN_API_URL, PUBLIC_API_URL, API_URL, http://localhost:7360)
  --token <token>   admin token (default: ADMIN_TOKEN)
  --json            print raw JSON responses
  --help            show this help`;

class UsageError extends Error {}

/**
 * Splits argv into positionals and `--flag [value]` options.
 *
 * @param {string[]} argv
 * @returns {{ args: string[], opts: Record<string, string | true> }}
 */
export function parseArgs(argv) {
  const BOOLEAN = new Set(['json', 'all', 'help']);
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) opts[name] = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) opts[name] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      opts[name] = v;
      i++;
    }
  }
  return { args, opts };
}

function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

/**
 * Environment with the repository `.env` files merged under the real one.
 *
 * @param {string} root - Repository root.
 * @param {Record<string, string | undefined>} env - Real environment.
 */
export function loadEnv(root, env) {
  return { ...readEnvFile(join(root, '.env')), ...readEnvFile(join(root, 'apps/api/.env')), ...env };
}

const enc = encodeURIComponent;

function need(value, what) {
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

/**
 * Maps a command to an HTTP request.
 *
 * @param {string[]} args - Positionals after `admin`.
 * @param {Record<string, string | true>} opts - Options.
 * @param {(file: string) => string} readFile - Reads `news publish` input.
 * @returns {{ method: string, path: string, body?: unknown }}
 */
export function toRequest(args, opts, readFile = (f) => readFileSync(f, 'utf8')) {
  const [group, action, a, ...rest] = args;
  const key = `${group ?? ''} ${action ?? ''}`.trim();
  switch (key) {
    case 'bans list': {
      const q = new URLSearchParams();
      if (opts.user) q.set('userId', String(opts.user));
      if (opts.all) q.set('active', '0');
      if (opts.limit) q.set('limit', String(opts.limit));
      return { method: 'GET', path: `/internal/bans${q.size ? `?${q}` : ''}` };
    }
    case 'bans add': {
      const hours = opts.hours === undefined ? undefined : Number(opts.hours);
      if (hours !== undefined && !(Number.isInteger(hours) && hours > 0))
        throw new UsageError('--hours must be a positive integer');
      return {
        method: 'POST',
        path: '/internal/bans',
        body: {
          userId: need(a, '<userId>'),
          reason: need(typeof opts.reason === 'string' ? opts.reason : '', '--reason'),
          scope: opts.scope ?? 'all',
          ...(hours ? { durationHours: hours } : {}),
        },
      };
    }
    case 'bans remove':
      return { method: 'DELETE', path: `/internal/bans/${enc(need(a, '<banId>'))}` };
    case 'reports list':
      return { method: 'GET', path: '/internal/reports' };
    case 'reports resolve':
      return {
        method: 'PATCH',
        path: `/internal/reports/${enc(need(a, '<reportId>'))}`,
        body: { status: opts.status ?? 'resolved' },
      };
    case 'news publish': {
      const file = need(a, '<post.json>');
      let post;
      try {
        post = JSON.parse(readFile(file));
      } catch (err) {
        throw new UsageError(`cannot read ${file}: ${err instanceof Error ? err.message : err}`);
      }
      return { method: 'POST', path: '/internal/news', body: post };
    }
    case 'news hide':
    case 'news show':
      return {
        method: 'PATCH',
        path: `/internal/news/${enc(need(a, '<postId>'))}`,
        body: { hidden: action === 'hide' },
      };
    case 'flags get':
      return { method: 'GET', path: '/internal/flags', filterKey: a };
    case 'flags set': {
      const state = need(rest[0], 'on|off');
      if (state !== 'on' && state !== 'off') throw new UsageError('flags set <key> on|off');
      const rollout = opts.rollout === undefined ? 100 : Number(opts.rollout);
      if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100)
        throw new UsageError('--rollout must be an integer 0-100');
      let payload;
      if (opts.payload !== undefined) {
        try {
          payload = JSON.parse(String(opts.payload));
        } catch {
          throw new UsageError('--payload must be JSON');
        }
      }
      return {
        method: 'PUT',
        path: `/internal/flags/${enc(need(a, '<key>'))}`,
        body: {
          enabled: state === 'on',
          rolloutPercent: rollout,
          ...(payload !== undefined ? { payload } : {}),
        },
      };
    }
    case 'ledger check':
      return { method: 'GET', path: `/internal/ledger/${enc(need(a, '<userId>'))}` };
    case 'user lookup':
      return {
        method: 'GET',
        path: `/internal/users/lookup?q=${enc(need([a, ...rest].join(' ').trim(), '<query>'))}`,
      };
    case 'user rename':
      return {
        method: 'POST',
        path: `/internal/users/${enc(need(a, '<userId>'))}/rename`,
        body: { displayName: need(rest.join(' ').trim(), '<new display name>') },
      };
    default:
      throw new UsageError(key ? `unknown command: ${key}` : 'no command given');
  }
}

/**
 * Runs the CLI.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch,
 *   out?: (s: string) => void, err?: (s: string) => void, readFile?: (f: string) => string }} [io]
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const env = io.env ?? process.env;
  let req;
  let opts;
  try {
    const parsed = parseArgs(argv);
    opts = parsed.opts;
    if (opts.help || parsed.args.length === 0) {
      out(USAGE);
      return opts.help ? 0 : 2;
    }
    req = toRequest(parsed.args, opts, io.readFile);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`admin: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  const base = String(
    opts['api-url'] ?? env.ADMIN_API_URL ?? env.PUBLIC_API_URL ?? env.API_URL ?? 'http://localhost:7360',
  ).replace(/\/$/, '');
  const token = String(opts.token ?? env.ADMIN_TOKEN ?? '');
  if (!token) {
    err('admin: no admin token; set ADMIN_TOKEN (the same value the API runs with) or pass --token');
    return 2;
  }
  let res;
  try {
    res = await (io.fetch ?? fetch)(`${base}${req.path}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const cause = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    err(`admin: cannot reach the API at ${base} (${cause})`);
    return 3;
  }
  const text = await res.text().catch(() => '');
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code = body && typeof body === 'object' ? body.error : undefined;
    const msg = body && typeof body === 'object' ? body.message : String(body ?? '').slice(0, 300);
    if (res.status === 401) err('admin: the API rejected the admin token (does ADMIN_TOKEN match the API?)');
    else if (code === 'admin_disabled')
      err('admin: admin routes are disabled on the API; set ADMIN_TOKEN there');
    else
      err(
        `admin: ${req.method} ${req.path} failed: HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`,
      );
    if (body && typeof body === 'object' && body.details) err(JSON.stringify(body.details, null, 2));
    return 1;
  }
  if (req.filterKey && body && Array.isArray(body.flags)) {
    body = { flags: body.flags.filter((f) => f.key === req.filterKey) };
    if (body.flags.length === 0) {
      err(`admin: no flag named ${req.filterKey}`);
      return 1;
    }
  }
  out(body === null ? `ok (HTTP ${res.status})` : JSON.stringify(body, null, opts.json ? 0 : 2));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  run(process.argv.slice(2), { env: loadEnv(root, process.env) }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
