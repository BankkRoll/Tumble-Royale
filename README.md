# Tumble Royale

A browser-native, physics-driven party royale. Up to 40 Tumblers (humans and
bots) compete through a show of 3–5 randomly drawn rounds (races, survivals,
team games, a logic round and a final) until one player takes the Crown.
No install, no plugins: it runs in a browser tab on desktop and mobile.

- **Rendering:** three.js `WebGPURenderer` with automatic WebGL2 fallback and TSL node materials
- **Physics:** Rapier (WASM), the same pinned build on client and server
- **Multiplayer:** server-authoritative 30 Hz rooms, binary delta snapshots, client prediction
- **UI:** React 19 + Zustand overlay on top of the canvas
- **Content:** 20 rounds, 36 obstacle types, 108 cosmetics, 10 themes, all procedural (zero external art assets)

All characters, rounds, obstacles and cosmetics are original IP.

## Quick start

Requirements: Node 22+, pnpm 10 (`corepack enable`), a recent Chrome or Edge.

```sh
pnpm install
pnpm --filter @tumble/client dev        # http://localhost:5173
```

That is enough to play: the client runs full shows offline against 39 bots.
To play online against a local authoritative server, also start the game
server and add `?online=1`:

```sh
pnpm --filter @tumble/game-server dev   # ws://localhost:7350/ws
# open http://localhost:5173/?online=1
```

`pnpm dev` starts every app with a `dev` script in parallel: client, game
server, API and matchmaker.

### Services

| Service     | Package            | Port | Needed for                                                                                            |
| ----------- | ------------------ | ---- | ----------------------------------------------------------------------------------------------------- |
| Game client | `apps/client`      | 5173 | everything                                                                                            |
| Game server | `apps/game-server` | 7350 | online play (`?online=1`)                                                                             |
| Account API | `apps/api`         | 7360 | accounts, inventory, store, pass, ranked, social (optional; the client falls back to a local profile) |
| Matchmaker  | `apps/matchmaker`  | 7370 | queues, parties, custom lobbies                                                                       |

The API uses an embedded Postgres (PGlite) and in-memory Redis when
`DATABASE_URL` / `REDIS_URL` are unset, and a fake payment provider without
Stripe keys, so the whole stack runs locally with no external services. See
each app's README for its environment variables.

### Client URL options

| Param                                       | Effect                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `?online=1`                                 | Play against the game server instead of offline bots              |
| `?autoplay=1`                               | A bot drives your Tumbler and menus auto-advance (demos, e2e)     |
| `?ts=N`                                     | Time scale (max 16)                                               |
| `?backend=webgpu\|webgl`                    | Force a GPU backend                                               |
| `?tier=low\|medium\|high\|ultra`            | Skip the GPU benchmark and force a quality tier                   |
| `?debug=1`                                  | Debug panel (skip round, force qualify, teleport) + stats overlay |
| `?playlist=<id>` / `?players=N` / `?seed=N` | Offline show overrides                                            |
| `?fresh=1`                                  | Ignore the saved profile (replays the first-launch flow)          |
| `?api=0` / `?apiUrl=<url>`                  | Disable or redirect the account API                               |
| `?scene=test`                               | Phase 0 renderer/physics test scene                               |

### Dev sandboxes

Every `apps/client/*.html` is its own Vite entry:

| Page                     | What it shows                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `/playground.html`       | Tumbler controller test course with live tuning                                        |
| `/tumbler.html`          | Character showroom: animation states, emotes, cosmetics, ragdoll, 40-crowd stress test |
| `/obstacles.html`        | Every obstacle animating, with live param editing                                      |
| `/level.html?round=<id>` | Any round with bots racing it; flyover and follow cameras                              |
| `/world.html`            | Themes, weather, VFX, post-processing, and the menu, wall and podium scenes            |
| `/ui.html?screen=<id>`   | Every UI screen with mock data, plus an auto-played show                               |
| `/audio.html`            | Sound board: SFX, adaptive music, stingers, spatial demo                               |

## Repository layout

```
apps/
  client/        Vite app: composition root, game loop, input, net, dev sandboxes
  game-server/   Authoritative rooms (Rapier in Node), show flow, bots, metrics
  api/           Fastify + Drizzle: accounts, economy, pass, ranked, social
  matchmaker/    Queues, parties, custom lobbies, server registry, join tickets
packages/
  shared/        Constants, math, seeded RNG, collision groups, round schema
  sim/           Headless simulation shared by server and client prediction
  content/       Data: rounds, playlists, cosmetics, themes, tuning, progression
  netcode/       Bit packing, snapshots, reliable channel, clock sync
  render/        Renderer, TSL materials, character, obstacles, levels, VFX, scenes
  audio/         Web Audio engine, procedural SFX, adaptive music, announcer
  ui/            React overlay: every screen, HUD and transition
tools/
  bot-swarm/     Headless WebSocket load tester
docs/
  SPEC.md        Product brief
  ARCHITECTURE.md  Package boundaries, contracts and team rules
  design/        Levels, screens, shows, art direction, audio direction
```

Dependencies flow one way: `shared ← sim ← content ← render / audio / netcode ← ui ← client`.
The `sim` package is the heart of the game: the server runs it
authoritatively and the client runs the same code to predict the local
player. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing a
package boundary or a shared contract, and [DECISIONS.md](DECISIONS.md) for
the reasoning behind non-obvious choices.

## Working on the code

```sh
pnpm typecheck                    # every package
pnpm test                         # every package's vitest suite
pnpm lint                         # eslint (also enforces sim determinism rules)
pnpm format:check
pnpm --filter @tumble/sim test    # one package
```

Browser tests use Playwright with the locally installed Edge (`PW_CHANNEL`
overrides the channel) and start the client and game server themselves:

```sh
cd apps/client
npx playwright test e2e/phase0.spec.ts                    # renderer parity + physics determinism
npx playwright test e2e/game.spec.ts                      # a full 40-player show, splash to rewards
ROUNDS=gumdrop-gauntlet,tile-panic npx playwright test e2e/level.spec.ts  # per-round smoke + screenshots
```

For long e2e runs while files are changing, point the specs at a private
`vite preview` build with `GAME_URL=http://localhost:<port>` so hot reloads
don't restart the page.

Rules that keep the simulation deterministic (lint-enforced in `sim`,
`shared`, `netcode` and `content`): no DOM, no three.js, no `Date.now()`, no
`Math.random()`. Use the seeded `Rng` from `@tumble/shared` and match time.
Moving obstacles are pure functions of match time, so every machine computes
the same pose with zero bandwidth.

### Adding content

- **A round:** add `packages/content/src/rounds/<id>/index.ts` exporting
  `defineRound({...})`, register it in one of the `group-*.ts` lists, and
  preview it at `/level.html?round=<id>`. Obstacle params are validated
  against each module's zod schema; misspelt keys are stripped silently, so
  copy the round tests' "no stripped keys" check.
- **An obstacle:** add a sim module in `packages/sim/src/obstacles/` (schema,
  pure `pose(t)`, `create()`), a visual in `packages/render/src/obstacles/`,
  and register both in the set files. It appears in `/obstacles.html`
  automatically.
- **A cosmetic:** add it to `packages/content/src/cosmetics/catalog.ts`; the
  procedural mesh or pattern id it references lives in
  `packages/render/src/character/`.

## Status

| Phase | Scope                       | State                                                                                |
| ----- | --------------------------- | ------------------------------------------------------------------------------------ |
| 0     | Foundations                 | Done: both GPU backends verified, client/server Rapier bit-identical after 600 steps |
| 1     | The Tumbler                 | Built and tested; needs a human playtest for feel                                    |
| 2     | Netcode slice               | Done: ~3 ms ticks at 40 players, no steady-state corrections at 150 ms + 2% loss     |
| 3     | First show                  | Done: full 40-player shows play end to end in the browser                            |
| 4     | Meta & accounts             | Backend done; client wiring in progress                                              |
| 5     | Content MVP                 | 20 rounds built; tutorial island in progress                                         |
| 6     | Ranked, store, pass, social | Backend done (40-player ranked update unit-tested); client wiring in progress        |
| 7     | Launch hardening            | Not started: soak and 2,000-client load tests, observability, deploy                 |

Production still needs Discord/Google OAuth credentials, Stripe keys and
hosting. Everything else runs locally on the fallbacks described above.
