/**
 * Matchmaker entry point: `pnpm --filter @tumble/matchmaker dev` (port 7370).
 */
import { buildMatchmaker } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const built = await buildMatchmaker(config);
if (config.memoryStoreInProduction) {
  built.app.log.warn(
    '!!! REDIS_URL is unset (ALLOW_MEMORY_STORE=1): queues, lobbies and the game-server registry are in ' +
      'process memory. They are lost on every restart and NOT shared between matchmaker instances. Run one instance only. !!!',
  );
}
if (!config.apiUrl)
  built.app.log.warn('API_URL is unset: bans are not checked when players queue or join lobbies');
await built.app.listen({ host: config.host, port: config.port });
built.app.log.info(
  `[matchmaker] ${config.redisUrl ? 'redis' : 'memory'} store | lobby ${config.targetSize} | max wait ${config.maxWaitMs} ms | :${config.port}`,
);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  built.app.log.info(`[matchmaker] ${signal} received, shutting down`);
  await built.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
