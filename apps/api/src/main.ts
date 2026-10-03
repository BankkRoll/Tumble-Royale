/**
 * API entry point: `pnpm --filter @tumble/api dev` (port 7360 by default).
 */
import { buildApp } from './app.ts';
import { SmtpMailer } from './auth/mailer.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const built = await buildApp(config);
const { app } = built;

if (config.memoryStoreInProduction) {
  app.log.warn(
    '!!! REDIS_URL is unset (ALLOW_MEMORY_STORE=1): parties, presence, leaderboards and replay nonces are ' +
      'in process memory. They are lost on every restart and NOT shared between API instances. Run one instance only. !!!',
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
app.log.info(
  `[api] ${built.database.driver} | ${config.redisUrl ? 'redis' : 'memory kv'} | listening on :${config.port}`,
);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`[api] ${signal} received, shutting down`);
  await built.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
