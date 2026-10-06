# TODO

What comes next, in order. Each item should land with tests, docs and a green
`typecheck`, `lint`, `format:check`, `test`, `build` and script-test run.

## 1. Wave 4 features

- [x] **Round editor with sharing**: build rounds from the existing obstacle
      kits, validate them against `RoundDefinitionSchema`, test-play locally,
      share by code, and moderate shared rounds from the admin console.
- [x] **Map voting**: players vote between round candidates during a show
      transition; the server decides, ties broken by seed.
- [x] **Elimination replay and highlights**: a short replay of how the player
      was eliminated, and automatic highlight moments built on the replay and
      clip pipeline.
- [x] **Spectator / broadcast mode**: a free camera, player switching and a
      clean overlay for streaming shows.
- [x] **Gifting and a wish list**: gift store items to friends, with abuse and
      refund rules that match the refund policy in `docs/ECONOMY.md`.
- [x] **Voice chat**: opt-in, party and team scoped, with mute, push-to-talk,
      reporting and Streamer Mode support.
- [x] **Clubs**: persistent groups with a roster, roles, chat and club
      challenges.
- [x] **Public status page**: service health, maintenance windows and incident
      notes, fed by the existing `/status` and live-ops data.

## 2. Follow-ups from the last wave

- [ ] **Render performance**: batches cull per shadow cascade, trails are one
      draw, the far cascade renders every other frame, the batcher compares
      state in place (see README). Still unverified on a quiet machine against
      the targets (High 60 fps p10 / 90 median, Ultra 45 p10 at 100 players).
      Next levers: the offline sim (4-6 ms a step), the per-frame scene-graph
      update of 4,100 bones, merging same-material obstacles of different
      geometry.
- [x] **WebGL2 post-reveal stall**: 3.8-27 s down to 0.1-0.26 s (shared CSM
      graph, real paced warm-up draws, no mid-round pipelines).
- [ ] **Loading**: environment and batch builds are sliced; the longest block
      left is one three.js shader build (40-120 ms on a loaded machine); total
      WebGPU load 5.3-7.0 s under load (target 3.5 s quiet, unmeasured).
- [ ] **Phones**: check on real devices (install prompt, safe areas, iOS
      keyboard, thermal throttling, Auto tier step-down tuning).
- [ ] **Bots and rounds**: Bounce Ball Blitz bots barely score; Pattern Panic
      and the two new logic rounds end very early with 100 players; Cannonball
      Canyon's rogue-wave variation undershoots its target.
- [ ] **Unverified in a real browser or service**: events screen, refunds
      (Store purchases tab, console queue, real Stripe), achievements and
      collection screens, admin console sign-in against a live API, WebM and
      MediaRecorder clip fallbacks.
- [ ] **Unverified in production infrastructure**: Docker image builds, the
      compose stack, ACME certificates, SIGTERM drain in containers, the new CI
      jobs and nightly workflow, and the API/matchmaker suites on real Postgres
      and Redis.
- [ ] **Economy**: add the login streak, seasonal challenge and event Gems to
      the season budget table in `docs/ECONOMY.md`.

## 2b. Operator setup and sign-in

- [x] **Env completeness**: every variable each service reads is listed in
      `deploy/.env.example` (and the game-server example), grouped as required
      or optional with what it enables (Discord, Google, Stripe, SMTP, TURN…);
      `setup:env --production` and the config tests agree with it.
- [x] **First admin**: a safe bootstrap path for a fresh server (e.g.
      `pnpm admin staff bootstrap` creating or promoting an account and a
      one-time sign-in link), documented.
- [x] **Admin guide**: one `docs/ADMIN.md` page covering roles, the console,
      and every `pnpm admin` command with examples and common runbooks.
- [x] **More sign-in providers**: add GitHub, Twitch and Apple next to email,
      Discord and Google, each enabled by its keys alone, with account linking
      in Settings and docs for creating each provider's app.

## 3. Full re-review

- [ ] Review every feature, flow, screen, endpoint and setting for missing,
      half-built or buggy behaviour, plus a dedicated security pass (auth,
      sessions, tokens, rate limits, input validation, WebSocket origin and
      abuse, payments and refunds, admin routes, secrets, dependencies).
- [ ] Fix everything found, then review again until a pass comes back clean.

## 4. Final check and release

- [ ] Every root and package script runs (`dev`, `build`, `test`, `lint`,
      `format`, `setup:env` including `--production`, `admin`, migrations).
- [ ] Client and server builds, Docker images, compose and Caddy routing,
      migrations, health and readiness, graceful drain and backups all work.
- [ ] README, `docs/SELF_HOSTING.md` and `.env.example` match reality.
- [ ] Full browser e2e suite passes, then push.
