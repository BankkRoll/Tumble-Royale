#!/usr/bin/env node
/**
 * Writes `.env` files with freshly generated secrets.
 *
 * Development (`pnpm setup:env`):
 * - The root `.env` gets freshly generated secrets for every `NAME=change-me`
 *   line; the API, matchmaker and game server all load it, so they share them.
 * - Each app's `.env.example` is copied to its `.env` as-is (all overrides
 *   start commented out).
 * - An existing `.env` is never overwritten.
 * - `--if-missing` is quiet unless it creates something; runs before every
 *   `pnpm dev`.
 *
 * Production (`pnpm setup:env --production --domain play.example.com
 * [--email you@example.com] [--force]`):
 * - Writes `deploy/.env` for `deploy/docker-compose.yml`: public URLs for the
 *   domain, compose-network service addresses and a fresh random value for
 *   every secret (`deploy/.env.example` shows the layout).
 * - Refuses to replace an existing file without `--force`; with it, keeps the
 *   existing `POSTGRES_PASSWORD` because Postgres only reads that variable
 *   when its volume is first created.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

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

// -----------------------------------------------------------------------------
// Production
// -----------------------------------------------------------------------------

/** Where the production file goes, relative to the repository root. */
export const PRODUCTION_ENV_FILE = 'deploy/.env';

/** Secrets generated for a production deployment (256 random bits each). */
export const PRODUCTION_SECRETS = [
  'JWT_SECRET',
  'INTERNAL_HMAC_SECRET',
  'GAME_TICKET_SECRET',
  'GAME_SERVER_SECRET',
  'ADMIN_TOKEN',
  'METRICS_TOKEN',
  'POSTGRES_PASSWORD',
];

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`, 'i');
// Conservative on purpose: the value lands unquoted in an env file and in Caddy's config.
const EMAIL = /^[\w.+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Bad command-line input; the CLI prints the message and exits with status 2. */
export class UsageError extends Error {}

/**
 * Renders `deploy/.env`.
 *
 * @param {{ domain: string, email?: string, secret: (name: string) => string }} opts -
 *   Public hostname, optional ACME email and the value of each of {@link PRODUCTION_SECRETS}.
 * @returns {string} The file contents.
 * @throws {UsageError} When the domain or email is malformed.
 * @example
 * productionEnv({ domain: 'play.example.com', secret: () => 'change-me' });
 */
export function productionEnv({ domain, email = '', secret }) {
  if (!HOSTNAME.test(domain)) {
    throw new UsageError(`--domain must be a bare hostname such as play.example.com, got "${domain}"`);
  }
  if (email && !EMAIL.test(email)) throw new UsageError(`--email must be an email address, got "${email}"`);
  const web = `https://${domain}`;
  const s = Object.fromEntries(PRODUCTION_SECRETS.map((name) => [name, secret(name)]));
  return `# Production settings for deploy/docker-compose.yml, written by
# \`pnpm setup:env --production --domain <domain>\`. Compose reads this file for
# the \${VARIABLES} in docker-compose.yml and as every service's environment.
# It holds every secret of the deployment: keep it private and backed up.

# --- Site ---------------------------------------------------------------------
# Public hostname; its DNS A/AAAA records must point at this server.
DOMAIN=${domain}
# Let's Encrypt account email for certificate expiry notices (optional).
ACME_EMAIL=${email}
NODE_ENV=production
PUBLIC_WEB_URL=${web}
# OAuth redirect URIs are built from it: ${web}/api/auth/<provider>/callback
PUBLIC_API_URL=${web}/api
# Advertised to the matchmaker; players connect here through Caddy.
PUBLIC_WS_URL=wss://${domain}/gs/ws
# Browser origins allowed by the API (CORS_ORIGINS) and by the matchmaker and
# game server (ALLOWED_ORIGINS).
CORS_ORIGINS=${web}
ALLOWED_ORIGINS=${web}
# Caddy is the one proxy in front of every service; trust its X-Forwarded-For.
TRUST_PROXY=1

# --- Secrets ------------------------------------------------------------------
# Shared by the services; a new JWT_SECRET signs every player out.
JWT_SECRET=${s.JWT_SECRET}
INTERNAL_HMAC_SECRET=${s.INTERNAL_HMAC_SECRET}
GAME_TICKET_SECRET=${s.GAME_TICKET_SECRET}
GAME_SERVER_SECRET=${s.GAME_SERVER_SECRET}
# Bearer for \`pnpm admin\` and the API's /internal admin routes.
ADMIN_TOKEN=${s.ADMIN_TOKEN}
# Bearer for /metrics on the API and matchmaker (${web}/api/metrics, /mm/metrics).
METRICS_TOKEN=${s.METRICS_TOKEN}

# --- Datastores ---------------------------------------------------------------
POSTGRES_USER=tumble
POSTGRES_DB=tumble
# Postgres applies it only when its volume is first created; to change it later,
# ALTER USER in psql first, then update it here and in DATABASE_URL.
POSTGRES_PASSWORD=${s.POSTGRES_PASSWORD}
DATABASE_URL=postgres://tumble:${s.POSTGRES_PASSWORD}@postgres:5432/tumble
REDIS_URL=redis://redis:6379

# --- Services inside the compose network --------------------------------------
API_URL=http://api:7360
MATCHMAKER_URL=http://matchmaker:7370
# This game server's identity; every extra game server needs its own values
# (docs/SELF_HOSTING.md, "Scaling").
SERVER_ID=gs-1
REGION=na
CONTROL_URL=http://game-server:7350

# --- Backups ------------------------------------------------------------------
# pg_dump every BACKUP_INTERVAL_HOURS into the backups volume; dumps older than
# BACKUP_KEEP_DAYS are deleted.
BACKUP_INTERVAL_HOURS=24
BACKUP_KEEP_DAYS=14

# --- Optional features (uncomment, fill in, then docker compose up -d) ---------
# Discord / Google sign-in. Redirect URI: ${web}/api/auth/<discord|google>/callback
# DISCORD_CLIENT_ID=
# DISCORD_CLIENT_SECRET=
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# Email sign-in: smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465.
# SMTP_URL=
# SMTP_FROM=Tumble Royale <no-reply@${domain}>
# Stripe Checkout for Gem packs. Webhook endpoint: ${web}/api/webhooks/stripe
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
# Sentry-compatible DSN for server crash reports.
# SENTRY_DSN=
`;
}

/**
 * Writes `deploy/.env` for a production deployment.
 *
 * @param {string} root - Repository root.
 * @param {{ domain: string, email?: string, force?: boolean, random?: (bytes: number) => Buffer }} opts
 * @returns {{ file: string, status: 'created' | 'exists' | 'replaced', keptPostgresPassword: boolean }}
 *   `exists` means nothing was written.
 * @throws {UsageError} When the domain or email is malformed.
 */
export function setupProductionEnv(root, { domain, email, force = false, random = randomBytes }) {
  const file = join(root, PRODUCTION_ENV_FILE);
  // Validate first, so a typo is reported as a typo rather than as "already exists".
  productionEnv({ domain, email, secret: () => '' });
  const existed = existsSync(file);
  if (existed && !force) return { file, status: 'exists', keptPostgresPassword: false };
  // NOTE: Postgres reads POSTGRES_PASSWORD only when it initialises an empty
  // volume, so a new one would lock the services out of the existing database.
  const previous = existed ? parseEnv(readFileSync(file, 'utf8')).POSTGRES_PASSWORD : undefined;
  const text = productionEnv({
    domain,
    email,
    secret: (name) =>
      name === 'POSTGRES_PASSWORD' && previous ? previous : random(32).toString('base64url'),
  });
  mkdirSync(dirname(file), { recursive: true });
  // SECURITY: the file holds every secret; keep it unreadable for other users (ignored on Windows).
  writeFileSync(file, text, { mode: 0o600, flag: existed ? 'w' : 'wx' });
  return { file, status: existed ? 'replaced' : 'created', keptPostgresPassword: Boolean(previous) };
}

/**
 * Parses the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{ production: boolean, ifMissing: boolean, force: boolean, domain?: string, email?: string }}
 * @throws {UsageError} On an unknown option, a missing value or options that do not combine.
 */
export function parseCliArgs(argv) {
  const out = { production: false, ifMissing: false, force: false };
  const flags = { '--production': 'production', '--if-missing': 'ifMissing', '--force': 'force' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(flags, name) && eq === -1) {
      out[flags[name]] = true;
    } else if (name === '--domain' || name === '--email') {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
      out[name.slice(2)] = value.trim().toLowerCase();
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  if (!out.production && (out.domain || out.email || out.force)) {
    throw new UsageError('--domain, --email and --force only apply with --production');
  }
  if (out.production && !out.domain) throw new UsageError('--production needs --domain <hostname>');
  return out;
}

const USAGE = `Usage:
  pnpm setup:env [--if-missing]
  pnpm setup:env --production --domain <hostname> [--email <address>] [--force]`;

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
    if (args.production) {
      const result = setupProductionEnv(root, args);
      const where = relative(root, result.file);
      if (result.status === 'exists') {
        console.error(`[setup:env] ${where} already exists; --force replaces it with new secrets.`);
        process.exitCode = 1;
        return;
      }
      console.log(`[setup:env] ${where}: ${result.status} for https://${args.domain}`);
      if (result.keptPostgresPassword) {
        console.log('[setup:env] kept POSTGRES_PASSWORD so the existing database volume stays usable.');
      }
      if (result.status === 'replaced') {
        console.log('[setup:env] the other secrets are new: players sign in again after the restart.');
      }
      console.log('[setup:env] next: docker compose -f deploy/docker-compose.yml up -d --build');
      return;
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`[setup:env] ${err.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  for (const { file, status } of setupEnv(root)) {
    if (args.ifMissing && status !== 'created') continue;
    console.log(
      `[setup:env] ${relative(root, file)}: ${status === 'exists' ? 'kept existing file' : status}`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
