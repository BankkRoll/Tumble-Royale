# @tumble/game-server

Authoritative match server. One Node process hosts many rooms. Each room
runs a show through the real match sim at 30 Hz (two 60 Hz Rapier steps per
tick) and streams delta snapshots to its clients over WebSocket.

```sh
pnpm --filter @tumble/game-server dev     # watch mode on :7350
pnpm --filter @tumble/game-server start
```

## Endpoints

| Path                           | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `/ws`                          | Game WebSocket (binary protocol, see `packages/netcode/PROTOCOL.md`) |
| `/health`                      | Liveness, Rapier version, room count                                 |
| `/rooms`                       | Active rooms                                                         |
| `/metrics`                     | Prometheus: tick time avg/p95/max, rooms, players, bytes out, RTT    |
| `/debug/determinism?steps=600` | Runs the Rapier determinism scenario (clients compare against it)    |

## Environment

Every variable and its default is listed once in [`.env.example`](.env.example).
The shared secrets and URLs come from the root [`.env`](../../.env.example); run
`pnpm setup:env` once to create both files.

- `GAME_TICKET_SECRET` (always required) verifies matchmaker join tickets.
- `API_URL` + `INTERNAL_HMAC_SECRET` post matchmade show results to the API
  (default in development: the local API). Results go through a durable outbox
  in `RESULTS_OUTBOX_DIR`, retried with exponential backoff (2 s doubling,
  capped at 5 min) across restarts; payloads the API rejects move to `dead/`.
  `REPORT_RESULTS=0` turns this off.
- `MATCHMAKER_URL` + `GAME_SERVER_SECRET` register and heartbeat with the
  matchmaker, advertising `SERVER_CAPACITY` seats (bots included, default
  `MAX_ROOMS × ROOM_CAPACITY` = 3 × 100). Once registered, tickets whose `sid` names
  another server are refused. `GAME_SERVER_SECRET` also enables the signed
  `POST /internal/kick` endpoint.

## Load testing

```sh
FILL_WAIT_MS=3000 pnpm --filter @tumble/game-server start
pnpm --filter @tumble/bot-swarm start -- --clients 100 --url ws://localhost:7350/ws --duration 60
```

Add `--lag 150 --jitter 20 --loss 0.02` to simulate a bad connection, or
`--procs 8` to spread clients across processes.

Every room in a process ticks on one Node event loop, so `MAX_ROOMS` is rooms
per core. A full 100-player room measured 6.4 ms p50 / 9.0 ms p95 per 30 Hz
tick in process (`TUMBLE_PERF=1 pnpm exec vitest run test/tickBudget.test.ts`),
so the default is 3: run one process per core to host more.

## Testing

```sh
pnpm --filter @tumble/game-server test
```
