# Operator's handbook

Everything an operator or staff member does on a running Tumble Royale
server: who can do what, how staff sign in, every `pnpm admin` command and
the runbooks for day-to-day work. Installing and configuring the server is
in [SELF_HOSTING.md](SELF_HOSTING.md); every environment variable is in its
[Environment reference](SELF_HOSTING.md#environment-reference).

- [Roles](#roles)
- [Signing in to the console](#signing-in-to-the-console)
- [First-time setup](#first-time-setup)
- [The `pnpm admin` CLI](#the-pnpm-admin-cli)
- [Command reference](#command-reference)
- [Runbooks](#runbooks)
- [Sign-in providers](#sign-in-providers)

## Roles

| Who                | How                                                  | Can                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Moderator**      | `pnpm admin staff grant <userId> --role moderator`   | the report queue, warnings, chat and voice mutes, ranked bans, suspensions and lifting them, renames, shared-round takedowns, club moderation, denying refunds, reading the audit log |
| **Admin**          | `pnpm admin staff grant <userId> --role admin`       | everything a moderator can, plus currency adjustments, cosmetic revokes, gift reversals, approving refunds, restoring shared rounds, live ops, status incidents and managing staff    |
| **Operator token** | `ADMIN_TOKEN` in `deploy/.env`, used by `pnpm admin` | acts as an admin, and is the only credential that can create the first admin (`staff bootstrap`) or mint staff sign-in links (`staff link`); keep it on the server                    |

Staff accounts must be full accounts (a linked login, not a guest). Every
action, from the console or the CLI, lands in the append-only audit log with
who did it, the target and the reason.

## Signing in to the console

The console lives at `https://DOMAIN/admin` and signs in with the game
session of the same browser:

1. Sign in to the game at `https://DOMAIN` with the staff account (any linked
   login), or open a one-time staff link from `pnpm admin staff link`.
2. Open `https://DOMAIN/admin` and press **Open the console**.

Console sessions last 30 minutes and live only in that tab. For safety:

- opening the console needs a game sign-in from the last **10 minutes**; an
  older session gets `reauth_required` (sign out of the game and back in, or
  use a fresh staff link);
- signing out of the game ends the console session at once;
- revoking the role or suspending the account ends it at the next request.

### Staff sign-in links

`pnpm admin staff bootstrap` and `pnpm admin staff link` print a link like
`https://DOMAIN/auth/staff?token=…`. It signs whoever opens it in to that
staff account and then opens the console, so treat it like a password:

- it works **once**, for **15 minutes**, and a new link for the same account
  cancels the previous one;
- only its SHA-256 is stored (in Redis), never the link itself;
- it can only be minted with `ADMIN_TOKEN`, never from a console session,
  and only for accounts that hold a staff role;
- minting and using it are audited (`staff.link_issue`, `staff.link_use`).

## First-time setup

A fresh server has no staff and possibly no sign-in method besides guests.
On the server, after `docker compose up -d`:

```sh
pnpm admin staff bootstrap --email you@example.com --name Owner
```

This creates a full account for that address (or finds the one already using
it), makes it **admin** and prints a one-time sign-in link. Open the link in
the browser you will administer from: it signs you in to the game and opens
the console. Make sure the address is yours: once email sign-in (SMTP) is set
up, that address signs in to this admin account with a magic link.

Then:

1. Configure at least one portable sign-in method ([Sign-in
   providers](#sign-in-providers)) so you, and players, can sign in from any
   device. Link it to your account in Settings → Account.
2. Grant roles to the rest of the team ([Granting and revoking
   staff](#granting-and-revoking-staff)).
3. Publish a welcome post with `pnpm admin news publish`, and check
   `https://DOMAIN/status`.

When you lose your session later, `pnpm admin staff link <userId>` gives you a
new link (find your id with `pnpm admin staff list`).

**Local development:** the root `.env` that `pnpm setup:env` writes has
`DEV_ADMIN_EMAIL=admin@tumble.localhost`. While no staff exist, `pnpm dev`
makes that address an admin, and every API boot logs a fresh one-time link
(`[dev] one-time admin sign-in link`). `ADMIN_TOKEN` is generated too, so
`pnpm admin` works against `http://localhost:7360`. Production refuses
`DEV_ADMIN_EMAIL`.

## The `pnpm admin` CLI

`pnpm admin` (or `node scripts/admin.mjs`, which needs only Node.js 22) calls
the API's `/internal/*` routes with `ADMIN_TOKEN`. It reads `deploy/.env`,
`.env` and `apps/api/.env` (later files win, real environment variables win
over all), and talks to `ADMIN_API_URL`, else `PUBLIC_API_URL`, else
`API_URL`, else `http://127.0.0.1:7360`. Inside the API container it talks to
that instance directly:

```sh
docker compose exec api node scripts/admin.mjs staff list
```

Options: `--api-url <url>`, `--token <token>`, `--json` (raw JSON) and
`--help`. Exit codes: 0 ok, 1 the API refused, 2 usage error, 3 the API could
not be reached. `pnpm admin --help` prints the same reference as below; a
test fails if a command is missing here.

## Command reference

### Staff and the audit log

```sh
pnpm admin staff bootstrap --email you@example.com --name Owner   # first admin + one-time link
pnpm admin staff link 3f2c1a9e-…                                   # new one-time link for a staff account
pnpm admin staff list
pnpm admin staff grant 3f2c1a9e-… --role moderator                 # or --role admin
pnpm admin staff revoke 3f2c1a9e-…                                 # takes effect at once
pnpm admin audit --limit 20
pnpm admin audit --action player. --target 3f2c1a9e-…              # a prefix ending in "." matches a group
```

### Players

```sh
pnpm admin user lookup "Bouncy#0042"          # also an id, an email or a bare name
pnpm admin user rename 3f2c1a9e-… Sunny_Day   # staff renames skip the cooldown
pnpm admin ledger check 3f2c1a9e-…            # cached balances against the append-only ledger
```

`user lookup` lists each account's linked sign-in methods (`device`,
`email`, `discord`, `google`, `github`, `twitch`, `apple`), email and bans.

### Reports and bans

```sh
pnpm admin reports list                                   # open reports, oldest first
pnpm admin reports resolve 8c1e… --status dismissed       # resolved | dismissed | actioned | open
pnpm admin bans list --user 3f2c1a9e-…                    # --all includes expired and revoked
pnpm admin bans add 3f2c1a9e-… --reason "cheating" --scope all --hours 72
pnpm admin bans remove 5d0a…                              # lift a ban by its id
```

Scopes: `all` (suspension: no sign-in, no play), `ranked` (no ranked
queues), `chat` (chat mute) and `voice` (voice mute). Without `--hours` a ban
is permanent.

### News

```sh
pnpm admin news publish post.json    # create or replace a live post
pnpm admin news hide winter-update   # withdraw (bundled posts too)
pnpm admin news show winter-update   # restore
```

`post.json`:

```json
{
  "id": "winter-update",
  "title": "Winter update",
  "summary": "Two new rounds and a snowy Main Show.",
  "body": [{ "type": "paragraph", "text": "Bundle up!" }],
  "tag": "PATCH NOTES",
  "date": "2026-12-01",
  "art": ["#7c5cff", "#3ec7e6"],
  "icon": "❄️"
}
```

Tags: `SEASON`, `ROUNDS`, `HOW TO PLAY`, `PATCH NOTES`, `TIPS`, `EVENT`.
Body blocks: `paragraph`, `heading`, `list`, `image`, `tip`.

### Live ops

```sh
pnpm admin flags get
pnpm admin flags get store.enabled
pnpm admin flags set store.enabled off                     # kill switch
pnpm admin flags set analytics.sample on --payload 0.25
pnpm admin flags set some.client.feature on --rollout 10   # sticky 10% of players
pnpm admin maintenance status
pnpm admin maintenance on --in 10 --for 30 --message "New rounds incoming!"
pnpm admin maintenance off
pnpm admin playlists list
pnpm admin playlists set chaos-mode --starts 2026-12-01T18:00:00Z --ends 2026-12-08T18:00:00Z --featured on
pnpm admin playlists hide duos
pnpm admin playlists show duos
pnpm admin playlists reset duos      # back to the schedule shipped with the game
pnpm admin events list
pnpm admin events set frostbite-frolic --starts 2026-12-11T18:00:00Z --ends 2027-01-08T18:00:00Z
pnpm admin events disable moonlit-mischief
pnpm admin events enable moonlit-mischief
pnpm admin events reset moonlit-mischief
```

The flags and what "off" means are in
[SELF_HOSTING.md, Feature flags](SELF_HOSTING.md#feature-flags-kill-switches).

### Status page

```sh
pnpm admin status summary
pnpm admin status incident list --all
pnpm admin status incident open --title "Queues are slow" --impact major --components matchmaking --message "We are looking into it."
pnpm admin status incident update 41 --status identified --message "A queue worker is stuck."
pnpm admin status incident resolve 41 --message "Queues are back to normal."
```

### Errors

```sh
pnpm admin errors top                       # client errors, last 24 h
pnpm admin errors top --server --hours 168  # server errors, last week
```

### Refunds

```sh
pnpm admin refunds list                                  # awaiting a decision
pnpm admin refunds list --status all --kind real_money --user 3f2c1a9e-…
pnpm admin refunds approve 9a7b… --note "bought the wrong pack"
pnpm admin refunds deny 9a7b… --reason "the Gems were already spent"
```

## Runbooks

### Granting and revoking staff

1. The person signs in to the game with a full account and sends you their
   `Name#1234` (or gets one from `staff bootstrap --email` if they have no
   login yet; it makes an admin, so lower it with `staff grant` afterwards).
2. `pnpm admin user lookup "Name#1234"` gives the account id.
3. `pnpm admin staff grant <userId> --role moderator` (or `admin`).
4. To remove someone: `pnpm admin staff revoke <userId>`. Their console
   session ends at the next request. Check `pnpm admin audit --target <userId>`
   for what they did.

### Handling a report

1. Console → **Reports** (or `pnpm admin reports list`). Each report shows the
   reason, both players, the chat evidence captured at report time and the
   target's other open reports and sanctions.
2. Decide: dismiss (nothing wrong), warn, mute, suspend or ban. In the
   console a decision can cover up to 100 reports at once, with one reason.
3. A sanction closes the target's open reports; `reports resolve` sets the
   status by hand.

### Banning and muting

| Problem                        | Command (or the console's player page)                                     |
| ------------------------------ | -------------------------------------------------------------------------- |
| Abusive chat                   | `pnpm admin bans add <userId> --scope chat --hours 24 --reason "…"`        |
| Abuse on voice                 | `pnpm admin bans add <userId> --scope voice --hours 72 --reason "…"`       |
| Boosting or throwing in ranked | `pnpm admin bans add <userId> --scope ranked --hours 168 --reason "…"`     |
| Cheating, threats              | `pnpm admin bans add <userId> --scope all --reason "…"` (permanent)        |
| Lift a sanction                | `pnpm admin bans list --user <userId>`, then `pnpm admin bans remove <id>` |

A suspension (`all`) ends the player's sessions and voice at once, on every
instance, and follows ban evasion: a new account with the same login, email
or device gets the remaining ban again.

### Refunds

- **Store items bought with Gumballs or Gems** are self-service: players
  refund them in Store → Purchases within 7 days, 3 times a year. Staff do
  nothing.
- **Gem packs (real money)** arrive as requests in the console's **Refunds**
  queue and `pnpm admin refunds list`. Admins approve; moderators and admins
  can deny with a reason the player sees.
  - With Stripe (`STRIPE_SECRET_KEY`), approval asks Stripe to refund the
    whole payment and the request shows `processing`; the Gems are taken back
    when Stripe's `charge.refunded` webhook arrives (`refunded`). Gems already
    spent become Gem debt; cosmetics are kept.
  - Without Stripe the request becomes `manual`: refund the payment yourself.
  - A refund Stripe refuses shows `failed` with the reason and can be approved
    again.
- A chargeback works the same way without a request: Stripe's dispute
  webhooks take the Gems back.

### Gift reversal

A gift sent by mistake or bought with fraudulent Gems: console → player page
of the sender or recipient → **Gifts** → **Reverse** (admin, reason
required). The sender gets the full price back and, for an opened gift, the
items the recipient still holds because of it are taken back (and off their
loadouts). Items the recipient has since earned another way stay.

### Maintenance windows

```sh
pnpm admin maintenance on --in 15 --for 30 --message "Upgrading the servers"
```

Players see the banner from now on; when the window opens, online queueing
and private lobbies close while running shows finish. Upgrade during the
window (SELF_HOSTING.md, "Upgrades"), then `pnpm admin maintenance off` (or
let `--for` end it).

### Incidents on the status page

1. `pnpm admin status incident open --title "…" --impact minor|major|critical
--components api,matchmaking,… --message "…"` as soon as players are
   affected.
2. `pnpm admin status incident update <id> --status identified|monitoring
--message "…"` at least every 30 minutes and whenever something changes.
3. `pnpm admin status incident resolve <id> --message "…"`.

Planned work is a maintenance window, not an incident.

### Feature flags and kill switches

Switch a broken feature off without a release: `pnpm admin flags set
store.enabled off` (purchases and refunds), `chat.global off`,
`party.lobbyGames off`, `replays.enabled off`, `events.enabled off`,
`clubs.enabled off`, `shows.mapVoting off`. Turn it back on with `on`. Client
features can roll out with `--rollout N`.

### Scheduling playlists and events

Limited-time playlists and events ship with windows; override them without a
release (`playlists set`, `events set`), withdraw them now (`playlists hide`,
`events disable`) and return to the shipped schedule (`playlists reset`,
`events reset`). Times are ISO 8601 in UTC.

### Shared-round takedowns

Console → **Shared rounds**: reported rounds first, with the round's JSON and
reports. **Take down** (moderator) removes it everywhere and closes its
reports; **Dismiss reports** keeps it; **Restore** (admin) undoes a takedown.

### Club moderation

Console → **Clubs**: search by name or tag, or open the club report queue.
Rename the club, reset its name or emblem, clear its description or disband
it, each with a reason; members are told once the change is committed.

### Reading top errors

`pnpm admin errors top` groups uncaught browser errors by message with the
number of players and releases affected; `--server` shows server crashes by
service. A new top entry right after a release is the first thing to check;
roll back or switch the feature off with a flag.

### Ledger checks

`pnpm admin ledger check <userId>` compares the player's cached balances with
the sum of their append-only ledger. A mismatch means a bug, never a fix by
hand: note the output and open an issue. Gem debt from refunded packs is
written off with `POST /internal/payments/debt/<userId>/forgive` (admin).

### Backups and restore

The `backup` service dumps Postgres every `BACKUP_INTERVAL_HOURS` and keeps
`BACKUP_KEEP_DAYS`. Copy dumps (and `deploy/.env`) off the server regularly.
Restore and manual dumps: [SELF_HOSTING.md, Backups](SELF_HOSTING.md#backups).

### Rotating secrets

Edit `deploy/.env`, then `docker compose up -d` (Compose recreates what
changed). Use 32+ random characters (`openssl rand -base64 32`).

| Secret                                                             | Effect of a new value                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `ADMIN_TOKEN`                                                      | the old token stops working at once; outstanding staff links still work until used |
| `METRICS_TOKEN`                                                    | update your scraper                                                                |
| `JWT_SECRET`                                                       | every player and console session ends; players sign in again                       |
| `INTERNAL_HMAC_SECRET`, `GAME_TICKET_SECRET`, `GAME_SERVER_SECRET` | change on the main server and every extra game server together, then restart all   |
| `VOICE_TURN_SECRET`                                                | restart coturn with the API (`--profile voice up -d`)                              |
| `POSTGRES_PASSWORD`                                                | `ALTER USER tumble PASSWORD '…'` in psql first, then update it and `DATABASE_URL`  |
| OAuth client secrets, `STRIPE_*`, `SMTP_URL`                       | rotate at the provider first, then here                                            |

`pnpm setup:env --production --domain <domain> --force` regenerates every
secret at once (keeping `POSTGRES_PASSWORD`); every session ends.

## Sign-in providers

Guests always work. Each other method turns on when its keys are set in
`deploy/.env` (then `docker compose up -d`), and the game shows exactly the
enabled ones. Every provider redirects to
`https://DOMAIN/api/auth/<provider>/callback`, which must be registered
**exactly** (scheme, host, path, no trailing slash). Players add and remove
logins in Settings → Account; the last one cannot be removed.

How sign-in stays safe: every flow is bound to the browser that started it
(a code, magic link or authorize URL forwarded to someone else does nothing
there), the provider's own user id is the identity, and an email address is
only trusted when the provider says it verified it. A new login joins an
existing account only when that address was proven there by an email magic
link; otherwise it creates a new account. "Connect" in Settings never moves
the device to a different account.

### Discord

1. <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** → **Redirects** → add `https://DOMAIN/api/auth/discord/callback`.
3. Copy the **Client ID** and **Client Secret** (Reset Secret) into
   `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.

Scopes requested: `identify email`.

### Google

1. <https://console.cloud.google.com/> → APIs & Services → **OAuth consent
   screen**: External, app name, support email, scopes `openid`, `email`,
   `profile`; publish it.
2. **Credentials** → **Create credentials** → **OAuth client ID** → Web
   application. Authorized redirect URI:
   `https://DOMAIN/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### GitHub

1. <https://github.com/settings/developers> (or your organisation's settings)
   → **OAuth Apps** → **New OAuth App** (not a GitHub App).
2. Homepage URL `https://DOMAIN`, Authorization callback URL
   `https://DOMAIN/api/auth/github/callback`.
3. Generate a client secret; set `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`.

Scopes requested: `read:user user:email`. Only the primary address GitHub
marks verified is used.

### Twitch

1. <https://dev.twitch.tv/console/apps> → **Register Your Application**.
2. OAuth Redirect URL `https://DOMAIN/api/auth/twitch/callback`, category
   Game Integration, client type Confidential.
3. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (New Secret).

Scopes requested: `openid user:read:email`, with the verified email claim.

### Apple

Sign in with Apple needs a paid Apple Developer account and a public HTTPS
domain (it does not work on `localhost`).

1. <https://developer.apple.com/account/resources/identifiers> → an **App
   ID** with **Sign in with Apple** enabled (the primary App ID).
2. A **Services ID** (for example `com.example.tumble.web`) → enable Sign in
   with Apple → **Configure**: primary App ID from step 1, domain `DOMAIN`,
   return URL `https://DOMAIN/api/auth/apple/callback`. This id is
   `APPLE_CLIENT_ID`.
3. **Keys** → a new key with Sign in with Apple, configured for that App ID.
   Download the `.p8` file (only once). Its Key ID is `APPLE_KEY_ID`.
4. Your **Team ID** (top right of the developer portal) is `APPLE_TEAM_ID`.
5. `APPLE_PRIVATE_KEY` is the `.p8` file's contents on one line, newlines
   written as `\n`:

   ```sh
   awk 'NF {printf "%s\\n", $0}' AuthKey_KEY1234567.p8
   ```

Apple posts the result back to the API (`response_mode=form_post`); the API
signs a fresh five-minute client secret with the key for every sign-in and
verifies Apple's ID token (signature, issuer, audience, nonce). Apple sends
the person's name only on their very first authorization; it becomes the
suggested display name. Users who choose "Hide My Email" get a private relay
address, which is treated as verified.

### Email (magic links)

Set `SMTP_URL` (`smtp://user:pass@host:587` for STARTTLS or
`smtps://user:pass@host:465`) and optionally `SMTP_FROM`. The link works once,
for 15 minutes, and only in the browser that asked for it.
