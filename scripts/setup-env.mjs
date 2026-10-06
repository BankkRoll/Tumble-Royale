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
  'VOICE_TURN_SECRET',
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
# the \${VARIABLES} in docker-compose.yml and as every service's environment,
# so a variable set here reaches the API, matchmaker and game server alike.
# It holds every secret of the deployment: keep it private and backed up.
#
# REQUIRED lines are set for you. OPTIONAL lines show their default; uncomment
# one and fill it in to change it, then run \`docker compose up -d\`.
# docs/SELF_HOSTING.md, "Environment reference", documents every variable.

# --- Site ---------------------------------------------------------------------
# REQUIRED. Public hostname; its DNS A/AAAA records must point at this server.
DOMAIN=${domain}
# OPTIONAL. Let's Encrypt account email for certificate expiry notices.
ACME_EMAIL=${email}
# REQUIRED. production turns on every production safety check.
NODE_ENV=production
# REQUIRED. Where players open the game; sign-in links and redirects land here.
PUBLIC_WEB_URL=${web}
# REQUIRED. Public API origin; OAuth redirect URIs are built from it:
# ${web}/api/auth/<provider>/callback
PUBLIC_API_URL=${web}/api
# REQUIRED. Advertised to the matchmaker; players connect here through Caddy.
PUBLIC_WS_URL=wss://${domain}/gs/ws
# REQUIRED. Browser origins allowed by the API (CORS_ORIGINS) and by the
# matchmaker and game server (ALLOWED_ORIGINS); comma-separated.
CORS_ORIGINS=${web}
ALLOWED_ORIGINS=${web}
# REQUIRED. Caddy is the one proxy in front of every service; trust its X-Forwarded-For.
TRUST_PROXY=1

# --- Secrets (REQUIRED, generated) --------------------------------------------
# Signs access tokens (API) and is verified by the matchmaker; a new value signs every player out.
JWT_SECRET=${s.JWT_SECRET}
# Signs game server results and matchmaker ban lookups sent to the API.
INTERNAL_HMAC_SECRET=${s.INTERNAL_HMAC_SECRET}
# Signs matchmaker join tickets; game servers verify them.
GAME_TICKET_SECRET=${s.GAME_TICKET_SECRET}
# Game servers present it to register with the matchmaker; it also signs kicks.
GAME_SERVER_SECRET=${s.GAME_SERVER_SECRET}
# Bearer for \`pnpm admin\` and the API's /internal admin routes (acts as admin).
ADMIN_TOKEN=${s.ADMIN_TOKEN}
# Bearer for /metrics on the API and matchmaker (${web}/api/metrics, /mm/metrics).
METRICS_TOKEN=${s.METRICS_TOKEN}
# Shared by the API and the coturn relay (compose profile \`voice\`); never sent to players.
VOICE_TURN_SECRET=${s.VOICE_TURN_SECRET}

# --- Datastores ---------------------------------------------------------------
# OPTIONAL (default: tumble). Postgres role and database the compose file creates.
POSTGRES_USER=tumble
POSTGRES_DB=tumble
# REQUIRED. Postgres applies it only when its volume is first created; to change
# it later, ALTER USER in psql first, then update it here and in DATABASE_URL.
POSTGRES_PASSWORD=${s.POSTGRES_PASSWORD}
# REQUIRED. The API's database.
DATABASE_URL=postgres://tumble:${s.POSTGRES_PASSWORD}@postgres:5432/tumble
# REQUIRED. Parties, presence, leaderboards, queues and pub/sub for the API and matchmaker.
REDIS_URL=redis://redis:6379

# --- Services inside the compose network --------------------------------------
# REQUIRED. The API, as the matchmaker and game server reach it.
API_URL=http://api:7360
# REQUIRED. The matchmaker the game server registers with (the API also probes it for /status).
MATCHMAKER_URL=http://matchmaker:7370
# REQUIRED. This game server's identity; every extra game server needs its own
# values (docs/SELF_HOSTING.md, "Scaling"). REGION: na | eu | asia | sa | oce.
SERVER_ID=gs-1
REGION=na
# OPTIONAL. Where the matchmaker reaches this game server's kick endpoint
# (default: PUBLIC_WS_URL without its /ws).
CONTROL_URL=http://game-server:7350

# --- Backups ------------------------------------------------------------------
# OPTIONAL. pg_dump every BACKUP_INTERVAL_HOURS into the backups volume; dumps
# older than BACKUP_KEEP_DAYS are deleted.
BACKUP_INTERVAL_HOURS=24
BACKUP_KEEP_DAYS=14

# --- Sign-in (OPTIONAL; each method turns on when its keys are set) -----------
# Guests always work. Register these exact redirect URIs with each provider;
# docs/ADMIN.md, "Sign-in providers", shows how to create each app.
# Discord: ${web}/api/auth/discord/callback
# DISCORD_CLIENT_ID=
# DISCORD_CLIENT_SECRET=
# Google: ${web}/api/auth/google/callback
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GitHub (OAuth app): ${web}/api/auth/github/callback
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# Twitch: ${web}/api/auth/twitch/callback
# TWITCH_CLIENT_ID=
# TWITCH_CLIENT_SECRET=
# Sign in with Apple: Services ID, team id, key id and the .p8 key's contents
# (one line, newlines written as \\n). Return URL: ${web}/api/auth/apple/callback
# APPLE_CLIENT_ID=
# APPLE_TEAM_ID=
# APPLE_KEY_ID=
# APPLE_PRIVATE_KEY=
# Email magic links: smtp://user:pass@host:587 (STARTTLS) or
# smtps://user:pass@host:465. Without it production has no email sign-in.
# SMTP_FROM defaults to the line below.
# SMTP_URL=
# SMTP_FROM=Tumble Royale <no-reply@${domain}>

# --- Payments (OPTIONAL) ------------------------------------------------------
# Stripe Checkout for Gem packs; set both or neither (without them Gem
# checkout is off). Webhook endpoint: ${web}/api/webhooks/stripe
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=

# --- Voice chat (OPTIONAL) ----------------------------------------------------
# docs/SELF_HOSTING.md, "Voice chat": start the relay with
# \`docker compose --profile voice up -d\`, open 3478/udp+tcp and 49160-49200/udp,
# then switch the voice.enabled flag on. Without a TURN URL voice stays hidden.
# VOICE_ICE_SERVERS=stun:${domain}:3478,turn:${domain}:3478?transport=udp,turn:${domain}:3478?transport=tcp
# Default 1 in production: voice needs a TURN relay. 0 allows direct peer connections only.
# VOICE_REQUIRE_TURN=1

# --- Admin CLI (OPTIONAL) -----------------------------------------------------
# API that \`pnpm admin\` talks to (default: PUBLIC_API_URL).
# ADMIN_API_URL=${web}/api

# --- Monitoring (OPTIONAL) ----------------------------------------------------
# Sentry-compatible DSN for server crash reports (every service).
# SENTRY_DSN=
# fatal | error | warn | info | debug | trace | silent (default: info, every service).
# LOG_LEVEL=info
# A private /metrics listener without auth on this port (default: none); keep it off the internet.
# INTERNAL_PORT=9100
# INTERNAL_HOST=0.0.0.0
# Status page uptime sampling interval in seconds (default: 60; 0 = no history).
# STATUS_SAMPLE_SECONDS=60

# --- API tuning (OPTIONAL) ----------------------------------------------------
# Requests per minute per player or IP. Read by the API (default 300) AND the
# matchmaker (default 120): setting it here sets both.
# RATE_LIMIT_MAX=300
# Days between display name changes (default: 30).
# NAME_CHANGE_COOLDOWN_DAYS=30
# How long a player stays online after their last connection closes, in ms (default: 8000).
# PRESENCE_GRACE_MS=8000
# Postgres pool size per API instance (default: 10).
# DB_POOL_MAX=10
# Realtime socket abuse limits: handshakes per minute per IP and per account,
# and open sockets per account and per IP.
# WS_IP_UPGRADES_PER_MINUTE=60
# WS_USER_UPGRADES_PER_MINUTE=20
# WS_MAX_SOCKETS_PER_USER=5
# WS_MAX_SOCKETS_PER_IP=50
# New guest accounts per IP per hour (returning devices don't count).
# GUEST_SIGNUPS_PER_IP_HOUR=10
# Global chat: minutes a guest must wait before posting (linked accounts post at
# once), and lines per IP per 10 seconds across all accounts.
# GLOBAL_CHAT_MIN_ACCOUNT_AGE_MINUTES=10
# GLOBAL_CHAT_IP_MAX=10
# Retention job: run interval, days past expiry before sessions go, non-audit
# event age, and guest accounts unused this long (0 = keep forever).
# RETENTION_INTERVAL_MINUTES=360
# RETENTION_SESSION_GRACE_DAYS=7
# RETENTION_EVENTS_DAYS=90
# RETENTION_GUEST_DAYS=0
# 1 runs without Redis or Postgres (single instance only; state in memory or PGLITE_DIR).
# ALLOW_MEMORY_STORE=
# ALLOW_EMBEDDED_DB=
# PGLITE_DIR=./.data/pglite

# --- Matchmaker tuning (OPTIONAL) ---------------------------------------------
# Lobby size when a ticket does not set one (default: 100).
# TARGET_SIZE=100
# Release a lobby with bots after this wait; the shorter one once HOT_THRESHOLD
# players search a region (defaults: 25000, 12000, 200).
# MAX_WAIT_MS=25000
# HOT_MAX_WAIT_MS=12000
# HOT_THRESHOLD=200
# How long a ready lobby waits for a server in its own region (default: 10000 ms).
# REGION_FALLBACK_MS=10000
# Queue and lobby changes per minute per player (default: 30).
# USER_RATE_LIMIT_MAX=30
# Matchmaking tick in ms (default: 500).
# TICK_MS=500
# Game server used while none has registered (default: none in production).
# DEFAULT_GAME_SERVER_URL=
# 1 lets the matchmaker and game server run in production without the API
# (no ban checks, live ops or results). Compose always has the API, so leave it.
# ALLOW_STANDALONE=

# --- Game server tuning (OPTIONAL) --------------------------------------------
# Show size for unticketed rooms (default/max: 100), rooms per process (default: 3)
# and seats advertised to the matchmaker (default: MAX_ROOMS x ROOM_CAPACITY).
# ROOM_CAPACITY=100
# MAX_ROOMS=3
# SERVER_CAPACITY=
# Bot fill wait after the first human (default: 25000 ms); start early at this many humans.
# FILL_WAIT_MS=25000
# START_AT_HUMANS=
# Matchmade rooms start when every ticketed human joined, or after this (default: 15000 ms).
# TICKET_FILL_WAIT_MS=15000
# Playlist for unticketed shows (default: Main Show).
# PLAYLIST=
# 1 accepts players without a matchmaker ticket (default: 0 in production).
# ALLOW_UNTICKETED=0
# 0 stops reporting results to the API (default: 1).
# REPORT_RESULTS=1
# Hello deadline for new sockets (default: 5000 ms) and unhandshaken sockets per IP (default: 8).
# HELLO_TIMEOUT_MS=5000
# MAX_PENDING_PER_IP=8
# SIGTERM drain: wait for late players, let shows finish, retry undelivered
# results. stop_grace_period in docker-compose.yml must exceed their sum.
# DRAIN_SETTLE_MS=15000
# DRAIN_TIMEOUT_MS=900000
# OUTBOX_FLUSH_MS=15000

# --- Edge and images (OPTIONAL) -----------------------------------------------
# Image tag to build and run (default: latest).
# TAG=latest
# Caddy site address and global options (defaults: DOMAIN, and the ACME_EMAIL line).
# SITE_ADDRESS=${domain}
# CADDY_GLOBAL_OPTIONS=
# Where Caddy proxies /api, /mm, /gs/ws and everything else (defaults: the compose services).
# API_UPSTREAM=api:7360
# MATCHMAKER_UPSTREAM=matchmaker:7370
# GAME_SERVER_UPSTREAM=game-server:7350
# CLIENT_UPSTREAM=client:8080

# --- Set by the images and docker-compose.yml (reference only; leave commented)
# Each image sets its own PORT (API 7360, matchmaker 7370, game server 7350),
# which Caddy and the other services expect; one value here would set all three.
# HOST=0.0.0.0
# PORT=
# The one-shot migrate service applies migrations, so the API skips them at boot.
# MIGRATE_ON_BOOT=0
# Volumes: the game server's results outbox and the backup dumps.
# RESULTS_OUTBOX_DIR=/data/results-outbox
# BACKUP_DIR=/backups

# --- Development only (refused or meaningless in production) ------------------
# DEV_ADMIN_EMAIL: seeds a local admin and logs a sign-in link (\`pnpm dev\` only).
# GS_DEV / PLAY_SECONDS: the game server's capsule stand-in sim for load tests.
# DEV_ADMIN_EMAIL=
# GS_DEV=
# PLAY_SECONDS=
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
