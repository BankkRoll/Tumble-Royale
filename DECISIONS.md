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

## Lag compensation as a server hit assist, not a rewind inside the sim

The spec promises ≤ 150 ms rewind for grab and dive hits. Rewinding Rapier
bodies inside `MatchSim.step` would make every step depend on per-client RTTs,
break the prediction contract (client and server stepping the same function)
and cost a world snapshot/restore per check. Instead the room records one pose
per network tick (`LagCompensator`) and, after each authoritative step, checks
each human's fresh grab press or ongoing dive against the other players'
poses rewound to that client's view time (RTT/2 + 100 ms render delay, capped
at 150 ms). When the client's view connected and the target is still within a
small present-day distance, the room calls `assistGrab` / `assistTackle` on
the sim, which run the controller's own grab/tackle path with every normal
eligibility rule. The assist can only add a hit the client saw, never move a
body back in time, so the sim stays a deterministic function of its inputs
plus these explicit, counted commands (`tumble_lagcomp_assists_total`).
Replays that re-simulate from inputs alone must record assists as events.

## The pre-show platform is a live lobby sim

Online, the waiting platform runs as a rule-less match sim (`lobby: true`)
on `PRE_SHOW_LOBBY_ROUND`, streamed through the same snapshot, prediction and
reliable-event pipeline as rounds (at half the snapshot rate). Using the real
Tumbler controller keeps grabs, dives, bumps and emotes identical to rounds;
`addPlayer`/`removePlayer` let people drop in and leave without rebuilding the
world (a rebuild would pop every Tumbler back to a spawn grid). A dropped
connection keeps its Tumbler idling until the resume window ends, so resumes
never flash a despawn. Offline shows keep the local pre-show.

## Self-hosting is one Compose stack on one origin

`deploy/docker-compose.yml` puts every service behind a single Caddy edge on
one domain (`/api`, `/mm`, `/gs/ws`) instead of a hostname per service. One
origin means one certificate, no cross-origin requests between the client and
its services, and one client build that works for any domain (it defaults to
same-origin paths and reads `/config.json`). Caddy was picked for automatic
HTTPS with no extra container or cron job. Game servers are the exception:
players connect to each one directly, so every extra game server gets its own
hostname (`deploy/game-server/`) rather than a path on the main edge, which
would route every show through one host. There is deliberately no monitoring
stack in the bundle: `/health`, `/ready` and token-protected `/metrics` are
there for whatever the operator already runs.
