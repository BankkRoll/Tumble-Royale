# Tumble Royale — Architecture & Team Contract

Read this before writing code. It defines package boundaries, ownership, and the
shared contracts that let several people (and agents) build in parallel.

## Packages

| Package | Runs on | Purpose |
|---|---|---|
| `@tumble/shared` | everywhere | constants, math, seeded `Rng`, collision groups, `RoundPhase`/`ShowPhase`, themes |
| `@tumble/sim` | server + client | Rapier world, character controller, obstacle runtimes, round rules, match sim, bots. **Headless** — no DOM, no three, no `Date.now`, no `Math.random` (lint-enforced) |
| `@tumble/content` | everywhere | data: round definitions, show playlists, cosmetics, themes, tuning — all zod-validated |
| `@tumble/netcode` | server + client | bit packer, input/snapshot codecs, delta compression, clock sync, jitter buffers |
| `@tumble/render` | client | three.js WebGPU renderer, TSL toon materials, obstacle visuals, level builder, Tumbler character mesh + procedural animation, VFX, camera helpers |
| `@tumble/audio` | client | Web Audio engine, procedural SFX, adaptive music, announcer |
| `@tumble/ui` | client | React 19 + Zustand + Tailwind overlay: every screen, HUD, transitions |
| `apps/client` | browser | composition root: boots renderer + sim + net + UI, game loop |
| `apps/game-server` | Node 22 | authoritative rooms, show flow, bots |
| `apps/api` | Node 22 | accounts, inventory, store, ranking (Fastify + Drizzle) |

Dependency direction (no cycles): `shared ← sim ← content ← render/audio/netcode ← ui ← client`. Full spec: `docs/SPEC.md`. Game design: `docs/design/`.
`netcode` may import `sim` types; `ui` must NOT import three or sim runtime (types only).

## Sub-path imports

Every package exports `"./*": "./src/*/index.ts"`, so a folder with an
`index.ts` is importable directly: `@tumble/sim/character`,
`@tumble/render/obstacles`, `@tumble/ui/screens`. **Do not edit another team's
`index.ts`.** Add your own folder with its own `index.ts` instead.

## Core contracts (already written — code against these)

- `packages/sim/src/character/types.ts` — `CharacterInput`, `Button`, `CharacterState`, `CharacterFullState`, `CharacterFlag`, `TumblerControllerLike`, `CharacterStepContext`, `CreateTumblerController`.
- `packages/render/src/obstacles/types.ts` — `ObstacleVisual`, `ObstacleVisualFactory`, `ObstacleVisualSet`.
- `packages/sim/src/obstacles/types.ts` — `ObstacleType`, `ObstacleInstance`, `ObstacleModule`, `ObstacleRuntime`, `ObstacleActor`, build/step contexts.
- `packages/sim/src/physics/surfaces.ts` — `SurfaceRegistry`, `SurfaceInfo` (ice, conveyor, bouncy, grabbable, lethal…).
- `packages/sim/src/events.ts` — `SimEvent` union + `EventSink`. All gameplay feedback (VFX, SFX, UI toasts, netcode events) flows through these.
- `packages/shared/src/schema/round.ts` — `RoundDefinitionSchema` + `defineRound`: geometry pieces, obstacles, triggers, spawns, flyover, bot waypoints, variations. (Lives in shared so sim can read rounds; `@tumble/content` re-exports it.)
- `packages/sim/src/match/types.ts` — `MatchSim`, `MatchSimOptions`, `RoundStatus`, `PlayerRoundStatus`: one round running in a Rapier world; driven identically by server (authority), client (predict) and offline/dev.
- `packages/render/src/character/types.ts` — `TumblerVisual`, `TumblerLoadout`, `TumblerAnimInput`, `CreateTumblerVisual`: every on-screen Tumbler (game, lobby, locker, player wall, podium) goes through this.
- `packages/shared/src/game.ts` — `RoundType`, `RoundPhase`, `ShowPhase`, `ThemeId`, `TEAM_COLORS`.
- `packages/shared/src/collision.ts` — `CollisionGroup`, `InteractionGroups` presets.

If a contract is missing something you need, **extend it additively** (new optional
fields, new union members) and say so in your final report. Never rename or
remove existing fields.

## Simulation rules

- Fixed step `SIM_DT = 1/60`. Server network tick 30 Hz = 2 sim steps per tick.
- Moving obstacles are kinematic bodies whose pose is a **pure function of match
  time** (`pose(t, params, out, speedScale)`). Server and every client compute the
  same pose with zero bandwidth.
- Non-pure obstacles (falling tiles, tilt platforms, breakable doors, props)
  replicate via `getNetState/setNetState`.
- Randomness: `new Rng(seed)` from `@tumble/shared`. Show seed ⊕ `hashString(roundId)` ⊕ `hashString(instanceId)`.
- Character controller state must be fully restorable (`CharacterFullState`) for rewind/replay.
- No per-step allocations in hot paths: reuse scratch vectors/quaternions.

## Rendering rules

- Import from `three/webgpu` and `three/tsl` (Vite aliases bare `three` to the WebGPU build).
- Materials: `createToonMaterial`, `createOutlineMaterial` from `@tumble/render`. Node materials only, so both backends match.
- Repeated things (tiles, pile props, crowd, confetti) → `InstancedMesh`/`BatchedMesh`. Budget < 250 draw calls.
- Everything you create, you `dispose()`.
- Art direction: candy toy world in a bright sky. Danger = magenta/orange, safe = cyan/mint, interactable = yellow. Chunky rounded shapes, rim light, soft shadows.

## Client dev pages

`apps/client/*.html` are all Vite entries. Each team owns its sandbox page:

| Page | Owner | Purpose |
|---|---|---|
| `index.html` | integration | the real game |
| `playground.html` | character | Tumbler controller + camera + obstacle test course |
| `obstacles.html` | obstacles | gallery of every obstacle animating |
| `ui.html` | ui | every screen previewable via `?screen=` with mock data |
| `tumbler.html` | art | character model, animation states, customization, VFX, audio board |
| `level.html` | levels | load any round by `?round=<id>` and fly/play it |

## IP rule

100% original. Never use "Fall Guys", "bean", "Mediatonic", "Epic", or any of
their round, obstacle, cosmetic or character names. Our characters are
**Tumblers**. The currencies are **Gumballs** and **Gems**. The prize is **the Crown**.

## Code style

- TypeScript strict; no `any` without a `// why` comment.
- JSDoc on every export. Comments explain *why*, never narrate *what*.
- Tests: vitest next to each package in `test/`. Every obstacle and round gets a
  determinism / collider sanity test.
- Run `pnpm --filter <your-package> typecheck` and `test` before reporting.
  Only fix errors in files you own; report others.
- **Do not run `pnpm install` / `pnpm add`.** Dependencies are pre-installed. If
  you truly need a new one, say so in your report.
- Do not commit; the integrator commits.
