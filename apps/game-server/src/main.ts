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
 *   (both required; reporting is skipped otherwise)
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
import { capacityConfig, linkConfig } from './config.ts';
import { createDevRoomDeps } from './devDeps.ts';
import { startMatchmakerLink, type MatchmakerLink } from './matchmakerLink.ts';
import { createRealRoomDeps } from './realDeps.ts';
import { HttpResultsSink } from './results.ts';
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
const apiUrl = process.env.API_URL;
const hmacSecret = process.env.INTERNAL_HMAC_SECRET;
const results = apiUrl && hmacSecret ? new HttpResultsSink({ apiUrl, secret: hmacSecret, log }) : null;
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
  `[game-server] listening on :${server.port} (rapier ${R.version()}) ws=/ws metrics=/metrics · tickets ${allowUnticketed ? 'optional (dev)' : 'required'} · results ${results ? `→ ${apiUrl}` : 'off'}`,
);

const link: MatchmakerLink | null = linkCfg
  ? startMatchmakerLink({
      ...linkCfg,
      capacity: serverCapacity,
      maxRooms,
      report: () => server.rooms.capacityReport(),
      log,
    })
  : null;

const shutdown = (): void => {
  console.log('[game-server] shutting down');
  void (link?.stop() ?? Promise.resolve()).then(() => server.close()).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
