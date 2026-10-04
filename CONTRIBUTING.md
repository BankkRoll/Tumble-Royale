# Contributing

Thanks for your interest in Tumble Royale.

## Maintenance status

This project is published as-is and is **not actively maintained**. Issues
and pull requests are welcome, but responses may be slow or may not come at
all. If you want to take the game somewhere new, forking is encouraged; the
MIT license allows it.

## Before opening a pull request

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package boundaries
  and the shared contracts, and [DECISIONS.md](DECISIONS.md) for the
  reasoning behind non-obvious choices.
- Keep the simulation deterministic. `packages/sim`, `shared`, `netcode` and
  `content` must not use the DOM, three.js, `Date.now()` or `Math.random()`;
  lint enforces this.
- Run the checks CI runs on every pull request and push to main
  (`.github/workflows/ci.yml`, job `check`, Node 22):

  ```sh
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm format:check
  pnpm typecheck
  pnpm test
  pnpm build
  ```

- Pushes to main also run the `e2e` job: Playwright's bundled Chromium
  against a sandbox build served by `vite preview` (the config starts the
  game server too), WebGL2 only since the runner has no WebGPU. To run the
  same thing locally:

  ```sh
  cd apps/client
  npx playwright install chromium            # once
  pnpm build:sandbox
  PW_CHANNEL=chromium PW_PREVIEW=1 npx playwright test e2e/menu.spec.ts e2e/phase0.spec.ts --workers=1
  ```

  Without the two variables Playwright uses your installed Edge and the Vite
  dev server instead. The `meta`, `online` and `game` specs and the
  100-player tick budget run nightly (`.github/workflows/nightly.yml`); the
  rest (`level`, `media`, …) run only by hand.

- The `services` job reruns the API and matchmaker suites on Postgres 16 and
  Redis 7, which also enables the Redis integration tests. Point them at any
  local servers the same way (each test creates and drops its own database):

  ```sh
  DATABASE_URL=postgres://user:pass@localhost:5432/postgres REDIS_URL=redis://localhost:6379 \
    pnpm --filter @tumble/api test
  ```

- The `compose` job builds the Docker images and boots
  `deploy/docker-compose.yml` over plain HTTP; changes under `deploy/` should
  keep it green.

- For gameplay or rendering changes, include a screenshot or short clip. The
  sandbox pages (`/playground.html`, `/level.html`, `/obstacles.html`, …) are
  the quickest way to show a change in isolation.
- Keep pull requests focused: one fix or feature per PR.

## Content

All characters, rounds, obstacles, cosmetics, music and sound effects must
be original. Don't submit names, art, audio or designs taken from existing
games.

## Reporting bugs

Open an issue with steps to reproduce, the browser and GPU backend (shown in
the `?debug=1` stats overlay), and any console errors. For security issues,
see [SECURITY.md](SECURITY.md) instead.
