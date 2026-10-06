# Self-hosting Tumble Royale

One server runs the whole game with Docker Compose: Postgres, Redis, the
account API, the matchmaker, a game server, the web client and a Caddy edge
proxy that gets HTTPS certificates automatically. Everything is served from
one domain:

| Path                         | Goes to                                                |
| ---------------------------- | ------------------------------------------------------ |
| `https://DOMAIN/`            | the web client (static files)                          |
| `https://DOMAIN/admin`       | the admin console ([below](#the-admin-console))        |
| `https://DOMAIN/editor`      | the round editor (needs no configuration)              |
| `https://DOMAIN/api/*`       | account API, including its WebSocket `/api/ws`         |
| `https://DOMAIN/mm/*`        | matchmaker, including its WebSocket `/mm/ws`           |
| `https://DOMAIN/gs/ws`       | game server WebSocket                                  |
| `https://DOMAIN/config.json` | optional client overrides ([below](#client-overrides)) |

Only Caddy publishes ports (80 and 443). The services' own ports stay on the
Compose network, and `/api/metrics` and `/mm/metrics` answer only with
`METRICS_TOKEN`.

The files live in [`deploy/`](../deploy): `docker-compose.yml`, the edge
`Caddyfile`, the image `Dockerfile`s in `deploy/docker/` and the backup script.

## Requirements

- A Linux server with Docker Engine 24+ and the Compose plugin 2.24+.
  2 CPU cores and 4 GB of RAM are a reasonable start for one game server
  (three shows at once); each extra game server process wants another core.
- A domain name whose DNS you control.
- Ports 80 and 443 (TCP, plus 443/UDP for HTTP/3) open to the internet.
- Node.js 22 to run the setup and admin scripts (no `pnpm install` needed),
  or Docker for both ([below](#without-nodejs-on-the-server)).

## 1. Point DNS at the server

Create an `A` record (and `AAAA` for IPv6) for your domain, for example
`play.example.com`, pointing at the server. Caddy requests the certificate on
first start, so the record must resolve before step 3.

## 2. Generate the configuration

```sh
git clone https://github.com/BankkRoll/Tumble-Royale.git
cd Tumble-Royale
node scripts/setup-env.mjs --production --domain play.example.com --email you@example.com
```

(`pnpm setup:env --production …` is the same command.) It writes
`deploy/.env` with:

- the public URLs for the domain (`PUBLIC_WEB_URL`, `PUBLIC_API_URL` used for
  OAuth redirects, `PUBLIC_WS_URL`) and the CORS allow-lists;
- a fresh random value for every secret (`JWT_SECRET`,
  `INTERNAL_HMAC_SECRET`, `GAME_TICKET_SECRET`, `GAME_SERVER_SECRET`,
  `ADMIN_TOKEN`, `METRICS_TOKEN`, `POSTGRES_PASSWORD`);
- `DATABASE_URL` and `REDIS_URL` for the Compose services, and
  `TRUST_PROXY=1` because Caddy is the one proxy in front of them.

`--email` is optional; Let's Encrypt uses it for expiry warnings. The script
never replaces an existing `deploy/.env` unless you pass `--force`, which
generates new secrets (every player has to sign in again) but keeps
`POSTGRES_PASSWORD`, because Postgres only reads it when its volume is first
created.

**Keep `deploy/.env` private and back it up.** It holds every secret of the
deployment. [`deploy/.env.example`](../deploy/.env.example) shows the layout.

## 3. Start it

```sh
docker compose -f deploy/docker-compose.yml up -d --build
```

The first build takes a few minutes. Compose starts Postgres and Redis, runs
the `migrate` service once (it applies the database migrations and exits),
then the API, matchmaker, game server and client, and finally Caddy.

Check it:

```sh
docker compose -f deploy/docker-compose.yml ps        # all running/healthy, migrate exited (0)
curl https://play.example.com/api/ready               # {"ok":true,…,"checks":{"db":"ok","kv":"ok"}}
curl https://play.example.com/mm/ping                 # {"ok":true,"regions":["na"]}: the game server registered
```

Then open `https://play.example.com` and press Play.

> Typing `-f deploy/docker-compose.yml` gets old: `cd deploy` and run
> `docker compose …` there, or `export COMPOSE_FILE=deploy/docker-compose.yml`.
> The rest of this guide writes plain `docker compose`.

## 4. First admin steps

Admin actions use `ADMIN_TOKEN` from `deploy/.env`. On the server,
`pnpm admin` (or `node scripts/admin.mjs`) reads that file and talks to
`https://DOMAIN/api`:

```sh
pnpm admin --help
pnpm admin user lookup "Name#1234"          # find a player (id, name, email)
pnpm admin bans add <userId> --reason "cheating" --hours 72
pnpm admin reports list                     # player reports, oldest first
pnpm admin news publish post.json           # a news post in the main menu
pnpm admin flags set some-flag on --rollout 50
```

Without Node.js on the host, run it inside the API container, where it talks
to that instance directly:

```sh
docker compose exec api node scripts/admin.mjs reports list
```

### The admin console

`https://DOMAIN/admin` is a web console for the same work: the report queue
(with chat evidence and bulk decisions), player lookup and the player page,
bans and mutes, shared custom rounds (inspect, take down, restore), live ops
and the audit log. It is part of the client image,
so there is nothing to enable; nobody can use it until you grant a role.

1. Have the person sign in to the game with a full account (email, Discord
   or Google; guests cannot be staff) and send you their `Name#1234`.
2. Find their account id and grant a role:

   ```sh
   pnpm admin user lookup "Name#1234"
   pnpm admin staff grant <userId> --role moderator   # or --role admin
   pnpm admin staff list
   pnpm admin staff revoke <userId>                    # takes effect at once
   ```

3. They open `https://DOMAIN/admin` in the browser where they play and press
   **Open the console**.

A **moderator** handles reports, warnings, mutes, suspensions and lifting
them, renames and the audit log. An **admin** can also adjust currencies,
revoke cosmetics, run live ops and manage staff. Console sessions last 30
minutes, live only in that browser tab and end at once if the role is revoked
or the account is suspended. Every action from the console or the CLI lands
in the audit log, with who did it and the reason:

```sh
pnpm admin audit --limit 20
pnpm admin audit --action player. --target <userId>
```

`ADMIN_TOKEN` still works for the CLI and acts as an admin; keep it on the
server.

## 5. Optional features

Each one is off until configured. Uncomment its lines in `deploy/.env`, fill
them in, then run `docker compose up -d` (Compose recreates the services whose
settings changed).

- **Discord / Google sign-in:** create an OAuth app and register the redirect
  URI `https://DOMAIN/api/auth/discord/callback` (or `/google/callback`), then
  set `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` or `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`.
- **Email sign-in (magic links):** set `SMTP_URL`
  (`smtp://user:pass@host:587` for STARTTLS, `smtps://user:pass@host:465`) and
  optionally `SMTP_FROM`. Without SMTP, production disables email sign-in.
- **Gem purchases (Stripe Checkout):** set `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET`. Add a webhook endpoint
  `https://DOMAIN/api/webhooks/stripe` in the Stripe dashboard for
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`,
  `charge.dispute.funds_reinstated` and `refund.failed` (or
  `refund.updated`). The API refuses to start with a key but no webhook
  secret, and without Stripe Gem checkout is simply off. See
  [Refunds](#refunds) for how Gem pack refund requests reach Stripe.
- **Crash reports:** `SENTRY_DSN` (any Sentry-compatible service) for the
  servers; `sentryDsn` in the client overrides below for browsers.
- **Voice chat:** needs a TURN relay; see [Voice chat](#voice-chat).

### Voice chat

Voice chat is opt-in for every player and off on the server until you set it
up: players talk peer to peer (WebRTC, Opus audio only) inside their party,
and in team rounds with up to eight teammates who also opted in. The API only
relays signalling between players it has put in the same room. Many home and
mobile networks cannot connect peer to peer, so voice needs a TURN relay, and
the client hides voice entirely until one is configured and the
`voice.enabled` flag is on.

1. **Secret.** `pnpm setup:env --production` writes `VOICE_TURN_SECRET` to
   `deploy/.env`. Older files: add `VOICE_TURN_SECRET=` with 32+ random
   characters (`openssl rand -base64 32`). It is shared only by the API and
   coturn; players get short-lived credentials derived from it (valid four
   hours, for one player and one room), never the secret.
2. **ICE servers.** Uncomment `VOICE_ICE_SERVERS` in `deploy/.env`:

   ```sh
   VOICE_ICE_SERVERS=stun:DOMAIN:3478,turn:DOMAIN:3478?transport=udp,turn:DOMAIN:3478?transport=tcp
   ```

   Any `turn:`/`turns:` URL requires `VOICE_TURN_SECRET` (the API refuses to
   start otherwise). An external TURN service that supports the "TURN REST
   API" shared-secret scheme (coturn's `use-auth-secret`) works the same way.

3. **Start the relay** with the `voice` profile:

   ```sh
   docker compose -f deploy/docker-compose.yml --profile voice up -d
   ```

   coturn runs on the host network (Docker's port publishing is slow for a UDP
   range). It refuses to relay to loopback, private, link-local and
   carrier-grade NAT ranges, so it cannot be used to reach Postgres, Redis or a
   cloud metadata service, and it caps each account's allocations and
   bandwidth. On a cloud VM behind 1:1 NAT (AWS, GCP) add
   `--external-ip=PUBLIC_IP/PRIVATE_IP` to the `turnserver` line in the
   compose file.

4. **Firewall.** Open `3478/udp`, `3478/tcp` and `49160-49200/udp` (the relay
   range; widen `--min-port`/`--max-port` for more than ~40 relayed calls).
5. **Switch it on:** `pnpm admin flags set voice.enabled on`. Players then see
   Settings → Voice; they still have to switch it on themselves.

`VOICE_REQUIRE_TURN` defaults to `1` in production. Setting it to `0` lets
voice run without TURN (direct connections only: fine on a LAN, unreliable on
the internet); it is `0` by default in development so voice can be tried on
`localhost` with two browser windows.

Rules worth knowing before you enable it:

- **Rooms:** a party (up to 4) is one room. In team rounds, players who
  turned on "Team voice" are grouped into squads of up to 8 teammates, with
  queue parties kept together; the game server reports teams to the API over
  the signed internal channel. Everyone else stays in their party room.
- **Guests and new accounts** can use party voice (a party is joined by a
  friend's invite or a code someone shared), but never team voice with
  strangers: that needs a linked account at least three days old. The game
  collects no ages, so there is no age gate; voice is off by default and
  push-to-talk is the default mode.
- **Moderation:** blocks are mutual (two players who blocked each other are
  never connected, even in a shared room). A moderator's voice mute
  (`pnpm admin` / the console's "Mute voice…", ban scope `voice`) or a
  suspension ends the player's voice on every instance at once. Nothing is
  recorded; a voice report carries which room the two shared and when.
- **Privacy:** peers connected directly see each other's IP address, as with
  any WebRTC call. Players can turn on "Relay only (hide my IP)" to send
  everything through your TURN relay instead.

### Refunds

Players refund store items bought with Gumballs or Gems themselves (Store →
Purchases, within 7 days, 3 per year). Gem packs bought with real money are
**requests** that land in the console's **Refunds** queue
(`https://DOMAIN/admin#/refunds`) and in the CLI:

```sh
pnpm admin refunds list                          # awaiting a decision, oldest first
pnpm admin refunds list --status all --user <userId>
pnpm admin refunds approve <refundId> --note "bought the wrong pack"
pnpm admin refunds deny <refundId> --reason "the Gems were already spent"
```

Approving needs the **admin** role. With `STRIPE_SECRET_KEY` set, approval
asks Stripe to refund the whole payment (the restricted key needs write
access to **Refunds**) and the request shows `processing`; the Gems are taken
back when Stripe's `charge.refunded` webhook arrives, and the request becomes
`refunded`. Without a key the request becomes `manual`: refund the payment
yourself in your payment dashboard. A refund issued straight from the Stripe
dashboard also closes a matching request. If Stripe refuses or later fails
the refund, the request shows `failed` with the reason and can be approved
again; Gems already taken back are not re-credited automatically (adjust
them with the player tools if needed). Denials need a reason, which the
player sees.

### Client overrides

The client talks to `/api`, `/mm` and `/gs/ws` on its own origin, so it needs
no configuration. To change that, or to turn on browser crash reports, copy
`deploy/client-config/config.json.example` to `deploy/client-config/config.json`
and edit it; the client reads it at every page load, no rebuild needed.

## 6. Live ops

Everything here takes effect without a restart or a client release, and
everything here can also be done from the admin console's **Live ops** page. The API
is the source of truth: the matchmaker and game servers read its live-ops
snapshot over the internal HMAC channel (cached 30 s, so allow up to half a
minute), browsers poll `GET /status` every minute and flags and playlists
every five. If the API is unreachable, services keep the last state they saw
and browsers keep their cached copy; nothing is ever switched off by an outage.

### Maintenance

```sh
pnpm admin maintenance on --in 10 --for 30 --message "New rounds incoming!"
pnpm admin maintenance status
pnpm admin maintenance off
```

`--in` (minutes) or `--starts <ISO time>` schedules it: the menu shows
"Maintenance in 10 min" until then. `--for` (minutes) or `--ends <ISO time>`
ends it automatically; without one it stays on until `maintenance off`. While
it is active:

- the menu shows the message, the Play Online tile is closed and Vs Bots keeps
  working offline;
- the API refuses queue tickets and the matchmaker refuses new queues and
  private lobbies with `503 maintenance`; players already queued are sent back
  to the menu;
- game servers stop opening new matches but let running shows finish, so
  scheduling maintenance a few minutes before an upgrade empties the servers
  without cutting anyone off.

### Feature flags (kill switches)

```sh
pnpm admin flags get
pnpm admin flags set store.enabled off
pnpm admin flags set analytics.sample on --payload 0.25
```

| Flag               | Off means                                                           |
| ------------------ | ------------------------------------------------------------------- |
| `store.enabled`    | every purchase and refund route answers 503; the Store tab closes   |
| `chat.global`      | global chat closes (party, lobby and show chat are unaffected)      |
| `party.lobbyGames` | party lobby mini-games stop and their button disappears             |
| `replays.enabled`  | replays are not recorded, starting with the next show               |
| `mutators.chaos`   | Chaos Mode plays without its per-show mutator                       |
| `analytics.sample` | no analytics are stored; with `on` the payload is the sampled share |
| `events.enabled`   | events count nothing and pay nothing; the menu says they are paused |
| `shows.mapVoting`  | no round votes; shows pick every round from the seed (next show)    |
| `voice.enabled`    | voice chat is hidden and every session ends (**off unless set**)    |

A flag that was never set is on, except `voice.enabled`, which needs a TURN
relay first ([Voice chat](#voice-chat)). `--rollout N` turns a flag on for a sticky N%
of players (client-side features only; servers read the master switch).
`maintenance` is reserved for the maintenance window above.

### Limited-time playlists

```sh
pnpm admin playlists list
pnpm admin playlists set chaos-mode --starts 2026-12-01T18:00:00Z --ends 2026-12-08T18:00:00Z --featured on
pnpm admin playlists hide duos      # withdraw now; `show` restores it
pnpm admin playlists reset duos     # back to the schedule shipped with the game
```

A playlist is queueable from `--starts` (inclusive) until `--ends`
(exclusive); `none` clears either. The menu shows "Ends in …" on a live one
and "Coming soon" with a countdown for a `--featured` one that has not
started. The matchmaker checks the window again when a party queues, on the
API's clock, so a show closes on time even if a server's or a player's clock
is off.

### Limited-time events

Events (`packages/content/src/progression/events.ts`) ship with a window, the
playlists they spotlight, challenges and a points track. To move or withdraw
one:

```sh
pnpm admin events list
pnpm admin events set frostbite-frolic --starts 2026-12-11T18:00:00Z --ends 2027-01-08T18:00:00Z
pnpm admin events disable moonlit-mischief   # withdraw it; `enable` restores it
pnpm admin events reset moonlit-mischief     # back to the window shipped with the game
```

A show counts toward every event live at the moment it **started** (as the
game server reported it, capped at the API's clock), so a show that straddles
the end still counts and its points arrive with its result. Custom lobbies
never count. Once an event has ended, each player's next visit pays out
everything they earned but did not claim. A disabled event, or any event
while the `events.enabled` flag is off, counts nothing, pays nothing and
settles nothing until it is switched back on. Event times always need an end
(no `none`), at most 90 days after the start. Changes reach every API
instance at once and are written to the admin audit log.

To add an event, append it to `LIVE_EVENTS` with its cosmetics (source
`event`) in `packages/content/src/cosmetics/catalog-events.ts`; the content
tests check the window, the tiers, the reward references and the currency
budget in [ECONOMY.md §5](design/ECONOMY.md#5-limited-time-events).

### Analytics and errors

Browsers send a fixed list of gameplay events (show and round results, quit
points, tutorial steps, store views, matchmaking wait, load times, an FPS
bucket per round) to `POST /api/events`, batched and sampled. Nothing is sent
while a player turns off Settings → Gameplay → Share gameplay stats, which is
the default when the browser sends Do Not Track or Global Privacy Control.
The only identity stored is the account id. Events are deleted after
`RETENTION_EVENTS_DAYS`.

Uncaught browser errors and server crashes land in the same table:

```sh
pnpm admin errors top                 # client errors, last 24 h
pnpm admin errors top --server --hours 168
```

## 7. Status page and incidents

`https://DOMAIN/status` is a public status page: the overall state, each
component (Website, Accounts & API, Matchmaking, Game servers and one row
per region once there are two or more, Store & payments, Chat), the current
and next maintenance window, open incidents with their updates, 90 days of
daily uptime bars and the past 90 days of incidents. It is a separate,
framework-free page (a few kilobytes), so it loads when the game does not;
the installed app never caches it. The in-game maintenance banner and the
"Servers offline" Play tile link to it.

### What it checks

The API computes the states itself (cached 5 s per instance):

| Component        | Major outage                                 | Degraded / other                        |
| ---------------- | -------------------------------------------- | --------------------------------------- |
| Accounts & API   | database unreachable (KV down: partial)      | database or KV slower than 1 s          |
| Matchmaking      | `MATCHMAKER_URL/health` fails or takes > 2 s | answers slower than 1 s                 |
| Game servers     | no live server, or every region down         | a region at 90 % of its seats           |
| Game servers · X | a region seen in the last 7 days has none    | that region at 90 % of its seats        |
| Store & payments | database unreachable                         | `store.enabled` off → under maintenance |
| Chat             | KV unreachable                               | `chat.global` off → under maintenance   |
| Website          | only through an incident                     |                                         |

Matchmaking and Game servers need `MATCHMAKER_URL` on the API (the compose
`.env` already has it) and `API_URL` plus `INTERNAL_HMAC_SECRET` on the
matchmaker, which answers per-region capacity on a signed
`/internal/capacity`. Without them those rows are left out (or show
Unknown). A major outage of the API, matchmaking or every game server is a
major outage overall; a major outage of anything else (one region, the
store, chat) reads as a partial outage. During an active maintenance window
everything but the website shows "Under maintenance".

### Uptime history

Each API instance runs a sampler every `STATUS_SAMPLE_SECONDS` (60; `0`
turns history off). A KV lock per interval makes exactly one instance write,
however many run. Samples land in `status_uptime`, one row per component and
UTC day; rows older than 90 days are deleted as it goes. A day's uptime
counts a major outage as down, a partial outage as half down, degraded as up,
and leaves maintenance and unknown samples out.

### Incidents runbook

Admins publish incidents from the console (**Status**) or the CLI;
moderators can read them. Titles and updates are public plain text (markup
shows literally); every write is in the audit log.

```sh
pnpm admin status summary                       # what the page shows now
pnpm admin status incident open --title "Queues are slow" --impact major \
  --components matchmaking,gameservers:eu --message "We are looking into slow queues."
pnpm admin status incident list                 # open incidents and their ids
pnpm admin status incident update <id> --status identified --message "A queue worker is stuck."
pnpm admin status incident update <id> --status monitoring --message "Fix deployed; watching."
pnpm admin status incident resolve <id> --message "Queues are back to normal."
```

- Impact: `minor` (shows the components as degraded), `major` (partial
  outage) or `critical` (major outage). No `--components` means the whole
  service. Probes can make a component look worse than the incident, never
  better.
- Post an update whenever something changes and at least every 30 minutes
  while it is open; players watch the page instead of guessing.
- For planned work use maintenance (`pnpm admin maintenance on --in 30
--for 60 --message "…"`): the page shows it as scheduled, then in
  progress, without an incident.
- A non-resolved update on a resolved incident reopens it.

Subscribers can follow `https://DOMAIN/api/status/feed.atom` or
`/api/status/feed.json` (incidents of the last 90 days). The summary is
`GET /api/status/summary`, the history `GET /api/status/history`; both are
public, rate limited per client and cacheable for 15 s and 5 min.

## Scaling

One game server process runs up to three 100-player shows at once (one event
loop, so one CPU core: `MAX_ROOMS=3`). Add game servers for more players or to
serve another region. The API and matchmaker keep their state in Postgres and
Redis, so a single instance of each serves several game servers.

Every game server needs:

| Variable        | Example                      | Notes                                                                         |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `PUBLIC_WS_URL` | `wss://gs-eu.example.com/ws` | its own public hostname: players connect to it directly                       |
| `SERVER_ID`     | `gs-eu-1`                    | unique among all game servers                                                 |
| `REGION`        | `eu`                         | `na`, `eu`, `asia`, `sa` or `oce`                                             |
| `CONTROL_URL`   | (derived)                    | where the matchmaker sends host kicks; defaults to the `PUBLIC_WS_URL` origin |

and the same `GAME_TICKET_SECRET`, `GAME_SERVER_SECRET` and
`INTERNAL_HMAC_SECRET` as the main server.

**On another host** (more capacity, or closer to players in another region):

1. Point a DNS record such as `gs-eu.example.com` at the new host.
2. On that host, clone the repository and create the settings:
   ```sh
   cp deploy/game-server/.env.example deploy/game-server/.env
   ```
   Fill in `GS_DOMAIN`, `PUBLIC_WS_URL`, `SERVER_ID`, `REGION`, the main
   server's URLs, and copy the four secrets from the main `deploy/.env`.
3. Start it:
   ```sh
   docker compose -f deploy/game-server/docker-compose.yml up -d --build
   ```
   It runs the game server behind its own Caddy (HTTPS for `GS_DOMAIN`),
   registers with `https://DOMAIN/mm` and reports results to
   `https://DOMAIN/api`. `curl https://DOMAIN/mm/ping` lists its region once it
   is up, and players pick the closest region in Settings.

**On the same host** (one more core's worth of shows), add a second game
server with its own hostname in a `deploy/docker-compose.override.yml`, which
Compose merges automatically when you run it from `deploy/`:

```yaml
services:
  game-server-2:
    extends: { file: docker-compose.yml, service: game-server }
    environment:
      SERVER_ID: gs-2
      PUBLIC_WS_URL: wss://gs2.play.example.com/ws
      CONTROL_URL: http://game-server-2:7350
    volumes: !override
      - results-outbox-2:/data/results-outbox
volumes:
  results-outbox-2:
```

and give it a site in `deploy/Caddyfile` (plus a DNS record for the name):

```caddyfile
gs2.play.example.com {
	reverse_proxy game-server-2:7350
}
```

## Upgrades

```sh
git pull
docker compose build
docker compose up -d
```

`up -d` replaces each changed service. The `migrate` service runs again
first and the API waits for it, so the schema is always current before new
API code starts. Running migrations twice is harmless (they take a lock and
skip what is applied).

The game server **drains** on stop: it deregisters from the matchmaker so no
new shows land on it, lets running shows finish (up to `DRAIN_TIMEOUT_MS`,
15 minutes by default) and delivers any pending results before exiting.
While the only game server drains, players cannot start new shows, so:

- upgrade at a quiet hour, or set a shorter `DRAIN_TIMEOUT_MS` in `deploy/.env`;
- or announce it: `pnpm admin maintenance on --in 15` stops new shows when the
  window opens while running ones finish ([Live ops](#maintenance));
- update the rest first and the game server last (`--no-deps` skips the
  automatic migration, so run it by hand first):
  ```sh
  docker compose run --rm migrate
  docker compose up -d --no-deps api matchmaker client caddy
  docker compose up -d game-server
  ```
- with several game servers, upgrade them one at a time.

`stop_grace_period` (17 minutes) must stay longer than
`DRAIN_TIMEOUT_MS + OUTBOX_FLUSH_MS` plus 30 s (the settle wait for late
arrivals, `DRAIN_SETTLE_MS`, runs inside `DRAIN_TIMEOUT_MS`); raise it together
with them. While it drains, a game server stays registered with the matchmaker
as draining: no new matches go to it, but players of running shows can still
rejoin and hosts can still remove players. It deregisters once its last room
closes, and a show cut off by the timeout reports the rounds played so far.

## Backups

The `backup` service runs `pg_dump` every `BACKUP_INTERVAL_HOURS` (24) into
the `backups` volume and deletes dumps older than `BACKUP_KEEP_DAYS` (14).

```sh
docker compose exec backup ls -lh /backups                            # list dumps
docker compose exec backup pg_dump -Fc -f /backups/manual-before-upgrade.dump   # one now (never pruned)
docker compose cp backup:/backups/tumble-20261004T030000Z.dump .      # copy one off the server
```

Copy dumps off the server regularly (and `deploy/.env` with them): a volume
on the same disk is not a backup of that disk.

**Restore** a dump (this replaces the current data):

```sh
docker compose stop api matchmaker game-server
docker compose exec backup pg_restore --clean --if-exists --no-owner \
  -d tumble /backups/tumble-20261004T030000Z.dump
docker compose up -d
```

To restore on a new server, copy the dump into the `backups` volume first
(`docker compose cp ./tumble-….dump backup:/backups/`).

Redis holds short-lived state (parties, presence, queues, rate limits, live
leaderboards) with an append-only file in the `redis` volume; it needs no
backup schedule. Caddy's certificates live in the `caddy-data` volume.

**Embedded database (PGlite):** the API can run without Postgres
(`ALLOW_EMBEDDED_DB=1`, data in `PGLITE_DIR`) as a single instance only; this
Compose stack does not use it. Back up that directory only while the API is
stopped, since copying it while running can capture a torn state.

## Troubleshooting

- **Logs:** `docker compose logs -f api` (or any service). A service with a
  bad or missing setting prints every problem at once and exits; `docker
compose logs migrate` shows migration errors.
- **Health:** each service answers `/health` (alive) and `/ready` (able to
  serve: database, Redis, draining). Through the edge: `/api/health`,
  `/api/ready`, `/mm/health`.
- **No certificate / site unreachable:** DNS must point at this server and
  ports 80 and 443 must be open; `docker compose logs caddy` shows ACME errors.
  Let's Encrypt rate-limits repeated failures, so fix DNS before retrying.
- **The menu loads but Play never connects:** WebSockets are not getting
  through. Anything in front of Caddy (a CDN, a load balancer) must allow
  WebSocket upgrades on `/gs/ws`, `/mm/ws` and `/api/ws`. Test:
  `curl -i https://DOMAIN/gs/ws -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='`
  should answer `101 Switching Protocols`.
- **Everyone gets "rate limited", or bans hit the wrong players:** the
  services see the wrong client address. `TRUST_PROXY=1` trusts exactly one
  proxy (Caddy). With another proxy in front of Caddy (Cloudflare, a load
  balancer), set `TRUST_PROXY=2` in `deploy/.env`, and make Caddy pass that
  proxy's `X-Forwarded-For` on by adding it to the global block at the top of
  `deploy/Caddyfile`:
  ```caddyfile
  {
  	{$CADDY_GLOBAL_OPTIONS}
  	servers {
  		trusted_proxies static 203.0.113.0/24
  	}
  }
  ```
  Never use `TRUST_PROXY=true`: the services refuse it because clients could
  forge their address.
- **CORS errors in the browser console, or WebSockets closed with 403:** the
  page's origin is not allowed. `PUBLIC_WEB_URL`, `CORS_ORIGINS` (API) and
  `ALLOWED_ORIGINS` (matchmaker, game server) must name the exact origin
  players use, scheme included. After a domain change, rerun
  `pnpm setup:env --production --domain <new> --force` or edit all of
  `DOMAIN`, `PUBLIC_*`, `CORS_ORIGINS` and `ALLOWED_ORIGINS`.
- **OAuth "redirect_uri mismatch":** the URI registered with the provider
  must be exactly `PUBLIC_API_URL` + `/auth/<provider>/callback`.
- **Ports:** do not publish 7350, 7360 or 7370; the edge reaches the
  services on the Compose network. Metrics need the token:
  `curl -H "Authorization: Bearer $METRICS_TOKEN" https://DOMAIN/api/metrics`
  (and `/mm/metrics`).

## Without Node.js on the server

Both scripts only need Node.js itself, so a throwaway container works:

```sh
docker run --rm -v "$PWD":/repo -w /repo -u "$(id -u):$(id -g)" node:22-slim \
  node scripts/setup-env.mjs --production --domain play.example.com
```

For admin commands, use `docker compose exec api node scripts/admin.mjs …`
as shown above.
