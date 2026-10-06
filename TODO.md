# TODO

What comes next, in order. Each item should land with tests, docs and a green
`typecheck`, `lint`, `format:check`, `test`, `build` and script-test run.

## 1. Wave 4 features

- [x] **Round editor with sharing**: build rounds from the existing obstacle
      kits, validate them against `RoundDefinitionSchema`, test-play locally,
      share by code, and moderate shared rounds from the admin console.
- [x] **Map voting**: players vote between round candidates during a show
      transition; the server decides, ties broken by seed.
- [ ] **Elimination replay and highlights**: a short replay of how the player
      was eliminated, and automatic highlight moments built on the replay and
      clip pipeline.
- [ ] **Spectator / broadcast mode**: a free camera, player switching and a
      clean overlay for streaming shows.
- [x] **Gifting and a wish list**: gift store items to friends, with abuse and
      refund rules that match the refund policy in `docs/ECONOMY.md`.
- [x] **Voice chat**: opt-in, party and team scoped, with mute, push-to-talk,
      reporting and Streamer Mode support.
- [x] **Clubs**: persistent groups with a roster, roles, chat and club
      challenges.
- [x] **Public status page**: service health, maintenance windows and incident
      notes, fed by the existing `/status` and live-ops data.

## 2. Other languages

- [ ] Add a translation system (there is none yet), move every UI, caption and
      rules-card string into it, and ship at least one more language. Run it
      when few other UI changes are in flight, since it touches nearly every
      screen.

## 3. Follow-ups from the last wave

- [ ] **Render performance**: 100 players reach 54 fps median on Ultra and 69 on
      High, but the High p10 is about 33 fps and frames over 50 ms remain. Next
      levers: frustum-cull obstacle batches per shadow cascade, cheaper batcher
      state comparison, merge trail draws, merge same-material obstacles,
      retune `TierGovernor`.
- [ ] **WebGL2 post-reveal stall**: about 3.8 s on the first visible frames
      after a round starts (ANGLE/D3D11 compiling on first draw).
- [ ] **Loading**: longest main-thread block during loading is 70–130 ms
      (target 50 ms); total round load about 4.2 s (target 3.5 s).
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

## 4. Full re-review

- [ ] Review every feature, flow, screen, endpoint and setting for missing,
      half-built or buggy behaviour, plus a dedicated security pass (auth,
      sessions, tokens, rate limits, input validation, WebSocket origin and
      abuse, payments and refunds, admin routes, secrets, dependencies).
- [ ] Fix everything found, then review again until a pass comes back clean.

## 5. Final check and release

- [ ] Every root and package script runs (`dev`, `build`, `test`, `lint`,
      `format`, `setup:env` including `--production`, `admin`, migrations).
- [ ] Client and server builds, Docker images, compose and Caddy routing,
      migrations, health and readiness, graceful drain and backups all work.
- [ ] README, `docs/SELF_HOSTING.md` and `.env.example` match reality.
- [ ] Full browser e2e suite passes, then push.
