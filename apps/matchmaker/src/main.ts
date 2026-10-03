/**
 * Matchmaker entry point: `pnpm --filter @tumble/matchmaker dev` (port 7370).
 */
import { resolve } from 'node:path';
import { loadServiceConfig } from '@tumble/shared/env';
import { consoleLogger, installLifecycle } from '@tumble/shared/lifecycle';
import { startInternalMetrics } from '@tumble/shared/metrics';
import { buildMatchmaker } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadServiceConfig(resolve(import.meta.dirname, '..'), loadConfig);
// Installed before anything opens, so a signal or crash during startup is handled too.
const life = installLifecycle({
  service: 'matchmaker',
  log: consoleLogger,
  sentryDsn: config.sentryDsn,
  environment: config.env,
});
const built = await buildMatchmaker(config);
life.setLogger(built.app.log);
life.onShutdown(() => built.close());
if (config.memoryStoreInProduction) {
  built.app.log.warn(
    '!!! REDIS_URL is unset (ALLOW_MEMORY_STORE=1): queues, lobbies and the game-server registry are in ' +
      'process memory. They are lost on every restart and NOT shared between matchmaker instances. Run one instance only. !!!',
  );
}
if (!config.apiUrl)
  built.app.log.warn('API_URL is unset: bans are not checked when players queue or join lobbies');
await built.app.listen({ host: config.host, port: config.port });
const { internalPort, internalHost } = config.metrics;
if (internalPort !== undefined) {
  const internal = await startInternalMetrics(() => built.ops.registry.render(), internalPort, internalHost);
  life.onShutdown(() => internal.close());
  built.app.log.info(`[matchmaker] internal metrics on :${internal.port}/metrics`);
} else if (config.env === 'production' && !config.metrics.token) {
  built.app.log.warn(
    '[matchmaker] /metrics is disabled: set INTERNAL_PORT (private listener) or METRICS_TOKEN (bearer)',
  );
}
built.app.log.info(
  `[matchmaker] ${config.redisUrl ? 'redis' : 'memory'} store | lobby ${config.targetSize} | max wait ${config.maxWaitMs} ms | :${config.port}`,
);
