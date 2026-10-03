# @tumble/client

The browser game: the composition root that boots the renderer, simulation,
networking, audio and UI and runs the game loop. The loop is plain
TypeScript; React only renders the DOM overlay.

```sh
pnpm --filter @tumble/client dev     # http://localhost:5173
pnpm --filter @tumble/client build
```

URL options and the dev sandbox pages are listed in the root README.

## Layout

| Path                                                                                              | Contents                                                                                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                                                                                     | Entry: boots `GameApp`, or the Phase 0 test scene at `?scene=test`                                                    |
| `src/game/app.ts`                                                                                 | App state machine: boot, splash, welcome, menu, shows, UI intents, settings, frame loop                               |
| `src/game/show/`                                                                                  | Show choreography shared by the offline runner (`createOfflineShow` vs bots) and the online runner (`NetGameSession`) |
| `src/game/round/`                                                                                 | Per-round rendering: level, environment, obstacles, Tumblers, camera, HUD mapping                                     |
| `src/game/views/`                                                                                 | 3D scene director: menu stage, pre-show, results, podium, player wall                                                 |
| `src/game/` (rest)                                                                                | Profile and persistence, cosmetics mapping, quality tier, audio bridge, account API client, autoplay, debug panel     |
| `src/net/`                                                                                        | `NetClient`, `PredictionController` (rewind and replay), `RemoteEntities` (interpolation)                             |
| `src/input/`                                                                                      | Keyboard, mouse (pointer lock), gamepad and touch input, latched per fixed step                                       |
| `src/*-lab/`, `src/playground/`, `src/level-viewer/`, `src/ui-preview/`, `src/obstacles-gallery/` | Dev sandboxes behind the extra `*.html` entries                                                                       |

## Deploying

The game handles a few paths itself, so the static host must answer them
with `index.html`:

| Path                                         | Purpose                            |
| -------------------------------------------- | ---------------------------------- |
| `/join/<code>`                               | Party invite links                 |
| `/auth/complete?code=…` / `?error=…`         | Return from Discord/Google sign-in |
| `/auth/email?token=…`                        | Email magic links                  |
| `/store?checkout=success\|cancel&purchase=…` | Return from Stripe Checkout        |

`public/_redirects` covers Netlify and Cloudflare Pages and `vercel.json`
covers Vercel (with `apps/client` as the project root). Elsewhere, add an
equivalent SPA fallback. `vite dev` and `vite preview` already fall back to
`index.html` (Vite's default `appType: 'spa'`).

## Testing

```sh
pnpm --filter @tumble/client test         # unit tests
npx playwright test e2e/phase0.spec.ts    # renderer parity + determinism
npx playwright test e2e/game.spec.ts      # full 40-player show, splash to rewards
npx playwright test e2e/online.spec.ts    # online show against a local game server
ROUNDS=<id,…> npx playwright test e2e/level.spec.ts
```

Playwright uses the installed Edge and starts the client and game server
itself. Set `GAME_URL` to test against a private `vite preview` of a
sandbox build (`pnpm build:sandbox`) instead of the shared dev server; the
specs use dev URL options, which production builds ignore.
