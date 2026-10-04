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
