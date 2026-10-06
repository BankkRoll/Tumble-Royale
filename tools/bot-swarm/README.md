# @tumble/bot-swarm

Headless load tester. Spawns WebSocket clients that join game-server rooms,
send plausible 60 Hz inputs with redundancy, and report snapshot rate,
bandwidth and RTT, followed by the server's `/metrics`.

```sh
pnpm --filter @tumble/bot-swarm start -- --clients 100 --url ws://localhost:7350/ws --duration 180
```

| Flag                            | Meaning                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `--clients N`                   | Clients to spawn (default 100, one full show)                |
| `--procs N`                     | Spread clients across N processes (for thousands of clients) |
| `--url <ws>`                    | Game server WebSocket                                        |
| `--duration S`                  | Run time in seconds (PLAYING starts about 60 s in)           |
| `--lag MS --jitter MS --loss P` | Simulated network conditions                                 |
| `--spectators N`                | Free-camera spectators that join the running show            |
| `--spectate-after S`            | Seconds before the spectators connect (default 45)           |
| `--ticket-secret S`             | The server's `GAME_TICKET_SECRET` (or that env variable)     |

Spectators only reach a running show through its match, so a spectator run
signs join tickets for every client (one shared match id) with the game
server's `GAME_TICKET_SECRET`; the server must run without a matchmaker
link, and the run stays in one process. Spectators send no inputs, ack
snapshots like the browser does while watching, and move a free-camera
focus hint down the course twice a second. Their traffic is reported in its
own block:

```sh
GAME_TICKET_SECRET=… pnpm --filter @tumble/bot-swarm start -- --clients 40 --spectators 8 --spectate-after 50 --duration 120
```
