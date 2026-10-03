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
import { loadRapier } from '@tumble/sim';
import { loadConfig } from './config.ts';
import { createDevRoomDeps } from './devDeps.ts';
import { startMatchmakerLink, type MatchmakerLink } from './matchmakerLink.ts';
import { createRealRoomDeps } from './realDeps.ts';
import { ResultsOutbox } from './outbox.ts';
import { sendResultsOnce } from './results.ts';
import { startGameServer } from './server.ts';

const config = loadServiceConfig(resolve(import.meta.dirname, '..'), loadConfig);
const production = config.env === 'production';
const { roomCapacity: capacity, maxRooms, serverCapacity } = config.capacity;
const resultsCfg = config.results;

const R = await loadRapier();
const log = (m: string): void => console.log(m);
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
});

console.log(
  `[game-server] listening on :${server.port} (rapier ${R.version()}) ws=/ws metrics=/metrics · tickets ${config.allowUnticketed ? 'optional (dev)' : 'required'} · results ${resultsCfg ? `→ ${resultsCfg.apiUrl} (outbox ${resultsCfg.outboxDir})` : 'off'}`,
);

const link: MatchmakerLink | null = config.link
  ? startMatchmakerLink({
      ...config.link,
      capacity: serverCapacity,
      maxRooms,
      report: () => server.rooms.capacityReport(),
      humans: () => server.rooms.list().reduce((n, r) => n + r.humans, 0),
      joined: () => server.rooms.takeJoined(),
      log,
    })
  : null;

const shutdown = (): void => {
  console.log('[game-server] shutting down');
  results?.stop();
  void (link?.stop() ?? Promise.resolve()).then(() => server.close()).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
