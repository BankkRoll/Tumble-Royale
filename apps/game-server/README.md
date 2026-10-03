# @tumble/game-server

Authoritative match server. One Node process hosts many rooms. Each room
runs a show through the real match sim at 30 Hz (two 60 Hz Rapier steps per
tick) and streams delta snapshots to its clients over WebSocket.

```sh
pnpm --filter @tumble/game-server dev     # watch mode on :7350
pnpm --filter @tumble/game-server build && pnpm --filter @tumble/game-server start   # production bundle
```

## Endpoints

| Path                           | Purpose                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `/ws`                          | Game WebSocket (binary protocol, see `packages/netcode/PROTOCOL.md`)            |
| `/health`                      | Liveness, Rapier version, room count                                            |
| `/rooms`                       | Active rooms (internal port, or `METRICS_TOKEN` bearer)                         |
| `/metrics`                     | Prometheus: tick time, rooms, players, bytes out, RTT (same access as `/rooms`) |
| `/debug/determinism?steps=600` | Rapier determinism scenario; development only, at most 1200 steps               |
| `POST /internal/kick`          | Signed matchmaker host kick (also `/gs/internal/kick`)                          |

Exposure: in production `/debug/*` is off (it runs Rapier on the room event
loop), `/metrics` and `/rooms` are served on `INTERNAL_PORT` or with
`Authorization: Bearer $METRICS_TOKEN`, and otherwise answer 404. CORS is sent
only to `ALLOWED_ORIGINS` (default `PUBLIC_WEB_URL` in production), which also
gate WebSocket upgrades that carry an `Origin`. Each client address may hold
`MAX_PENDING_PER_IP` (8) sockets that have not sent their Hello, which must
arrive within `HELLO_TIMEOUT_MS` (5 s). Client addresses come from the socket
unless `TRUST_PROXY` names the proxies in front.

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
  `MAX_ROOMS × ROOM_CAPACITY`). Once registered, tickets whose `sid` names
  another server are refused. `GAME_SERVER_SECRET` also enables the signed
  `POST /internal/kick` endpoint.

## Load testing

```sh
FILL_WAIT_MS=3000 pnpm --filter @tumble/game-server dev
pnpm --filter @tumble/bot-swarm start -- --clients 40 --url ws://localhost:7350/ws --duration 60
```

Add `--lag 150 --jitter 20 --loss 0.02` to simulate a bad connection, or
`--procs 8` to spread clients across processes.

## Testing

```sh
pnpm --filter @tumble/game-server test
```
