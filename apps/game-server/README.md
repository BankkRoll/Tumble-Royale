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

| Variable                                                                                          | Default                                                        | Meaning                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                                            | 7350                                                           | HTTP + WebSocket port                                                                                                                                                                                                                                               |
| `ROOM_CAPACITY`                                                                                   | 40                                                             | Show size including bots (unticketed rooms)                                                                                                                                                                                                                         |
| `FILL_WAIT_MS`                                                                                    | 25000                                                          | Wait after the first human before filling with bots                                                                                                                                                                                                                 |
| `START_AT_HUMANS`                                                                                 | capacity                                                       | Start early once this many humans join                                                                                                                                                                                                                              |
| `TICKET_FILL_WAIT_MS`                                                                             | 15000                                                          | Matchmade rooms start when every ticketed human joins, or after this                                                                                                                                                                                                |
| `PLAYLIST`                                                                                        | Main Show                                                      | Playlist for unticketed shows                                                                                                                                                                                                                                       |
| `GAME_TICKET_SECRET`                                                                              | dev secret                                                     | Verifies matchmaker join tickets; required in production                                                                                                                                                                                                            |
| `ALLOW_UNTICKETED`                                                                                | on unless `NODE_ENV=production`                                | Accept joins without a ticket                                                                                                                                                                                                                                       |
| `API_URL`, `INTERNAL_HMAC_SECRET`                                                                 | dev: `http://localhost:7360` + the API dev secret; prod: unset | Post matchmade show results to the account API. Production must set both and refuses the dev secret                                                                                                                                                                 |
| `RESULTS_OUTBOX_DIR`                                                                              | `./.data/results-outbox`                                       | Durable outbox: results are written here before the first post and retried with exponential backoff (2 s doubling, capped at 5 min) until the API accepts them, across restarts. Payloads the API rejects as malformed move to `dead/`                              |
| `REPORT_RESULTS`                                                                                  | on                                                             | `0` disables results reporting                                                                                                                                                                                                                                      |
| `MATCHMAKER_URL`, `GAME_SERVER_SECRET`, `PUBLIC_WS_URL`, `SERVER_ID`, `REGION`, `SERVER_CAPACITY` | unset                                                          | Register and heartbeat with the matchmaker                                                                                                                                                                                                                          |
| `MAX_ROOMS`                                                                                       | 10                                                             | Concurrent rooms; reported to the matchmaker at registration                                                                                                                                                                                                        |
| `SERVER_CAPACITY`                                                                                 | `MAX_ROOMS × ROOM_CAPACITY`                                    | Concurrent seats **including bots** advertised to the matchmaker. Heartbeats report seats in use (a matchmade room counts its full size from the first ticket), rooms and hosted match ids. When registered, join tickets whose `sid` is another server are refused |
| `GS_DEV`                                                                                          | unset                                                          | `1` swaps in the capsule stand-in sim for load tests                                                                                                                                                                                                                |

## Load testing

```sh
FILL_WAIT_MS=3000 pnpm --filter @tumble/game-server start
pnpm --filter @tumble/bot-swarm start -- --clients 40 --url ws://localhost:7350/ws --duration 60
```

Add `--lag 150 --jitter 20 --loss 0.02` to simulate a bad connection, or
`--procs 8` to spread clients across processes.

## Testing

```sh
pnpm --filter @tumble/game-server test
```
