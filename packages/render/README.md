# @tumble/render

Client-side rendering on three.js `WebGPURenderer` with an automatic WebGL2
fallback. All materials are TSL node materials, so both backends look the
same. Import from `three/webgpu` and `three/tsl`; the client's Vite config
aliases bare `three` to the WebGPU build.

## Modules

| Import                       | Contents                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tumble/render`             | `createRenderer` (backend detection), `createToonMaterial`, `createOutlineMaterial`, `createSkyDome`                                                                                                                  |
| `@tumble/render/character`   | `createTumblerVisual`: procedural Tumbler (lathe body, 17-bone rig, TSL face with 16 expressions, 16 body patterns, accessories), procedural animation, spring squash and stretch, `RagdollManager`, `NameplateLayer` |
| `@tumble/render/obstacles`   | Visual factory for every obstacle type (`getObstacleVisual`). Visuals reuse each sim module's `pose(t)`, so they match physics exactly.                                                                               |
| `@tumble/render/level`       | `buildLevelVisuals(round, theme)`: themed toy meshes for every static piece, surface materials, patterns, void below                                                                                                  |
| `@tumble/render/environment` | `createEnvironment(theme)`: sky, clouds, floating islands, balloons, crowd, lighting rig and shadows, weather                                                                                                         |
| `@tumble/render/vfx`         | GPU-instanced particle effects, blob shadows, trails, `handleSimEvent`                                                                                                                                                |
| `@tumble/render/post`        | Tiered TSL post stack: AA, selective bloom, colour grade, vignette, hit punch, edge outline                                                                                                                           |
| `@tumble/render/quality`     | Quality presets, silent GPU benchmark, adaptive resolution                                                                                                                                                            |
| `@tumble/render/camera`      | `ThirdPersonCamera`: spring arm, collision, look-ahead, shake, flyover, spectate and orbit modes                                                                                                                      |
| `@tumble/render/scenes`      | Main menu stage, pre-show arena, player wall, victory podium, results backdrop                                                                                                                                        |

Scenes take a `CreateTumblerVisual` factory so they can run with the
placeholder Tumbler in isolation. Text uses canvas atlases rather than
troika-three-text, which doesn't run on WebGPU (see `DECISIONS.md`).

## Testing

```sh
pnpm --filter @tumble/render test
```

Visual checks happen in the client's sandbox pages (`/tumbler.html`,
`/obstacles.html`, `/world.html`, `/level.html`) and Playwright screenshots.
