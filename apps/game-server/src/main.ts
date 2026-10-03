/**
 * Game server entry point.
 *
 * Boots Rapier, builds the room dependencies and starts HTTP + WebSocket on
 * one port. Configuration (env):
 * - `PORT` (7350)
 * - `ROOM_CAPACITY` (40) — show size including bots (unticketed dev rooms)
 * - `FILL_WAIT_MS` (25000) — wait after the first human before bot fill
 * - `START_AT_HUMANS` (= capacity) — start early once this many humans joined
 * - `TICKET_FILL_WAIT_MS` (15000) — matchmade rooms start once every ticketed human joined, or after this
 * - `PLAY_SECONDS` (120) — dev show loop round length (GS_DEV=1 only)
 * - `GS_DEV` — `1` uses the capsule stand-in sim instead of the real game
 * - `PLAYLIST` — playlist id for unticketed shows (default Main Show)
 * - `GAME_TICKET_SECRET` — verifies matchmaker join tickets (dev default outside production)
 * - `ALLOW_UNTICKETED` — `1`/`0`; defaults to allowed except when `NODE_ENV=production`
 * - `API_URL` + `INTERNAL_HMAC_SECRET` — post matchmade show results to the account API
 *   (development defaults: the local API and its dev secret; production must set both)
 * - `RESULTS_OUTBOX_DIR` (`./.data/results-outbox`) — durable queue of undelivered results;
 *   `REPORT_RESULTS=0` turns reporting off
 * - `MATCHMAKER_URL` + `GAME_SERVER_SECRET` + `PUBLIC_WS_URL` (+ `SERVER_ID`, `REGION`) —
 *   register with the matchmaker and heartbeat (optional); tickets for other servers are refused
 * - `MAX_ROOMS` (10) and `SERVER_CAPACITY` (= MAX_ROOMS × ROOM_CAPACITY seats, bots included) —
 *   what the matchmaker may place here
 *
 * Integration: `createDevRoomDeps` is the standalone wiring (capsule sim,
 * dev arena, single-round loop, random-walk bots); `createRealRoomDeps`
 * plays real shows through `ShowDirectorController`.
 */
import { loadRapier } from '@tumble/sim';
import { capacityConfig, linkConfig, resultsConfig } from './config.ts';
import { createDevRoomDeps } from './devDeps.ts';
import { startMatchmakerLink, type MatchmakerLink } from './matchmakerLink.ts';
import { createRealRoomDeps } from './realDeps.ts';
import { ResultsOutbox } from './outbox.ts';
import { sendResultsOnce } from './results.ts';
import { startGameServer } from './server.ts';
import { DEV_TICKET_SECRET } from './tickets.ts';

const env = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d;
};

const production = process.env.NODE_ENV === 'production';
const ticketSecret = process.env.GAME_TICKET_SECRET ?? (production ? '' : DEV_TICKET_SECRET);
if (!ticketSecret) throw new Error('GAME_TICKET_SECRET must be set in production');
const allowUnticketed = process.env.ALLOW_UNTICKETED ? process.env.ALLOW_UNTICKETED === '1' : !production;

const R = await loadRapier();
const { roomCapacity: capacity, maxRooms, serverCapacity } = capacityConfig(process.env);
const port = env('PORT', 7350);
const linkCfg = linkConfig(process.env, port);
const log = (m: string): void => console.log(m);
const resultsCfg = resultsConfig(process.env);
const results = resultsCfg
  ? new ResultsOutbox({
      dir: resultsCfg.outboxDir,
      send: (payload) => sendResultsOnce({ ...resultsCfg, log }, payload),
      log,
    })
  : null;
await results?.start();
// GS_DEV=1 swaps in the capsule stand-in sim for load tests that should not depend on content.
const deps =
  process.env.GS_DEV === '1'
    ? createDevRoomDeps(R, { playSeconds: env('PLAY_SECONDS', 120), log })
    : createRealRoomDeps(R, {
        ...(process.env.PLAYLIST ? { playlistId: process.env.PLAYLIST } : {}),
        log,
        results,
      });

const server = await startGameServer({
  port,
  deps,
  maxRooms,
  config: {
    capacity,
    fillWaitMs: env('FILL_WAIT_MS', 25_000),
    startAtHumans: env('START_AT_HUMANS', capacity),
    ticketedFillWaitMs: env('TICKET_FILL_WAIT_MS', 15_000),
  },
  tickets: {
    secret: ticketSecret,
    allowUnticketed,
    ...(linkCfg ? { serverId: linkCfg.serverId, allowDefaultSid: !production } : {}),
  },
});

console.log(
  `[game-server] listening on :${server.port} (rapier ${R.version()}) ws=/ws metrics=/metrics · tickets ${allowUnticketed ? 'optional (dev)' : 'required'} · results ${resultsCfg ? `→ ${resultsCfg.apiUrl} (outbox ${resultsCfg.outboxDir})` : 'off'}`,
);

const link: MatchmakerLink | null = linkCfg
  ? startMatchmakerLink({
      ...linkCfg,
      capacity: serverCapacity,
      maxRooms,
      report: () => server.rooms.capacityReport(),
      humans: () => server.rooms.list().reduce((n, r) => n + r.humans, 0),
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
