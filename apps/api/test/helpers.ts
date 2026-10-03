/**
 * Test harness: an API on in-memory PGlite + memory KV with a controllable clock.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildOptions, type BuiltApp } from '../src/app.ts';
import { MemoryMailer } from '../src/auth/mailer.ts';
import { loadConfig } from '../src/config.ts';
import { applyLedger } from '../src/economy/ledger.ts';
import { HMAC_HEADERS, signInternal } from '../src/http/auth.ts';
import type { MatchResultInput } from '../src/matches/schema.ts';

/** Admin bearer used by tests. */
export const ADMIN_TOKEN = 'test-admin-token-0123456789';

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
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
  grant(userId: string, currency: 'gumballs' | 'gems' | 'crown_shards', amount: number): Promise<void>;
  postMatch(
    payload: MatchResultInput,
    opts?: { secret?: string; nonce?: string; timestamp?: number },
  ): Promise<LightMyRequestResponse>;
}

/**
 * Builds a fresh isolated API.
 *
 * @param startIso - Initial clock time.
 * @param extra - Extra build options (e.g. season-change listeners).
 */
export async function createTestApi(
  startIso = '2026-10-02T12:00:00.000Z',
  extra: Pick<BuildOptions, 'seasonListeners'> = {},
): Promise<TestApi> {
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
  const config = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_MAX: '100000', ADMIN_TOKEN, LOG_LEVEL: 'silent' });
  const mailer = new MemoryMailer();
  const built = await buildApp(config, { now: clock.now, mailer, logger: false, ...extra });

  const req: TestApi['req'] = (method, url, opts = {}) =>
    built.app.inject({
      method,
      url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });

  let guestNo = 0;
  return {
    ...built,
    mailer,
    clock,
    req,
    async guest(displayName) {
      guestNo++;
      const res = await req('POST', '/auth/guest', {
        body: { displayName: displayName ?? `Tester_${guestNo}` },
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
    },
    async grant(userId, currency, amount) {
      await built.ctx.db.transaction((tx) =>
        applyLedger(tx, { userId, currency, delta: amount, reason: 'admin_adjust', ref: randomUUID() }),
      );
    },
    postMatch(payload, opts = {}) {
      const body = JSON.stringify(payload);
      const ts = String(opts.timestamp ?? clock.now().getTime());
      const nonce = opts.nonce ?? randomUUID();
      const sig = signInternal(opts.secret ?? config.internalHmacSecret, ts, nonce, body);
      return built.app.inject({
        method: 'POST',
        url: '/internal/match-results',
        headers: {
          'content-type': 'application/json',
          [HMAC_HEADERS.timestamp]: ts,
          [HMAC_HEADERS.nonce]: nonce,
          [HMAC_HEADERS.signature]: sig,
        },
        payload: body,
      });
    },
  };
}

/**
 * Builds a 40-slot show: humans take the given placements, bots fill the rest.
 * Rounds: race 40→26, survival 26→14, team 14→7, final 7→1.
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
  const size = opts.size ?? 40;
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
  const cut = [size, 26, 14, 7, 1];
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
