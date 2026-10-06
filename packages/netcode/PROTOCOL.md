# Tumble Royale wire protocol — v6

`PROTOCOL_VERSION = 6` (`src/protocol.ts`). Any incompatible change bumps it;
the server rejects a Hello with a different version (`Kick{VersionMismatch}`).

Transport: binary WebSocket frames (`/ws`; `/gs/ws` is also accepted for the
Vite proxy path). One message per frame. permessage-deflate is off and Nagle is
disabled. Bits are packed **LSB-first** (`BitWriter`/`BitReader`). Byte 0 of
every message is the type:

| id  | message    | dir  | reliability                | rate                             |
| --- | ---------- | ---- | -------------------------- | -------------------------------- |
| 1   | Hello      | C→S  | retried 1/s until Welcome  | connect / resume                 |
| 2   | Welcome    | S→C  | re-sent on duplicate Hello | once per connection              |
| 3   | InputBatch | C→S  | unreliable, 3× redundancy  | 60 Hz (10 Hz ack-only when idle) |
| 4   | Snapshot   | S→C  | unreliable, delta vs acked | 30 Hz (`SNAPSHOT_HZ`)            |
| 5   | Reliable   | both | sequenced + acked + resent | on demand, flushed each tick     |
| 6   | Ping       | C→S  | unreliable                 | every 2 s                        |
| 7   | Pong       | S→C  | unreliable                 | per Ping                         |
| 8   | Kick       | S→C  | followed by close          | —                                |

## Quantisation

| quantity           | encoding                                                                          | bits   | max error                                          |
| ------------------ | --------------------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| position           | per axis inside `RoundDefinition.bounds`                                          | 3 × 16 | extent / 131 070 (≈1.5 mm per 200 m)               |
| rotation, upright  | yaw about +Y (when \|x\|,\|z\| < 1e-4)                                            | 1 + 16 | 0.0028°                                            |
| rotation, tumbling | smallest-three: 2-bit index + 3 × 10-bit components in ±1/√2 (symmetric, 0 exact) | 1 + 32 | < 0.25° (fuzz-tested over 20 000 random rotations) |
| velocity           | per axis, symmetric in ±40 m/s, 0 exact                                           | 3 × 12 | 0.0098 m/s                                         |
| facing / input yaw | [0, 2π)                                                                           | 16     | 0.0028°                                            |
| move axes          | signed −127…127                                                                   | 2 × 8  | 0.0039                                             |
| state time         | sim ticks since the state began, `4095` = "≥ 68 s"                                | 12     | exact (1/60 s)                                     |

The spec's "30-bit quaternion" is the 3 × 10 component bits; with the 2-bit
index a full rotation is 32 bits. Upright Tumblers (the common case) use the
17-bit yaw form instead.

Clients quantise their own input **before** predicting with it
(`quantizeInputInPlace`), so prediction and the server consume identical inputs.

## Handshake

```
Hello    type:8 version:16 name:str(≤32B) resumeToken:str(≤64B) loadout:str(≤255B)
         ticket:str(≤2048B)
Welcome  type:8 version:16 playerId:8 resumeToken:str roomId:str serverTick:32
         tickEpochMs:f64 tickMs:f64 resumed:1
Kick     type:8 reason:8 detail:str
```

`str` = varint byte length + UTF-8. Player ids 0–127 are entities (players and
bots; a show uses 0–99, `MAX_PLAYERS`); 128–254 are spectators who joined
mid-show (127 seats; the next is refused with `ServerFull`). Server tick T happened at
server time `tickEpochMs + T × tickMs`.

**Resume:** a Hello carrying the token within 30 s of the drop reattaches the
player (the character idles server-side meanwhile; inputs are neutral). The new
connection gets a fresh reliable channel, `joinRound` and a **full** snapshot.
An expired token falls through to a normal join.

**Join tickets (v2):** `ticket` is the matchmaker's HS256 join ticket
(`GAME_TICKET_SECRET`, `iss` tumble-matchmaker, `aud` tumble-game-server, 90 s).
The server verifies it and places the player into the room for the ticket's
`mid` (created on the first ticket seen, sized `humans + bots`, started once
every ticketed human joined or after `TICKET_FILL_WAIT_MS`). A ticket whose
account already holds a slot in that match reattaches to it (page reload).
Invalid/expired tickets get `Kick{BadTicket=7}`. Hellos without a ticket are
accepted into public rooms only when `ALLOW_UNTICKETED` (default outside
production).

## InputBatch (C→S, 60 Hz)

```
type:8 newestSeq:32 clientTick:32 hasAck:1 [ackSnapshotId:16] count:2
input[0] (newest)                          39 bits: moveX:8s moveZ:8s yaw:16 buttons:4 emote:3
input[1..count-1]: same:1 [input 39]       redundant copies of seq-1, seq-2
```

Budget: 17 B typical (held input → two 1-bit repeats), 27 B worst case.
≈1.0–1.6 KB/s plus WebSocket framing. `count = 0` is an ack-only batch.

Server side: each input goes into the player's `InputJitterBuffer`, which
targets 2–6 buffered inputs (1–3 server ticks) adaptively from arrival jitter.
Lost input (later seq present) → repeat the last input; underrun (nothing newer
yet) → repeat without consuming a sequence; persistent excess → trim one input.
Sanity: a client's newest seq may not exceed `firstSeq + elapsed/16.7 ms × 1.1 + 180`.

## Snapshot (S→C, 30 Hz, per client)

```
header   type:8 snapshotId:16 serverTick:32 epoch:8 baselineAge:5
         hasAckedInput:1 [ackedInputSeq:32] matchTime:f32          102–134 bits
status   phase:4 finished:1 timeLeft:varint(0.1 s, 0 = untimed)
         qualified:8 target:8 eliminated:8 teamCount:3 score:varint×n  ≈ 40–48 bits
removed  count:8 id:7 × count
obstacle { more:1=1 index:varint count:varint value×count }* more:1=0
         value = isFloat:1 (varint-zigzag | f32)
entity   { more:1=1 id:7 full:1 [mask:7] fields… }* more:1=0
```

Field groups (mask bit → payload):

| bit | group  | bits                          |
| --- | ------ | ----------------------------- |
| 0   | Pos    | 48                            |
| 1   | Rot    | 1 + 16 (yaw) or 1 + 32 (quat) |
| 2   | Vel    | 36                            |
| 3   | State  | 5 state + 12 state age        |
| 4   | Facing | 16                            |
| 5   | Flags  | 8                             |
| 6   | Grab   | 1 [+ 16 (target + 1)]         |

Per-entity cost: 16 bits header; full record 152 bits (19 B, upright) / 168
bits (21 B, tumbling); typical running delta (pos + vel + facing ± rot) 116–133
bits ≈ 15–17 B. Unchanged entities cost **0 bits** (not written).

`ackedInputSeq` is the last input the server consumed for this client, which
always happens on the tick's last sim step, so `matchTime` is exactly the match
time at which that input ran — the client uses this to align its local sim
clock (see Prediction).

### Delta compression

Both sides keep a ring of 32 _views_ (the full quantised world after snapshot
N). A snapshot names its baseline as `baselineAge` = snapshots since the newest
snapshot the client acked (0 = full). Each written entity is either `full`
(baseline lacks it) or a changed-field mask vs the baseline record; entities
absent from the snapshot keep their baseline values, identically on both sides.
Obstacles use a per-obstacle version: only obstacles whose version differs from
the baseline view are sent. A new round bumps `epoch`; the decoder only accepts
a full snapshot to enter a new epoch.

### Interest management and byte budget

Per (client, entity) priority accumulates every snapshot:
own player 10⁶ (always sent), spectate target 10⁵, top-3 leaders 1, within
20 m of the viewer 1, otherwise `max(0.17, 20 m / distance)` (≈5 Hz floor), +1
on appearance or state change. Entities with accumulator ≥ 1 are written,
highest first, until the packet reaches **1200 B**; the rest roll over.
Obstacles are written before entities (up to half the budget) so tile
collapses are never starved.

The budget caps a client at 1200 B × 30 Hz = **36 KB/s** down, under the
40 KB/s target, whatever the field size. Worst case, all 100 Tumblers piled
within 10 m of the viewer and moving every tick (`test/snapshot.test.ts`):
every snapshot stays ≤ 1200 B and no moving Tumbler goes more than 3
snapshots (100 ms) without an update.

## Reliable channel (both directions)

```
type:8 hasAck:1 [ack:16] count:varint { seq:16 len:varint payload }*
```

Cumulative ack of the highest in-order sequence received; out-of-order messages
are buffered and delivered strictly in order; unacked messages are re-sent after
`clamp(1.5 × RTT + 30 ms, 100, 2000)`. Packets are capped at 1100 B (a single
larger message is sent alone). Payloads:

- `0x00 tick:varint SimEvent` — table-driven binary (`src/events.ts`), event
  type id 8 bits, positions as 3 × f32; unknown/new union members fall back to
  id 255 + msgpack.
- `0x01 msgpack(LowFreqMessage)` — `joinRound` (round id, seed, stage, players,
  obstacle id table, bounds, epoch; v2 adds `roundIndex`, `isFinal`,
  `qualifyTarget` and `variationId` so clients never estimate them),
  `showInfo` (match id, playlist, show name, queue, round estimate — once per
  connection), `showRewards` (the account API's `PlayerRewardSummary` for
  this player, forwarded after the server posted the results), `playerList`, `roundPhase`, `showPhase`,
  `roundResults`, `showSummary`, `lobby`, `chat`, `loadingStatus` (v4),
  `voteOptions`, `voteTally`, `voteResult` (v6);
  client→server: `chat`, `loaded`, `loadProgress` (v4), `castVote` (v6), `spectate` (sent
  whenever the spectated player changes; drives interest management). Clients
  may never send SimEvents.

  v3 additions: `playerList[].partyId` (duos/squads), `joinRound.lobby` (the
  live pre-show platform: a rule-less lobby sim players join and leave while
  snapshots stream; joiners appear as snapshot entities, leavers as removals),
  `joinRound.mutatorId` (show mutator every peer passes to its sim),
  `joinRound.roundTimeScale` (round timer multiplier, 0.5–2; peers pass it as
  `MatchSimOptions.roundTimeScale`, which is the only place a timer is scaled),
  `roundResults[].carried` (eliminated but carried by a qualifying teammate)
  and `showPhase.startsInMs` (pre-show countdown).

  v4 additions: `loadProgress` and `loadingStatus` (see Round loading). v4
  exists because a v3 server counts an unknown client message
  (`loadProgress`) as a protocol violation and eventually kicks for it.

  v5: 100-player shows. Snapshot entity ids grow from 6 to 7 bits
  (`ENTITY_ID_BITS = ceil(log2(MAX_PLAYERS))`, `MAX_ENTITIES = 128`) and the
  removal count from 7 to 8 bits so a whole lobby can leave in one snapshot;
  spectator ids move from 64–254 to 128–254. No message changed shape.

  v6: round voting. `voteOptions`, `castVote`, `voteTally` and `voteResult`
  (see Round voting). v6 exists for the same reason as v4: a v5 server counts
  the unknown `castVote` as a protocol violation.

### Round loading (v4)

A round stays in LOADING until every connected human entrant has sent
`loaded{roundId}`, which clients send only once the round's scene is built and
its shaders are compiled. While building, a client sends
`loadProgress{roundId, pct 0..1}` about every 500 ms, from the moment
`joinRound` arrives; each one keeps the server waiting on that player for
another `loadingStall` (15 s). A player who goes quiet that long, or anyone
still loading at `loadingHardCap` (60 s), is forfeited. Disconnected players
never hold the round, and bots never load. Meanwhile the server broadcasts
`loadingStatus{roundId, loaded, total, waitingOn ≤ 8 ids}` at most 2 Hz (when
it changed, plus a 1 Hz keepalive). IntroFlyover then starts on the same
server tick for everyone, so clients that finished early wait on their loading
screen instead of seeing the round begin.

### Round voting (v6)

Between rounds the director may put the next round to a vote (SHOWS.md §2.1).
The server is authoritative; clients only ever send `castVote`.

| message       | dir | when                                                    | payload                                                                                                                       |
| ------------- | --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `voteOptions` | S→C | ballot opens (RESULTS starts); re-sent on (re)attach    | `roundIndex`, `options` (≤ 4 round ids), `counts`, `voted`, `eligible`, `closesInMs`, `canVote`, `yourVote`, `botsDiscounted` |
| `castVote`    | C→S | the player picks or changes an option                   | `roundIndex`, `option`                                                                                                        |
| `voteTally`   | S→C | ballots changed; at most 4 Hz                           | `roundIndex`, `counts`, `voted`                                                                                               |
| `voteResult`  | S→C | ballot closed (or called off: `winner -1`, `cancelled`) | `roundIndex`, `winner`, `roundId`, `counts`, `reason`                                                                         |

`voteOptions` is per connection: `canVote` is false for spectators and
players already knocked out, and `yourVote` echoes the player's own ballot so
a reconnect restores the selection. Validation, all silent (never a protocol
violation): a `castVote` for another round, after the close, with an option
out of range or a non-integer, from a spectator or eliminated player, or
repeating the current ballot is ignored. Ballots may change until the close.
Each connection may send 2 `castVote`/s (burst 4); extras are dropped and
counted in `rateLimited`. A dropped connection keeps its ballot (a resume
gets `voteOptions` again); a player who leaves for good loses it. The next
round is then announced with the usual `joinRound`, and the round still
waits in LOADING for every connected human (the all-loaded gate is
unchanged).

Measured msgpack payloads with three options: `voteOptions` 150 B,
`voteTally` 45 B (at most 4/s while the ballot is open), `voteResult` 79 B,
`castVote` 34 B.

## Clock sync (Ping/Pong)

`Ping{t0:f64}` → `Pong{t0, t1:f64, t2:f64}`; RTT = (t3−t0)−(t2−t1), offset =
((t1−t0)+(t2−t3))/2. `ClockSync` keeps 10 samples, follows the lowest-RTT one,
rejects RTT outliers (> 2 × median + 25 ms; 4 in a row = path changed, restart),
and slews offset changes (25% per sample, snaps above 120 ms).

## Prediction & interpolation (client)

- **Prediction** (`apps/client/src/net/PredictionController.ts`): one fixed 60
  Hz step per input; on each snapshot compare the predicted state after
  `ackedInputSeq` with the server state; if > 5 cm or a different state, rewind
  (`setPlayerState`) and replay unacked inputs; the visual jump is hidden by an
  offset decaying over 100 ms (snap above 2 m). Two clocks: input production is
  paced to `matchTime + RTT/2 + 50 ms`; the sim's _time label_ is trimmed by
  the measured (local − server) application time so moving obstacles agree at
  contact.
- **Remotes** (`RemoteEntities`): rendered ≥100 ms behind the newest snapshot
  (`max(100, 2 × interval + 3 × jitter)`, ≤ 250 ms), cubic Hermite with
  replicated velocity (linear when velocity disagrees with displacement, i.e. a
  bounce), extrapolate ≤ 250 ms then hold, no blending across teleports.

## Measured at 100 players (v5)

In process, real `createMatchSim` + show director + snapshot encoders, Tilt
Town, 60 s of PLAYING, fixed seed (`apps/game-server/test/tickBudget.test.ts`
with `TUMBLE_PERF=1`):

| scenario               | tick p50 / p95 / p99 / max | mean split (sim + snapshot + send) | per client     |
| ---------------------- | -------------------------- | ---------------------------------- | -------------- |
| 100 protocol clients   | 6.4 / 9.0 / 11.5 / 26.8 ms | 4.1 + 2.4 + 0.1 ms                 | 33.9 KB/s down |
| 1 client + 99 sim bots | 5.2 / 8.1 / 9.4 / 11.2 ms  | 5.3 + 0.2 + 0.0 ms                 | 24.1 KB/s down |

No PLAYING tick exceeded two tick periods (67 ms) in either run.

Over loopback WebSockets: the built game server and `tools/bot-swarm`
(`--clients 100 --duration 180`) on the same 16-thread desktop, PLAYING
window read from `/metrics`. The machine was shared with other work; the
in-process scenario above measured 12.2 / 16.1 / 22.9 / 99.8 ms right after,
so compare rows from the same session only.

| scenario                               | tick p50 / p95 / max  | mean split (sim + snapshot + send) | per client                             |
| -------------------------------------- | --------------------- | ---------------------------------- | -------------------------------------- |
| 100 swarm clients, Slip 'n' Spiral     | 12.2 / 22.4 / 70.3 ms | 6.6 + 4.9 + 2.3 ms                 | 26.4 KB/s down, 1.3 KB/s up, RTT 12 ms |
| same, `tsx` dev server, Conveyor Chaos | 14.5 / 18.3 / 24.7 ms | 6.3 + 5.7 + 2.6 ms                 | 31.9 KB/s down, 1.3 KB/s up, RTT 10 ms |

## Measured at 40 players (v4, dev capsule sim, 40 dynamic capsules + kinematic sweepers)

| scenario                                                            | tick avg / p95 / max       | snapshot avg / p95    | per client                                               |
| ------------------------------------------------------------------- | -------------------------- | --------------------- | -------------------------------------------------------- |
| 40 swarm clients, LAN                                               | 2.3–3.3 / 3.4–5.3 / ≤10 ms | 323–347 B / 415–457 B | 30.0 snap/s, 12 KB/s down, 1.2 KB/s up                   |
| 40 clients, 150 ms RTT ±20 ms, 2% loss/dir                          | 2.3 / 6.4 / 25 ms          | 433 B                 | 29.4 snap/s, 14.8 KB/s down, 1 input missed in 40 × 40 s |
| real `createMatchSim` (test-kit controller) + 39 sim bots + 1 human | 2.0–4.1 ms avg             | 214–459 B             | —                                                        |

Prediction end to end (150 ms RTT, 2% loss, 30 s, virtual clock): 2
corrections, both during the first 350 ms; 0 in steady state; max correction
0.15 m; local/server application-time error −0.4 ms.
