# Security

This project is not actively maintained, so there are no supported versions
and no guaranteed response times.

If you find a vulnerability, please report it privately through GitHub's
[private vulnerability reporting](https://github.com/BankkRoll/Tumble-Royale/security/advisories/new)
rather than in a public issue.

If you run your own deployment ([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)):

- Give `JWT_SECRET`, `INTERNAL_HMAC_SECRET`, `GAME_TICKET_SECRET` and
  `GAME_SERVER_SECRET` strong random values; `pnpm setup:env --production`
  generates them, along with `ADMIN_TOKEN`, `METRICS_TOKEN` and the database
  password. There are no built-in defaults: the services refuse to start
  without them or with the `change-me` placeholders from the examples.
- Keep `deploy/.env` (or wherever those values live) private, and rotate a
  secret by replacing it on every service at once.
- Run every service with `NODE_ENV=production`: the game server then rejects
  joins without a matchmaker ticket, and the API's fake payment provider is
  off (configure Stripe or leave Gem purchases off).
- Publish only the reverse proxy. The services' ports, and their internal
  metrics listeners, belong on a private network.
- Treat `ADMIN_TOKEN` like a root password: it acts as an admin on every
  admin route. Give people console access through staff roles instead
  (`pnpm admin staff grant <userId> --role moderator`), so each action in the
  audit log names a person and access can be withdrawn without rotating it.

### Payment webhook trust boundary

`POST /webhooks/stripe` is public by necessity, so nothing in a delivery is
trusted until `stripe.webhooks.constructEvent` has verified the
`Stripe-Signature` HMAC over the exact raw body with `STRIPE_WEBHOOK_SECRET`
(which also bounds the timestamp's age); a missing or bad signature is a
`400` with no effect. Each verified event id is recorded in `stripe_events`
in the same transaction as its effects, so a redelivery is acknowledged and
ignored, and a failed one is retried whole. Refunds and disputes are
reconciled to a target per PaymentIntent rather than replayed, so retried,
late and out-of-order events converge on the same ledger. A `refund.failed`
event can only mark a refund request `failed`; it never credits anything.

Player refunds never trust the client: the API re-checks ownership of the
purchase, the window, the yearly limit and the items under the buyer's
wallet lock, and `refunds.purchase_id` is unique, so a double or concurrent
submit refunds once. Real-money refunds are only ever issued by an admin
(moderators can deny but not approve), each decision is audited, and the
Stripe refund carries an idempotency key per approval attempt.

### Gifting abuse

Gifting moves value between accounts, which makes it the obvious channel for
laundering stolen currency, farming with throwaway accounts, and harassment.
The server enforces every limit ([ECONOMY.md §3.4](docs/design/ECONOMY.md)):

- **Throwaways:** only linked (non-guest) accounts at least 7 days old can
  send, the guest flag is read from the database rather than the token, and
  only to friends of at least 3 days, so a fresh account cannot be set up to
  move currency the same day.
- **Volume:** 5 gifts per sender per UTC day (cancelled and declined ones
  count, so cancel-and-resend does not reset it), 30 unopened gifts per
  recipient, and per-route rate limits (`POST /gifts` 10/min).
- **Harassment:** blocks end gifting in both directions and read exactly like
  "not friends", suspended players cannot receive gifts, notes go through the
  chat filter and chat-muted accounts cannot attach one, and a recipient can
  decline (which refunds the sender) or ignore a gift.
- **Double spending:** both players' profile rows are locked in id order
  before any check, the send is idempotent per `Idempotency-Key`, and each
  refund is a single `gift_refund` / `gift:<id>` ledger row under the ledger's
  unique key, so races, retries and replays charge and refund at most once.
- **Trail:** every gift is a row with both parties, price and outcome; the
  ledger rows carry `gift:<id>`. Moderators can list a player's gifts in the
  console, and only admins can reverse one, audited in the same transaction.
- **Privacy:** wish lists are friends-only by default and can be hidden, and
  every refusal of someone else's list is the same `wishlist_hidden`, so it
  never reveals a block or whether an account exists. Streamer Mode masks the
  names in gift toasts, the inbox and the friend picker.

### Admin console trust boundary

The console at `/admin` is only a client. Every action is authorised by the
API on each request: a console session token (30 minutes, `sessionStorage`
only, sent as a bearer header, never a cookie) is looked up by its hash, the
account's staff role is re-read, and suspended or deleted accounts are
refused. Moderators cannot reach live ops, economy corrections or staff
management (`403 insufficient_role`). A player's ordinary access token is
never accepted on an admin route, even for a staff account. The console page
is served with `X-Frame-Options: DENY` and `frame-ancestors 'none'` so its
confirm buttons cannot be clickjacked. Every admin action is written to the
append-only `admin_audit_log`. Report evidence only includes the reported
player's public global chat and whispers they sent to the reporter.

### Clubs and abuse

Clubs (persistent groups with a chat) are a new place for abuse, so the API
treats every club input as untrusted:

- Only full accounts take part; founding also needs an account at least three
  days old, so throwaway guests cannot squat names or flood club chat.
- Club names, tags and descriptions go through the shared profanity filter,
  reserved staff-like names are refused, and emblems can only use the banner
  motifs and the Tumbler palette.
- Club chat uses the same filter, mute and suspension checks as every other
  channel (read through the ban cache that every instance drops the moment a
  moderator acts), a per-account rate limit held in the shared KV, and never
  reaches members who blocked the sender.
- Every club route is rate limited, role-checked on the server
  (`CLUB_PERMISSIONS`), and switchable off with `clubs.enabled`.
- Reports carry evidence: a club report snapshots the name, tag, description
  and emblem, and attaches recent club chat only when the reporter is a
  member who could read it; a player report attaches club chat only from the
  reporter's own club. Club chat is deleted after 30 days.
- Moderators can rename, reset to a neutral name, clear the description,
  reset the emblem or disband a club from the console; each action needs a
  reason and is written to `admin_audit_log` in the same transaction.
- Goal rewards are paid once per player, week and goal, whichever club the
  player is in, so hopping between clubs cannot farm them.
