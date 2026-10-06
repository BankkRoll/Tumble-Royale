/**
 * Environment configuration for the game server.
 *
 * Responsibilities:
 * - Parse and validate every environment variable the server reads, once, at
 *   boot, reporting every problem together.
 * - Keep capacity, results reporting and the matchmaker link consistent with
 *   each other (the matchmaker never places more than the room manager accepts).
 * - Require secrets from the environment or the `.env` files `pnpm setup:env`
 *   writes; there are no built-in fallbacks.
 *
 * Kept apart from `main.ts` so the rules are testable without booting Rapier
 * or opening a port.
 */
import { hostname } from 'node:os';
import { DEFAULT_SHOW_PLAYERS, MAX_PLAYERS } from '@tumble/shared';
import { EnvIssues, MAX_TIMER_MS, type Env, type NodeEnv } from '@tumble/shared/env';
import type { TrustProxy } from '@tumble/shared/proxy';

/** How much this process hosts. */
export interface CapacityConfig {
  /** Show size including bots for unticketed rooms (`ROOM_CAPACITY`, 100; at most `MAX_PLAYERS`). */
  roomCapacity: number;
  /** Concurrent rooms (`MAX_ROOMS`, {@link DEFAULT_MAX_ROOMS}). */
  maxRooms: number;
  /**
   * Concurrent seats, humans and bots, advertised to the matchmaker
   * (`SERVER_CAPACITY`, default `MAX_ROOMS × ROOM_CAPACITY`).
   */
  serverCapacity: number;
}

/** Where and how show results are reported. */
export interface ResultsConfig {
  apiUrl: string;
  /** `INTERNAL_HMAC_SECRET`, shared with the API. */
  secret: string;
  /** Durable outbox directory (`RESULTS_OUTBOX_DIR`, `./.data/results-outbox`). */
  outboxDir: string;
}

/** Matchmaker registration settings. */
export interface LinkConfig {
  matchmakerUrl: string;
  /** `GAME_SERVER_SECRET`. */
  secret: string;
  /** Id the matchmaker knows this server by; join tickets carry it as `sid`. */
  serverId: string;
  publicUrl: string;
  region: string;
  /** Where the matchmaker reaches `POST /internal/kick`; absent → derived from `publicUrl`. */
  controlUrl: string | undefined;
}

/** Who may reach what over HTTP and the WebSocket. */
export interface ExposureConfig {
  /** Serve `/debug/*` (development and test only). */
  debug: boolean;
  /**
   * Browser origins allowed CORS on `/health` and WebSocket upgrades
   * (`ALLOWED_ORIGINS`, else `PUBLIC_WEB_URL` in production); true = any.
   */
  allowedOrigins: string[] | true;
  /** Bearer for `/metrics` and `/rooms` on the public port (`METRICS_TOKEN`). */
  metricsToken: string | undefined;
  /** Separate listener serving `/metrics`, `/rooms` and `/health` without a token (`INTERNAL_PORT`). */
  internalPort: number | undefined;
  /** Interface for the internal listener (`INTERNAL_HOST`, default all). */
  internalHost: string | undefined;
  /** Reverse proxies allowed to set X-Forwarded-For (`TRUST_PROXY`, default none). */
  trustProxy: TrustProxy;
  /** Hello deadline for new sockets (`HELLO_TIMEOUT_MS`, 5 s). */
  helloTimeoutMs: number;
  /** Unhandshaken sockets per client address (`MAX_PENDING_PER_IP`, 8). */
  maxPendingPerIp: number;
}

/** Fully resolved game server configuration. */
export interface GameServerConfig {
  env: NodeEnv;
  /** HTTP + WebSocket port (`PORT`, 7350). */
  port: number;
  capacity: CapacityConfig;
  /** Wait after the first human before bot fill (`FILL_WAIT_MS`, 25 s). */
  fillWaitMs: number;
  /** Start early once this many humans joined (`START_AT_HUMANS`, room capacity). */
  startAtHumans: number;
  /** Matchmade rooms start once every ticketed human joined, or after this (`TICKET_FILL_WAIT_MS`, 15 s). */
  ticketedFillWaitMs: number;
  /** `GS_DEV=1`: the capsule stand-in sim with rounds of `PLAY_SECONDS`; null → real shows. */
  devSim: { playSeconds: number } | null;
  /** Playlist for unticketed shows (`PLAYLIST`); absent → Main Show. */
  playlistId: string | undefined;
  /** Verifies matchmaker join tickets (`GAME_TICKET_SECRET`, shared with the matchmaker). */
  ticketSecret: string;
  /** Accept players without a ticket (`ALLOW_UNTICKETED`; default on except in production). */
  allowUnticketed: boolean;
  /** Results reporting; null when off. */
  results: ResultsConfig | null;
  /** Matchmaker registration; null when `MATCHMAKER_URL` is unset. */
  link: LinkConfig | null;
  /** Enables the signed `POST /internal/kick` endpoint (`GAME_SERVER_SECRET`). */
  controlSecret: string | undefined;
  exposure: ExposureConfig;
  /** Logging, crash reporting and shutdown. */
  ops: OpsConfig;
}

/** Logging, crash reporting and graceful-drain settings. */
export interface OpsConfig {
  /** pino level (`LOG_LEVEL`, info). */
  logLevel: string;
  /** Sentry-compatible DSN for crash reports (`SENTRY_DSN`). */
  sentryDsn: string | undefined;
  /**
   * On SIGTERM, how long running shows may continue before the server closes
   * anyway (`DRAIN_TIMEOUT_MS`, 15 min). Orchestrator grace periods must be longer.
   */
  drainTimeoutMs: number;
  /**
   * After deregistering, how long to wait for players of matches placed just
   * before it to arrive and open their rooms (`DRAIN_SETTLE_MS`, 15 s).
   */
  drainSettleMs: number;
  /** How long to keep retrying undelivered results before exiting (`OUTBOX_FLUSH_MS`, 15 s). */
  outboxFlushMs: number;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

function ops(issues: EnvIssues): OpsConfig {
  const logLevel = issues.optional('LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) issues.add('LOG_LEVEL', `must be one of ${LOG_LEVELS.join(', ')}`);
  return {
    logLevel,
    sentryDsn: issues.url('SENTRY_DSN', HTTP),
    drainTimeoutMs: issues.int('DRAIN_TIMEOUT_MS', 15 * 60_000, { min: 0, max: MAX_TIMER_MS }),
    drainSettleMs: issues.int('DRAIN_SETTLE_MS', 15_000, { min: 0, max: MAX_TIMER_MS }),
    outboxFlushMs: issues.int('OUTBOX_FLUSH_MS', 15_000, { min: 0, max: MAX_TIMER_MS }),
  };
}

function exposure(issues: EnvIssues, env: NodeEnv, port: number): ExposureConfig {
  const production = env === 'production';
  const origins = issues.optional('ALLOWED_ORIGINS');
  const publicWeb = issues.url('PUBLIC_WEB_URL', HTTP) ?? 'http://localhost:5173';
  const metricsToken =
    issues.optional('METRICS_TOKEN') === undefined ? undefined : issues.secret('METRICS_TOKEN', 16);
  const internalPort =
    issues.optional('INTERNAL_PORT') === undefined
      ? undefined
      : issues.int('INTERNAL_PORT', 0, { min: 1, max: 65535 });
  if (internalPort !== undefined && internalPort === port)
    issues.add('INTERNAL_PORT', 'must differ from PORT: the internal listener must not be the public one');
  return {
    debug: !production,
    allowedOrigins: origins
      ? origins
          .split(',')
          .map((o) => o.trim().replace(/\/$/, ''))
          .filter(Boolean)
      : production
        ? [publicWeb]
        : true,
    metricsToken: metricsToken || undefined,
    internalPort,
    internalHost: issues.optional('INTERNAL_HOST'),
    trustProxy: issues.trustProxy(),
    helloTimeoutMs: issues.int('HELLO_TIMEOUT_MS', 5000, { min: 500, max: 60_000 }),
    maxPendingPerIp: issues.int('MAX_PENDING_PER_IP', 8, { min: 1, max: 1000 }),
  };
}

/**
 * Default rooms per process. Every room ticks on the one Node event loop, so
 * this is rooms per core: a full 100-player room measured 6.5 ms mean / 9 ms
 * p95 per 30 Hz tick (test/tickBudget.test.ts), and three of them leave a
 * third of the 33 ms tick spare for GC, I/O and a bad tick.
 */
export const DEFAULT_MAX_ROOMS = 3;

const HTTP = ['http:', 'https:'] as const;

function capacity(issues: EnvIssues): CapacityConfig {
  const roomCapacity = issues.int('ROOM_CAPACITY', DEFAULT_SHOW_PLAYERS, { min: 1, max: MAX_PLAYERS });
  const maxRooms = issues.int('MAX_ROOMS', DEFAULT_MAX_ROOMS, { min: 1 });
  return {
    roomCapacity,
    maxRooms,
    serverCapacity: issues.int('SERVER_CAPACITY', maxRooms * roomCapacity, { min: 1 }),
  };
}

/**
 * In development reporting defaults to the local API so `pnpm dev` records
 * shows end to end; elsewhere it is on only when `API_URL` is set.
 */
function results(issues: EnvIssues, env: NodeEnv): ResultsConfig | null {
  const enabled = issues.flag('REPORT_RESULTS', true);
  const apiUrl = issues.url('API_URL', HTTP) ?? (env === 'development' ? 'http://localhost:7360' : undefined);
  // The results API is also where maintenance and kill switches come from;
  // without it a production server silently records nothing and obeys nothing.
  if (env === 'production' && (!enabled || !apiUrl) && !issues.flag('ALLOW_STANDALONE', false)) {
    issues.add(
      enabled ? 'API_URL' : 'REPORT_RESULTS',
      'production needs results reporting to the API (API_URL with INTERNAL_HMAC_SECRET): it also carries ' +
        'maintenance and kill switches. Set ALLOW_STANDALONE=1 to run without an account API anyway.',
    );
  }
  if (!enabled || !apiUrl) return null;
  return {
    apiUrl,
    secret: issues.secret('INTERNAL_HMAC_SECRET', 16),
    outboxDir: issues.optional('RESULTS_OUTBOX_DIR') ?? './.data/results-outbox',
  };
}

function link(issues: EnvIssues, port: number, secret: string | undefined): LinkConfig | null {
  const matchmakerUrl = issues.url('MATCHMAKER_URL', HTTP);
  if (!matchmakerUrl) return null;
  if (secret === undefined) issues.add('GAME_SERVER_SECRET', 'is required when MATCHMAKER_URL is set');
  if (!secret) return null;
  return {
    matchmakerUrl,
    secret,
    serverId: issues.optional('SERVER_ID') ?? `gs-${hostname()}-${port}`,
    publicUrl: issues.url('PUBLIC_WS_URL', ['ws:', 'wss:']) ?? `ws://localhost:${port}/ws`,
    region: issues.optional('REGION') ?? 'na',
    controlUrl: issues.url('CONTROL_URL', HTTP),
  };
}

/**
 * Parses an environment map into a {@link GameServerConfig}.
 *
 * @param env - Usually `process.env`; tests pass a literal map.
 * @returns The validated configuration.
 * @throws {EnvConfigError} Listing every malformed variable and missing or
 *   placeholder secret (`INTERNAL_HMAC_SECRET` only while results are
 *   reported, `GAME_SERVER_SECRET` only with `MATCHMAKER_URL`).
 */
export function loadConfig(env: Env = process.env): GameServerConfig {
  const issues = new EnvIssues(env);
  const nodeEnv = issues.nodeEnv();
  const port = issues.int('PORT', 7350, { min: 1, max: 65535 });
  const cap = capacity(issues);
  const controlSecret =
    issues.optional('GAME_SERVER_SECRET') === undefined ? undefined : issues.secret('GAME_SERVER_SECRET', 16);
  const config: GameServerConfig = {
    env: nodeEnv,
    port,
    capacity: cap,
    fillWaitMs: issues.int('FILL_WAIT_MS', 25_000, { min: 0, max: MAX_TIMER_MS }),
    startAtHumans: issues.int('START_AT_HUMANS', cap.roomCapacity, { min: 1 }),
    ticketedFillWaitMs: issues.int('TICKET_FILL_WAIT_MS', 15_000, { min: 0, max: MAX_TIMER_MS }),
    devSim: issues.flag('GS_DEV', false)
      ? { playSeconds: issues.int('PLAY_SECONDS', 120, { min: 1, max: Math.floor(MAX_TIMER_MS / 1000) }) }
      : null,
    playlistId: issues.optional('PLAYLIST'),
    ticketSecret: issues.secret('GAME_TICKET_SECRET', 16),
    allowUnticketed: issues.flag('ALLOW_UNTICKETED', nodeEnv !== 'production'),
    results: results(issues, nodeEnv),
    link: link(issues, port, controlSecret),
    controlSecret,
    ops: ops(issues),
    exposure: exposure(issues, nodeEnv, port),
  };
  issues.throwIfAny('game-server');
  return config;
}
