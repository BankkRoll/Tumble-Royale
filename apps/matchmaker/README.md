# @tumble/matchmaker

Queue service for Tumble Royale: parties and solos queue per playlist and
region, lobbies fill to the playlist size (default 40) or are released with
bots after the max wait, and each player receives a signed join ticket for a
game server. Also hosts custom/private lobbies.

```sh
pnpm --filter @tumble/matchmaker dev    # http://localhost:7370
pnpm --filter @tumble/matchmaker test
```

Redis is optional in development (`REDIS_URL`); without it state is in-process.

> **Production needs Redis.** The in-process store holds every queue entry,
> custom lobby, placed match and the game-server registry: all of it is lost
> on restart and none of it is shared between instances. With
> `NODE_ENV=production` the matchmaker refuses to boot without `REDIS_URL`
> unless `ALLOW_MEMORY_STORE=1` is set, and then logs a loud warning at boot.

## Environment

Every variable and its default is listed once in [`.env.example`](.env.example).
The shared secrets (`JWT_SECRET` with the API, `GAME_TICKET_SECRET` and
`GAME_SERVER_SECRET` with game servers, `INTERNAL_HMAC_SECRET` for ban lookups)
and `API_URL` / `PUBLIC_WEB_URL` come from the root [`.env`](../../.env.example);
run `pnpm setup:env` once to create both files. `INTERNAL_HMAC_SECRET` is only
required while `API_URL` is set (it defaults to the local API in development).

## Bans

Access tokens are verified without calling the API, so the matchmaker asks
the API which players are suspended (cached 15 s per player). Players with an
`all` ban cannot queue (the whole party is refused), create or join custom
lobbies, or open `/ws`; they are dropped from a lobby's roster when it starts.
`ranked` bans block the ranked queue. `chat` bans set `mute: true` in the
player's join ticket so the game server drops their chat. If the API is
unreachable the check fails open (the API already refuses suspended accounts
when it mints tokens and queue tickets) and the outage is logged.

## Client flow

1. Party leader: `POST {api}/party/queue-ticket { playlistId }` → `ticket`.
2. Leader: `POST /queue { ticket }` with `Authorization: Bearer <accessToken>`.
3. Every member: open `GET /ws?token=<accessToken>` and receive `queued`,
   `status { searching, waitedSec, etaSec, band }` (1 Hz),
   `waiting_for_server { region, otherRegions }` (sent once when the lobby is
   ready but no server has room, and once more with `otherRegions: true` when
   other regions are being tried: "Finding a server in another region"),
   `queue_cancelled`, and finally
   `match_found { matchId, server: { url }, ticket, team, role }`.
4. Connect to `server.url` and present `ticket`. `DELETE /queue` cancels for
   the whole party.

`match_found` is also kept per player (`user-match:<userId>`) for the
ticket's 90 s: `GET /queue/status` returns it as `match` and the stream
replays it on connect, so a player whose socket was reconnecting when the
match was placed still gets it (clients dedupe by `matchId`). It is cleared
when the game server reports the player joined (heartbeat `joined`), when
they queue again, on `DELETE /queue/match` (declined or left), on a host
kick, or when the ticket expires.

`POST /queue/rejoin { matchId }` re-issues a ticket for a running match after
a reload outlived both the ticket and the game server's 30 s resume window.
Only roster members get one, only while the hosting server is alive and
still reports the match (or still holds its reservation), never for players
the host removed or who are suspended (`404 match_not_found`,
`403 not_in_match` / `removed_by_host` / `banned`, `410 match_over`). The
ticket carries `rejoin: true`: the game server attaches it to the existing
room and never opens a new one for it.

Ticks are serialised across instances by `tick-lock`, which carries a random
token per tick, is renewed while the tick runs and is released by
compare-and-delete; entries are claimed with an atomic `HDEL` before a lobby
is placed, so a cancel racing the tick either wins (no `match_found`) or loses
(the match stands), never both. A re-queue while a claim is in flight gets
`409 match_forming`.

Custom lobbies: `POST /lobbies { settings? }` → `{ lobby.code }`;
`POST /lobbies/:code/join { spectator? }`, `PATCH /lobbies/:code` (host
settings: `playlistId`, `rounds[]`, `maxPlayers`, `bots`, `roundTimeScale`,
`lobbyCountdownSec`, `spectatorSlots`, `minPlayers`), `POST /lobbies/:code/leave`,
`POST /lobbies/:code/start { force? }` (host; refuses with `not_enough_players`
or `not_ready` unless forced). Lobby changes arrive on the same WebSocket as
`lobby_update`; a reconnecting member gets their lobby pushed right away
(`GET /lobbies/mine` returns it too).

Host tools (all host-only, all broadcast): `POST /lobbies/:code/kick { userId }`
removes and bans a member (they get `lobby_kicked { reason: 'kicked' }`; after
the start the kick is forwarded to the game server, see below),
`/unban { userId }`, `/host { userId }` transfers the crown, `/lock { locked }`
refuses code joins, `/code` issues a new invite code. Members:
`/ready { ready }` and `/role { spectator }`. When the host leaves, the
longest-present connected player inherits the crown. Members whose last socket
closed are marked away and dropped after 90 s (`lobby_kicked { reason: 'away' }`).

Kicks after a start reach the game server as `POST {controlUrl}/internal/kick
{ matchId, userId }`, HMAC-SHA256 signed with `GAME_SERVER_SECRET` over
`<ts>.<nonce>.<body>` (`x-tumble-ts`, `x-tumble-nonce`, `x-tumble-sig`); the
game server refuses timestamps older than 30 s and any nonce it already saw.
`controlUrl` is the game server's `CONTROL_URL` from its registration (set it
whenever the public URL does not route plain HTTP to the server); without it
the base is derived from the public WebSocket URL by dropping only the
trailing `/ws`, so a proxy prefix survives: `wss://play.example/gs/ws` →
`https://play.example/gs` (the game server serves the kick at both
`/internal/kick` and `/gs/internal/kick`).

## Game servers

- `POST /servers/register { serverId, url, region, capacity, load?, maxRooms?, rooms? }`
  and `POST /servers/heartbeat { serverId, load, rooms?, matches?, joined? }` every ≤ 5 s
  (dead after 15 s), `DELETE /servers/:id` on shutdown. Bearer
  `GAME_SERVER_SECRET`. `capacity` and `load` count **seats, humans and bots**
  (bots cost the server as much simulation as players); `maxRooms`/`rooms`
  cap concurrent rooms; `matches` lists the match ids the server hosts;
  `joined` lists `{ matchId, userId }` ticketed arrivals since the last beat.
- Placing a match reserves its seats (and one room) on the server until a
  heartbeat lists the match id, or for 120 s (join tickets last 90 s), so a
  heartbeat sent before the players arrive cannot hand the same seats out
  twice.
- A lobby goes to the least-loaded server in its region. If none has room
  for `REGION_FALLBACK_MS` (default 10 s), the nearest regions with room are
  tried (`na → sa, eu, oce, asia`; `eu → na, asia, sa, oce`;
  `asia → oce, eu, na, sa`; `oce → asia, na, eu, sa`; `sa → na, eu, oce, asia`),
  then any region. Custom lobbies try other regions immediately on start.
- Join ticket: HS256 JWT signed with `GAME_TICKET_SECRET`, `iss`
  `tumble-matchmaker`, `aud` `tumble-game-server`, 90 s expiry. Claims
  (`JoinTicketClaims` in `src/tickets.ts`): `sub` (user id), `name`, `mid`
  (match id — use it as `matchId` when posting results to the API), `sid`,
  `pid` (party), `team`, `role` (`player`/`spectator`), `playlistId`, `queue`
  (`casual`/`ranked`/`custom`), `region`, `size`, `humans`, `bots`, `teamSize`,
  `custom` (lobby settings), `mute` (chat-suspended; present only when true).
  `verifyJoinTicket()` is the reference verifier.
- `GET /matches/:id` (Bearer) returns the full roster, bot fill and settings,
  so a server can create the room on the first ticket it sees.

## Matching rules

See `src/engine.ts`. Parties are never split; duos/squads are assembled with
best-fit team packing; ranked queues only group entries whose mean rating
ordinal lies within the anchor's band, which widens from ±3 by 0.6/s to ±30.
Playlists with `botsAllowed: false` (Ranked) release on timeout only once
`minPlayers` humans are present.
