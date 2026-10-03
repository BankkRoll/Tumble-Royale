/**
 * Composition root for the API.
 *
 * Responsibilities:
 * - Open the database (Postgres or PGlite), run migrations, sync the content catalog,
 *   soft-reset ranked ratings when the active season is new.
 * - Pick the KV (Redis or memory), payment provider (Stripe or fake) and mailer.
 * - Configure Fastify: CORS, rate limits, raw-body JSON parsing, error mapping.
 * - Register every route module and the realtime gateway.
 */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { trustFunction } from '@tumble/shared/proxy';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerIdentityRoutes } from './accounts/identities.ts';
import { registerAccountRoutes } from './accounts/routes.ts';
import { createMailer, type Mailer } from './auth/mailer.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { clockedCatalog, cosmeticIndex, loadCatalog, type Catalog } from './catalog.ts';
import type { ApiConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { openDatabase, type Database } from './db/client.ts';
import { challenges, cosmeticsCatalog } from './db/schema.ts';
import {
  DisabledPaymentProvider,
  FakePaymentProvider,
  StripePaymentProvider,
  type PaymentProvider,
} from './economy/payments.ts';
import { registerEconomyRoutes } from './economy/routes.ts';
import { ApiError } from './http/errors.ts';
import { rateLimitKey } from './http/rate-limit.ts';
import { kvRateLimitStore } from './http/rate-limit-store.ts';
import { createKV, type KV } from './kv/index.ts';
import { registerMatchRoutes } from './matches/routes.ts';
import { registerModerationRoutes } from './moderation/routes.ts';
import { registerNewsRoutes } from './news/routes.ts';
import { registerProgressionRoutes } from './progression/routes.ts';
import { ensureSeason, onSeasonChanged, type SeasonChangeListener } from './progression/seasons.ts';
import { registerTutorialRoutes } from './progression/tutorial.ts';
import { ensureRankedSeason } from './ranked/season.ts';
import { attachGateway, type Gateway } from './realtime/gateway.ts';
import { Notifier } from './realtime/notifier.ts';
import { registerFriendRoutes } from './social/friends.ts';
import { registerWhisperRoutes } from './social/whisper.ts';
import { registerPartyRoutes } from './social/party.ts';

/** Optional dependency overrides (tests). */
export interface BuildOptions {
  database?: Database;
  kv?: KV;
  now?: () => Date;
  mailer?: Mailer;
  payments?: PaymentProvider;
  fetch?: typeof fetch;
  catalog?: Catalog;
  /**
   * Run once per new season, cluster-wide (e.g. the ranked soft reset).
   * Also attachable later with `onSeasonChanged(ctx, fn)`.
   */
  seasonListeners?: SeasonChangeListener[];
  /** Disable request logging (tests). */
  logger?: boolean;
  /** Count rate limits in the KV (default: when REDIS_URL is set). */
  sharedRateLimit?: boolean;
}

/** A built API ready to `listen()` or `inject()`. */
export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  database: Database;
  gateway: Gateway;
  close(): Promise<void>;
}

/**
 * Upserts the content catalog into `cosmetics_catalog` and `challenges` so SQL
 * reporting and foreign tools see the same items the API validates against.
 */
export async function syncCatalog(ctx: AppContext): Promise<void> {
  const now = ctx.now();
  for (const c of ctx.catalog.cosmetics) {
    const values = {
      name: c.name,
      slot: c.slot,
      rarity: c.rarity,
      source: c.source,
      priceCurrency: c.price?.currency ?? null,
      priceAmount: c.price?.amount ?? null,
      active: true,
      data: {},
      updatedAt: now,
    };
    await ctx.db
      .insert(cosmeticsCatalog)
      .values({ id: c.id, ...values })
      .onConflictDoUpdate({ target: cosmeticsCatalog.id, set: values });
  }
  for (const c of ctx.catalog.challenges) {
    const values = {
      period: c.period,
      title: c.title,
      metric: c.metric,
      target: c.target,
      rewardXp: c.rewardXp,
      rewardGumballs: c.rewardGumballs,
      active: true,
    };
    await ctx.db
      .insert(challenges)
      .values({ id: c.id, ...values })
      .onConflictDoUpdate({ target: challenges.id, set: values });
  }
}

const HEALTH_PROBE_MS = 2000;

/** Runs a dependency check with a deadline; false on failure or timeout. */
async function probe(check: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_PROBE_MS);
  });
  try {
    return await Promise.race([check().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the API.
 *
 * @param config - Parsed configuration.
 * @param opts - Overrides for tests.
 */
export async function buildApp(config: ApiConfig, opts: BuildOptions = {}): Promise<BuiltApp> {
  const database =
    opts.database ?? (await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir }));
  await database.migrate();
  const now = opts.now ?? (() => new Date());
  const kv = opts.kv ?? createKV(config.redisUrl, () => now().getTime());
  const catalog = clockedCatalog(opts.catalog ?? loadCatalog(), now);
  const payments =
    opts.payments ??
    (config.stripe
      ? new StripePaymentProvider(config.stripe.secretKey, config.stripe.webhookSecret)
      : config.env === 'production'
        ? new DisabledPaymentProvider()
        : new FakePaymentProvider());

  const ctx: AppContext = {
    config,
    db: database.db,
    kv,
    catalog,
    cosmetics: cosmeticIndex(catalog),
    now,
    mailer: opts.mailer ?? createMailer(config),
    payments,
    fetch: opts.fetch ?? fetch,
    notifier: new Notifier(kv),
  };
  await syncCatalog(ctx);
  // The ranked soft reset follows every season change; listeners must be
  // registered before the boot check so a rollover that happened while the
  // API was down still reaches them.
  onSeasonChanged(ctx, async ({ current }) => {
    await ensureRankedSeason(ctx, current.id);
  });
  for (const listener of opts.seasonListeners ?? []) onSeasonChanged(ctx, listener);
  await ensureSeason(ctx);
  await ensureRankedSeason(ctx);
  // Idle servers still notice a rollover; requests also check (cheaply) below.
  const seasonTimer = setInterval(() => void ensureSeason(ctx).catch(() => undefined), 60_000);
  seasonTimer.unref();

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    // SECURITY: X-Forwarded-For is believed only from the proxies TRUST_PROXY names.
    trustProxy: trustFunction(config.trustProxy) || false,
    bodyLimit: 256 * 1024,
  });

  // Signature checks (internal HMAC, Stripe) need the exact bytes that were signed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = text;
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError(400, 'invalid_json', 'Body is not valid JSON'), undefined);
    }
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => rateLimitKey(config.jwtSecret, req, now),
    // Shared windows across instances whenever there is a shared store; the
    // in-process store only for single-instance memory setups (its expired keys
    // are never revisited, so the KV store would leak them).
    ...((opts.sharedRateLimit ?? !!config.redisUrl)
      ? { store: kvRateLimitStore(kv, () => now().getTime()), skipOnError: true }
      : {}),
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests; retry in ${Math.ceil(c.ttl / 1000)} s`,
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({
        error: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; error?: string };
    if (e.statusCode === 429)
      return reply.code(429).send({ error: 'rate_limited', message: e.message ?? 'Too many requests' });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply
        .code(e.statusCode)
        .send({ error: e.code ?? 'bad_request', message: e.message ?? 'Bad request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: 'not_found', message: `No route ${req.method} ${req.url}` }),
  );

  app.addHook('onRequest', async (req) => {
    try {
      await ensureSeason(ctx);
    } catch (err) {
      req.log.error({ err }, 'season rollover check failed');
    }
  });

  // Load balancers route on this: an instance that lost Redis cannot fan out
  // realtime events, keep presence or share rate limits, so it reports 503.
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const [db, store] = await Promise.all([
      probe(() => ctx.db.execute(sql`select 1`)),
      probe(() => kv.ping()),
    ]);
    const ok = db && store;
    return reply.code(ok ? 200 : 503).send({
      ok,
      db: database.driver,
      dbOk: db,
      kv: config.redisUrl ? 'redis' : 'memory',
      kvOk: store,
      payments: payments.id,
      season: catalog.season.id,
    });
  });

  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerIdentityRoutes(app, ctx);
  registerEconomyRoutes(app, ctx);
  registerProgressionRoutes(app, ctx);
  registerTutorialRoutes(app, ctx);
  registerMatchRoutes(app, ctx);
  registerFriendRoutes(app, ctx);
  registerWhisperRoutes(app, ctx);
  registerPartyRoutes(app, ctx);
  registerModerationRoutes(app, ctx);
  registerNewsRoutes(app, ctx);
  const gateway = attachGateway(app, ctx);

  return {
    app,
    ctx,
    database,
    gateway,
    close: async () => {
      clearInterval(seasonTimer);
      await gateway.close();
      await app.close();
      await kv.close();
      await database.close();
    },
  };
}
