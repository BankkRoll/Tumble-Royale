/**
 * Game server entry point.
 *
 * Boots Rapier, builds the room dependencies and starts HTTP + WebSocket on
 * one port. Configuration (env):
 * - `PORT` (7350)
 * - `ROOM_CAPACITY` (40) — show size including bots
 * - `FILL_WAIT_MS` (25000) — wait after the first human before bot fill
 * - `START_AT_HUMANS` (= capacity) — start early once this many humans joined
 * - `PLAY_SECONDS` (120) — dev show loop round length (GS_DEV=1 only)
 * - `GS_DEV` — `1` uses the capsule stand-in sim instead of the real game
 * - `PLAYLIST` — playlist id for real shows (default Main Show)
 *
 * Integration: `createDevRoomDeps` is the standalone wiring (capsule sim,
 * dev arena, single-round loop, random-walk bots). The real game swaps in
 * `createMatchSim` from `@tumble/sim/match`, rounds from `@tumble/content`
 * and the ShowDirector through `ShowDirectorController`:
 *   createMatchSim: (o) => createMatchSim(o, matchDeps), loadRound: getRound,
 *   createShowController: () => new ShowDirectorController({ playlist, rounds }), createBot: null
 */
import { loadRapier } from '@tumble/sim';
import { createDevRoomDeps } from './devDeps.ts';
import { createRealRoomDeps } from './realDeps.ts';
import { startGameServer } from './server.ts';

const env = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d;
};

const R = await loadRapier();
const capacity = env('ROOM_CAPACITY', 40);
const log = (m: string): void => console.log(m);
// GS_DEV=1 swaps in the capsule stand-in sim for load tests that should not depend on content.
const deps =
  process.env.GS_DEV === '1'
    ? createDevRoomDeps(R, { playSeconds: env('PLAY_SECONDS', 120), log })
    : createRealRoomDeps(R, { ...(process.env.PLAYLIST ? { playlistId: process.env.PLAYLIST } : {}), log });

const server = await startGameServer({
  port: env('PORT', 7350),
  deps,
  config: {
    capacity,
    fillWaitMs: env('FILL_WAIT_MS', 25_000),
    startAtHumans: env('START_AT_HUMANS', capacity),
  },
});

console.log(`[game-server] listening on :${server.port} (rapier ${R.version()}) ws=/ws metrics=/metrics`);

const shutdown = (): void => {
  console.log('[game-server] shutting down');
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
