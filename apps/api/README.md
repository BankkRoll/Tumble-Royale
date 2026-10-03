# @tumble/api

Accounts, inventory, store, economy, progression, ranked, social and the
realtime gateway for Tumble Royale. Fastify 5 + Drizzle ORM.

```sh
pnpm --filter @tumble/api dev     # watch mode, http://localhost:7360
pnpm --filter @tumble/api start   # single run
pnpm --filter @tumble/api test    # vitest, in-memory PGlite
```

No Docker needed: without `DATABASE_URL` the API runs on embedded
[PGlite](https://pglite.dev) (`./.data/pglite`, in-memory for tests); without
`REDIS_URL` it uses an in-process KV. Same schema, same migrations either way.

## Environment

| Variable                                      | Default                             | Purpose                                                                                                                                 |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` / `HOST`                               | `7360` / `0.0.0.0`                  | Listen address                                                                                                                          |
| `DATABASE_URL`                                | –                                   | Postgres; unset → PGlite                                                                                                                |
| `PGLITE_DIR`                                  | `./.data/pglite`                    | PGlite data directory                                                                                                                   |
| `REDIS_URL`                                   | –                                   | Redis for parties, presence, leaderboards, pub/sub; unset → memory                                                                      |
| `JWT_SECRET`                                  | dev value                           | HS256 secret for access tokens and party queue tickets. **Shared with the matchmaker.** Required in production                          |
| `INTERNAL_HMAC_SECRET`                        | dev value                           | Signs `/internal/match-results` from game servers. Required in production                                                               |
| `ADMIN_TOKEN`                                 | –                                   | Bearer for `/internal/bans`, `/internal/flags`, `/internal/reports`, `/internal/ledger`; unset → disabled                               |
| `PUBLIC_WEB_URL`                              | `http://localhost:5173`             | Client origin (invite links, magic links, OAuth return)                                                                                 |
| `PUBLIC_API_URL`                              | `http://localhost:7360`             | Used to build OAuth redirect URIs                                                                                                       |
| `CORS_ORIGINS`                                | any (dev) / `PUBLIC_WEB_URL` (prod) | Comma-separated allow-list                                                                                                              |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | –                                   | Discord OAuth; unset → `/auth/discord/*` returns 503 `provider_disabled`                                                                |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`   | –                                   | Google OAuth; same behaviour                                                                                                            |
| `SMTP_URL`                                    | –                                   | Magic-link mail relay, e.g. `smtp://user:pass@host:587` (STARTTLS) or `smtps://…:465`; unset → console (dev) / email sign-in off (prod) |
| `SMTP_FROM`                                   | `Tumble Royale <no-reply@web host>` | Sender for sign-in emails                                                                                                               |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | –                                   | Stripe Checkout for Gem packs; unset → fake provider that completes instantly                                                           |
| `NAME_CHANGE_COOLDOWN_DAYS`                   | `30`                                | Display name change cooldown (the first rename is free)                                                                                 |
| `RATE_LIMIT_MAX`                              | `300`                               | Requests/minute per token (or IP)                                                                                                       |
| `LOG_LEVEL`                                   | `info`                              | pino level                                                                                                                              |

OAuth redirect URIs to register: `${PUBLIC_API_URL}/auth/discord/callback`,
`${PUBLIC_API_URL}/auth/google/callback`. Stripe webhook endpoint:
`${PUBLIC_API_URL}/webhooks/stripe` (events `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.expired`).

## Auth flow (client)

1. First launch: `POST /auth/guest { displayName?, region? }` → `{ accessToken (15 min), refreshToken (30 d), deviceToken, user }`. Store `deviceToken` + `refreshToken`.
2. Later launches: `POST /auth/refresh { refreshToken }` (rotates; keep the new one). If it fails, `POST /auth/guest { deviceToken }` signs back into the same guest.
3. Send `Authorization: Bearer <accessToken>` on every call; refresh on 401.
4. Upgrade: `POST /auth/discord/start` (Bearer) → `{ url }`; navigate there. The provider returns to the API, which redirects to `${PUBLIC_WEB_URL}/auth/complete?code=…` (or `?error=…`); the client calls `POST /auth/exchange { code }` for tokens. Email: `POST /auth/email/start { email }` (Bearer to link) → link to `${PUBLIC_WEB_URL}/auth/email?token=…` → `POST /auth/email/verify { token }`.
5. `/auth/exchange` and `/auth/email/verify` return the token pair plus `provider` and `outcome`: `linked` / `alreadyLinked` (the signed-in account), `switched` (the identity belongs to another account, so the tokens are for that one — the client confirms before replacing the local Tumbler, and revokes them via `/auth/logout` if the player declines), `signedIn` or `created` (no session was sent). The OAuth return URL also carries `provider=…`.
6. Reusing a rotated refresh token revokes the whole session family (`401 refresh_reused`).

Errors are always `{ error: <code>, message, details? }`.

## Endpoints

| Method & path                                                                                                                                                                                               | Auth          | Notes                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                                                                                                                                               | –             | DB/KV/payments driver                                                                                                               |
| `POST /auth/guest` · `/auth/refresh` · `/auth/logout` · `/auth/exchange`                                                                                                                                    | –             | see above                                                                                                                           |
| `GET /auth/providers`                                                                                                                                                                                       | –             | which sign-ins are configured                                                                                                       |
| `GET\|POST /auth/{discord,google}/start`, `GET /auth/{discord,google}/callback`                                                                                                                             | opt.          | PKCE authorization-code flow                                                                                                        |
| `POST /auth/email/start` · `/auth/email/verify`                                                                                                                                                             | opt.          | magic link (SMTP, console mailer in dev; 503 `provider_disabled` without a mailer)                                                  |
| `DELETE /me/identities/{discord,google,email}`                                                                                                                                                              | ✔             | unlink; 409 `last_login_method` if no other Discord/Google/email login would remain                                                 |
| `GET /me` · `PATCH /me { displayName?, region? }`                                                                                                                                                           | ✔             | profile card + wallet + linked providers                                                                                            |
| `GET /profile/:id`                                                                                                                                                                                          | ✔             | public profile card                                                                                                                 |
| `GET /inventory`                                                                                                                                                                                            | ✔             | owned cosmetics                                                                                                                     |
| `GET /loadouts` · `PUT /loadouts/:i` · `DELETE /loadouts/:i` · `POST /loadouts/:i/activate`                                                                                                                 | ✔             | 6 slots; ids/slots/ownership validated                                                                                              |
| `GET /store`                                                                                                                                                                                                | opt.          | today's featured + daily offers, `refreshesAt`, `secondsRemaining`, `owned` flags                                                   |
| `POST /purchase { offerId, currency? }` + `Idempotency-Key`                                                                                                                                                 | ✔             | 402 `insufficient_funds`, 409 `already_owned` / `idempotency_key_reused`                                                            |
| `GET /wallet`                                                                                                                                                                                               | ✔             | balances + last 50 ledger rows                                                                                                      |
| `GET /gems/packs` · `POST /gems/checkout { packId }` + `Idempotency-Key`                                                                                                                                    | ✔             | Stripe Checkout URL, or instant fake completion                                                                                     |
| `POST /webhooks/stripe`                                                                                                                                                                                     | Stripe sig    | idempotent Gem grant                                                                                                                |
| `GET /pass` · `POST /pass/claim { tier, track }` · `POST /pass/premium` + `Idempotency-Key`                                                                                                                 | ✔             | season pass                                                                                                                         |
| `GET /challenges` · `POST /challenges/reroll { id }` · `POST /challenges/claim { id }`                                                                                                                      | ✔             | 3 daily / 6 weekly, 1 daily reroll                                                                                                  |
| `GET /leaderboards/:type?scope=global\|regional\|friends&region=&limit=&offset=`                                                                                                                            | ✔             | `crowns`, `crowns_weekly`, `crowns_all_time`, `ranked`, `win_streak`; includes your own row                                         |
| `GET /matches/:id` · `GET /me/matches`                                                                                                                                                                      | ✔             | show detail; last 20 shows with per-round results                                                                                   |
| `GET /friends` · `POST /friends/request { nameTag }` · `/friends/accept` · `/friends/decline` · `DELETE /friends/:userId` · `POST /friends/block` · `DELETE /friends/block/:userId` · `GET /friends/recent` | ✔             | name#tag, presence                                                                                                                  |
| `POST /presence { status }`                                                                                                                                                                                 | ✔             | `online`/`in_menu`/`in_queue`/`in_match`                                                                                            |
| `GET /party` · `POST /party` · `GET /party/code/:code` · `POST /party/join { code }` · `/party/leave` · `/party/kick` · `/party/promote` · `/party/ready` · `/party/playlist` · `/party/invite`             | ✔             | ≤4 members, invite link `${PUBLIC_WEB_URL}/join/<code>`                                                                             |
| `POST /party/queue-ticket { playlistId?, region? }`                                                                                                                                                         | ✔             | leader only, everyone ready → 120 s JWT for the matchmaker's `POST /queue`                                                          |
| `POST /report`                                                                                                                                                                                              | ✔             | moderation queue (10/hour)                                                                                                          |
| `GET /flags` · `POST /events`                                                                                                                                                                               | opt.          | feature flags (sticky % rollout), analytics                                                                                         |
| `POST /internal/match-results`                                                                                                                                                                              | HMAC          | game server → API (below)                                                                                                           |
| `GET /internal/reports` · `POST /internal/bans` · `DELETE /internal/bans/:id` · `PUT /internal/flags/:key` · `GET /internal/ledger/:userId`                                                                 | `ADMIN_TOKEN` | moderation & audits                                                                                                                 |
| `GET /ws?token=<accessToken>`                                                                                                                                                                               | ✔             | realtime: `presence`, `friend_request`, `friend_accepted`, `party_update`, `party_invite`, `party_kicked`, `notification`, `wallet` |

## Game server → `POST /internal/match-results`

Body: `MatchResult` in `src/matches/schema.ts` (participants with `userId`/`isBot`,
optional per-player `stats` counters and `quit`, rounds with per-participant
`qualified/position/timeMs`, and `placements` where 1 = Crown winner and
players eliminated together share a value). Signing:

```
x-tumble-timestamp: <unix ms>
x-tumble-nonce:     <16–128 random chars, never reused>
x-tumble-signature: hex(HMAC_SHA256(INTERNAL_HMAC_SECRET, `${timestamp}.${nonce}.${rawBody}`))
```

Requests outside ±5 min or with a seen nonce are rejected. Grants are keyed by
`matchId`: re-posting (with a fresh nonce) returns the stored summaries with
`alreadyProcessed: true`. The response's `rewards[]` (`PlayerRewardSummary`)
is what the client's rewards screen shows. Custom-lobby shows are recorded but
grant nothing.

## Design notes

- **Ledger**: `currencies_ledger` is append-only (DB trigger); `profiles`
  caches balances, updated in the same transaction under a row lock;
  `(user, currency, reason, ref)` is unique so keyed grants apply once.
  `GET /internal/ledger/:userId` audits cache vs. ledger.
- **Ranked** (`src/ranked/rating.ts`): OpenSkill Plackett-Luce over the whole
  lobby by placement. Bots stay in the finishing order but enter the update
  with a proxy rating (the lobby's mean human rating) and are never updated.
  Visible RP = placement percentile swing (±30, +15 for the Crown) × lobby
  strength + convergence toward the hidden rating. 5 placement shows, then RP
  is seeded from the hidden rating. Tiers Bronze→Champion (III→I, 400 RP per
  division); Crown League = Champion within the region's top 500.
- **Content**: cosmetics, playlists, show rewards, challenges, levels and the
  season pass come from `@tumble/content` (`src/catalog.ts` adapts them);
  Gem packs and season dates live in `catalog.ts`.
- Migrations: `pnpm exec drizzle-kit generate` (from `apps/api`) writes to
  `./drizzle`; they run automatically on boot.
