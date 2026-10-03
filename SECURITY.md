# Security

This project is not actively maintained, so there are no supported versions
and no guaranteed response times.

If you find a vulnerability, please report it privately through GitHub's
[private vulnerability reporting](https://github.com/BankkRoll/Tumble-Royale/security/advisories/new)
rather than in a public issue.

If you run your own deployment:

- Set strong, unique values for `JWT_SECRET`, `INTERNAL_HMAC_SECRET`,
  `GAME_TICKET_SECRET` and `GAME_SERVER_SECRET`. The development defaults are
  public.
- Run the game server with `NODE_ENV=production` so it rejects joins without
  a matchmaker ticket.
- Keep the API's fake payment provider disabled in production: configure
  Stripe or leave Gem purchases off.
