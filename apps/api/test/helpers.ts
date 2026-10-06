/**
 * Test harness: an API with a controllable clock, on in-memory PGlite and the
 * in-process KV, or on the Postgres and Redis named by `DATABASE_URL` and
 * `REDIS_URL` when those are set (see `backing.ts`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_SHOW_PLAYERS } from '@tumble/shared';
import type { Env } from '@tumble/shared/env';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions, type BuiltApp } from '../src/app.ts';
import { MemoryMailer } from '../src/auth/mailer.ts';
import { loadConfig } from '../src/config.ts';
import { applyLedger } from '../src/economy/ledger.ts';
import { HMAC_HEADERS, signInternal } from '../src/http/auth.ts';
import type { MatchResultInput } from '../src/matches/schema.ts';
import { createScratchDatabase, isolatedRedisKV, TEST_DATABASE_URL, TEST_REDIS_URL } from './backing.ts';

/** The nonce a test "browser" keeps while signing in (`/auth/exchange`, `/auth/email/verify`). */
export const TEST_NONCE = 'test-browser-nonce-0123456789';
/** Its binding, sent to `/auth/:provider/start` and `/auth/email/start`. */
export const TEST_BINDING = createHash('sha256').update(TEST_NONCE).digest('hex');

/** Admin bearer used by tests. */
export const ADMIN_TOKEN = 'test-admin-token-0123456789-abcdefghij';

/** Explicit secrets for tests, which never read `.env` files. */
export const TEST_SECRETS = {
  JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijkl',
  INTERNAL_HMAC_SECRET: 'test-internal-hmac-secret-0123456789',
} as const;

/**
 * A complete, quiet test environment: `NODE_ENV=test`, `LOG_LEVEL=silent`
 * and {@link TEST_SECRETS}.
 *
 * @param overrides - Variables to add or replace; `undefined` removes one.
 */
export function testEnv(overrides: Env = {}): Env {
  return { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...TEST_SECRETS, ...overrides };
}

/** A signed-in guest. */
export interface TestUser {
  id: string;
  accessToken: string;
  refreshToken: string;
  deviceToken: string;
  displayName: string;
  tag: string;
}

/** Test API with helpers. */
export interface TestApi extends BuiltApp {
  mailer: MemoryMailer;
  clock: { now(): Date; advance(ms: number): void; set(iso: string): void };
  guest(displayName?: string): Promise<TestUser>;
  req(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string>; ip?: string },
  ): Promise<LightMyRequestResponse>;
  /**
   * A guest upgraded to a full account through an email magic link (each call
   * from a fresh address so the auth rate limit stays out of the way).
   */
  account(email?: string): Promise<TestUser & { email: string }>;
  /** Completes an email magic-link sign-in, linking to `token`'s account when given. */
  emailSignIn(email: string, token?: string): Promise<LightMyRequestResponse>;
  grant(userId: string, currency: 'gumballs' | 'gems' | 'crown_shards', amount: number): Promise<void>;
  postMatch(
    payload: MatchResultInput,
    opts?: { secret?: string; nonce?: string; timestamp?: number },
  ): Promise<LightMyRequestResponse>;
  /** POSTs an HMAC-signed body to an `/internal/*` route, as game servers and the matchmaker do. */
  internal(
    url: string,
    payload: unknown,
    opts?: { secret?: string; nonce?: string; timestamp?: number },
  ): Promise<LightMyRequestResponse>;
  /** Bans a user through the admin route. */
  ban(userId: string, scope?: 'all' | 'ranked' | 'chat' | 'voice'): Promise<void>;
}

/** Build overrides for {@link createTestApi}. */
export interface TestApiOptions extends Pick<
  BuildOptions,
  'seasonListeners' | 'payments' | 'kv' | 'database' | 'fetch' | 'sharedRateLimit' | 'status'
> {
  /**
   * Keep the in-process KV even when `REDIS_URL` is set, for tests that expire
   * KV entries with the fake clock or expect pub/sub to deliver synchronously.
   */
  memoryKv?: boolean;
}

/**
 * Builds a fresh isolated API.
 *
 * @param startIso - Initial clock time.
 * @param env - Extra environment variables (override the test defaults).
 * @param extra - Extra build options (e.g. season-change listeners).
 */
export async function createTestApi(
  startIso = '2026-10-02T12:00:00.000Z',
  env: Record<string, string> = {},
  extra: TestApiOptions = {},
): Promise<TestApi> {
  const { memoryKv, ...buildOptions } = extra;
  let nowMs = Date.parse(startIso);
  const clock = {
    now: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
    set: (iso: string) => {
      nowMs = Date.parse(iso);
    },
  };
  // `DATABASE_URL` / `REDIS_URL` in `env` pick the servers for this API (empty
  // forces PGlite / the in-process KV); otherwise the suite-wide ones apply.
  // Either way the API gets a database and key prefix of its own. A test that
  // brings its own database or KV (shared by two instances, a failing double)
  // keeps it.
  const dbServer = 'DATABASE_URL' in env ? env.DATABASE_URL || undefined : TEST_DATABASE_URL;
  const redisServer = memoryKv ? undefined : 'REDIS_URL' in env ? env.REDIS_URL || undefined : TEST_REDIS_URL;
  const scratch = dbServer && !extra.database ? await createScratchDatabase(dbServer) : null;
  const kv = extra.kv ?? (redisServer ? isolatedRedisKV(redisServer) : undefined);
  let built: BuiltApp;
  const mailer = new MemoryMailer();
  try {
    const config = loadConfig(
      testEnv({
        RATE_LIMIT_MAX: '100000',
        ADMIN_TOKEN,
        // Short enough for tests to watch a disconnect turn into "offline".
        PRESENCE_GRACE_MS: '150',
        // Every test socket and chat line comes from 127.0.0.1, and suites mint
        // fresh guests by the dozen; abuse tests lower these again.
        WS_IP_UPGRADES_PER_MINUTE: '100000',
        WS_USER_UPGRADES_PER_MINUTE: '100000',
        WS_MAX_SOCKETS_PER_IP: '100000',
        GUEST_SIGNUPS_PER_IP_HOUR: '100000',
        GLOBAL_CHAT_MIN_ACCOUNT_AGE_MINUTES: '0',
        GLOBAL_CHAT_IP_MAX: '100000',
        ...env,
        ...(scratch ? { DATABASE_URL: scratch.url } : {}),
      }),
    );
    built = await buildApp(config, {
      now: clock.now,
      mailer,
      logger: false,
      ...buildOptions,
      ...(kv ? { kv } : {}),
    });
  } catch (err) {
    if (!extra.kv) await kv?.close();
    await scratch?.drop();
    throw err;
  }
  const config = built.ctx.config;
  const close = async (): Promise<void> => {
    await built.close();
    await scratch?.drop();
  };

  const req: TestApi['req'] = (method, url, opts = {}) =>
    built.app.inject({
      method,
      url,
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });

  const internal: TestApi['internal'] = (url, payload, opts = {}) => {
    const body = JSON.stringify(payload);
    const ts = String(opts.timestamp ?? clock.now().getTime());
    const nonce = opts.nonce ?? randomUUID();
    const sig = signInternal(opts.secret ?? config.internalHmacSecret, ts, nonce, body);
    return built.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        [HMAC_HEADERS.timestamp]: ts,
        [HMAC_HEADERS.nonce]: nonce,
        [HMAC_HEADERS.signature]: sig,
      },
      payload: body,
    });
  };

  let guestNo = 0;
  const freshIp = () =>
    `10.${guestNo % 250}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const emailSignIn: TestApi['emailSignIn'] = async (email, token) => {
    const start = await req('POST', '/auth/email/start', {
      token,
      body: { email, binding: TEST_BINDING },
      ip: freshIp(),
    });
    if (start.statusCode !== 202) throw new Error(`email start failed: ${start.statusCode} ${start.body}`);
    const magic = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;
    return req('POST', '/auth/email/verify', {
      token,
      body: { token: magic, nonce: TEST_NONCE },
      ip: freshIp(),
    });
  };
  const guest: TestApi['guest'] = async (displayName) => {
    guestNo++;
    const res = await req('POST', '/auth/guest', {
      body: { displayName: displayName ?? `Tester_${guestNo}` },
      ip: freshIp(),
    });
    if (res.statusCode !== 200) throw new Error(`guest signup failed: ${res.statusCode} ${res.body}`);
    const j = res.json();
    return {
      id: j.user.id,
      accessToken: j.accessToken,
      refreshToken: j.refreshToken,
      deviceToken: j.deviceToken,
      displayName: j.user.displayName,
      tag: j.user.tag,
    };
  };
  return {
    ...built,
    close,
    mailer,
    clock,
    req,
    emailSignIn,
    guest,
    async account(email) {
      const g = await guest();
      const address = email ?? `player-${randomUUID()}@example.com`;
      const res = await emailSignIn(address, g.accessToken);
      if (res.statusCode !== 200) throw new Error(`email link failed: ${res.statusCode} ${res.body}`);
      const j = res.json();
      return { ...g, accessToken: j.accessToken, refreshToken: j.refreshToken, email: address };
    },
    async grant(userId, currency, amount) {
      await built.ctx.db.transaction((tx) =>
        applyLedger(tx, { userId, currency, delta: amount, reason: 'admin_adjust', ref: randomUUID() }),
      );
    },
    async ban(userId, scope = 'all') {
      const res = await req('POST', '/internal/bans', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: { userId, scope, reason: 'testing bans', durationHours: 1 },
      });
      if (res.statusCode !== 201) throw new Error(`ban failed: ${res.statusCode} ${res.body}`);
    },
    postMatch: (payload, opts = {}) => internal('/internal/match-results', payload, opts),
    internal,
  };
}

/**
 * Builds a full show (`DEFAULT_SHOW_PLAYERS` slots unless `size` says otherwise):
 * humans take the given placements, bots fill the rest.
 * Rounds follow the Main Show curve: race 100→60, survival 60→30, team 30→12, final 12→1.
 *
 * @param humans - User ids in finishing order among humans with explicit placements.
 */
export function buildShow(opts: {
  matchId?: string;
  queue?: 'casual' | 'ranked' | 'custom';
  humans: { userId: string; placement: number }[];
  size?: number;
  startIso?: string;
}): MatchResultInput {
  const size = opts.size ?? DEFAULT_SHOW_PLAYERS;
  const byPlacement = new Map(opts.humans.map((h) => [h.placement, h.userId]));
  const participants = Array.from({ length: size }, (_, i) => {
    const placement = i + 1;
    const userId = byPlacement.get(placement) ?? null;
    return {
      key: `p${placement}`,
      userId,
      isBot: userId === null,
      name: userId ? `Human ${placement}` : `Bot ${placement}`,
      ...(userId
        ? { stats: { jumps: 200, dives: 50, grabs: 30, checkpoints: 20, bounces: 25, emotes: 12 } }
        : {}),
    };
  });
  const cut = [size, Math.round(size * 0.6), Math.round(size * 0.3), Math.round(size * 0.12), 1];
  const types = ['race', 'survival', 'team', 'final'] as const;
  const rounds = types.map((roundType, r) => ({
    roundId: `${roundType}-${r}`,
    roundType,
    durationMs: 120_000,
    results: participants
      .filter((_, i) => i < cut[r]!)
      .map((p, i) => ({
        key: p.key,
        qualified: i < cut[r + 1]!,
        position: roundType === 'race' ? i + 1 : null,
        timeMs: roundType === 'race' ? 60_000 + i * 500 : null,
      })),
  }));
  const start = Date.parse(opts.startIso ?? '2026-10-02T11:50:00.000Z');
  return {
    matchId: opts.matchId ?? `m_${randomUUID().replace(/-/g, '')}`,
    queue: opts.queue ?? 'casual',
    playlistId: opts.queue === 'ranked' ? 'ranked' : 'main-show',
    region: 'na',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 8 * 60_000).toISOString(),
    participants,
    rounds,
    placements: participants.map((p, i) => ({ key: p.key, placement: i + 1, crowned: i === 0 })),
  };
}
