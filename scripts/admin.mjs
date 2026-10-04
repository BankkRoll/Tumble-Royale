#!/usr/bin/env node
/**
 * Admin CLI for a running Tumble Royale API: `pnpm admin <command>`.
 *
 * Calls the API's `/internal/*` admin routes with `ADMIN_TOKEN`. The API URL
 * and token come from `--api-url` / `--token`, else `ADMIN_API_URL` /
 * `ADMIN_TOKEN`, else `PUBLIC_API_URL` / `API_URL`, reading the repository's
 * `deploy/.env`, `.env` and `apps/api/.env` when present (later files win,
 * real environment variables win over all of them).
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
Playlists (limited-time shows; times are ISO 8601, "none" clears)
  playlists list                                    every playlist with its schedule and phase
  playlists set <id> [--starts <time>] [--ends <time>] [--featured on|off] [--hidden on|off]
  playlists hide <id> | playlists show <id>         withdraw or restore a playlist
  playlists reset <id>                              drop the override (back to the bundled schedule)
Events (limited-time events; times are ISO 8601)
  events list                                       every event with its window, phase and switch
  events set <id> [--starts <time>] [--ends <time>] move an event's window
  events disable <id> | events enable <id>          withdraw an event (it awards nothing) or restore it
  events reset <id>                                 drop the override (back to the bundled window)
Maintenance
  maintenance status
  maintenance on [--message <text>] [--in <minutes> | --starts <time>] [--for <minutes> | --ends <time>]
  maintenance off
Errors
  errors top [--hours N] [--limit N] [--server]     most frequent client (or server) errors
Economy
  ledger check <userId>                             verify cached balances against the ledger
Users
  user lookup <userId | name#1234 | email | name>
  user rename <userId> <new display name>
Admin console (staff accounts sign in at https://DOMAIN/admin)
  staff list
  staff grant <userId> [--role admin|moderator]       the account must not be a guest
  staff revoke <userId>
  audit [--action <name|prefix.>] [--target <id>] [--limit N]   newest admin actions

Options
  --api-url <url>   API base URL (default: ADMIN_API_URL, PUBLIC_API_URL, API_URL, http://127.0.0.1:7360)
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
  const BOOLEAN = new Set(['json', 'all', 'help', 'server']);
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
 * `deploy/.env` (written by `pnpm setup:env --production`) comes first, so
 * on a production host the CLI talks to the public API with its admin token,
 * while a development checkout's own `.env` files still win.
 *
 * @param {string} root - Repository root.
 * @param {Record<string, string | undefined>} env - Real environment.
 */
export function loadEnv(root, env) {
  return {
    ...readEnvFile(join(root, 'deploy/.env')),
    ...readEnvFile(join(root, '.env')),
    ...readEnvFile(join(root, 'apps/api/.env')),
    ...env,
  };
}

const enc = encodeURIComponent;

function need(value, what) {
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

/** `--x <ISO time>` → ISO string, `none` → null, absent → undefined. */
function timeOpt(opts, name) {
  const v = opts[name];
  if (v === undefined) return undefined;
  if (v === 'none') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t))
    throw new UsageError(`--${name} must be an ISO time (2026-12-01T18:00:00Z) or none`);
  return new Date(t).toISOString();
}

function onOff(opts, name) {
  const v = opts[name];
  if (v === undefined) return undefined;
  if (v !== 'on' && v !== 'off') throw new UsageError(`--${name} must be on or off`);
  return v === 'on';
}

function minutesOpt(opts, name) {
  if (opts[name] === undefined) return undefined;
  const n = Number(opts[name]);
  if (!(Number.isFinite(n) && n > 0)) throw new UsageError(`--${name} must be a positive number of minutes`);
  return n * 60_000;
}

/** Positive integer query option, passed through when present. */
function intOpt(q, opts, name) {
  if (opts[name] === undefined) return;
  const n = Number(opts[name]);
  if (!(Number.isInteger(n) && n > 0)) throw new UsageError(`--${name} must be a positive integer`);
  q.set(name, String(n));
}

/**
 * Maps a command to an HTTP request.
 *
 * @param {string[]} args - Positionals after `admin`.
 * @param {Record<string, string | true>} opts - Options.
 * @param {(file: string) => string} readFile - Reads `news publish` input.
 * @param {number} now - Wall clock (ms) for relative times such as `maintenance on --in 10`.
 * @returns {{ method: string, path: string, body?: unknown }}
 */
export function toRequest(args, opts, readFile = (f) => readFileSync(f, 'utf8'), now = Date.now()) {
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
    case 'playlists list':
      return { method: 'GET', path: '/internal/playlists' };
    case 'playlists set': {
      const body = {
        startsAt: timeOpt(opts, 'starts'),
        endsAt: timeOpt(opts, 'ends'),
        featured: onOff(opts, 'featured'),
        hidden: onOff(opts, 'hidden'),
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      if (Object.keys(body).length === 0)
        throw new UsageError('playlists set needs --starts, --ends, --featured or --hidden');
      return { method: 'PUT', path: `/internal/playlists/${enc(need(a, '<id>'))}`, body };
    }
    case 'playlists hide':
    case 'playlists show':
      return {
        method: 'PUT',
        path: `/internal/playlists/${enc(need(a, '<id>'))}`,
        body: { hidden: action === 'hide' },
      };
    case 'playlists reset':
      return { method: 'DELETE', path: `/internal/playlists/${enc(need(a, '<id>'))}` };
    case 'events list':
      return { method: 'GET', path: '/internal/live-events' };
    case 'events set': {
      const body = { startsAt: timeOpt(opts, 'starts'), endsAt: timeOpt(opts, 'ends') };
      // Unlike playlists, an event always has an end: settling its rewards depends on it.
      if (body.startsAt === null || body.endsAt === null) throw new UsageError('event times cannot be none');
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      if (Object.keys(body).length === 0) throw new UsageError('events set needs --starts or --ends');
      return { method: 'PUT', path: `/internal/live-events/${enc(need(a, '<id>'))}`, body };
    }
    case 'events disable':
    case 'events enable':
      return {
        method: 'PUT',
        path: `/internal/live-events/${enc(need(a, '<id>'))}`,
        body: { enabled: action === 'enable' },
      };
    case 'events reset':
      return { method: 'DELETE', path: `/internal/live-events/${enc(need(a, '<id>'))}` };
    case 'maintenance status':
      return { method: 'GET', path: '/status' };
    case 'maintenance on': {
      const inMs = minutesOpt(opts, 'in');
      const forMs = minutesOpt(opts, 'for');
      if (inMs !== undefined && opts.starts !== undefined)
        throw new UsageError('use --in or --starts, not both');
      if (forMs !== undefined && opts.ends !== undefined)
        throw new UsageError('use --for or --ends, not both');
      const startsAt =
        inMs !== undefined ? new Date(now + inMs).toISOString() : (timeOpt(opts, 'starts') ?? null);
      const from = startsAt ? Date.parse(startsAt) : now;
      const endsAt =
        forMs !== undefined ? new Date(from + forMs).toISOString() : (timeOpt(opts, 'ends') ?? null);
      return {
        method: 'PUT',
        path: '/internal/maintenance',
        body: {
          enabled: true,
          startsAt,
          endsAt,
          ...(typeof opts.message === 'string' ? { message: opts.message } : {}),
        },
      };
    }
    case 'maintenance off':
      return { method: 'DELETE', path: '/internal/maintenance' };
    case 'errors top': {
      const q = new URLSearchParams();
      intOpt(q, opts, 'hours');
      intOpt(q, opts, 'limit');
      if (opts.server) q.set('source', 'server');
      return { method: 'GET', path: `/internal/errors/top${q.size ? `?${q}` : ''}`, format: formatErrors };
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
    case 'staff list':
      return { method: 'GET', path: '/internal/staff' };
    case 'staff grant': {
      const role = opts.role ?? 'moderator';
      if (role !== 'admin' && role !== 'moderator') throw new UsageError('--role must be admin or moderator');
      return { method: 'PUT', path: `/internal/staff/${enc(need(a, '<userId>'))}`, body: { role } };
    }
    case 'staff revoke':
      return { method: 'DELETE', path: `/internal/staff/${enc(need(a, '<userId>'))}` };
    default:
      if (group === 'audit') {
        const q = new URLSearchParams();
        if (typeof opts.action === 'string') q.set('action', opts.action);
        if (typeof opts.target === 'string') q.set('targetId', opts.target);
        intOpt(q, opts, 'limit');
        return { method: 'GET', path: `/internal/audit${q.size ? `?${q}` : ''}` };
      }
      throw new UsageError(key ? `unknown command: ${key}` : 'no command given');
  }
}

/**
 * Renders `errors top` for a terminal: one line per error, most frequent first.
 *
 * @param {{ source: string, since: string, errors: { type: string, message: string, occurrences: number,
 *   players: number, lastSeen: string, services?: string | null, releases?: string | null }[] }} body
 * @returns {string}
 */
export function formatErrors(body) {
  if (!body.errors?.length) return `No ${body.source} errors since ${body.since}.`;
  const lines = [`Top ${body.source} errors since ${body.since}:`];
  for (const e of body.errors) {
    const who =
      body.source === 'server' ? (e.services ?? '?') : `${e.players} player${e.players === 1 ? '' : 's'}`;
    const release = e.releases ? ` · ${e.releases}` : '';
    lines.push(`${String(e.occurrences).padStart(7)}x  ${e.type}: ${e.message}`);
    lines.push(`          ${who}${release} · last ${e.lastSeen}`);
  }
  return lines.join('\n');
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
    opts['api-url'] ?? env.ADMIN_API_URL ?? env.PUBLIC_API_URL ?? env.API_URL ?? 'http://127.0.0.1:7360',
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
  if (req.format && !opts.json && body && typeof body === 'object') out(req.format(body));
  else out(body === null ? `ok (HTTP ${res.status})` : JSON.stringify(body, null, opts.json ? 0 : 2));
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
