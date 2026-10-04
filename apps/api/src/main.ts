/**
 * API entry point: `pnpm --filter @tumble/api dev` (port 7360 by default).
 */
import { resolve } from 'node:path';
import { loadServiceConfig } from '@tumble/shared/env';
import { consoleLogger, installLifecycle } from '@tumble/shared/lifecycle';
import { startInternalMetrics } from '@tumble/shared/metrics';
import { buildApp } from './app.ts';
import { SmtpMailer } from './auth/mailer.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { recordServerError } from './liveops/routes.ts';

const config = loadServiceConfig(resolve(import.meta.dirname, '..'), loadConfig);
// Crashes before the database is open only reach the log and Sentry.
let ctx: AppContext | null = null;
// Installed before anything opens, so a signal or crash during startup is handled too.
const life = installLifecycle({
  service: 'api',
  log: consoleLogger,
  sentryDsn: config.ops.sentryDsn,
  environment: config.env,
  reporters: [async (err, context) => (ctx ? recordServerError(ctx, err, context) : undefined)],
});
const built = await buildApp(config);
ctx = built.ctx;
const { app } = built;
life.setLogger(app.log);
life.onShutdown(async () => {
  built.ops.setDraining();
  await built.close();
});

if (config.memoryStoreInProduction) {
  app.log.warn(
    '!!! REDIS_URL is unset (ALLOW_MEMORY_STORE=1): parties, presence, leaderboards and replay nonces are ' +
      'in process memory. They are lost on every restart and NOT shared between API instances. Run one instance only. !!!',
  );
}
if (config.env === 'production' && built.database.driver === 'pglite') {
  app.log.warn(
    '!!! DATABASE_URL is unset (ALLOW_EMBEDDED_DB=1): running on embedded PGlite. Run one API instance only ' +
      'and back up PGLITE_DIR while the API is stopped. !!!',
  );
}
if (!config.discord) app.log.info('Discord sign-in disabled (DISCORD_CLIENT_ID/SECRET unset)');
if (!config.google) app.log.info('Google sign-in disabled (GOOGLE_CLIENT_ID/SECRET unset)');
if (built.ctx.mailer instanceof SmtpMailer) {
  // A bad relay only breaks email sign-in, so boot anyway but say so loudly.
  void built.ctx.mailer.verify().catch((err: unknown) => app.log.error({ err }, 'SMTP relay check failed'));
} else if (built.ctx.mailer.id === 'disabled') {
  app.log.info('Email sign-in disabled (SMTP_URL unset)');
}
if (!config.stripe) app.log.info('Stripe disabled: Gem checkouts complete instantly via the fake provider');

await app.listen({ host: config.host, port: config.port });
const { internalPort, internalHost } = config.ops.metrics;
if (internalPort !== undefined) {
  const internal = await startInternalMetrics(
    () => built.ops.metrics.registry.render(),
    internalPort,
    internalHost,
  );
  life.onShutdown(() => internal.close());
  app.log.info(`[api] internal metrics on :${internal.port}/metrics`);
} else if (config.env === 'production' && !config.ops.metrics.token) {
  app.log.warn('[api] /metrics is disabled: set INTERNAL_PORT (private listener) or METRICS_TOKEN (bearer)');
}
app.log.info(
  `[api] ${built.database.driver} | ${config.redisUrl ? 'redis' : 'memory kv'} | listening on :${config.port}`,
);
