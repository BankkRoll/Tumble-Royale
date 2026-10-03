# @tumble/bot-swarm

Headless load tester. Spawns WebSocket clients that join game-server rooms,
send plausible 60 Hz inputs with redundancy, and report snapshot rate,
bandwidth and RTT, followed by the server's `/metrics`.

```sh
pnpm --filter @tumble/bot-swarm start -- --clients 40 --url ws://localhost:7350/ws --duration 60
```

| Flag                            | Meaning                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `--clients N`                   | Clients to spawn                                             |
| `--procs N`                     | Spread clients across N processes (for thousands of clients) |
| `--url <ws>`                    | Game server WebSocket                                        |
| `--duration S`                  | Run time in seconds                                          |
| `--lag MS --jitter MS --loss P` | Simulated network conditions                                 |
