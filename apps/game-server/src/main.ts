/**
 * Game server entry point: `pnpm --filter @tumble/game-server dev` (port 7350).
 *
 * Boots Rapier, builds the room dependencies and starts HTTP + WebSocket on
 * one port. Every environment variable is parsed by `config.ts`; see
 * `.env.example` for the full list.
 *
 * Integration: `createDevRoomDeps` is the standalone wiring (capsule sim,
 * dev arena, single-round loop, random-walk bots); `createRealRoomDeps`
 * plays real shows through `ShowDirectorController`.
 */
import { resolve } from 'node:path';
import { loadServiceConfig } from '@tumble/shared/env';
import { installLifecycle } from '@tumble/shared/lifecycle';
import {
  apiErrorReporter,
  ApiLiveOps,
  STATIC_LIVEOPS,
  type LiveOpsSource,
} from '@tumble/shared/liveops-client';
import { trustFunction } from '@tumble/shared/proxy';
import { loadRapier } from '@tumble/sim';
import { loadConfig } from './config.ts';
import { createDevRoomDeps } from './devDeps.ts';
import { drain } from './drain.ts';
import { createLogger, lineLogger } from './logger.ts';
import { startMatchmakerLink, type MatchmakerLink } from './matchmakerLink.ts';
import { createRealRoomDeps } from './realDeps.ts';
import { ResultsOutbox } from './outbox.ts';
import { sendResultsOnce } from './results.ts';
import { startGameServer } from './server.ts';

const config = loadServiceConfig(resolve(import.meta.dirname, '..'), loadConfig);
const production = config.env === 'production';
const { roomCapacity: capacity, maxRooms, serverCapacity } = config.capacity;
const resultsCfg = config.results;
const logger = createLogger({
  level: config.ops.logLevel,
  ...(config.link ? { serverId: config.link.serverId, region: config.link.region } : {}),
});
const log = lineLogger(logger);
// Maintenance and kill switches come from the API that results go to; without one, nothing is ever switched off.
const liveOps: LiveOpsSource = resultsCfg
  ? new ApiLiveOps({ apiUrl: resultsCfg.apiUrl, secret: resultsCfg.secret, log })
  : STATIC_LIVEOPS;
if (liveOps instanceof ApiLiveOps) {
  // Refreshed on a timer, not on demand: an idle server must already know about maintenance when the next join arrives.
  void liveOps.refresh();
  setInterval(() => void liveOps.refresh(), 30_000).unref();
}
// Installed before anything opens, so a signal or crash during startup is handled too.
const life = installLifecycle({
  service: 'game-server',
  log: logger,
  sentryDsn: config.ops.sentryDsn,
  environment: config.env,
  reporters: resultsCfg
    ? [apiErrorReporter({ apiUrl: resultsCfg.apiUrl, secret: resultsCfg.secret, service: 'game-server' })]
    : [],
  // The drain bounds itself; this only catches a drain that hangs.
  shutdownTimeoutMs: config.ops.drainSettleMs + config.ops.drainTimeoutMs + config.ops.outboxFlushMs + 30_000,
});
let draining = false;

const R = await loadRapier();
const results = resultsCfg
  ? new ResultsOutbox({
      dir: resultsCfg.outboxDir,
      send: (payload) => sendResultsOnce({ ...resultsCfg, log }, payload),
      log,
    })
  : null;
await results?.start();
// GS_DEV=1 swaps in the capsule stand-in sim for load tests that should not depend on content.
const deps = config.devSim
  ? createDevRoomDeps(R, { playSeconds: config.devSim.playSeconds, log })
  : createRealRoomDeps(R, {
      ...(config.playlistId ? { playlistId: config.playlistId } : {}),
      log,
      results,
      // peek() never waits on the API: a stale answer is better than a stalled show start.
      mutatorsEnabled: () => liveOps.peek().flag('mutators.chaos'),
    });

const server = await startGameServer({
  port: config.port,
  deps,
  maxRooms,
  config: {
    capacity,
    fillWaitMs: config.fillWaitMs,
    startAtHumans: config.startAtHumans,
    ticketedFillWaitMs: config.ticketedFillWaitMs,
  },
  tickets: {
    secret: config.ticketSecret,
    allowUnticketed: config.allowUnticketed,
    ...(config.link ? { serverId: config.link.serverId, allowDefaultSid: !production } : {}),
  },
  ...(config.controlSecret ? { control: { secret: config.controlSecret } } : {}),
  ready: () => !draining,
  acceptNewMatches: () => liveOps.peek().maintenance(Date.now()).phase !== 'active',
  helloTimeoutMs: config.exposure.helloTimeoutMs,
  http: {
    debug: config.exposure.debug,
    allowedOrigins: config.exposure.allowedOrigins,
    ...(config.exposure.metricsToken ? { metricsToken: config.exposure.metricsToken } : {}),
    // Outside production, monitoring stays open unless the operator chose a token or an internal port.
    openMetrics: !production && !config.exposure.metricsToken && config.exposure.internalPort === undefined,
    ...(config.exposure.internalPort !== undefined ? { internalPort: config.exposure.internalPort } : {}),
    ...(config.exposure.internalHost ? { internalHost: config.exposure.internalHost } : {}),
    trust: trustFunction(config.exposure.trustProxy),
    maxPendingPerIp: config.exposure.maxPendingPerIp,
  },
});
if (production && !config.exposure.metricsToken && config.exposure.internalPort === undefined)
  logger.warn(
    '[game-server] /metrics and /rooms are disabled: set INTERNAL_PORT (private listener) or METRICS_TOKEN (bearer) to scrape them',
  );

log(
  `[game-server] listening on :${server.port} (rapier ${R.version()}) ws=/ws${server.internalPort ? ` internal=:${server.internalPort}` : ''} · tickets ${config.allowUnticketed ? 'optional (dev)' : 'required'} · results ${resultsCfg ? `→ ${resultsCfg.apiUrl} (outbox ${resultsCfg.outboxDir})` : 'off'}`,
);

const link: MatchmakerLink | null = config.link
  ? startMatchmakerLink({
      ...config.link,
      capacity: serverCapacity,
      maxRooms,
      report: () => server.rooms.capacityReport(),
      humans: () => server.rooms.list().reduce((n, r) => n + r.humans, 0),
      ...(results ? { outbox: () => results.backlog } : {}),
      joined: () => server.rooms.takeJoined(),
      log,
    })
  : null;

if (results) {
  const outbox = results;
  const timer = setInterval(() => (server.metrics.outboxBacklog = outbox.backlog), 5000);
  timer.unref();
}

life.onShutdown(async () => {
  await drain({
    setDraining: () => {
      draining = true;
      server.metrics.draining = 1;
    },
    link,
    rooms: () => server.rooms.list().length,
    closeServer: () => server.close(),
    outbox: results,
    log,
    settleMs: config.ops.drainSettleMs,
    timeoutMs: config.ops.drainTimeoutMs,
    outboxFlushMs: config.ops.outboxFlushMs,
  });
  logger.flush();
});
