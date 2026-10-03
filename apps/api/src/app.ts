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
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccountRoutes } from './accounts/routes.ts';
import { ConsoleMailer, type Mailer } from './auth/mailer.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { cosmeticIndex, loadCatalog, type Catalog } from './catalog.ts';
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
import { createKV, type KV } from './kv/index.ts';
import { registerMatchRoutes } from './matches/routes.ts';
import { registerModerationRoutes } from './moderation/routes.ts';
import { registerProgressionRoutes } from './progression/routes.ts';
import { ensureRankedSeason } from './ranked/season.ts';
import { attachGateway, type Gateway } from './realtime/gateway.ts';
import { Notifier } from './realtime/notifier.ts';
import { registerFriendRoutes } from './social/friends.ts';
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
  /** Disable request logging (tests). */
  logger?: boolean;
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
  const catalog = opts.catalog ?? loadCatalog();
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
    mailer: opts.mailer ?? new ConsoleMailer(),
    payments,
    fetch: opts.fetch ?? fetch,
    notifier: new Notifier(kv),
  };
  await syncCatalog(ctx);
  await ensureRankedSeason(ctx);

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
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
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      // Per-token buckets for signed-in calls so players behind one NAT do not share a limit.
      return auth?.startsWith('Bearer ') ? `t:${auth.slice(-24)}` : `ip:${req.ip}`;
    },
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

  app.get('/health', { config: { rateLimit: false } }, async () => {
    await ctx.db.execute(sql`select 1`);
    return {
      ok: true,
      db: database.driver,
      kv: config.redisUrl ? 'redis' : 'memory',
      payments: payments.id,
      season: catalog.season.id,
    };
  });

  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerEconomyRoutes(app, ctx);
  registerProgressionRoutes(app, ctx);
  registerMatchRoutes(app, ctx);
  registerFriendRoutes(app, ctx);
  registerPartyRoutes(app, ctx);
  registerModerationRoutes(app, ctx);
  const gateway = attachGateway(app, ctx);

  return {
    app,
    ctx,
    database,
    gateway,
    close: async () => {
      await gateway.close();
      await app.close();
      await kv.close();
      await database.close();
    },
  };
}
