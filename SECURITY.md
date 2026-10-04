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
