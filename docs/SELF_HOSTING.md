# Self-hosting Tumble Royale

One server runs the whole game with Docker Compose: Postgres, Redis, the
account API, the matchmaker, a game server, the web client and a Caddy edge
proxy that gets HTTPS certificates automatically. Everything is served from
one domain:

| Path                         | Goes to                                                |
| ---------------------------- | ------------------------------------------------------ |
| `https://DOMAIN/`            | the web client (static files)                          |
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

There are no admin accounts; admin actions use `ADMIN_TOKEN` from
`deploy/.env`. On the server, `pnpm admin` (or `node scripts/admin.mjs`) reads
that file and talks to `https://DOMAIN/api`:

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
  `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` and
  `charge.dispute.funds_reinstated`. The API refuses to start with a key but
  no webhook secret, and without Stripe Gem checkout is simply off.
- **Crash reports:** `SENTRY_DSN` (any Sentry-compatible service) for the
  servers; `sentryDsn` in the client overrides below for browsers.

### Client overrides

The client talks to `/api`, `/mm` and `/gs/ws` on its own origin, so it needs
no configuration. To change that, or to turn on browser crash reports, copy
`deploy/client-config/config.json.example` to `deploy/client-config/config.json`
and edit it; the client reads it at every page load, no rebuild needed.

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
- update the rest first and the game server last:
  `docker compose up -d --no-deps api matchmaker client caddy`, then
  `docker compose up -d game-server`;
- with several game servers, upgrade them one at a time.

`stop_grace_period` (17 minutes) must stay longer than
`DRAIN_SETTLE_MS + DRAIN_TIMEOUT_MS + OUTBOX_FLUSH_MS` plus 30 s; raise it
together with them.

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
