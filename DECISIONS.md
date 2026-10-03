# Decisions

Short log of design choices made under uncertainty. Newest last.

## TypeScript 5.9, not 7

The spec asks for TS 5.x. TS 7 (native port) is out, but typescript-eslint
supports `<6.1`. Revisit when the lint toolchain catches up.

## Source-only internal packages

Workspace packages export `src/*.ts` directly. Vite and `tsx` compile on the
fly, so there is no per-package build step and no stale `dist/` during dev.

## Bare `three` aliased to `three/webgpu`

Addons import `'three'`. Aliasing it to the WebGPU build keeps a single copy of
the core in the bundle, as three's own WebGPU examples do with import maps.

## TSL post-processing instead of pmndrs `postprocessing`

`postprocessing` targets `WebGLRenderer` only. Three's TSL post nodes run on
both WebGPU and the WebGL2 fallback, which the spec requires to look identical.

## `ws` first, uWebSockets.js behind a transport interface

uWS ships as a GitHub-hosted native binary, which complicates Windows dev and
CI. The server talks to a `Transport` interface; `ws` implements it now, and a
uWS adapter can drop in once the tick budget shows the socket layer matters.

## Determinism check compares f32 bit patterns

Rapier stores state as f32. Hashing float32 bits gives an exact equality check
that is immune to f64 formatting, with a separate max-error figure for the
spec's "within tolerance" criterion.

## Canvas-atlas text instead of troika-three-text

troika builds classic GLSL materials and imports `ShaderChunk`/`ShaderLib`
from `three`, which the WebGPU build (and our `three` alias) does not export.
Nameplates and signs draw into canvas atlases rendered by TSL materials, so
they work on both backends.

## Feet positions for spawns and teleports

Controllers take feet positions; the body sits at the capsule centre. Round
data authors floor points, so spawn/respawn only add a few centimetres of
clearance (`SPAWN_LIFT`).

## Bloom only above rim light; no screen-space edge outline

The toon material's rim light is written to the emissive target that feeds
selective bloom, so with a low threshold every silhouette glowed and the
image looked hazy. Themes now bloom above 0.75, which is brighter than any
rim, so only real emissives (telegraphs, lights, VFX) glow. The screen-space
edge outline is off in every preset: it traced blob-shadow decals as squares
under each Tumbler and fringed edges, while characters already carry an
inverted-hull outline.
