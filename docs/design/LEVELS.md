# Tumble Royale — Launch Rounds (LEVELS.md)

> Owner: Lead Game Design. Consumers: level-builder engineers (transcribe into
> `packages/content/src/rounds/<id>/`), obstacle engineers (param names below),
> bot engineers (waypoint graphs), art/audio (theme + music ids).
>
> Everything here maps onto `RoundDefinitionSchema` in
> `packages/shared/src/schema/round.ts` and `ObstacleType` in
> `packages/sim/src/obstacles/types.ts`. Where a design wants something the schema
> does not have yet, it is called out in a **Schema wish** box and given a
> fallback that works with today's schema.

## Contents

0. [Movement envelope](#0-movement-envelope)
1. [Authoring conventions](#1-authoring-conventions)
2. [Obstacle param dictionary](#2-obstacle-param-dictionary)
3. [Round template & quality bar](#3-round-template--quality-bar)
4. Races — R1 Gumdrop Gauntlet · R2 Conveyor Chaos · R3 Tilt Town · R4 Slip 'n' Spiral · R5 Hammer Highway · R6 Wind Tunnel Peaks · R7 Cannonball Canyon
5. Survivals — S1 Spin Cycle · S2 Tile Panic · S3 Rising Goo Tower · S4 Jump Rope Royale
6. Team — T1 Egg Heist · T2 Bounce Ball Blitz · T3 Paint the Plaza
7. Hunt — H1 Tail Chase
8. Logic — L1 Pattern Panic
9. Finals — F1 Crown Climb · F2 Last Tumbler Standing · F3 Spin Cycle Finale · F4 Goo Peak Final
10. [Cross-round summary tables](#10-cross-round-summary)
11. [Schema wish list](#11-schema-wish-list)
12. [Post-launch rounds](#12-post-launch-rounds) — H2 Comet Catch · H3 Sunbeam Squabble · L2 Colour Cauldron · L3 Trail Tracer · F5 Throne Rush

---

## 0. Movement envelope

Every layout in this document is built to these numbers. The character
controller is being tuned to hit them; if tuning drifts, the **design numbers
(right column) must still hold** — re-tune the controller, not the levels.

| Quantity                                          | Controller target           | Design rule                                                                                                      |
| ------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Run speed (ground, max)                           | 9.0 m/s                     | Pace estimates use 9 m/s on clear ground, 5–6 m/s average through obstacle sections                              |
| Jump apex (from flat, full hold)                  | ≈ 2.0 m                     | Never require more than 1.8 m of rise from a jump                                                                |
| Running jump distance (flat → flat, edge to edge) | ≈ 4.5 m                     | Design gaps **≤ 3.5 m** without dive                                                                             |
| Jump + dive extra distance                        | +≈ 2.5 m (max ≈ 6.5 m)      | Design gaps **≤ 5.5 m** when a dive is intended; never on the only route                                         |
| Standing step-up (walk over, no jump)             | 0.35 m                      | Treads/curbs ≤ 0.3 m are "free"; 0.4–1.8 m needs a jump                                                          |
| Jumpable ledge (land on top)                      | ≤ 1.8 m                     | Use 1.2–1.5 m for "normal" jump-ups, 1.8 m as the hard maximum                                                   |
| Grab-climbable ledge (hang + climb)               | ≤ 2.6 m                     | Use 2.2–2.4 m for intended climbs; mark lip `grabbable: true` + yellow lip trim                                  |
| Capsule                                           | radius 0.45 m, height 1.8 m | Min passage width 1.2 m (single file), 1.8 m to pass another Tumbler; min overhead clearance 2.2 m               |
| Walkway width                                     | —                           | **≥ 3 m** standard; narrow beams **≥ 1.2 m** only as deliberate challenges, never > 30 m long without a rest pad |
| Dive from standstill                              | ≈ 2.0 m slide               | Used for low-beam "duck" moments (beam bottom ≥ 0.7 m above floor ⇒ dive passes under)                           |

**Height-adjusted gap rule** (edge to edge, running start, no dive):

- Landing **higher** by Δh (0 < Δh ≤ 1.5 m): max gap ≈ 4.5 − 1.0·Δh. Design ≤ 3.5 − 1.0·Δh.
- Landing **lower** by Δh: max gap ≈ 4.5 + 0.8·Δh (cap 7 m). Design ≤ 3.5 + 0.6·Δh.
- Moving / rotating landing: subtract 0.5 m from the design limit.
- Ice / slime take-off: subtract 0.5 m (reduced traction ⇒ worse take-off).

**Survival-relevant timings** (for obstacle tuning):

- Single jump airtime ≈ 0.75 s; a ground beam ≤ 0.6 m tall at ≤ 2.6 rad/s × 9 m radius tip speed (~23 m/s) is the hardest jump-rope we ship.
- Dive recovery (GetUp) 0.45 s; stun 0.8–1.6 s. Do not chain two mandatory hazards closer than 1.2 s of travel (≈ 7 m at run speed) without a safe pocket.

---

## 1. Authoring conventions

### 1.1 Axes, units, origin

- Metres, seconds, radians for obstacle angular rates (rad/s), **degrees for every
  rotation field** (schema). Y up. Race travel is **+Z**. Spawn grid centred near
  `z = 0`.
- Ground level of the start plaza is **top surface y = 0**. Floors are 1 m thick
  boxes, so a floor whose top is `y = T` has `position.y = T − 0.5`.
- Yaw: rotation about +Y; `yaw = 90` turns local +Z to world +X (three.js
  right-handed). Spawn `yaw = 0` faces +Z.
- Pitch is avoided for walkable surfaces (use `ramp`). Where used, **pitch +θ
  raises the local +Z end**; engineers negate if their convention differs. Roll
  is only used as `roll: 90` to lay a cylinder/hexPrism axis along world X, and
  `pitch: 90` to lay it along Z (sign irrelevant for symmetric shapes).

### 1.2 Shape semantics (what `size` means)

| Shape      | `position`                              | `size`                                         | Notes                                                                                                                                   |
| ---------- | --------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `box`      | centre                                  | full extents x, y, z                           | bevel 0.15 default; 0.3 for big chunky platforms                                                                                        |
| `ramp`     | centre of bounding box                  | x = width, y = rise, z = run                   | Triangular prism, top plane rises toward **local +Z**. Descend toward +Z ⇒ `yaw: 180`. Slope ≤ 30° walkable, 30–40° slide surfaces only |
| `wedge`    | centre of bounding box                  | x = base width, y = height, z = length         | Roof/prow: ridge runs along local Z at top centre, faces fall toward ±X. Lane dividers, ball deflectors                                 |
| `cylinder` | centre                                  | x = radius, y = height                         | Upright by default                                                                                                                      |
| `hexPrism` | centre                                  | x = circumradius (centre → corner), y = height | Flat-top hex tiles: corner at local +X                                                                                                  |
| `sphere`   | centre                                  | x = radius                                     | Decorative candy, bumper heads                                                                                                          |
| `torus`    | centre                                  | x = major radius, y = tube radius              | Lies flat (axis Y). Hoops/rings; `pitch: 90` stands it up facing Z                                                                      |
| `arch`     | centre of footprint at floor (y = base) | x = outer width, y = outer height, z = depth   | Leg thickness = 0.15·x, lintel thickness = 0.15·y. Gates, decorative frames                                                             |

### 1.3 Table formats used below

**Geometry tables** — one row per `StaticPiece`:

`# | shape | pos x, y, z | size x, y, z | rot y/p/r | surface | colour | grab | pattern | note`

- `rot` shown as `yaw/pitch/roll`, `—` means all zero.
- `colour` is a palette key (`primary`, `secondary`, `accent`, `danger`, `safe`,
  `neutral`) or hex. Theme palettes live in `ART_DIRECTION.md`.
- `grab` ✓ = `grabbable: true`. `deco` in the note column = `decorative: true`.
- `×N` rows: mirrored or repeated pieces; the note says how (e.g. "mirror x" ⇒ also
  place at −x).

**Obstacle tables** — one row per `ObstacleInstance`:

`id | type | pos x, y, z | rot | params`

Param names follow the dictionary in §2. Unlisted params take the dictionary default.

**Triggers** — `id | kind | pos | size | index | respawn points | respawnYaw`.

**Bot nav** — `id | pos | r | next | action | timeAgainst | note`. Actions are
the schema enum. `waitForGap` means "hold at this waypoint until
`pose(t)` of `timeAgainst` says the lane is clear for the next segment".

### 1.4 Colour semantics in level data

- `danger` (magenta/orange) — anything that knocks, eliminates, or moves into you.
  Hazard stripes (`pattern: hazard`) on every edge that drops into void within
  1 m of a hazard.
- `safe` (cyan/mint) — checkpoint pads, rest pads, finish area, start plaza.
- `accent` (yellow family) — interactables: grab lips, bounce pads, props, buttons.
- `primary`/`secondary` — main walkable surfaces, alternating by section so a
  player always sees where one section ends.
- `neutral` — walls, rails, supports, decor bases.
- `pattern: chevron` points along travel on conveyors and boost strips;
  `checker` on finish/checkpoint pads; `dots` on bouncy; `stripes` on moving or
  collapsing pieces.

### 1.5 Standard pieces (reuse everywhere)

| Piece                 | Spec                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start plaza**       | Floor 26 × 1 × 20, top y 0, `safe` + `checker` front strip; rails 0.5 × 1 × 20 at x = ±13.25; `startGate` at z = +7                                                                                                                                                 |
| **Spawn grid (race)** | origin (0, 0.1, 0), yaw 0, cols 8, spacing 1.4 ⇒ 40 players = 5 rows, 9.8 × 5.6 m footprint                                                                                                                                                                         |
| **Checkpoint pad**    | Floor stripe 2 m deep in `safe`/`checker`, `checkpointGate` arch over it (visual), trigger 1 m above floor 4 m tall spanning the full width. 6 respawn points spread across the width, 1.5–2.5 m **past** the trigger (never back inside the hazard), y = top + 0.1 |
| **Finish arch**       | `finishLine` obstacle (arch + confetti emitters), trigger 2 m deep × 4 m tall × full width, centred 2 m above floor                                                                                                                                                 |
| **Rail**              | box 0.5 wide × 1.0 tall, `neutral`; stops accidental slide-offs at starts, never used to make hazards trivial                                                                                                                                                       |
| **Grab lip**          | 0.3 × 0.3 strip along a ledge edge, `accent`, `grabbable: true` (same piece as the ledge top if engine supports per-edge grab; otherwise separate strip)                                                                                                            |
| **Rest pad**          | ≥ 6 m deep, full width, no hazards, `safe` tint, after every hard section                                                                                                                                                                                           |

### 1.6 Kill planes and bounds

- `killY` sits **8–12 m below the lowest walkable surface** (lower in vertical
  rounds) so falls read as falls, with a 1.2 s fade-burst before respawn.
- `bounds` = playable AABB + 10 m margin in x/z, + 25 m above the highest surface
  (bounce arcs), down to `killY − 5`.

### 1.7 Ids

- Round ids are kebab-case (`gumdrop-gauntlet`). Obstacle ids are
  `<section>-<kind>-<n>` (e.g. `s2-door-1`). Trigger ids `cp-1`, `finish`, `void-main`,
  `goal-0`… Waypoint ids are integers, unique per round, grouped by hundreds per
  section (section 3 ⇒ 300–399) so routes are easy to read.

---

## 2. Obstacle param dictionary

These are the param names every round below uses. Obstacle engineers: please
match names; if a module already shipped different names, add an alias in the
module schema rather than renaming here. All speeds are **base speeds at
speedScale = 1**; the round's `speedScaleByStage` multiplies angular speeds,
linear speeds and divides periods unless noted. Phases are **fractions of one
cycle (0–1)** so they survive period changes.

### Obstacle origin convention (important)

**An obstacle's `position` is where it meets the walkable floor:**

- Platform-like modules (`spinningDisc`, `movingPlatform`, `conveyorBelt`,
  `tiltPlatform`, `seesaw` (pivot, level state), `fallingTiles`, `popupBlocks`
  (lowered state), `collapsingBridge`, `iceFloor`, `stickyGoo`, `bouncePad`,
  `slideRamp` (top of the high end), `teleporterPair`): `position` = **centre of the
  top walking surface**. Thickness extends downward.
- Hazards standing on a floor (`spinwheel`, `pendulumHammer`, `sweeperArm`,
  `jumpRopeBeam`, `bumperPillar`, `punchWall`, `cannon`, `laserSweep`,
  `doorGauntlet`, gates, `climbWall`): `position` = the **floor point at the base**
  (hub/pivot/beam heights are params measured up from there).
- `rollingDrum`: `position` = drum **axis centre** (top of drum = y + radius).
- `fanZone`: base centre of the wind volume. `risingSlime`: centre of its
  footprint at y = 0 of the round (heights in the schedule are world Y).
- `boulderLane`: `path` points are relative to `position`.

### Common params (any module may accept)

| Param            | Type        | Default  | Meaning                                                                                                                 |
| ---------------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `phase`          | 0–1         | 0        | Cycle offset                                                                                                            |
| `knockImpulse`   | m/s         | 10       | Velocity change applied on hit (direction = contact normal + 0.25 up)                                                   |
| `stun`           | bool        | true     | Whether a hit above threshold puts the Tumbler in Tumble                                                                |
| `telegraph`      | s           | 0.6      | Lead time of the pre-activation pulse (emissive + audio)                                                                |
| `scaleWithStage` | bool        | true     | Set false to ignore `speedScaleByStage`                                                                                 |
| `colorKey`       | palette key | `danger` | Hazard colour                                                                                                           |
| `activeFrom`     | s           | −∞       | Obstacle is inert (parked/hidden/harmless) before this match time; telegraphs for `telegraph` s before activating. Pure |
| `activeUntil`    | s           | +∞       | Inert after this time                                                                                                   |

### Per type

| Type               | Params (name: unit = default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Pose / behaviour                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spinwheel`        | `hubHeight: m = 7.5`, `bladeCount = 3`, `bladeLength: m = 7`, `bladeWidth: m = 1.2`, `bladeDepth: m = 1.0`, `angularSpeed: rad/s = 1.2` (+ = clockwise seen from spawn, i.e. looking +Z), `hubRadius: m = 1.2`                                                                                                                                                                                                                                                                                                                                          | Upright "windmill" facing the runner; axis = local Z. Blades sweep through the lane and knock sideways. Pure f(t)                                                                                                                                             |
| `pendulumHammer`   | `pivotHeight: m = 11`, `armLength: m = 9`, `headRadius: m = 1.3`, `headLength: m = 3.2`, `amplitudeDeg = 65`, `period: s = 3.0`, `swingAxis: 'z'                                                                                                                                                                                                                                                                                                                                                                                                        | 'x' = 'z'` (`'z'` ⇒ head travels along X, across the lane)                                                                                                                                                                                                    | θ(t) = A·sin(2π(t/period + phase)). Head is a cylinder with axis along the swing axis. Pure                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sweeperArm`       | `armLength: m = 9`, `armCount = 2`, `armHeight: m = 0.6` (bar centre above origin), `armRadius: m = 0.35`, `angularSpeed: rad/s = 1.0`, `angularAccel: rad/s² = 0`, `maxAngularSpeed: rad/s = 3`, `speedSchedule: [{t, speed}] = []` (piecewise-linear overrides accel), `reverseTimes: s[] = []`, `hubRadius: m = 1.0`, `hubHeight: m = 2.5`, `heightSchedule: [{t, height}] = []` (armHeight steps, each eased over 1.5 s with a telegraph flash; a height ≥ 4 m means "parked", harmless), `innerRadius: m = 0` (bar starts this far from the hub)   | Vertical axis. Angle = ∫ω dt computed analytically from the schedule (piecewise-linear ⇒ quadratic), so still pure f(t)                                                                                                                                       |
| `bumperPillar`     | `radius: m = 0.9`, `height: m = 2.4`, `bounceImpulse: m/s = 9`, `moveAxis: 'x'                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 'z' = 'x'`, `moveAmplitude: m = 0`, `movePeriod: s = 3`                                                                                                                                                                                                       | Static or sinusoidal slide. Bouncy surface                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `punchWall`        | `panelCount = 4`, `panelWidth: m = 3`, `panelHeight: m = 2.5`, `extend: m = 3.5`, `extendTime: s = 0.15`, `holdTime: s = 0.5`, `retractTime: s = 0.8`, `period: s = 3`, `pattern: 'wave'                                                                                                                                                                                                                                                                                                                                                                | 'alternate'                                                                                                                                                                                                                                                   | 'random'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 'all' = 'wave'`, `waveStep: s = 0.35`, `telegraph: s = 0.6`, `knockImpulse = 13`                                                                     | Wall at origin, panels punch toward local +X. `random` uses seeded Rng per cycle (still pure: cycle index → rng)                                                             |
| `doorGauntlet`     | `doorCount = 6`, `doorWidth: m = 4.0`, `doorHeight: m = 3.5`, `pillarWidth: m = 0.85`, `wallHeight: m = 5`, `thickness: m = 0.6`, `breakableCount = 3`, `burstSpeed: m/s = 2.5`, `solidKnock: m/s = 4`, `halfRule: bool = false` (≥ 1 breakable door in each x-half), `noRepeatRows: bool = true` (with other rows of the same round, avoid the same column pattern)                                                                                                                                                                                    | One row. Breakable doors burst (hinge-flap) on contact above `burstSpeed`; stay open. Replicated net state = bitmask                                                                                                                                          |
| `conveyorBelt`     | `length: m`, `width: m`, `speed: m/s = 4` (+ = local +Z), `reversePeriod: s = 0` (0 = never), `reverseTelegraph: s = 1.0`, `reverseRamp: s = 0.4`, `rails: bool = true`, `railHeight: m = 0.6`                                                                                                                                                                                                                                                                                                                                                          | Surface `conveyor`; belt velocity is f(t) (square wave with ramps) written into `SurfaceInfo.conveyorVelocity`                                                                                                                                                |
| `tiltPlatform`     | `sizeX: m`, `sizeZ: m`, `thickness: m = 0.8`, `maxTiltDeg = 22`, `axes: 'x'                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 'z'                                                                                                                                                                                                                                                           | 'both' = 'both'`, `torquePerPlayer: N·m·kg⁻¹ scale = 1`, `stiffness = 6`, `damping = 2.5`, `pivotDepth: m = 2`                                                                                                                                                                                                                                                                                                                                                                                        | Dynamic body on spherical/hinge joint, replicated (`getNetState`: quantised quaternion)                                                              |
| `seesaw`           | `length: m = 16`, `width: m = 4`, `thickness: m = 0.8`, `maxTiltDeg = 25`, `pivotHeight: m = 1.5`, `axis: 'x'                                                                                                                                                                                                                                                                                                                                                                                                                                           | 'z' = 'x'` (`'x'`⇒ ends go up/down along Z),`stiffness = 2`, `damping = 1.5`                                                                                                                                                                                  | Dynamic, replicated. Hinge at origin                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fanZone`          | `sizeX`, `sizeY`, `sizeZ: m` (wind volume, origin = volume base centre), `force: m/s² = 18`, `direction: Vec3 = (0,0,1)` (local), `onTime: s = 0` (0 = always on), `offTime: s = 0`, `telegraph: s = 0.8`, `fanRadius: m = 2.5` (visual), `gust: bool = false` (±25 % 1.3 Hz force wobble, pure), `gravityFraction: number` (optional; overrides `force` as a multiple of world gravity along `direction` — updrafts use 1.6–1.8 ⇒ net lift, "low-G" zones use 0.4 ⇒ 60 % effective gravity; keeps designs valid if gravity is retuned), `visual: 'fan' | 'updraft'                                                                                                                                                                                                                                                     | 'lowG'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 'none' = 'fan'`                                                                                                                                      | Pushes actors inside the volume; airborne actors get 1.6× (not applied when `gravityFraction` is set)                                                                        |
| `bouncePad`        | `radius: m = 1.4`, `targetApex: m = 6`, `targetRange: m = 8` (horizontal distance along local +Z at landing height = `landingDelta`), `landingDelta: m = 0`, `cooldown: s = 0.25`                                                                                                                                                                                                                                                                                                                                                                       | Module solves launch velocity from gravity so designs stay valid if gravity is retuned. `targetRange 0` = straight up                                                                                                                                         |
| `fallingTiles`     | `cols`, `rows`, `tileShape: 'square'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 'hex' = 'square'`, `tileSize: m = 2.5`(square edge / hex circumradius),`gap: m = 0.12`, `thickness: m = 0.6`, `shakeTime: s = 0.9`, `dropDelay: s = 0`(after shake),`fallDepth: m = 30`, `respawn: bool = false`, `respawnTime: s = 8`, `triggerMode: 'touch' | 'timed'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 'both' = 'touch'`, `timedSchedule: [{t, fraction}                                                                                                    | {t, beyondRadius}]`(force-drop a fraction of remaining tiles in seeded order, or every tile whose centre is farther than`beyondRadius`from the origin),`timedOrder: 'random' | 'outsideIn' = 'random'`, `immune: [{radius}]`(tiles inside this radius never drop, e.g. under a hub),`shakeTimeSchedule: [{t, shakeTime}]`(late-round faster tiles),`mask: string[]`(rows of`#`/`.`; `.` = no tile) **or** a mask rule (`radius ≤ R`, annulus `rIn…rOut`, "plus", "corners clipped" — engineers may implement rules as helper generators that emit the string mask), `surface: SurfaceKind = normal`, `glareRatio: number = 0`(seeded share of tiles that use`ice`) | Replicated bitset + per-tile state                                                                                                                                                                                                                                                                                                    |
| `risingSlime`      | `sizeX`, `sizeZ: m`, `startY: m`, `schedule: [{t, y}]` (piecewise-linear, pure), `waveAmplitude: m = 0.25`, `wavePeriod: s = 2.2`, `lethal: bool = true`, `surgeTelegraph: s = 2`                                                                                                                                                                                                                                                                                                                                                                       | Top surface is a lethal sensor at y(t)                                                                                                                                                                                                                        |
| `boulderLane`      | `path: Vec3[]` (relative points; ball rolls along polyline), `ballRadius: m = 1.6`, `speed: m/s = 7`, `spawnInterval: s = 4`, `maxBalls = 6`, `popAtEnd: bool = true`, `knockImpulse = 12`                                                                                                                                                                                                                                                                                                                                                              | Ball k position = path(s), s = (t − phase·interval − k·interval)·speed; pure. Balls are kinematic spheres, roll visually                                                                                                                                      |
| `spinningDisc`     | `radius: m = 7`, `thickness: m = 1`, `angularSpeed: rad/s = 0.6`, `bumpCount = 0`, `bumpRadius: m = 0.7`, `bumpHeight: m = 1.2`, `surface: SurfaceKind = 'normal'`                                                                                                                                                                                                                                                                                                                                                                                      | Kinematic, riders inherit velocity                                                                                                                                                                                                                            |
| `movingPlatform`   | `sizeX`, `sizeY`, `sizeZ: m`, `path: Vec3[]` (relative), `period: s`, `ease: 'sine'                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 'linear'                                                                                                                                                                                                                                                      | 'smoothstep' = 'sine'`, `pingPong: bool = true`, `holdTime: s = 0.5`(at each end),`shape: 'box'                                                                                                                                                                                                                                                                                                                                                                                                       | 'cylinder'                                                                                                                                           | 'hexPrism' = 'box'`, `surface = 'normal'`                                                                                                                                    | Pure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `slideRamp`        | `length`, `width: m`, `drop: m`, `boost: m/s² = 6`, `walls: bool = true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Surface `slide`; adds along-slope acceleration                                                                                                                                                                                                                |
| `iceFloor`         | `sizeX`, `sizeZ: m`, `thickness = 0.6`, `crackOnLand: bool = false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Surface `ice`; use static geometry `surface: ice` unless animated cracks are needed                                                                                                                                                                           |
| `stickyGoo`        | `sizeX`, `sizeZ: m`, `speedMul = 0.45`, `jumpMul = 0.6`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Surface `sticky`                                                                                                                                                                                                                                              |
| `popupBlocks`      | `cols`, `rows`, `blockSize: m = 3`, `riseHeight: m = 1.5`, `upTime: s = 1.5`, `downTime: s = 1.5`, `moveTime: s = 0.25`, `pattern: 'checker'                                                                                                                                                                                                                                                                                                                                                                                                            | 'wave'                                                                                                                                                                                                                                                        | 'random'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 'rows' = 'wave'`, `waveStep: s = 0.3`, `telegraph = 0.5`                                                                                             | Pure. Raised block = wall; lowered = flush floor                                                                                                                             |
| `laserSweep`       | `length: m = 12`, `beamHeight: m = 0.6`, `beamRadius: m = 0.18`, `mode: 'rotate'                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 'slide' = 'slide'`, `travel: m = 20`(slide distance along local Z),`angularSpeed: rad/s = 1`(rotate),`period: s = 4`(slide),`stunTime: s = 1.0`                                                                                                               | Soft beam: stun, no knock                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cannon`           | `fireInterval: s = 2.5`, `burst = 1`, `burstGap: s = 0.25`, `muzzleSpeed: m/s = 22`, `elevationDeg = 20`, `ballRadius: m = 0.7`, `ballLife: s = 3`, `aim: 'fixed'                                                                                                                                                                                                                                                                                                                                                                                       | 'sweep'                                                                                                                                                                                                                                                       | 'pattern' = 'fixed'`, `sweepDeg = 0`, `sweepPeriod: s = 6`, `patternYaws: deg[] = []`, `telegraph = 0.8`, `knockImpulse = 11`, `targetRange: m`+`targetApex: m`+`landingDelta: m = 0`(optional; when set they override`muzzleSpeed`/`elevationDeg`and the module solves the launch from gravity, like`bouncePad`), `landingMarker: bool = true`(render a danger ring at the predicted landing point during`telegraph`), `landingDeltaSchedule: [{t, landingDelta}]` (retarget lower layers over time) | Ballistic, pure f(t); balls despawn on ground contact (visual bounce/pop). Barrel faces local +Z                                                     |
| `bumperCar`        | `path: Vec3[]`, `speed: m/s = 5`, `radius: m = 1.6`, `bounceImpulse = 10`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Kinematic loop along path, pure                                                                                                                                                                                                                               |
| `rollingDrum`      | `length: m = 12`, `radius: m = 2`, `angularSpeed: rad/s = 1.5` (+ ⇒ top surface moves toward −Z, i.e. against travel), `ridgeCount = 8`, `ridgeHeight: m = 0.2`                                                                                                                                                                                                                                                                                                                                                                                         | Axis along local X. Riders inherit surface velocity                                                                                                                                                                                                           |
| `collapsingBridge` | `segmentCount = 8`, `segmentLength: m = 3`, `width: m = 4`, `thickness: m = 0.6`, `mode: 'touch'                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 'timed' = 'touch'`, `shakeTime: s = 0.8`, `respawnTime: s = 6`, `timedPeriod: s = 0`, `timedOrder: 'forward'                                                                                                                                                  | 'random' = 'forward'`, `timedStep: s = 0.5`(forward: delay between consecutive segments),`downTime: s = 2`(timed: how long a dropped segment stays down),`dropFraction = 0.3` (random: share of segments dropped per cycle, seeded per cycle index, never two adjacent)                                                                                                                                                                                                                               | Replicated (touch) or pure (timed). Timed: a cycle starts every `timedPeriod`; chosen segments shake `shakeTime`, drop for `downTime`, then pop back |
| `jumpRopeBeam`     | `armLength: m = 18`, `armCount = 1`, `beamHeight: m = 0.55` (centre), `beamRadius: m = 0.3`, `angularSpeed: rad/s = 0.8`, `speedSchedule: [{t, speed}]`, `heightSchedule: [{t, height}]` (step changes, telegraphed 1.5 s), `hubRadius = 1.5`, `knockImpulse = 9`, `innerRadius: m = 0` (beam spans innerRadius → armLength; used for concentric rings), `reverseTimes: s[] = []`                                                                                                                                                                       | Vertical axis; pure. Height changes telegraph: beam glows `accent` (low → jump) or `danger` + striped (high → dive) for 1.5 s before moving                                                                                                                   |
| `teleporterPair`   | `target: Vec3` (world), `radius: m = 1.5`, `cooldown: s = 1`, `exitYaw: deg = 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Sensor                                                                                                                                                                                                                                                        |
| `climbWall`        | `width: m`, `height: m`, `holdSpacing: m = 0.9`, `overhangDeg = 0`, `slipBands: [{y0, y1}] = []`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Grabbable everywhere except slip bands                                                                                                                                                                                                                        |
| `checkpointGate`   | `width: m`, `height: m = 5`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Visual only; logic is the trigger                                                                                                                                                                                                                             |
| `finishLine`       | `width: m`, `height: m = 6`, `confetti: bool = true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Visual + celebration emitters                                                                                                                                                                                                                                 |
| `startGate`        | `width: m = 24`, `height: m = 3`, `dropTime: s = 0.4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Blocks until GO, then drops into floor (pure: t ≥ 0)                                                                                                                                                                                                          |
| `voidTrigger`      | `sizeX`, `sizeY`, `sizeZ: m`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Extra kill volume (local pits)                                                                                                                                                                                                                                |
| `propSpawner`      | `prop: 'egg'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 'goldenEgg'                                                                                                                                                                                                                                                   | 'ball'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 'tail'                                                                                                                                               | 'crown'                                                                                                                                                                      | 'key'                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 'paintBucket'`, `count`, `areaX`, `areaZ: m`, `respawn: bool`, `respawnTime: s`, `scoreValue = 1`, `radius: m`(ball),`mass`(relative, Tumbler = 1),`bounciness`, `floatHeight: m`(crown, above`position`), `bob: m`+`bobPeriod: s`, `floatSchedule: [{t, floatHeight}]`, `orbitRadius: m`+`orbitPeriod: s` (crown circles its anchor) | Replicated ownership |

---

## 3. Round template & quality bar

Every round entry below follows this order: **Header → Objective & tips →
Fantasy & moments → Layout (sections with geometry + obstacle tables) → Triggers →
Spawn → Flyover → Bot nav → Difficulty & variations → Set dressing & lighting →
Sanity checks.**

Race quality bar:

- 6–10 sections, **teach → test → twist** inside each section and across the course.
- Competent completion 90–150 s; first qualifier ≈ 70–85 % of the average.
- Checkpoints every 1–2 sections; a rest pad after every high-risk section.
- At least two **route choices** (safe-slow vs risky-fast) per course.
- At least one **crowd chokepoint** in the first 30 % (doors, funnels) — that is
  where the comedy is.
- **Final stretch drama**: a visible finish from ≥ 40 m away, crowd, confetti,
  one last hazard that can steal a qualification.

Survival quality bar: an explicit **escalation timeline** in ≤ 20 s steps, a
readable "you are about to be in trouble" telegraph for every step, and a final
30 s that is meaningfully harder.

---

## 4. Races

---

### R1 — Gumdrop Gauntlet

| Field         | Value                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| id            | `gumdrop-gauntlet`                                                            |
| name          | Gumdrop Gauntlet                                                              |
| type          | `race`                                                                        |
| theme         | `candy`                                                                       |
| players       | min 12 · max 60 · ideal 40                                                    |
| qualification | mode `finish`, ratio **0.65** (stage 0); see SHOWS.md for per-stage overrides |
| duration      | 240 s, overtime 0                                                             |
| fallBehavior  | `respawnCheckpoint`                                                           |
| killY         | −12                                                                           |
| bounds        | min (−40, −20, −25) · max (40, 45, 540)                                       |
| music         | `mus_candy_sugarrush`                                                         |
| cameraMode    | `orbit`                                                                       |
| decorSeed     | 1101                                                                          |

**Objective (rules card):** `Reach the finish! Doors may be fakes.` (37 chars)

**Tips:**

1. Watch which doors burst open — follow the crowd's trail.
2. Hug the edge lanes to dodge the hammers… if you dare.
3. Hit a bounce pad to skip the bumper field entirely.

**Fantasy & moments.** The signature opener: a sugar-coated obstacle parade
that teaches every core verb in the first 40 s and then gets loud.

1. **The Row-Three Pile-up** — the last door row has only 2 breakable doors out
   of 6. A dozen Tumblers bounce off the same solid door, then all stampede
   sideways at once.
2. **Windmill Swat** — on the narrow spinwheel bridge a blade catches a Tumbler
   mid-stride and launches them in a slow arc into the void while daredevils
   hop the gumdrop stepping stones beside them.
3. **Edge-Lane Gamble** — the hammer plaza has 2.7 m "safe" edge lanes the
   hammers never reach… right next to the void, where everyone shoulder-checks.
4. **Sky Skip** — two bounce pads fling show-offs onto the wafer shelves, sailing
   over the bumper field in full view of everyone below.
5. **Gumball Avalanche + Twin Twirlers** — a lane-clearing ball and then a final
   jump-the-bar spinner 30 m from the finish that steals a leader's
   qualification.

#### Layout overview

| §   | Name                        | Z range   | Teaches / tests                     | Checkpoint after |
| --- | --------------------------- | --------- | ----------------------------------- | ---------------- |
| 0   | Start Plaza                 | −10 → 10  | —                                   | (start = cp 0)   |
| 1   | Sugar Steps                 | 10 → 50   | jump up, first gap                  | —                |
| 2   | Door Dash                   | 50 → 112  | crowd chokepoint, fake doors        | cp-1 (z 109)     |
| 3   | Windmill Bridges            | 112 → 190 | timing; 3 routes                    | cp-2 (z 184)     |
| 4   | Hammer Plaza                | 190 → 262 | rhythm wave, edge lanes             | cp-3 (z 264)     |
| 5   | Bumper Field + Sky Skip     | 262 → 322 | weaving; bounce shortcut            | —                |
| 6   | Gumball Hill                | 322 → 402 | uphill lane dodging                 | cp-4 (z 396)     |
| 7   | Twirl Isles                 | 402 → 448 | jumps between spinning discs / beam | cp-5 (z 452)     |
| 8   | Twin Twirlers & Finish Ramp | 448 → 524 | jump-the-bar, final climb           | finish (z 516)   |

#### §0 Start Plaza (z −10 → 10)

Purpose: safe spawn, crowd builds pressure behind the start gate.

| #   | shape  | pos x, y, z    | size x, y, z | rot | surface | colour  | grab | pattern | note                     |
| --- | ------ | -------------- | ------------ | --- | ------- | ------- | ---- | ------- | ------------------------ |
| 0.1 | box    | 0, −0.5, 0     | 26, 1, 20    | —   | normal  | safe    |      | checker | start floor (z −10…10)   |
| 0.2 | box    | 0, 1.5, −10.5  | 26, 3, 1     | —   | normal  | neutral |      | none    | back wall                |
| 0.3 | box    | ±13.25, 0.5, 0 | 0.5, 1, 20   | —   | normal  | neutral |      | none    | side rails ×2 (mirror x) |
| 0.4 | sphere | ±16, 3, −4     | 3, —, —      | —   | normal  | accent  |      | dots    | giant gumdrops (deco) ×2 |

| id      | type      | pos     | rot | params                           |
| ------- | --------- | ------- | --- | -------------------------------- |
| s0-gate | startGate | 0, 0, 7 | —   | width 26, height 3, dropTime 0.4 |

#### §1 Sugar Steps (z 10 → 50)

Purpose: **teach** jump-up and the first void gap with zero pressure; the 40-player
crowd spreads out across 24 m.

| #   | shape    | pos x, y, z   | size x, y, z  | rot    | surface | colour    | grab | pattern | note                                   |
| --- | -------- | ------------- | ------------- | ------ | ------- | --------- | ---- | ------- | -------------------------------------- |
| 1.1 | box      | 0, −0.5, 20   | 24, 1, 20     | —      | normal  | primary   |      | none    | floor z 10–30, top 0                   |
| 1.2 | box      | 0, 0.3, 26    | 24, 0.6, 4    | —      | normal  | secondary |      | stripes | step 1, top 0.6 (z 24–28) — jump       |
| 1.3 | box      | 0, 0.1, 33    | 24, 2.2, 10   | —      | normal  | primary   |      | none    | step 2 platform top 1.2 (z 28–38)      |
| 1.4 | box      | 0, 0.1, 45.25 | 24, 2.2, 9.5  | —      | normal  | secondary |      | none    | landing top 1.2 (z 40.5–50); gap 2.5 m |
| 1.5 | box      | 0, 1.2, 38.3  | 24, 0.05, 0.6 | —      | normal  | danger    |      | hazard  | edge stripe on take-off lip (deco)     |
| 1.6 | cylinder | ±15, 4, 30    | 0.5, 8, —     | —      | normal  | neutral   |      | stripes | lollipop sticks (deco) ×2              |
| 1.7 | cylinder | ±15, 9, 30    | 3, 0.8, —     | 0/90/0 | normal  | accent    |      | none    | lollipop heads facing track (deco)     |

No obstacles. This is intentional: section 1 is the "learn the jump" breath.

#### §2 Door Dash (z 50 → 112)

Purpose: **crowd chokepoint #1**. Three door rows, decreasing breakable count
4 → 3 → 2. Walls span full width so there is no bypass.

| #   | shape | pos x, y, z     | size x, y, z | rot     | surface | colour    | grab | pattern | note                             |
| --- | ----- | --------------- | ------------ | ------- | ------- | --------- | ---- | ------- | -------------------------------- |
| 2.1 | ramp  | 0, 0.6, 53      | 30, 1.2, 6   | 180/0/0 | normal  | primary   |      | chevron | descends 1.2 → 0 (z 50–56)       |
| 2.2 | box   | 0, −0.5, 84     | 30, 1, 56    | —       | normal  | primary   |      | none    | door floor z 56–112, top 0       |
| 2.3 | box   | ±15.25, 2.5, 84 | 0.5, 5, 56   | —       | normal  | neutral   |      | none    | tall side walls ×2 (no bypass)   |
| 2.4 | box   | 0, 0.01, 76     | 30, 0.02, 1  | —       | normal  | secondary |      | stripes | floor stripe between rows (deco) |
| 2.5 | box   | 0, 0.01, 92     | 30, 0.02, 1  | —       | normal  | secondary |      | stripes | floor stripe (deco)              |
| 2.6 | box   | 0, 0.01, 108    | 30, 0.02, 2  | —       | normal  | safe      |      | checker | cp-1 pad                         |

| id        | type           | pos       | rot | params                                                                                                                                                       |
| --------- | -------------- | --------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| s2-door-1 | doorGauntlet   | 0, 0, 68  | —   | doorCount 6, doorWidth 4.0, pillarWidth 0.85, doorHeight 3.5, wallHeight 5, thickness 0.6, breakableCount **4**, halfRule true, burstSpeed 2.5, solidKnock 4 |
| s2-door-2 | doorGauntlet   | 0, 0, 84  | —   | as door-1, breakableCount **3**, halfRule true                                                                                                               |
| s2-door-3 | doorGauntlet   | 0, 0, 100 | —   | as door-1, breakableCount **2**, halfRule false, noRepeatRows true                                                                                           |
| s2-bump-1 | bumperPillar   | −6, 0, 92 | —   | radius 0.9, height 2.4, bounceImpulse 8                                                                                                                      |
| s2-bump-2 | bumperPillar   | 6, 0, 92  | —   | radius 0.9, height 2.4, bounceImpulse 8                                                                                                                      |
| s2-cpgate | checkpointGate | 0, 0, 109 | —   | width 30, height 5                                                                                                                                           |

Design note: 6 × 4.0 + 7 × 0.85 = 29.95 m ⇒ the door row fills the 30 m corridor.

#### §3 Windmill Bridges (z 112 → 190)

Purpose: **test** timing on a narrow bridge with three upright spinwheels, plus
two alternate routes: left = 7 gumdrop stepping stones (precision, no knocks),
right = 1.2 m candy-cane beam with a sliding bumper (fast, risky).

| #    | shape    | pos x, y, z       | size x, y, z  | rot     | surface | colour    | grab | pattern | note                             |
| ---- | -------- | ----------------- | ------------- | ------- | ------- | --------- | ---- | ------- | -------------------------------- |
| 3.1  | box      | 0, −0.5, 116      | 30, 1, 8      | —       | normal  | secondary |      | none    | funnel z 112–120                 |
| 3.2  | box      | 0, −0.5, 122      | 24, 1, 4      | —       | normal  | secondary |      | none    | funnel z 120–124 (x ±12)         |
| 3.3  | box      | 12.6, 0.5, 118.5  | 0.5, 1, 7.1   | −45/0/0 | normal  | neutral   |      | none    | funnel rail right                |
| 3.4  | box      | −12.6, 0.5, 118.5 | 0.5, 1, 7.1   | 45/0/0  | normal  | neutral   |      | none    | funnel rail left                 |
| 3.5  | box      | 0, −0.5, 147      | 8, 1, 46      | —       | normal  | primary   |      | none    | main bridge z 124–170, x ±4      |
| 3.6  | box      | ±4, 0.02, 147     | 0.4, 0.04, 46 | —       | normal  | danger    |      | hazard  | bridge edge stripes ×2 (deco)    |
| 3.7  | cylinder | −11, −0.75, 128.6 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 1 (top 0)                  |
| 3.8  | cylinder | −11, −0.75, 134.8 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 2                          |
| 3.9  | cylinder | −11, −0.75, 141.0 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 3                          |
| 3.10 | cylinder | −11, −0.75, 147.2 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 4                          |
| 3.11 | cylinder | −11, −0.75, 153.4 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 5                          |
| 3.12 | cylinder | −11, −0.75, 159.6 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 6                          |
| 3.13 | cylinder | −11, −0.75, 165.8 | 1.6, 1.5, —   | —       | normal  | accent    |      | dots    | stone 7 (gap to 3.15 = 2.6)      |
| 3.14 | box      | 9, −0.25, 147     | 1.2, 0.5, 46  | —       | normal  | secondary |      | stripes | candy-cane beam z 124–170, top 0 |
| 3.15 | box      | 0, −0.5, 180      | 24, 1, 20     | —       | normal  | safe      |      | none    | rest pad z 170–190 (x ±12)       |
| 3.16 | box      | 0, 0.01, 184      | 24, 0.02, 2   | —       | normal  | safe      |      | checker | cp-2 pad                         |
| 3.17 | arch     | 0, 0, 133.8       | 16, 10, 1.2   | —       | normal  | neutral   |      | stripes | wheel frame 1 (deco)             |
| 3.18 | arch     | 0, 0, 147.8       | 16, 10, 1.2   | —       | normal  | neutral   |      | stripes | wheel frame 2 (deco)             |
| 3.19 | arch     | 0, 0, 161.8       | 16, 10, 1.2   | —       | normal  | neutral   |      | stripes | wheel frame 3 (deco)             |

| id        | type           | pos       | rot | params                                                                                                                     |
| --------- | -------------- | --------- | --- | -------------------------------------------------------------------------------------------------------------------------- |
| s3-spin-1 | spinwheel      | 0, 0, 133 | —   | hubHeight 7.5, bladeCount 3, bladeLength 7, bladeWidth 1.2, bladeDepth 1.0, angularSpeed **1.2**, phase 0, knockImpulse 11 |
| s3-spin-2 | spinwheel      | 0, 0, 147 | —   | as spin-1, angularSpeed **−1.4**, phase 0.33                                                                               |
| s3-spin-3 | spinwheel      | 0, 0, 161 | —   | as spin-1, angularSpeed **1.6**, phase 0.66                                                                                |
| s3-bump-1 | bumperPillar   | 9, 0, 147 | —   | radius 0.8, height 2.2, bounceImpulse 10, moveAxis x, moveAmplitude 2.2, movePeriod 2.6                                    |
| s3-cpgate | checkpointGate | 0, 0, 184 | —   | width 24                                                                                                                   |

Spinwheel maths (proves the timing window): blade tip reaches the bridge edge
(x = ±4) when within ±35° of straight down, at 1.75 m height. With 3 blades at
1.2 rad/s, a blade passes bottom every 1.75 s; the lane is blocked ≈ 1.0 s and
open ≈ 0.75 s. Crossing a wheel's 2 m danger slab takes 0.22 s at run speed.

#### §4 Hammer Plaza (z 190 → 262)

Purpose: **rhythm test**. Five pendulum hammers in a phase "wave" across a 14 m
plaza. Hammer heads only reach player height within |x| ≤ 4.3 m — the 2.7 m edge
lanes are safe from hammers but sit on the void edge (crowd shoves).

| #   | shape   | pos x, y, z               | size x, y, z   | rot | surface | colour    | grab | pattern | note                                                       |
| --- | ------- | ------------------------- | -------------- | --- | ------- | --------- | ---- | ------- | ---------------------------------------------------------- |
| 4.1 | box     | 0, −0.5, 226              | 14, 1, 72      | —   | normal  | primary   |      | none    | plaza z 190–262, x ±7                                      |
| 4.2 | box     | ±6.8, 0.02, 226           | 0.4, 0.04, 72  | —   | normal  | danger    |      | hazard  | void edge stripes (deco)                                   |
| 4.3 | box     | ±4.3, 0.01, 226           | 0.15, 0.02, 72 | —   | normal  | safe      |      | none    | painted edge-lane lines (deco) — reads "hammers stop here" |
| 4.4 | arch ×5 | 0, 0, 200/212/224/236/248 | 22, 13, 1.5    | —   | normal  | neutral   |      | stripes | hammer gantries (deco)                                     |
| 4.5 | box     | 0, 0.01, 230              | 14, 0.02, 4    | —   | normal  | secondary |      | none    | mid-plaza marker (deco)                                    |

| id       | type           | pos       | rot | params                                                                                                                                |
| -------- | -------------- | --------- | --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| s4-ham-1 | pendulumHammer | 0, 0, 200 | —   | pivotHeight 11, armLength 9, headRadius 1.3, headLength 3.2, amplitudeDeg 65, period 3.0, swingAxis z, phase **0.0**, knockImpulse 14 |
| s4-ham-2 | pendulumHammer | 0, 0, 212 | —   | as ham-1, phase **0.2**                                                                                                               |
| s4-ham-3 | pendulumHammer | 0, 0, 224 | —   | as ham-1, phase **0.4**                                                                                                               |
| s4-ham-4 | pendulumHammer | 0, 0, 236 | —   | as ham-1, phase **0.6**                                                                                                               |
| s4-ham-5 | pendulumHammer | 0, 0, 248 | —   | as ham-1, phase **0.8**                                                                                                               |

The 0.2 phase step makes a travelling wave: a player who clears hammer 1 at the
moment it is at max swing reaches hammer 2 (12 m ≈ 1.3 s later) as it is 0.43
cycles later — i.e. again near the extreme. **Run straight at full speed and the
wave carries you through**; hesitate and you are out of sync. That is the lesson.

#### §5 Bumper Field + Sky Skip (z 262 → 322)

Purpose: **recovery + reward**. Wide floor with a forest of bouncy pillars;
two bounce pads at the edges launch players onto the wafer shelves that bypass
§5's back half and ~30 m of §6.

| #   | shape | pos x, y, z    | size x, y, z | rot | surface | colour    | grab | pattern | note                                                                         |
| --- | ----- | -------------- | ------------ | --- | ------- | --------- | ---- | ------- | ---------------------------------------------------------------------------- |
| 5.1 | box   | 0, −0.5, 292   | 28, 1, 60    | —   | normal  | secondary |      | none    | field floor z 262–322, x ±14                                                 |
| 5.2 | box   | 0, 0.01, 264   | 28, 0.02, 2  | —   | normal  | safe      |      | checker | cp-3 pad                                                                     |
| 5.3 | box   | ±11, 2.5, 325  | 6, 7, 54     | —   | normal  | neutral   |      | stripes | wafer shelves z 298–352, top 6, x 8–14 (mirror) — also the hill's side walls |
| 5.4 | box   | ±11, 6.02, 325 | 6, 0.04, 54  | —   | normal  | accent    |      | dots    | shelf top paint (deco)                                                       |
| 5.5 | torus | ±11, 0.05, 286 | 2.0, 0.2, —  | —   | normal  | accent    |      | none    | pad target ring (deco)                                                       |

| id           | type           | pos                  | rot | params                                                                            |
| ------------ | -------------- | -------------------- | --- | --------------------------------------------------------------------------------- |
| s5-bump-1..3 | bumperPillar   | x −8 / 0 / 8, 0, 272 | —   | radius 0.9, height 2.4, bounceImpulse 9                                           |
| s5-bump-4    | bumperPillar   | −4, 0, 280           | —   | radius 0.9, bounceImpulse 9, moveAxis x, moveAmplitude 3, movePeriod 3.0, phase 0 |
| s5-bump-5    | bumperPillar   | 4, 0, 280            | —   | as bump-4, phase 0.5                                                              |
| s5-bump-6..8 | bumperPillar   | x −8 / 0 / 8, 0, 290 | —   | radius 0.9, bounceImpulse 9                                                       |
| s5-bump-9    | bumperPillar   | −4, 0, 298           | —   | as bump-4, phase 0.25                                                             |
| s5-bump-10   | bumperPillar   | 4, 0, 298            | —   | as bump-4, phase 0.75                                                             |
| s5-bump-11   | bumperPillar   | −5, 0, 308           | —   | radius 1.5, height 3, bounceImpulse 11                                            |
| s5-bump-12   | bumperPillar   | 5, 0, 308            | —   | radius 1.5, height 3, bounceImpulse 11                                            |
| s5-pad-L     | bouncePad      | −11, 0, 286          | —   | radius 1.4, targetApex 7.5, targetRange 14, landingDelta 6                        |
| s5-pad-R     | bouncePad      | 11, 0, 286           | —   | as pad-L                                                                          |
| s5-cpgate    | checkpointGate | 0, 0, 264            | —   | width 28                                                                          |

#### §6 Gumball Hill (z 322 → 402)

Purpose: **test under pressure**: 9.5° climb while giant gumballs roll down
three lanes (five above z 352 where the hill widens). Balls telegraph by a
"clunk" from the chute 1.5 s before they appear.

| #   | shape | pos x, y, z              | size x, y, z  | rot | surface | colour    | grab | pattern | note                                                           |
| --- | ----- | ------------------------ | ------------- | --- | ------- | --------- | ---- | ------- | -------------------------------------------------------------- |
| 6.1 | ramp  | 0, 5, 352                | 28, 10, 60    | —   | normal  | primary   |      | none    | hill z 322–382, y 0→10 (walled by shelves to x ±8 until z 352) |
| 6.2 | box   | ±2.5, 0.0, 352           | 0.2, 0.05, 60 | —   | normal  | secondary |      | none    | lane paint lines (deco; follow slope)                          |
| 6.3 | box   | 0, 9.5, 392              | 28, 1, 20     | —   | normal  | safe      |      | none    | summit plateau z 382–402, top 10                               |
| 6.4 | box   | 0, 10.01, 396            | 28, 0.02, 2   | —   | normal  | safe      |      | checker | cp-4 pad                                                       |
| 6.5 | box   | x −11/−5/0/5/11, 16, 381 | 2.5, 3, 3     | —   | normal  | accent    |      | dots    | gumball chutes above lanes (deco, no collider)                 |
| 6.6 | box   | 0, 18, 381               | 28, 1, 3      | —   | normal  | neutral   |      | stripes | chute gantry (deco)                                            |

| id         | type           | pos        | rot | params                                                                                                                 |
| ---------- | -------------- | ---------- | --- | ---------------------------------------------------------------------------------------------------------------------- |
| s6-ball-c  | boulderLane    | 0, 0, 0    | —   | path [(0, 11.6, 381), (0, 1.6, 321)], ballRadius 1.6, speed 7, spawnInterval 4.5, phase 0, maxBalls 3, knockImpulse 12 |
| s6-ball-l  | boulderLane    | −5, 0, 0   | —   | as ball-c, phase 0.33                                                                                                  |
| s6-ball-r  | boulderLane    | 5, 0, 0    | —   | as ball-c, phase 0.66                                                                                                  |
| s6-ball-ll | boulderLane    | −11, 0, 0  | —   | path [(0, 11.6, 381), (0, 6.6, 353)], spawnInterval 4.5, phase 0.15, maxBalls 2                                        |
| s6-ball-rr | boulderLane    | 11, 0, 0   | —   | as ball-ll, phase 0.65                                                                                                 |
| s6-cpgate  | checkpointGate | 0, 10, 396 | —   | width 28                                                                                                               |

Balls pop into sprinkle confetti at the path end (z 321 / z 353 shelf face). Lane
spacing 5 m vs ball diameter 3.2 m ⇒ 1.8 m safe strip between adjacent lanes
(enough for one Tumbler — a sidestep dodge, not a free ride).

#### §7 Twirl Isles (z 402 → 448)

Purpose: **twist**: three spinning candy discs in a zig-zag, or the long 1.2 m
licorice beam on the left with one hammer.

| #   | shape       | pos x, y, z                              | size x, y, z  | rot | surface | colour    | grab | pattern | note                             |
| --- | ----------- | ---------------------------------------- | ------------- | --- | ------- | --------- | ---- | ------- | -------------------------------- |
| 7.1 | box         | −10, 9.75, 425                           | 1.2, 0.5, 46  | —   | normal  | secondary |      | stripes | licorice beam z 402–448, top 10  |
| 7.2 | box         | 0, 10.01, 401.7                          | 28, 0.02, 0.6 | —   | normal  | danger    |      | hazard  | plateau lip stripe (deco)        |
| 7.3 | cylinder ×3 | (0, 4, 412) / (5, 4, 427) / (−2, 4, 439) | 1.2, 11, —    | —   | normal  | neutral   |      | stripes | disc spindles below discs (deco) |

| id        | type           | pos          | rot | params                                                                                                                           |
| --------- | -------------- | ------------ | --- | -------------------------------------------------------------------------------------------------------------------------------- |
| s7-disc-1 | spinningDisc   | 0, 10, 412   | —   | radius 7, thickness 1, angularSpeed 0.6, bumpCount 0                                                                             |
| s7-disc-2 | spinningDisc   | 5, 10, 427   | —   | radius 6, angularSpeed −0.8, bumpCount 3, bumpRadius 0.7, bumpHeight 1.2                                                         |
| s7-disc-3 | spinningDisc   | −2, 10, 439  | —   | radius 6, angularSpeed 1.0, bumpCount 4, bumpRadius 0.7, bumpHeight 1.2                                                          |
| s7-ham-1  | pendulumHammer | −10, 10, 425 | —   | pivotHeight 9, armLength 7, headRadius 1.3, headLength 2.6, amplitudeDeg 50, period 2.6, swingAxis z, phase 0.5, knockImpulse 12 |

Gaps: plateau → disc 1 = 3.0 m (z 402 → 405); disc 1 → disc 2 = 2.8 m (rim to rim
along the centre line); disc 2 → disc 3 = 1.9 m; disc 3 → landing = 3.0 m.

#### §8 Twin Twirlers & Finish Ramp (z 448 → 524)

Purpose: **final stretch drama**. A 2-arm low sweeper you must hop, with safe-but-
edgy outer strips, then a wide finish ramp up to the confetti arch. The finish is
visible from the summit plateau (z 382+), 130 m out.

| #   | shape | pos x, y, z   | size x, y, z | rot | surface | colour    | grab | pattern | note                                        |
| --- | ----- | ------------- | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------------------- |
| 8.1 | box   | 0, 9.5, 469   | 24, 1, 42    | —   | normal  | primary   |      | none    | landing + twirler plaza z 448–490, top 10   |
| 8.2 | box   | 0, 10.01, 452 | 24, 0.02, 2  | —   | normal  | safe      |      | checker | cp-5 pad                                    |
| 8.3 | torus | 0, 10.02, 477 | 9, 0.15, —   | —   | normal  | danger    |      | none    | sweep circle paint (deco)                   |
| 8.4 | ramp  | 0, 11.5, 501  | 20, 3, 22    | —   | normal  | secondary |      | chevron | finish ramp z 490–512, y 10→13              |
| 8.5 | box   | 0, 12.5, 518  | 24, 1, 12    | —   | normal  | safe      |      | checker | finish platform z 512–524, top 13           |
| 8.6 | box   | ±16, 15, 510  | 6, 6, 30     | —   | normal  | neutral   |      | stripes | crowd stands (deco, instanced crowd on top) |

| id         | type           | pos        | rot | params                                                                                                                |
| ---------- | -------------- | ---------- | --- | --------------------------------------------------------------------------------------------------------------------- |
| s8-sweep-1 | sweeperArm     | 0, 10, 477 | —   | armLength 9, armCount 2, armHeight 0.5, armRadius 0.3, angularSpeed 1.3, hubRadius 1.0, hubHeight 2.5, knockImpulse 8 |
| s8-cpgate  | checkpointGate | 0, 10, 452 | —   | width 24                                                                                                              |
| s8-finish  | finishLine     | 0, 13, 516 | —   | width 24, height 6, confetti true                                                                                     |

Twirler maths: arm tip speed 1.3 × 9 = 11.7 m/s; a bar passes any point every
π/1.3 = 2.4 s; bar top 0.8 m — one hop. Outer strips (|x| 9.3–12) are bar-free.

#### Triggers

| id     | kind       | pos        | size      | index | respawn points (y = top + 0.1)                           | yaw |
| ------ | ---------- | ---------- | --------- | ----- | -------------------------------------------------------- | --- |
| cp-0   | checkpoint | 0, 2, 0    | 26, 4, 20 | 0     | spawn grid                                               | 0   |
| cp-1   | checkpoint | 0, 2, 109  | 30, 4, 2  | 1     | x −7.5/−4.5/−1.5/1.5/4.5/7.5, y 0.1, z 111               | 0   |
| cp-2   | checkpoint | 0, 2, 184  | 24, 4, 2  | 2     | x ±7.5/±4.5/±1.5, y 0.1, z 186.5                         | 0   |
| cp-3   | checkpoint | 0, 2, 264  | 28, 4, 2  | 3     | x ±7.5/±4.5/±1.5, y 0.1, z 266.5 (lanes between bumpers) | 0   |
| cp-4   | checkpoint | 0, 12, 396 | 28, 4, 2  | 4     | x ±7.5/±4.5/±1.5, y 10.1, z 398.5                        | 0   |
| cp-5   | checkpoint | 0, 12, 452 | 24, 4, 2  | 5     | x ±7.5/±4.5/±1.5, y 10.1, z 454.5                        | 0   |
| finish | finish     | 0, 15, 516 | 24, 4, 2  | 0     | —                                                        | 0   |

Respawn convention (all rounds): respawn points sit **1.5–2.5 m past** the trigger
on the safe pad, so a respawn never re-enters the hazard behind it.

#### Spawn

origin (0, 0.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (duration 9 s)

| #   | camera       | look-at    |
| --- | ------------ | ---------- |
| 0   | 30, 25, −15  | 0, 0, 10   |
| 1   | 20, 16, 75   | 0, 2, 84   |
| 2   | −18, 18, 140 | 0, 4, 147  |
| 3   | 16, 20, 222  | 0, 2, 226  |
| 4   | −22, 22, 315 | 0, 6, 345  |
| 5   | 20, 28, 420  | 0, 10, 430 |
| 6   | 0, 22, 545   | 0, 13, 516 |

#### Bot nav

Multi-`next` choice weights by tier (Clumsy / Average / Sharp) are given in the
note; schema wish §11 #1 (until then bots pick uniformly with the tier's
`riskTolerance`).

| id  | pos            | r   | next          | action     | timeAgainst | note                                                                                                                                                         |
| --- | -------------- | --- | ------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | 0, 0, 4        | 3   | 10            | run        |             |                                                                                                                                                              |
| 10  | 0, 0, 22       | 3   | 11            | jump       |             | onto step 1                                                                                                                                                  |
| 11  | 0, 0.6, 26.5   | 3   | 12            | jump       |             | onto step 2                                                                                                                                                  |
| 12  | 0, 1.2, 36.5   | 3   | 13            | jump       |             | 2.5 m gap                                                                                                                                                    |
| 13  | 0, 1.2, 46     | 3   | 100           | run        |             |                                                                                                                                                              |
| 100 | 0, 0, 58       | 6   | 101           | run        |             | door behaviour: aim at a door; if bounced, retarget nearest door that has burst (doorGauntlet exposes burst mask). Sharp bots read burst mask before contact |
| 101 | 0, 0, 68       | 12  | 102           | run        | s2-door-1   |                                                                                                                                                              |
| 102 | 0, 0, 84       | 12  | 103           | run        | s2-door-2   |                                                                                                                                                              |
| 103 | 0, 0, 100      | 12  | 104           | run        | s2-door-3   |                                                                                                                                                              |
| 104 | 0, 0, 111      | 5   | 200, 210, 220 | run        |             | weights main/stones/beam: C 80/10/10 · A 60/20/20 · S 40/30/30                                                                                               |
| 200 | 0, 0, 125      | 2   | 201           | waitForGap | s3-spin-1   |                                                                                                                                                              |
| 201 | 0, 0, 140      | 1.5 | 202           | waitForGap | s3-spin-2   |                                                                                                                                                              |
| 202 | 0, 0, 154      | 1.5 | 203           | waitForGap | s3-spin-3   |                                                                                                                                                              |
| 203 | 0, 0, 172      | 3   | 300           | run        |             |                                                                                                                                                              |
| 210 | −9.5, 0, 123   | 1.2 | 211           | jump       |             |                                                                                                                                                              |
| 211 | −11, 0, 128.6  | 1.0 | 212           | jump       |             | stones: each 6.2 m apart                                                                                                                                     |
| 212 | −11, 0, 134.8  | 1.0 | 213           | jump       |             |                                                                                                                                                              |
| 213 | −11, 0, 141.0  | 1.0 | 214           | jump       |             |                                                                                                                                                              |
| 214 | −11, 0, 147.2  | 1.0 | 215           | jump       |             |                                                                                                                                                              |
| 215 | −11, 0, 153.4  | 1.0 | 216           | jump       |             |                                                                                                                                                              |
| 216 | −11, 0, 159.6  | 1.0 | 217           | jump       |             |                                                                                                                                                              |
| 217 | −11, 0, 165.8  | 1.0 | 218           | jump       |             | to rest pad                                                                                                                                                  |
| 218 | −9, 0, 173     | 2   | 300           | run        |             |                                                                                                                                                              |
| 220 | 9, 0, 123      | 1.0 | 221           | run        |             | beam                                                                                                                                                         |
| 221 | 9, 0, 141      | 0.6 | 222           | waitForGap | s3-bump-1   |                                                                                                                                                              |
| 222 | 9, 0, 153      | 0.6 | 223           | run        |             |                                                                                                                                                              |
| 223 | 9, 0, 172      | 2   | 300           | run        |             |                                                                                                                                                              |
| 300 | 0, 0, 188      | 3   | 301, 310, 311 | run        |             | weights centre/left/right: C 70/15/15 · A 50/25/25 · S 70/15/15 (Sharp bots ride the wave)                                                                   |
| 301 | 0, 0, 196      | 1.5 | 302           | waitForGap | s4-ham-1    |                                                                                                                                                              |
| 302 | 0, 0, 208      | 1.5 | 303           | waitForGap | s4-ham-2    |                                                                                                                                                              |
| 303 | 0, 0, 220      | 1.5 | 304           | waitForGap | s4-ham-3    |                                                                                                                                                              |
| 304 | 0, 0, 232      | 1.5 | 305           | waitForGap | s4-ham-4    |                                                                                                                                                              |
| 305 | 0, 0, 244      | 1.5 | 306           | waitForGap | s4-ham-5    |                                                                                                                                                              |
| 306 | 0, 0, 258      | 3   | 400           | run        |             |                                                                                                                                                              |
| 310 | −5.6, 0, 194   | 0.8 | 312           | run        |             | edge lane                                                                                                                                                    |
| 312 | −5.6, 0, 254   | 0.8 | 306           | run        |             |                                                                                                                                                              |
| 311 | 5.6, 0, 194    | 0.8 | 313           | run        |             |                                                                                                                                                              |
| 313 | 5.6, 0, 254    | 0.8 | 306           | run        |             |                                                                                                                                                              |
| 400 | 0, 0, 267      | 4   | 401, 410, 411 | run        |             | weights field/padL/padR: C 90/5/5 · A 60/20/20 · S 30/35/35                                                                                                  |
| 401 | 0, 0, 276      | 3   | 402           | run        |             | steer around bumpers (local avoidance)                                                                                                                       |
| 402 | −2, 0, 285     | 2.5 | 403           | waitForGap | s5-bump-4   |                                                                                                                                                              |
| 403 | 2, 0, 294      | 2.5 | 404           | waitForGap | s5-bump-10  |                                                                                                                                                              |
| 404 | 0, 0, 303      | 2.5 | 405           | run        |             |                                                                                                                                                              |
| 405 | 0, 0, 318      | 3   | 500           | run        |             |                                                                                                                                                              |
| 410 | −11, 0, 279    | 1.2 | 412           | run        |             |                                                                                                                                                              |
| 412 | −11, 0, 286    | 0.9 | 414           | run        |             | pad launches                                                                                                                                                 |
| 414 | −11, 6, 303    | 2   | 416           | run        |             |                                                                                                                                                              |
| 416 | −11, 6, 350    | 1.5 | 503           | run        |             | drop 1 m onto hill                                                                                                                                           |
| 411 | 11, 0, 279     | 1.2 | 413           | run        |             |                                                                                                                                                              |
| 413 | 11, 0, 286     | 0.9 | 415           | run        |             |                                                                                                                                                              |
| 415 | 11, 6, 303     | 2   | 417           | run        |             |                                                                                                                                                              |
| 417 | 11, 6, 350     | 1.5 | 503           | run        |             |                                                                                                                                                              |
| 500 | 0, 0, 323      | 3   | 501           | run        |             | lane dodge: when a ball in my lane is < 14 m ahead, sidestep to the 1.8 m strip at x ±2.5                                                                    |
| 501 | −2.5, 2.5, 337 | 2.5 | 502           | run        |             |                                                                                                                                                              |
| 502 | 2.5, 5, 352    | 2.5 | 503           | run        |             |                                                                                                                                                              |
| 503 | 0, 7.5, 367    | 3   | 504           | run        |             |                                                                                                                                                              |
| 504 | 0, 10, 386     | 3   | 600           | run        |             |                                                                                                                                                              |
| 600 | 0, 10, 398     | 3   | 601, 610      | run        |             | weights discs/beam: C 85/15 · A 70/30 · S 60/40                                                                                                              |
| 601 | 0, 10, 401     | 1.2 | 602           | jump       |             | 3.0 m to disc 1                                                                                                                                              |
| 602 | 0, 10, 412     | 2   | 603           | run        |             |                                                                                                                                                              |
| 603 | 2.2, 10, 418.6 | 1.0 | 604           | jump       |             | 2.8 m to disc 2                                                                                                                                              |
| 604 | 5, 10, 427     | 2   | 605           | run        |             |                                                                                                                                                              |
| 605 | 2.0, 10, 432.2 | 1.0 | 606           | jump       |             | 1.9 m to disc 3                                                                                                                                              |
| 606 | −2, 10, 439    | 2   | 607           | run        |             |                                                                                                                                                              |
| 607 | −2, 10, 444.6  | 1.0 | 608           | jump       |             | 3.0 m to landing                                                                                                                                             |
| 608 | 0, 10, 455     | 3   | 700           | run        |             |                                                                                                                                                              |
| 610 | −10, 10, 402   | 0.6 | 611           | run        |             | beam                                                                                                                                                         |
| 611 | −10, 10, 420   | 0.6 | 612           | waitForGap | s7-ham-1    |                                                                                                                                                              |
| 612 | −10, 10, 431   | 0.6 | 613           | run        |             |                                                                                                                                                              |
| 613 | −10, 10, 449   | 1.5 | 608           | run        |             |                                                                                                                                                              |
| 700 | −4.5, 10, 466  | 2   | 701           | run        |             | auto-hop: jump when a sweeper bar is ≤ 0.35 s from contact                                                                                                   |
| 701 | −4.5, 10, 488  | 2   | 702           | run        |             |                                                                                                                                                              |
| 702 | 0, 10, 491     | 3   | 703           | run        |             |                                                                                                                                                              |
| 703 | 0, 13, 516     | 4   | —             | run        |             | finish                                                                                                                                                       |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.08, 1.15, 1.22, 1.3]** — scales spinwheel ω, hammer
period (÷), bumper move period (÷), ball speed + spawn interval (÷), disc ω,
sweeper ω. Doors are unaffected (breakable counts are authored, not scaled).

| id              | weight | weather | description                                                    | overrides                                                                                                                                                                                                         |
| --------------- | ------ | ------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classic`       | 4      | clear   | As authored.                                                   | —                                                                                                                                                                                                                 |
| `sugar-rush`    | 2      | sunset  | Stingier doors, faster hammers.                                | `s2-door-1`: breakableCount 3 · `s2-door-2`: breakableCount 2 · `s2-door-3`: breakableCount 1, halfRule false · `s4-ham-1..5`: period 2.6                                                                         |
| `gumball-storm` | 2      | windy   | Five centre lanes, quicker balls.                              | `s6-ball-c/l/r`: spawnInterval 3.6, speed 8 · add `s6-ball-l2` boulderLane at (−2.5,0,0) path as ball-c, phase 0.5, and `s6-ball-r2` at (2.5,0,0) phase 0.0 (the "safe strips" disappear: dodging becomes timing) |
| `night-fair`    | 1      | night   | Carnival lights; wheels spin faster.                           | `s3-spin-1..3`: angularSpeed ×1.15 · edge trim emissive (render)                                                                                                                                                  |
| `sticky-bridge` | 1      | clear   | Goo on the main bridge makes side routes worth it.             | add `s3-goo-1` stickyGoo at (0,0,140) sizeX 8 sizeZ 8; add `s3-goo-2` stickyGoo at (0,0,154) sizeX 8 sizeZ 8 · `s3-bump-1`: movePeriod 2.0                                                                        |
| `hammer-sync`   | 1      | clear   | All hammers in phase — a single "wall" you pass in one window. | `s4-ham-1..5`: phase 0, period 3.4                                                                                                                                                                                |

#### Set dressing & lighting

- **Decor:** floating cupcake islands (instanced, 25–60 m off-course), drifting
  pastel balloons, two candy blimps circling at y 60, wafer-cone towers, chocolate
  waterfall (animated UV) under §3, crowd stands at §2 entry and the finish.
  Hanging bunting across §4 gantries. Giant lollipops lining §1.
- **Sun:** azimuth 135°, elevation 55°, colour `#fff4e0`, warm. Fog light pink,
  near 120 m / far 650 m. Sky: candy gradient (see ART_DIRECTION candy).
- **Readability:** door faces are all the same colour (`secondary`) with a
  question-mark stencil — no tells; burst doors flap open in `accent` and leave
  sprinkle confetti on the floor as a trail.

#### Sanity checks

| Hardest jump                        | Gap                     | Δh   | Envelope check                    |
| ----------------------------------- | ----------------------- | ---- | --------------------------------- |
| Plateau → disc 1 / disc 3 → landing | 3.0 m                   | 0    | moving-landing design limit 3.0 ✓ |
| Gumdrop stones (×7)                 | 3.0 m onto 3.2 m Ø pads | 0    | ≤ 3.5 ✓ (precision, not distance) |
| Disc 1 → disc 2                     | 2.8 m                   | 0    | ≤ 3.0 ✓                           |
| Step 1 → step 2                     | 0 gap                   | +0.6 | ≤ 1.8 ✓                           |
| Shelf → hill                        | drop                    | −1.0 | ✓                                 |

- **Completion:** competent ≈ 95 s (S1 6 s · S2 12 · S3 12 · S4 13 · S5 8 · S6 13 ·
  S7 12 · S8 10, + ~9 s of contact losses). Sky-Skip saves ≈ 4 s. Bots: Sharp
  105 s, Average 125 s, Clumsy 160 s.
- **Pacing (40 players, ratio 0.65 ⇒ 26 qualify):** first finisher ≈ 85 s, 13th ≈
  110 s, 26th ≈ 130–140 s. Round ends ≈ 140 s; the 240 s limit only matters in
  tiny lobbies.

---

### R2 — Conveyor Chaos

| Field         | Value                                   |
| ------------- | --------------------------------------- |
| id            | `conveyor-chaos`                        |
| name          | Conveyor Chaos                          |
| type          | `race`                                  |
| theme         | `factory`                               |
| players       | min 12 · max 60 · ideal 40              |
| qualification | mode `finish`, ratio 0.65               |
| duration      | 240 s, overtime 0                       |
| fallBehavior  | `respawnCheckpoint`                     |
| killY         | −10                                     |
| bounds        | min (−40, −15, −25) · max (40, 40, 530) |
| music         | `mus_factory_clockwork`                 |
| cameraMode    | `orbit`                                 |
| decorSeed     | 1201                                    |

**Objective:** `Ride the belts to the finish! Read the arrows.` (46 chars)

**Tips:**

1. Chevron lights show which way a belt runs — and flash before it flips.
2. Punch walls light up before they fire. Stay on the far side.
3. Pistons are platforms too: hop on top and ride the wave.

**Fantasy & moments.** You are a toy on the assembly line of the world's
silliest factory. Every surface moves; the skill is reading which way.

1. **Belt Roulette** — §1's four lanes run at different speeds/directions: the
   crowd picks lanes in the first second and half of them pick wrong.
2. **The Punch Line** — a travelling wave of punch panels slaps rows of
   Tumblers off the void side like dominoes.
3. **Flip Ramp** — two uphill belts swap direction every 5 s; players leap the
   divider at the horn while the indecisive get carried back to the bottom.
4. **Piston Surfing** — a wave of rising blocks; skilled players hop up and ride
   it, everyone else bonks into rising walls.
5. **The Last Reverse** — the finish conveyor reverses as the leaders reach the
   top, sliding the pack backward under the finish arch.

#### Layout overview

| §   | Name           | Z range   | Y (walk) | Teaches / tests                                | Checkpoint     |
| --- | -------------- | --------- | -------- | ---------------------------------------------- | -------------- |
| 0   | Loading Bay    | −10 → 10  | 0        | —                                              | cp-0           |
| 1   | Intake Belts   | 10 → 60   | 0        | conveyor basics, lane choice                   | —              |
| 2   | The Punch Line | 60 → 122  | 0        | telegraph reading, void edge                   | cp-1 (z 124)   |
| 3   | Flip Ramp      | 134 → 184 | 0 → 6    | reversing belts, lane hop                      | —              |
| 4   | Crossbelts     | 184 → 256 | 6        | lateral push + moving bumpers                  | cp-2 (z 240)   |
| 5   | Gear Works     | 256 → 321 | 6        | rolling drums, gear discs / collapsing catwalk | —              |
| 6   | Press Hall     | 321 → 395 | 6        | popup piston wave                              | cp-3 (z 385)   |
| 7   | QC Scanners    | 395 → 455 | 6        | sliding lasers over a fast belt                | cp-4 (z 457)   |
| 8   | Shipping Dock  | 455 → 515 | 6 → 10   | reversing finish ramp                          | finish (z 506) |

#### §0 Loading Bay (z −10 → 10)

Standard start plaza (§1.5) in `neutral` steel with `safe` checker strip; back
wall is a giant crate stack (deco). `s0-gate` startGate at (0, 0, 7), width 26.

#### §1 Intake Belts (z 10 → 60)

| #   | shape | pos x, y, z        | size x, y, z | rot | surface | colour    | grab | pattern | note                                                |
| --- | ----- | ------------------ | ------------ | --- | ------- | --------- | ---- | ------- | --------------------------------------------------- |
| 1.1 | box   | 0, −0.5, 12        | 26, 1, 4     | —   | normal  | secondary |      | none    | entry apron z 10–14                                 |
| 1.2 | box   | 0, −0.5, 57        | 26, 1, 6     | —   | normal  | secondary |      | none    | exit apron z 54–60                                  |
| 1.3 | box   | ±12.75, 0.5, 34    | 0.5, 1, 40   | —   | normal  | neutral   |      | none    | side rails ×2                                       |
| 1.4 | box   | x −6/0/6, 0.15, 34 | 0.3, 0.3, 40 | —   | normal  | neutral   |      | stripes | lane curbs ×3 (0.3 tall = free step)                |
| 1.5 | box   | 0, 6, 34           | 26, 0.6, 1   | —   | normal  | neutral   |      | none    | overhead lane-sign gantry (deco) with arrow screens |

| id        | type         | pos       | rot | params                             |
| --------- | ------------ | --------- | --- | ---------------------------------- |
| s1-belt-a | conveyorBelt | −9, 0, 34 | —   | length 40, width 6, speed **+3.0** |
| s1-belt-b | conveyorBelt | −3, 0, 34 | —   | length 40, width 6, speed **−2.5** |
| s1-belt-c | conveyorBelt | 3, 0, 34  | —   | length 40, width 6, speed **+2.0** |
| s1-belt-d | conveyorBelt | 9, 0, 34  | —   | length 40, width 6, speed **−3.5** |

Lane times over 40 m (ground speed 9 ± belt): a: 3.3 s · b: 6.2 s · c: 3.6 s · d: 7.3 s. The
lesson costs at most 4 s.

#### §2 The Punch Line (z 60 → 122)

An 8 m corridor on a gentle forward belt. First half: punch wall on the **left**,
void on the right. Middle crossover pad. Second half: wall on the **right**, void
on the left. Panels reach 5.5 m out, leaving a 2.5 m safe strip on the void side.

| #   | shape | pos x, y, z     | size x, y, z  | rot | surface | colour    | grab | pattern | note                          |
| --- | ----- | --------------- | ------------- | --- | ------- | --------- | ---- | ------- | ----------------------------- |
| 2.1 | box   | 0, −0.5, 61     | 12, 1, 2      | —   | normal  | secondary |      | none    | funnel lip z 60–62            |
| 2.2 | box   | 0, −0.5, 91     | 8, 1, 2       | —   | normal  | safe      |      | none    | crossover pad z 90–92         |
| 2.3 | box   | 3.8, 0.02, 76   | 0.4, 0.04, 28 | —   | normal  | danger    |      | hazard  | void-edge stripe right (deco) |
| 2.4 | box   | −3.8, 0.02, 106 | 0.4, 0.04, 28 | —   | normal  | danger    |      | hazard  | void-edge stripe left (deco)  |
| 2.5 | box   | −5.3, 2.5, 76   | 2, 5, 28      | —   | normal  | neutral   |      | none    | left punch housing (solid)    |
| 2.6 | box   | 5.3, 2.5, 106   | 2, 5, 28      | —   | normal  | neutral   |      | none    | right punch housing (solid)   |
| 2.7 | box   | 0, −0.5, 128    | 20, 1, 12     | —   | normal  | safe      |      | none    | rest pad z 122–134            |
| 2.8 | box   | 0, 0.01, 124    | 20, 0.02, 2   | —   | normal  | safe      |      | checker | cp-1 pad                      |

| id         | type           | pos         | rot     | params                                                                                                                                                                           |
| ---------- | -------------- | ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s2-belt-1  | conveyorBelt   | 0, 0, 76    | —       | length 28, width 8, speed +2.0, rails false                                                                                                                                      |
| s2-belt-2  | conveyorBelt   | 0, 0, 107   | —       | length 30, width 8, speed +2.0, rails false                                                                                                                                      |
| s2-punch-L | punchWall      | −4.3, 0, 76 | yaw 0   | panelCount 7, panelWidth 4, panelHeight 2.5, extend 5.5, extendTime 0.15, holdTime 0.5, retractTime 0.8, period 3.0, pattern wave, waveStep 0.35, telegraph 0.6, knockImpulse 13 |
| s2-punch-R | punchWall      | 4.3, 0, 106 | yaw 180 | as punch-L, pattern **alternate**, period 2.6                                                                                                                                    |
| s2-cpgate  | checkpointGate | 0, 0, 124   | —       | width 20                                                                                                                                                                         |

(punchWall panels are laid along local Z, punch toward local +X; yaw 180 punches
toward −X.)

#### §3 Flip Ramp (z 134 → 184)

Two parallel uphill belts (rise 6 m over 50 m, 6.8°), each reversing every 5 s and
half a cycle apart, so **one lane is always helping**. A 0.3 m divider is a free
step; a 1 s horn + flashing chevrons telegraph each flip.

| #   | shape | pos x, y, z     | size x, y, z | rot | surface | colour  | grab | pattern | note                               |
| --- | ----- | --------------- | ------------ | --- | ------- | ------- | ---- | ------- | ---------------------------------- |
| 3.1 | ramp  | 0, 3.3, 159     | 1, 6, 50     | —   | normal  | neutral |      | stripes | lane divider; top 0.3 above belts  |
| 3.2 | ramp  | ±8.25, 3.5, 159 | 0.5, 7, 50   | —   | normal  | neutral |      | none    | side walls ×2 (top 1 m above belt) |
| 3.3 | box   | 0, 5.5, 195     | 20, 1, 22    | —   | normal  | primary |      | none    | landing deck z 184–206, top 6      |

| id        | type         | pos           | rot        | params                                                                                              |
| --------- | ------------ | ------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| s3-belt-L | conveyorBelt | −4, 3, 159    | pitch 6.84 | length 50.36, width 7, speed +3.0, reversePeriod 10, reverseTelegraph 1.0, reverseRamp 0.4, phase 0 |
| s3-belt-R | conveyorBelt | 4, 3, 159     | pitch 6.84 | as belt-L, phase **0.5**                                                                            |
| s3-bump-1 | bumperPillar | −4, 1.92, 150 | —          | radius 0.8, height 2.2, bounceImpulse 8                                                             |
| s3-bump-2 | bumperPillar | 4, 4.08, 168  | —          | radius 0.8, height 2.2, bounceImpulse 8                                                             |

Belt maths: helping lane ⇒ 12 m/s ground speed (4.2 s up); against ⇒ 6 m/s
(8.4 s). A player who never switches averages ~6.3 s; a lane-hopper ~4.5 s.

#### §4 Crossbelts (z 184 → 256)

Four lateral belt strips (6 m deep) push toward the void edges, alternating
direction and flipping every 3.5 s; 2 m static seams between them carry moving
bumpers. Crossing a strip takes 0.7 s (≈ 2.3 m drift) — fine if you keep moving,
deadly if you get bumped and stunned.

| #   | shape | pos x, y, z    | size x, y, z  | rot | surface | colour    | grab | pattern | note                |
| --- | ----- | -------------- | ------------- | --- | ------- | --------- | ---- | ------- | ------------------- |
| 4.1 | box   | 0, 5.5, 213    | 20, 1, 2      | —   | normal  | secondary |      | none    | seam 1 z 212–214    |
| 4.2 | box   | 0, 5.5, 221    | 20, 1, 2      | —   | normal  | secondary |      | none    | seam 2              |
| 4.3 | box   | 0, 5.5, 229    | 20, 1, 2      | —   | normal  | secondary |      | none    | seam 3              |
| 4.4 | box   | 0, 5.5, 246    | 24, 1, 20     | —   | normal  | safe      |      | none    | rest deck z 236–256 |
| 4.5 | box   | 0, 6.01, 240   | 24, 0.02, 2   | —   | normal  | safe      |      | checker | cp-2 pad            |
| 4.6 | box   | ±10, 6.02, 222 | 0.4, 0.04, 28 | —   | normal  | danger    |      | hazard  | void edges (deco)   |

| id         | type           | pos       | rot    | params                                                                                        |
| ---------- | -------------- | --------- | ------ | --------------------------------------------------------------------------------------------- |
| s4-xbelt-1 | conveyorBelt   | 0, 6, 209 | yaw 90 | length 20, width 6, speed +3.5, reversePeriod 7, phase 0, rails false                         |
| s4-xbelt-2 | conveyorBelt   | 0, 6, 217 | yaw 90 | as xbelt-1, speed −3.5, phase 0.25                                                            |
| s4-xbelt-3 | conveyorBelt   | 0, 6, 225 | yaw 90 | as xbelt-1, phase 0.5                                                                         |
| s4-xbelt-4 | conveyorBelt   | 0, 6, 233 | yaw 90 | as xbelt-1, speed −3.5, phase 0.75                                                            |
| s4-bump-1  | bumperPillar   | 0, 6, 213 | —      | radius 0.8, height 2.2, bounceImpulse 9, moveAxis x, moveAmplitude 6, movePeriod 3.2, phase 0 |
| s4-bump-2  | bumperPillar   | 0, 6, 221 | —      | as bump-1, phase 0.33                                                                         |
| s4-bump-3  | bumperPillar   | 0, 6, 229 | —      | as bump-1, phase 0.66                                                                         |
| s4-cpgate  | checkpointGate | 0, 6, 240 | —      | width 24                                                                                      |

#### §5 Gear Works (z 256 → 321)

Main route: two rolling drums (top surface runs against you at 3.5 / 4.4 m/s)
then two meshing gear discs. Alt route (right): a 1.5 m collapsing maintenance
catwalk — fastest for the first few, a trap for the crowd.

| #   | shape    | pos x, y, z      | size x, y, z | rot | surface | colour  | grab | pattern | note                               |
| --- | -------- | ---------------- | ------------ | --- | ------- | ------- | ---- | ------- | ---------------------------------- |
| 5.1 | box      | 0, 5.5, 263.4    | 16, 1, 5.2   | —   | normal  | primary |      | none    | pad between drums z 260.8–266      |
| 5.2 | box      | 0, 5.5, 274.4    | 16, 1, 7.2   | —   | normal  | primary |      | none    | pad z 270.8–278                    |
| 5.3 | box      | 0, 5.5, 315      | 26, 1, 12    | —   | normal  | safe    |      | none    | gear exit deck z 309–321           |
| 5.4 | cylinder | 0, 1, 286        | 1, 9, —      | —   | normal  | neutral |      | none    | gear axle 1 (deco, under (−3,286)) |
| 5.5 | box      | 11.5, 5.5, 256.5 | 1.5, 1, 1    | —   | normal  | accent  |      | hazard  | catwalk entry stub (z 256–257)     |
| 5.6 | box      | 11.5, 5.5, 308.5 | 1.5, 1, 1    | —   | normal  | accent  |      | none    | catwalk exit stub (z 308–309)      |

| id         | type             | pos            | rot | params                                                                                                              |
| ---------- | ---------------- | -------------- | --- | ------------------------------------------------------------------------------------------------------------------- |
| s5-drum-1  | rollingDrum      | 0, 4.1, 258.4  | —   | length 16, radius 2.2, angularSpeed 1.6, ridgeCount 10, ridgeHeight 0.15                                            |
| s5-drum-2  | rollingDrum      | 0, 4.1, 268.4  | —   | as drum-1, angularSpeed 2.0                                                                                         |
| s5-gear-1  | spinningDisc     | −3, 6, 286     | —   | radius 6.5, thickness 1, angularSpeed 0.7, bumpCount 6, bumpRadius 0.6, bumpHeight 0.9                              |
| s5-gear-2  | spinningDisc     | 3, 6, 300      | —   | radius 6.5, angularSpeed −0.7, bumpCount 6, bumpRadius 0.6, bumpHeight 0.9, phase 0.083 (teeth interleave visually) |
| s5-catwalk | collapsingBridge | 11.5, 6, 282.5 | —   | segmentCount 17, segmentLength 3, width 1.5, thickness 0.4, mode touch, shakeTime 0.8, respawnTime 5                |

Drum tops sit 0.3 m above the pads (y 6.3): a free step, no jump needed. Gaps:
pad (z 278) → gear 1 rim 1.5 m; gear 1 → gear 2 2.2 m; gear 2 → deck 2.5 m.

#### §6 Press Hall (z 321 → 395)

A 5 × 15 grid of 4 m pistons rising 1.5 m in a wave that travels **forward**
(+Z) at 13 m/s. Raised blocks are 1.5 m walls — jumpable — so experts hop on
and surf; others weave the lowered gaps.

| #   | shape | pos x, y, z   | size x, y, z | rot | surface | colour  | grab | pattern | note                         |
| --- | ----- | ------------- | ------------ | --- | ------- | ------- | ---- | ------- | ---------------------------- |
| 6.1 | box   | ±10.5, 8, 351 | 1, 4, 60     | —   | normal  | neutral |      | none    | hall side walls ×2 (no fall) |
| 6.2 | box   | 0, 14, 351    | 22, 1, 60    | —   | normal  | neutral |      | stripes | roof beams (deco)            |
| 6.3 | box   | 0, 5.5, 388   | 20, 1, 14    | —   | normal  | safe    |      | none    | exit deck z 381–395          |
| 6.4 | box   | 0, 6.01, 385  | 20, 0.02, 2  | —   | normal  | safe    |      | checker | cp-3 pad                     |

| id         | type           | pos       | rot | params                                                                                                                                                    |
| ---------- | -------------- | --------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s6-pistons | popupBlocks    | 0, 6, 351 | —   | cols 5, rows 15, blockSize 4, riseHeight 1.5, upTime 1.5, downTime 1.5, moveTime 0.25, pattern wave, waveStep 0.3 (row k rises at k·0.3 s), telegraph 0.5 |
| s6-cpgate  | checkpointGate | 0, 6, 385 | —   | width 20                                                                                                                                                  |

#### §7 QC Scanners (z 395 → 455)

A 60 m fast forward belt (+3.5 m/s) with three soft lasers sliding along it:
low (jump), high (dive under or jump), low. Stun 1.0 s; the belt still carries
you, so a hit costs ~2 s, not a respawn.

| #   | shape   | pos x, y, z           | size x, y, z | rot | surface | colour  | grab | pattern | note                          |
| --- | ------- | --------------------- | ------------ | --- | ------- | ------- | ---- | ------- | ----------------------------- |
| 7.1 | box     | ±6.5, 6.75, 425       | 1, 1.5, 60   | —   | normal  | neutral |      | none    | belt walls ×2                 |
| 7.2 | arch ×3 | 0, 6, 397 / 415 / 431 | 14, 5, 1     | —   | normal  | neutral |      | stripes | scanner emitter frames (deco) |

| id         | type         | pos       | rot | params                                                                                             |
| ---------- | ------------ | --------- | --- | -------------------------------------------------------------------------------------------------- |
| s7-belt    | conveyorBelt | 0, 6, 425 | —   | length 60, width 12, speed +3.5, rails false                                                       |
| s7-laser-1 | laserSweep   | 0, 6, 397 | —   | mode slide, length 12, beamHeight 0.6, beamRadius 0.18, travel 24, period 5, phase 0, stunTime 1.0 |
| s7-laser-2 | laserSweep   | 0, 6, 415 | —   | mode slide, length 12, beamHeight **1.3**, travel 24, period 5, phase 0.5                          |
| s7-laser-3 | laserSweep   | 0, 6, 431 | —   | mode slide, length 12, beamHeight 0.6, travel 24, period 4.2, phase 0.25                           |

#### §8 Shipping Dock (z 455 → 515)

Final drama. Central 12 m conveyor ramp (6 → 10 m over 40 m) **reversing every 3
s with a 1 s horn**; static side lanes are safe from the belt but carry three
sliding bumpers each. Finish arch visible from the scanner exit.

| #   | shape | pos x, y, z      | size x, y, z | rot | surface | colour    | grab | pattern | note                                         |
| --- | ----- | ---------------- | ------------ | --- | ------- | --------- | ---- | ------- | -------------------------------------------- |
| 8.1 | box   | 0, 5.5, 457      | 22, 1, 4     | —   | normal  | safe      |      | checker | pre-ramp deck z 455–459 + cp-4               |
| 8.2 | ramp  | ±8.5, 8, 479     | 4, 4, 40     | —   | normal  | secondary |      | none    | static side lanes ×2 (x 6.5–10.5), z 459–499 |
| 8.3 | ramp  | ±10.75, 8.5, 479 | 0.5, 5, 40   | —   | normal  | neutral   |      | none    | outer walls ×2                               |
| 8.4 | box   | 0, 9.5, 507      | 24, 1, 16    | —   | normal  | safe      |      | checker | finish deck z 499–515, top 10                |
| 8.5 | box   | ±15, 13, 500     | 6, 6, 30     | —   | normal  | neutral   |      | stripes | crowd stands (deco)                          |

| id             | type         | pos                                        | rot        | params                                                                                                                |
| -------------- | ------------ | ------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| s8-belt        | conveyorBelt | 0, 8, 479                                  | pitch 5.71 | length 40.2, width 12, speed +3.5, reversePeriod 6, reverseTelegraph 1.0, reverseRamp 0.3, rails true, railHeight 0.6 |
| s8-bump-L1..L3 | bumperPillar | −8.5, (7.2 / 8.4 / 9.6), (471 / 483 / 495) | —          | radius 0.8, height 2.2, bounceImpulse 9, moveAxis x, moveAmplitude 1.3, movePeriod 2.2, phase 0 / 0.33 / 0.66         |
| s8-bump-R1..R3 | bumperPillar | 8.5, (7.2 / 8.4 / 9.6), (471 / 483 / 495)  | —          | as L, phases 0.5 / 0.83 / 0.16                                                                                        |
| s8-finish      | finishLine   | 0, 10, 506                                 | —          | width 24                                                                                                              |

Side-lane rails (0.6 m) between belt and side lanes are part of `s8-belt`;
crossing between them requires a hop (0.6 > step-up), a deliberate commitment.

#### Triggers

| id     | kind       | pos        | size      | index | respawn points                                        | yaw |
| ------ | ---------- | ---------- | --------- | ----- | ----------------------------------------------------- | --- |
| cp-0   | checkpoint | 0, 2, 0    | 26, 4, 20 | 0     | spawn grid                                            | 0   |
| cp-1   | checkpoint | 0, 2, 124  | 20, 4, 2  | 1     | x ±7.5/±4.5/±1.5, y 0.1, z 127                        | 0   |
| cp-2   | checkpoint | 0, 8, 240  | 24, 4, 2  | 2     | x ±7.5/±4.5/±1.5, y 6.1, z 243                        | 0   |
| cp-3   | checkpoint | 0, 8, 385  | 20, 4, 2  | 3     | x ±7.5/±4.5/±1.5, y 6.1, z 388                        | 0   |
| cp-4   | checkpoint | 0, 8, 457  | 22, 4, 2  | 4     | x ±7.5/±4.5/±1.5, y 6.1, z 458 (on deck, belt behind) | 0   |
| finish | finish     | 0, 12, 506 | 24, 4, 2  | 0     | —                                                     | 0   |

#### Spawn

origin (0, 0.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (8 s)

| #   | camera       | look-at                            |
| --- | ------------ | ---------------------------------- |
| 0   | −25, 18, −12 | 0, 0, 30                           |
| 1   | 18, 14, 70   | 0, 1, 92                           |
| 2   | −20, 16, 150 | 0, 4, 165                          |
| 3   | 22, 20, 225  | 0, 6, 225                          |
| 4   | −18, 22, 300 | 0, 6, 290                          |
| 5   | 0, 26, 330   | 0, 6, 370 (top-down piston reveal) |
| 6   | 20, 18, 440  | 0, 6, 425                          |
| 7   | 0, 20, 535   | 0, 10, 506                         |

#### Bot nav

| id  | pos            | r   | next          | action     | timeAgainst | note                                                                                              |
| --- | -------------- | --- | ------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------- |
| 0   | 0, 0, 5        | 3   | 10, 11        | run        |             | lane pick: Sharp → belt a (x −9) 90 %; Average 60 % a / 40 % c; Clumsy uniform over a–d           |
| 10  | −9, 0, 15      | 2   | 12            | run        |             |                                                                                                   |
| 11  | 3, 0, 15       | 2   | 13            | run        |             |                                                                                                   |
| 12  | −9, 0, 55      | 2   | 100           | run        |             |                                                                                                   |
| 13  | 3, 0, 55       | 2   | 100           | run        |             | (Clumsy on b/d use same nodes offset to their lane x)                                             |
| 100 | 0, 0, 61       | 2   | 101           | run        |             |                                                                                                   |
| 101 | 2.2, 0, 64     | 1.0 | 102           | waitForGap | s2-punch-L  | hug void-side strip; wait if a panel ahead telegraphs                                             |
| 102 | 2.2, 0, 89     | 1.0 | 103           | run        |             |                                                                                                   |
| 103 | −2.2, 0, 93    | 1.0 | 104           | waitForGap | s2-punch-R  | cross to left strip                                                                               |
| 104 | −2.2, 0, 120   | 1.0 | 105           | run        |             |                                                                                                   |
| 105 | 0, 0, 132      | 3   | 200           | run        |             |                                                                                                   |
| 200 | ±4, 0, 135     | 2   | 201           | run        |             | pick lane whose belt is currently +; re-check every flip telegraph and hop the divider (curb 0.3) |
| 201 | ±4, 3, 159     | 2   | 202           | run        |             |                                                                                                   |
| 202 | 0, 6, 188      | 3   | 300           | run        |             |                                                                                                   |
| 300 | 0, 6, 206      | 2   | 301           | run        |             | cross strips perpendicular; bias against belt push by 20°                                         |
| 301 | 0, 6, 213      | 1.5 | 302           | waitForGap | s4-bump-1   |                                                                                                   |
| 302 | 0, 6, 221      | 1.5 | 303           | waitForGap | s4-bump-2   |                                                                                                   |
| 303 | 0, 6, 229      | 1.5 | 304           | waitForGap | s4-bump-3   |                                                                                                   |
| 304 | 0, 6, 244      | 3   | 400, 410      | run        |             | main / catwalk: C 90/10 · A 80/20 · S 70/30 (only if catwalk segment 0 is intact)                 |
| 400 | 0, 6, 255      | 1.5 | 401           | run        |             | drums: sprint, no jump                                                                            |
| 401 | 0, 6, 263.4    | 1.5 | 402           | run        |             |                                                                                                   |
| 402 | 0, 6, 276.5    | 1.2 | 403           | jump       |             | 1.5 m to gear 1                                                                                   |
| 403 | −3, 6, 286     | 2   | 404           | run        |             |                                                                                                   |
| 404 | −0.5, 6, 292   | 1.0 | 405           | jump       |             | 2.2 m to gear 2                                                                                   |
| 405 | 3, 6, 300      | 2   | 406           | run        |             |                                                                                                   |
| 406 | 1.5, 6, 306    | 1.0 | 407           | jump       |             | 2.5 m to deck                                                                                     |
| 407 | 0, 6, 314      | 3   | 500           | run        |             |                                                                                                   |
| 410 | 11.5, 6, 256.5 | 0.6 | 411           | run        |             |                                                                                                   |
| 411 | 11.5, 6, 308.5 | 0.6 | 407           | run        |             | abort to main if segment ahead is shaking                                                         |
| 500 | 0, 6, 320      | 3   | 501           | run        |             | pistons: path along the lowered row; if row ahead telegraphs, jump on it (1.5 m)                  |
| 501 | 0, 6, 351      | 4   | 502           | jump       | s6-pistons  |                                                                                                   |
| 502 | 0, 6, 383      | 3   | 600           | run        |             |                                                                                                   |
| 600 | 0, 6, 396      | 2   | 601           | run        |             | lasers: jump low beams (h 0.6) at 0.3 s to contact; dive high beam (h 1.3) at 0.35 s              |
| 601 | 0, 6, 425      | 3   | 602           | run        | s7-laser-2  |                                                                                                   |
| 602 | 0, 6, 456      | 2   | 700, 710, 711 | run        |             | belt/left/right: C 60/20/20 · A 50/25/25 · S 70/15/15 (Sharp times belt to forward phase)         |
| 700 | 0, 6, 458      | 2   | 701           | waitForGap | s8-belt     | wait for forward phase ≥ 3 s remaining                                                            |
| 701 | 0, 10, 501     | 3   | 800           | run        |             |                                                                                                   |
| 710 | −8.5, 6, 459   | 1.2 | 712           | run        |             |                                                                                                   |
| 712 | −8.5, 10, 500  | 1.5 | 800           | run        |             |                                                                                                   |
| 711 | 8.5, 6, 459    | 1.2 | 713           | run        |             |                                                                                                   |
| 713 | 8.5, 10, 500   | 1.5 | 800           | run        |             |                                                                                                   |
| 800 | 0, 10, 506     | 4   | —             | run        |             | finish                                                                                            |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.1, 1.2, 1.3, 1.4]** — belt speeds, reverse periods (÷),
punch period (÷), bumper periods (÷), gear ω, drum ω, piston timings (÷), laser
period (÷). Belt speeds are capped at 5 m/s regardless of stage.

| id               | weight | weather | description                                          | overrides                                                                                                                                   |
| ---------------- | ------ | ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `day-shift`      | 4      | clear   | As authored.                                         | —                                                                                                                                           |
| `overtime-shift` | 2      | clear   | Intake belts also reverse.                           | `s1-belt-a..d`: reversePeriod 8, phases 0/0.25/0.5/0.75                                                                                     |
| `night-shift`    | 1      | night   | Lasers glow; laser 2 moves to low, extra high laser. | `s7-laser-2`: beamHeight 0.6 · add `s7-laser-4` laserSweep (0,6,405) mode rotate, length 12, beamHeight 1.3, angularSpeed 1.2               |
| `heavy-load`     | 2      | stormy  | Punch walls on both sides of the corridor.           | add `s2-punch-R2` punchWall (4.3,0,76) yaw 180 params as s2-punch-L with phase 0.5, extend 3.0 (safe strip moves to the centre: x −1.2…1.3) |
| `piston-checker` | 1      | clear   | Pistons in checker pattern.                          | `s6-pistons`: pattern checker, upTime 1.2, downTime 1.2                                                                                     |

#### Set dressing & lighting

- Factory interior-exterior hybrid: open sky above with giant toy-factory
  chimneys puffing pastel smoke rings; overhead gantry cranes carrying giant toys
  across the course (deco, kinematic visual only); stacked crates and wrapped
  presents as walls; hanging lamps over §6; QC "approved" stamps on §7 walls.
- Sun azimuth 210°, elevation 50°, cool white `#eef3ff`; warm fill from lamps.
  Fog light steel-blue near 100 / far 600.
- Belt readability: animated chevrons on every belt (UV scroll at belt speed);
  1 s before a flip, chevrons flash `danger` at 4 Hz and the horn sounds.

#### Sanity checks

| Hardest jump              | Gap                      | Δh   | Envelope |
| ------------------------- | ------------------------ | ---- | -------- |
| Gear 2 rim → exit deck    | 2.5 m from a moving disc | 0    | ≤ 3.0 ✓  |
| Gear 1 → gear 2           | 2.2 m disc → disc        | 0    | ≤ 3.0 ✓  |
| Hop onto raised piston    | —                        | +1.5 | ≤ 1.8 ✓  |
| Belt → side lane rail hop | —                        | +0.6 | ≤ 1.8 ✓  |

- **Completion:** competent ≈ 100 s (§1 5 · §2 9 · cp pad 2 · §3 6 · §4 9 · §5 14 ·
  §6 10 · §7 7 · §8 7 + ~25 s losses/waiting). Sharp bot 110 s, Average 130,
  Clumsy 170.
- **Pacing (40, ratio 0.65):** first finisher ≈ 90 s, 26th ≈ 135–145 s.

---

### R3 — Tilt Town

| Field         | Value                                   |
| ------------- | --------------------------------------- |
| id            | `tilt-town`                             |
| name          | Tilt Town                               |
| type          | `race`                                  |
| theme         | `sunset`                                |
| players       | min 10 · max 50 · ideal 36              |
| qualification | mode `finish`, ratio 0.65               |
| duration      | 270 s, overtime 0                       |
| fallBehavior  | `respawnCheckpoint`                     |
| killY         | −14                                     |
| bounds        | min (−35, −20, −25) · max (35, 40, 455) |
| music         | `mus_sunset_boardwalk`                  |
| cameraMode    | `orbit`                                 |
| decorSeed     | 1301                                    |

**Objective:** `Cross the wobbly town! Balance is everything.` (45 chars)

**Tips:**

1. Platforms tip toward the crowd. Go where others aren't.
2. A raised seesaw end can still be grabbed — hold Grab, then Jump.
3. Stay near the middle of a tilting plate; edges tip hardest.

**Fantasy & moments.** A sunset boardwalk town built on scales, teacups and
seesaws over a glittering bay. Nothing is static; the crowd itself is the hazard.

1. **The Lean** — 20 Tumblers pile onto one side of the Tilt Table and the whole
   thing tips them into the bay together, in slow motion.
2. **Seesaw Catapult** — a heavy crowd lands on the near end and the far end
   flings a lone Tumbler up and over onto the next pad (it works, sort of).
3. **Grab-and-Pray** — a raised seesaw end is 2.4 m up; a Tumbler hangs from the
   lip, others grab _them_, and the chain slides off.
4. **The Plank** — one 20 m seesaw over the void: the leader walks it alone as
   the pack piles on behind, launching them skyward.
5. **Grand Seesaw Finale** — a 30 m plank tips toward the finish under the
   leaders' weight; the trailing crowd must climb the rising lip.

#### Layout overview

| §   | Name                    | Z range   | Y       | Tests                           | Checkpoint     |
| --- | ----------------------- | --------- | ------- | ------------------------------- | -------------- |
| 0   | Pier Plaza              | −10 → 10  | 0       | —                               | cp-0           |
| 1   | Wobble Warm-up          | 10 → 56   | 0       | first tilts, gentle             | —              |
| 2   | Seesaw Strait           | 56 → 137  | 0       | three-lane seesaws (×3 deep)    | cp-1 (z 132)   |
| 3   | Teeter Bridges          | 137 → 207 | 0       | rolling beams vs zig-zag plates | cp-2 (z 199)   |
| 4   | Tilt Tables             | 207 → 265 | 0       | crowd-weight giant tables       | —              |
| 5   | Scale Stairs            | 265 → 326 | 0 → 7.2 | ascending tilt steps (grab)     | cp-3 (z 318)   |
| 6   | Wobble Grid & The Plank | 326 → 392 | 7.2     | grid + hammers, long seesaw     | cp-4 (z 384)   |
| 7   | Grand Seesaw            | 392 → 440 | 7.2     | finale plank to finish          | finish (z 432) |

All tilt/seesaw pieces are **dynamic, replicated** (`getNetState`). `stiffness`
returns an empty piece to level within ~1.5 s, so no piece can deadlock the course.

#### §0 Pier Plaza (z −10 → 10)

Standard start plaza in boardwalk planks (`primary`, `stripes`). `s0-gate`
startGate (0, 0, 7) width 26.

#### §1 Wobble Warm-up (z 10 → 56)

| #   | shape       | pos x, y, z               | size x, y, z | rot | surface | colour    | grab | pattern | note                               |
| --- | ----------- | ------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | ---------------------------------- |
| 1.1 | box         | 0, −0.5, 29               | 22, 1, 6     | —   | normal  | secondary | ✓    | none    | static pad z 26–32 (lip grabbable) |
| 1.2 | box         | 0, −0.5, 51               | 24, 1, 10    | —   | normal  | safe      | ✓    | none    | static pad z 46–56                 |
| 1.3 | cylinder ×4 | ±11, −6, 18 / ±11, −6, 39 | 0.6, 12, —   | —   | normal  | neutral   |      | none    | pier stilts (deco)                 |

| id          | type         | pos       | rot | params                                                                                  |
| ----------- | ------------ | --------- | --- | --------------------------------------------------------------------------------------- |
| s1-tilt-big | tiltPlatform | 0, 0, 18  | —   | sizeX 20, sizeZ 12, thickness 0.8, maxTiltDeg **12**, axes both, stiffness 8, damping 3 |
| s1-tilt-a   | tiltPlatform | −7, 0, 39 | —   | sizeX 6, sizeZ 10, maxTiltDeg 18, axes both, stiffness 6, damping 2.5                   |
| s1-tilt-b   | tiltPlatform | 0, 0, 39  | —   | as tilt-a                                                                               |
| s1-tilt-c   | tiltPlatform | 7, 0, 39  | —   | as tilt-a                                                                               |

Gaps: plaza (z 10) → big tilt (z 12) 2 m; big tilt (24) → pad (26) 2 m; pad (32) →
small tilts (34) 2 m; small tilts (44) → pad (46) 2 m. Between small tilts: 1 m.

#### §2 Seesaw Strait (z 56 → 137)

Three lanes (x −7 / 0 / 7) × three rows of 16 m seesaws (axis x: the ends rise
and fall along Z). maxTilt 18° ⇒ ends move ±2.47 m: a raised near end is still
grab-climbable (≤ 2.6), a lowered far end leaves the next pad lip ≤ 2.47 above —
also grab-climbable. Pads between rows are full width so lanes can be swapped.

| #   | shape | pos x, y, z               | size x, y, z | rot | surface | colour    | grab | pattern | note                           |
| --- | ----- | ------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------ |
| 2.1 | box   | 0, −0.5, 81               | 24, 1, 6     | —   | normal  | secondary | ✓    | none    | pad A z 78–84 (lips grabbable) |
| 2.2 | box   | 0, −0.5, 107              | 24, 1, 6     | —   | normal  | secondary | ✓    | none    | pad B z 104–110                |
| 2.3 | box   | 0, −0.5, 133              | 24, 1, 8     | —   | normal  | safe      | ✓    | none    | pad C z 129–137                |
| 2.4 | box   | 0, 0.01, 132              | 24, 0.02, 2  | —   | normal  | safe      |      | checker | cp-1 pad                       |
| 2.5 | box   | ±3.5, −0.5, 68 / 94 / 120 | 1, 1, 16     | —   | normal  | neutral   |      | stripes | lane posts under pivots (deco) |

| id                  | type           | pos                  | rot | params                                                                                              |
| ------------------- | -------------- | -------------------- | --- | --------------------------------------------------------------------------------------------------- |
| s2-saw-1L / 1C / 1R | seesaw         | x −7 / 0 / 7, 0, 68  | —   | length 16, width 4, thickness 0.8, maxTiltDeg 18, axis x, pivotHeight 1.5, stiffness 2, damping 1.5 |
| s2-saw-2L / 2C / 2R | seesaw         | x −7 / 0 / 7, 0, 94  | —   | as row 1                                                                                            |
| s2-saw-3L / 3C / 3R | seesaw         | x −7 / 0 / 7, 0, 120 | —   | as row 1, stiffness 1.6 (looser, more dramatic)                                                     |
| s2-cpgate           | checkpointGate | 0, 0, 132            | —   | width 24                                                                                            |

Seesaw spans: row 1 z 60–76, row 2 z 86–102, row 3 z 112–128. Apron 2.6 bridges
pad 1.2 (ends z 56) to a 1 m gap before row 1.

| #   | shape | pos x, y, z   | size x, y, z | rot | surface | colour | grab | pattern | note                             |
| --- | ----- | ------------- | ------------ | --- | ------- | ------ | ---- | ------- | -------------------------------- |
| 2.6 | box   | 0, −0.5, 57.5 | 24, 1, 3     | —   | normal  | safe   | ✓    | none    | apron z 56–59 ⇒ 1 m gap to row 1 |

(Apron 2.6 ends z 59; row 1 starts z 60; row ends 76 → pad A 78 (2 m); pad A 84 →
row 2 86 (2 m); row 2 102 → pad B 104; pad B 110 → row 3 112; row 3 128 → pad C 129.)

#### §3 Teeter Bridges (z 137 → 207)

Left route: three 4 × 14 m **rolling beams** (tilt about Z only — they roll side
to side) linked by round rest stools. Right route: seven 6 × 6 tilt plates in a
zig-zag — more jumps, less wobble per plate.

| #   | shape    | pos x, y, z   | size x, y, z | rot | surface | colour | grab | pattern | note                |
| --- | -------- | ------------- | ------------ | --- | ------- | ------ | ---- | ------- | ------------------- |
| 3.1 | cylinder | −6, −0.5, 156 | 2, 1, —      | —   | normal  | safe   | ✓    | none    | stool 1 (z 154–158) |
| 3.2 | cylinder | −6, −0.5, 176 | 2, 1, —      | —   | normal  | safe   | ✓    | none    | stool 2 (z 174–178) |
| 3.3 | box      | 0, −0.5, 201  | 26, 1, 12    | —   | normal  | safe   | ✓    | none    | landing z 195–207   |
| 3.4 | box      | 0, 0.01, 199  | 26, 0.02, 2  | —   | normal  | safe   |      | checker | cp-2 pad            |

| id            | type           | pos                                                                                 | rot | params                                                                           |
| ------------- | -------------- | ----------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------- |
| s3-roll-1     | tiltPlatform   | −6, 0, 146                                                                          | —   | sizeX 4, sizeZ 14, maxTiltDeg 20, axes **z** (roll only), stiffness 5, damping 2 |
| s3-roll-2     | tiltPlatform   | −6, 0, 166                                                                          | —   | as roll-1                                                                        |
| s3-roll-3     | tiltPlatform   | −6, 0, 186                                                                          | —   | as roll-1, maxTiltDeg 24                                                         |
| s3-plate-1..7 | tiltPlatform   | (4, 0, 141) (9, 0, 149) (4, 0, 157) (9, 0, 165) (4, 0, 173) (9, 0, 181) (4, 0, 189) | —   | sizeX 6, sizeZ 6, maxTiltDeg 16, axes both, stiffness 6, damping 2.5             |
| s3-cpgate     | checkpointGate | 0, 0, 199                                                                           | —   | width 26                                                                         |

Left gaps: pad C (137) → beam (139) 2 m; beam ↔ stool 1 m; beam 3 (193) → landing
(195) 2 m. Right gaps: pad C → plate 1 1 m; plate-to-plate diagonal ≈ 2.0 m in z
with 1 m x-overlap; plate 7 (192) → landing 3.0 m (moving take-off, at limit).

#### §4 Tilt Tables (z 207 → 265)

Two giant crowd-weighted tables. 24 × 24 (maxTilt 15° ⇒ edges ±3.1 m) then
18 × 18 (maxTilt 22° ⇒ ±3.4 m). Everyone is on them at once — the chaos centrepiece.

| #   | shape    | pos x, y, z  | size x, y, z | rot | surface | colour  | grab | pattern | note                                                            |
| --- | -------- | ------------ | ------------ | --- | ------- | ------- | ---- | ------- | --------------------------------------------------------------- |
| 4.1 | box      | 0, −0.5, 260 | 24, 1, 10    | —   | normal  | safe    | ✓    | none    | pad z 255–265 (lip grabbable: tables can dip 3.4 m, see sanity) |
| 4.2 | cylinder | 0, −5, 221   | 2.5, 9, —    | —   | normal  | neutral |      | none    | table 1 pedestal (deco)                                         |
| 4.3 | cylinder | 0, −5, 244   | 2, 9, —      | —   | normal  | neutral |      | none    | table 2 pedestal (deco)                                         |

| id         | type         | pos       | rot | params                                                                                                               |
| ---------- | ------------ | --------- | --- | -------------------------------------------------------------------------------------------------------------------- |
| s4-table-1 | tiltPlatform | 0, 0, 221 | —   | sizeX 24, sizeZ 24, thickness 1, maxTiltDeg 15, axes both, torquePerPlayer 1.0, stiffness 4, damping 3, pivotDepth 3 |
| s4-table-2 | tiltPlatform | 0, 0, 244 | —   | sizeX 18, sizeZ 18, thickness 1, maxTiltDeg 22, axes both, torquePerPlayer 1.2, stiffness 3, damping 2.5             |
| s4-bump-1  | bumperPillar | 0, 0, 260 | —   | radius 1.0, height 2.4, bounceImpulse 8 (splits the exit crowd)                                                      |

Gaps: landing (207) → table 1 (209) 2 m; table 1 (233) → table 2 (235) 2 m;
table 2 (253) → pad (255) 2 m. Table-to-table: both moving ⇒ design limit 2.5 m ✓.

#### §5 Scale Stairs (z 265 → 326)

Two parallel staircases (x ±5) of 8 × 8 tilt plates, each 1.2 m higher than the
last. Level: a normal jump-up. Tipped away from you: up to 2.2 m — grab it.

| #   | shape        | pos x, y, z             | size x, y, z | rot | surface | colour  | grab | pattern | note                                 |
| --- | ------------ | ----------------------- | ------------ | --- | ------- | ------- | ---- | ------- | ------------------------------------ |
| 5.1 | box          | 0, 6.7, 320             | 24, 1, 12    | —   | normal  | safe    | ✓    | none    | summit deck z 314–326, top 7.2       |
| 5.2 | box          | 0, 7.21, 318            | 24, 0.02, 2  | —   | normal  | safe    |      | checker | cp-3 pad                             |
| 5.3 | cylinder ×10 | ±5, (y top − 4), step z | 0.8, 8, —    | —   | normal  | neutral |      | none    | scale columns under each step (deco) |

| id              | type           | pos                | rot | params                                                                              |
| --------------- | -------------- | ------------------ | --- | ----------------------------------------------------------------------------------- |
| s5-step-1L / 1R | tiltPlatform   | ∓5, **1.2**, 270.5 | —   | sizeX 8, sizeZ 8, thickness 0.8, maxTiltDeg 14, axes both, stiffness 6, damping 2.5 |
| s5-step-2L / 2R | tiltPlatform   | ∓5, **2.4**, 280   | —   | as step 1                                                                           |
| s5-step-3L / 3R | tiltPlatform   | ∓5, **3.6**, 289.5 | —   | as step 1                                                                           |
| s5-step-4L / 4R | tiltPlatform   | ∓5, **4.8**, 299   | —   | as step 1                                                                           |
| s5-step-5L / 5R | tiltPlatform   | ∓5, **6.0**, 308.5 | —   | as step 1                                                                           |
| s5-cpgate       | checkpointGate | 0, 7.2, 318        | —   | width 24                                                                            |

Each step spans z ±4 around its centre ⇒ 1.5 m gaps, Δh +1.2. Edge swing at 14°
on a 4 m half-length = ±0.97 m.

#### §6 Wobble Grid & The Plank (z 326 → 392)

A 3 × 4 grid of 6 × 6 tilt plates (gaps 1.5) with two hammers swinging over the
centre column, then **The Plank**: one 20 × 6 m seesaw spanning a void.

| #   | shape   | pos x, y, z           | size x, y, z | rot | surface | colour  | grab | pattern | note                      |
| --- | ------- | --------------------- | ------------ | --- | ------- | ------- | ---- | ------- | ------------------------- |
| 6.1 | box     | 0, 6.7, 386           | 24, 1, 12    | —   | normal  | safe    | ✓    | none    | Plank exit deck z 380–392 |
| 6.2 | box     | 0, 7.21, 384          | 24, 0.02, 2  | —   | normal  | safe    |      | checker | cp-4 pad                  |
| 6.3 | arch ×2 | 0, 7.2, 338.5 / 353.5 | 26, 14, 1.2  | —   | normal  | neutral |      | stripes | hammer gantries (deco)    |

| id                     | type           | pos                                                | rot | params                                                                                                       |
| ---------------------- | -------------- | -------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------ |
| s6-grid-r{1..4}c{1..3} | tiltPlatform   | x −7.5 / 0 / 7.5, 7.2, z 331 / 338.5 / 346 / 353.5 | —   | sizeX 6, sizeZ 6, maxTiltDeg 16, axes both, stiffness 6, damping 2.5 (12 instances)                          |
| s6-ham-1               | pendulumHammer | 0, 7.2, 338.5                                      | —   | pivotHeight 10, armLength 8, headRadius 1.3, headLength 3, amplitudeDeg 55, period 2.8, swingAxis z, phase 0 |
| s6-ham-2               | pendulumHammer | 0, 7.2, 353.5                                      | —   | as ham-1, phase 0.5                                                                                          |
| s6-plank               | seesaw         | 0, 7.2, 369                                        | —   | length 20, width 6, thickness 0.8, maxTiltDeg 15, axis x, pivotHeight 2, stiffness 1.4, damping 1.2          |
| s6-cpgate              | checkpointGate | 0, 7.2, 384                                        | —   | width 24                                                                                                     |

Gaps: summit (326) → grid row 1 (328) 2 m; grid rows 1.5 m; row 4 (356.5) →
Plank (359) 2.5 m; Plank (379) → deck (380) 1 m. Plank ends move ±2.59 m.
Hammer danger band |x| ≤ 4.05 (centre column only).

#### §7 Grand Seesaw (z 392 → 440)

The finale: a 30 × 12 m plank, maxTilt 8° (ends ±2.09 m). Whoever is ahead
tips it down toward the finish; the pack behind sees their near end rise to
2.1 m and must jump-grab it. Finish arch sits on the far deck, glowing in the
sunset from the summit.

| #   | shape      | pos x, y, z               | size x, y, z | rot | surface | colour  | grab | pattern | note                           |
| --- | ---------- | ------------------------- | ------------ | --- | ------- | ------- | ---- | ------- | ------------------------------ |
| 7.1 | box        | 0, 6.7, 433               | 26, 1, 14    | —   | normal  | safe    | ✓    | checker | finish deck z 426–440, top 7.2 |
| 7.2 | box        | ±15, 10, 430              | 4, 6, 20     | —   | normal  | neutral |      | stripes | crowd stands (deco)            |
| 7.3 | sphere ×12 | x ±14, y 14–20, z 395–440 | 1.2          | —   | normal  | accent  |      | none    | paper lanterns (deco, bob)     |

| id        | type       | pos         | rot | params                                                                                              |
| --------- | ---------- | ----------- | --- | --------------------------------------------------------------------------------------------------- |
| s7-grand  | seesaw     | 0, 7.2, 409 | —   | length 30, width 12, thickness 1, maxTiltDeg 8, axis x, pivotHeight 2.5, stiffness 1.2, damping 1.0 |
| s7-finish | finishLine | 0, 7.2, 432 | —   | width 26                                                                                            |

Gaps: deck (392) → plank (394) 2 m; plank (424) → finish deck (426) 2 m.

#### Triggers

| id     | kind       | pos         | size      | index | respawn points                   | yaw |
| ------ | ---------- | ----------- | --------- | ----- | -------------------------------- | --- |
| cp-0   | checkpoint | 0, 2, 0     | 26, 4, 20 | 0     | spawn grid                       | 0   |
| cp-1   | checkpoint | 0, 2, 132   | 24, 4, 2  | 1     | x ±7.5/±4.5/±1.5, y 0.1, z 134.5 | 0   |
| cp-2   | checkpoint | 0, 2, 199   | 26, 4, 2  | 2     | x ±7.5/±4.5/±1.5, y 0.1, z 202   | 0   |
| cp-3   | checkpoint | 0, 9.2, 318 | 24, 4, 2  | 3     | x ±7.5/±4.5/±1.5, y 7.3, z 321   | 0   |
| cp-4   | checkpoint | 0, 9.2, 384 | 24, 4, 2  | 4     | x ±7.5/±4.5/±1.5, y 7.3, z 387.5 | 0   |
| finish | finish     | 0, 9.2, 432 | 26, 4, 2  | 0     | —                                | 0   |

#### Spawn

origin (0, 0.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (8 s)

| #   | camera       | look-at                                                  |
| --- | ------------ | -------------------------------------------------------- |
| 0   | 20, 12, −15  | 0, 0, 20                                                 |
| 1   | −22, 14, 70  | 0, 0, 94                                                 |
| 2   | 20, 16, 160  | 0, 0, 170                                                |
| 3   | 0, 30, 205   | 0, 0, 232 (top-down tables)                              |
| 4   | −20, 16, 285 | 0, 4, 300                                                |
| 5   | 18, 20, 350  | 0, 7, 365                                                |
| 6   | 0, 16, 455   | 0, 7, 410 (reverse shot of the Grand Seesaw, sun behind) |

#### Bot nav

Tilt behaviour (all tilt/seesaw nodes): steer toward the piece's **high side**
(counter-balance) and stay within the inner 60 %; if a target ledge is > 1.8 m
above, use `grab` then `climb`.

| id              | pos                        | r              | next            | action           | timeAgainst         | note                                                   |
| --------------- | -------------------------- | -------------- | --------------- | ---------------- | ------------------- | ------------------------------------------------------ |
| 0               | 0, 0, 6                    | 3              | 1               | run              |                     |                                                        |
| 1               | 0, 0, 9                    | 2              | 2               | jump             |                     | 2 m to big tilt                                        |
| 2               | 0, 0, 18                   | 3              | 3               | run              |                     |                                                        |
| 3               | 0, 0, 23.5                 | 2              | 4               | jump             |                     |                                                        |
| 4               | 0, 0, 31                   | 2              | 5               | jump             |                     | pick small tilt (lane = bot index mod 3)               |
| 5               | (−7/0/7), 0, 39            | 2              | 6               | run              |                     |                                                        |
| 6               | (−7/0/7), 0, 43.5          | 1.5            | 7               | jump             |                     |                                                        |
| 7               | 0, 0, 52                   | 3              | 100, 101, 102   | run              |                     | lane choice: least occupied (Sharp), random (others)   |
| 100             | −7, 0, 58.5                | 1.2            | 110             | waitForGap       | s2-saw-1L           | go when near end ≤ +1.2 m                              |
| 101             | 0, 0, 58.5                 | 1.2            | 111             | waitForGap       | s2-saw-1C           |                                                        |
| 102             | 7, 0, 58.5                 | 1.2            | 112             | waitForGap       | s2-saw-1R           |                                                        |
| 110 / 111 / 112 | (−7/0/7), 0, 75            | 1.2            | 120             | jump             |                     | onto pad A (grab if > 1.8)                             |
| 120             | 0, 0, 82                   | 3              | 130, 131, 132   | run              |                     |                                                        |
| 130 / 131 / 132 | (−7/0/7), 0, 84.5          | 1.2            | 140             | waitForGap       | s2-saw-2L/2C/2R     |                                                        |
| 140             | (lane), 0, 101             | 1.2            | 150             | jump             |                     |                                                        |
| 150             | 0, 0, 108                  | 3              | 160, 161, 162   | run              |                     |                                                        |
| 160 / 161 / 162 | (−7/0/7), 0, 110.5         | 1.2            | 170             | waitForGap       | s2-saw-3L/3C/3R     |                                                        |
| 170             | (lane), 0, 127             | 1.2            | 200             | jump             |                     |                                                        |
| 200             | 0, 0, 135                  | 3              | 210, 230        | run              |                     | left beams / right plates: C 60/40 · A 50/50 · S 40/60 |
| 210             | −6, 0, 138                 | 1              | 211             | jump             |                     |                                                        |
| 211             | −6, 0, 152                 | 1              | 212             | jump             |                     | to stool 1                                             |
| 212             | −6, 0, 156                 | 1              | 213             | jump             |                     |                                                        |
| 213             | −6, 0, 172                 | 1              | 214             | jump             |                     | stool 2                                                |
| 214             | −6, 0, 176                 | 1              | 215             | jump             |                     |                                                        |
| 215             | −6, 0, 192                 | 1              | 290             | jump             |                     |                                                        |
| 230             | 4, 0, 137.5                | 1              | 231             | jump             |                     |                                                        |
| 231–237         | plate centres (4           | 9, 0, 141…189) | 1.5             | next plate / 290 | jump                |                                                        | 7 plates in order |
| 290             | 0, 0, 200                  | 3              | 300             | run              |                     |                                                        |
| 300             | 0, 0, 206                  | 2              | 301             | jump             |                     |                                                        |
| 301             | 0, 0, 221                  | 4              | 302             | run              |                     | table: aim for the high side                           |
| 302             | 0, 0, 232                  | 2              | 303             | jump             |                     |                                                        |
| 303             | 0, 0, 244                  | 4              | 304             | run              |                     |                                                        |
| 304             | 0, 0, 252.5                | 2              | 305             | jump             |                     | grab lip if table dipped                               |
| 305             | 0, 0, 262                  | 3              | 400, 410        | run              |                     | stair L / R: least occupied                            |
| 400             | −5, 0, 265                 | 1.5            | 401             | jump             |                     |                                                        |
| 401–405         | −5, step y, step z         | 2              | next / 420      | jump             |                     | grab if lip > 1.8                                      |
| 410             | 5, 0, 265                  | 1.5            | 411             | jump             |                     |                                                        |
| 411–415         | 5, step y, step z          | 2              | next / 420      | jump             |                     |                                                        |
| 420             | 0, 7.2, 320                | 3              | 500, 501, 502   | run              |                     | grid column: S prefers side columns 80 %               |
| 500 / 501 / 502 | (−7.5/0/7.5), 7.2, 327     | 1.2            | 510 / 511 / 512 | jump             |                     |                                                        |
| 510–512         | column x, 7.2, 331 → 353.5 | 1.5            | 520             | jump             | s6-ham-1 / s6-ham-2 | centre column waits for hammer gap                     |
| 520             | 0, 7.2, 357                | 1.5            | 521             | waitForGap       | s6-plank            | go when plank near end ≤ +1.2                          |
| 521             | 0, 7.2, 369                | 2              | 522             | run              |                     |                                                        |
| 522             | 0, 7.2, 378.5              | 1.5            | 600             | jump             |                     |                                                        |
| 600             | 0, 7.2, 390                | 2              | 601             | jump             |                     | onto Grand Seesaw                                      |
| 601             | 0, 7.2, 409                | 4              | 602             | run              |                     |                                                        |
| 602             | 0, 7.2, 423                | 2              | 603             | jump             |                     | grab if needed                                         |
| 603             | 0, 7.2, 432                | 4              | —               | run              |                     | finish                                                 |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.05, 1.1, 1.15, 1.2]** — only hammers scale (period ÷);
tilt pieces scale `maxTiltDeg` by +5 % per stage instead (capped so seesaw
ends never exceed 2.6 m: rows 2 and 3 cap at 18.9°, Plank at 15°).

| id              | weight | weather | description                                            | overrides                                                                                                                                                                                                     |
| --------------- | ------ | ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `golden-hour`   | 4      | sunset  | As authored.                                           | —                                                                                                                                                                                                             |
| `sea-breeze`    | 2      | windy   | A gusty crosswind over the Strait and the Plank.       | add `w-gust-1` fanZone (−14, −2, 92) sizeX 4 sizeY 10 sizeZ 76, direction (1,0,0), force 6, gust true · add `w-gust-2` fanZone (−14, 5, 369) sizeX 4 sizeY 10 sizeZ 22, direction (1,0,0), force 5, gust true |
| `loose-hinges`  | 2      | sunset  | Everything tips further and settles slower.            | all seesaws stiffness ×0.7, damping ×0.8; `s4-table-1` maxTiltDeg 18; `s4-table-2` maxTiltDeg 24                                                                                                              |
| `lantern-night` | 1      | night   | Lanterns light the edges; hammers get a third partner. | add `s6-ham-3` pendulumHammer (0, 7.2, 346) as ham-1, phase 0.25                                                                                                                                              |
| `stiff-town`    | 1      | clear   | Beginner-friendly: tilts halved.                       | all tiltPlatform maxTiltDeg ×0.5 (playlist: First Show only)                                                                                                                                                  |

#### Set dressing & lighting

- Sunset boardwalk town on stilts over a glittering bay: pastel beach huts on
  floating piers, a Ferris wheel (deco, slow spin) at (−60, 0, 250), string
  lights between §2 posts, seagull flocks, sailboats drifting, a lighthouse
  sweeping beam (deco) behind the finish.
- Sun low: azimuth 260° (behind-left), elevation **12°**, colour `#ffb36b`,
  long shadows (cascade 1 range 60 m). Fog peach, near 90 / far 500.
- Readability: every tilt piece has a mint rim stripe and a contrasting underside
  so its angle reads even at the low sun angle.

#### Sanity checks

| Hardest move                  | Value                                 | Envelope                                                                                                |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Scale step at max tilt away   | +1.2 + 0.97 = 2.17 m rise, 1.5 m gap  | jump ≤ 1.8 ✗ ⇒ grab ≤ 2.6 ✓ (intended)                                                                  |
| Seesaw near end fully raised  | +2.47 m                               | grab ≤ 2.6 ✓                                                                                            |
| Plank end raised              | +2.59 m                               | grab ≤ 2.6 ✓ (tight — do not raise maxTilt)                                                             |
| Right-route plate 7 → landing | 3.0 m from a moving plate             | ≤ 3.0 ✓                                                                                                 |
| Tables at max tilt to pad     | pad lip up to 3.4 m above dipped edge | ✗ for climbing at the extreme ⇒ walk uphill 1–2 m and jump: never blocks (table recentres when emptied) |

- **Completion:** competent ≈ 110 s (low average speed ~4 m/s over 430 m).
  Sharp bot 125 s, Average 145 s, Clumsy 185 s.
- **Pacing (36, ratio 0.65 ⇒ 23):** first ≈ 100 s; 23rd ≈ 150–165 s. Duration 270 s
  covers worst-case crowd-tilt jams.

---

### R4 — Slip 'n' Spiral

| Field         | Value                                                |
| ------------- | ---------------------------------------------------- |
| id            | `slip-n-spiral`                                      |
| name          | Slip 'n' Spiral                                      |
| type          | `race`                                               |
| theme         | `frosty`                                             |
| players       | min 12 · max 60 · ideal 40                           |
| qualification | mode `finish`, ratio 0.65                            |
| duration      | 240 s, overtime 0                                    |
| fallBehavior  | `respawnCheckpoint`                                  |
| killY         | −4 (plus a void slab under the spiral, see triggers) |
| bounds        | min (−50, −10, −25) · max (50, 110, 440)             |
| music         | `mus_frosty_snowglobe`                               |
| cameraMode    | `orbit`                                              |
| decorSeed     | 1401                                                 |

**Objective:** `Slide down the frozen spiral to the finish!` (43 chars)

**Tips:**

1. Ice keeps your momentum — start turning early.
2. Snowballs chase you down the spiral. Duck into the side pockets!
3. Snow islands give grip. Use them to steer on the rink.

**Fantasy & moments.** A bobsled run carved into a snow-globe mountain: you start
at the summit, slide 2.5 turns down an ice tube while giant snowballs chase you,
then shoot out onto a glacier slide and a final skating rink.

1. **The Chute** — 40 Tumblers funnel from a 22 m bridge into a 7 m tube mouth.
   Pure slapstick.
2. **Snowball Chase** — a 3.2 m snowball rumbles down the tube behind the pack;
   everyone dives into the same inner pocket, the last one gets flattened.
3. **Icicle Swing** — an icicle pendulum swats a sliding Tumbler who can't stop
   on the ice.
4. **Glacier Launch** — exit the spiral onto a 15° slide at 16 m/s, overshoot the
   turn, ricochet off the walls.
5. **Rink Pirouette** — a three-arm sweeper on pure ice 20 m from the finish:
   players hop bars while sliding sideways.

#### Layout overview

| §   | Name                      | Z range     | Y       | Tests                                    | Checkpoint             |
| --- | ------------------------- | ----------- | ------- | ---------------------------------------- | ---------------------- |
| 0   | Summit Start              | −10 → 10    | 80      | —                                        | cp-0                   |
| 1   | Powder Run                | 10 → 70     | 80 → 72 | first ice strip, crossing snowballs      | —                      |
| 2   | Penguin Slalom            | 70 → 131    | 72      | ice steering around bumpers              | cp-1 (z 128)           |
| 3   | Crack Bridges + The Chute | 131 → 195.5 | 72 → 70 | collapsing ice bridges, funnel           | cp-2 (z 174)           |
| 4   | The Spiral (turns 1–2.5)  | v0 → v30    | 70 → 22 | tube descent, snowballs, pendulums, fans | cp-3 (v12), cp-4 (v24) |
| 5   | Glacier Slide             | 255 → 315   | 22 → 6  | speed control                            | cp-5 (z 320)           |
| 6   | Icicle Hall               | 315 → 370   | 6       | pendulums on ice                         | —                      |
| 7   | Rink Finale               | 370 → 425   | 6 → 7.2 | sweeper on ice, step-up finish           | finish (z 418)         |

#### §0 Summit Start (y 80)

Standard start plaza raised to top y 80: box (0, 79.5, 0) 26 × 1 × 20, `safe`,
rails, back wall = snow cornice. `s0-gate` startGate (0, 80, 7) width 26.

#### §1 Powder Run (z 10 → 70)

| #   | shape | pos x, y, z      | size x, y, z | rot     | surface | colour    | grab | pattern | note                           |
| --- | ----- | ---------------- | ------------ | ------- | ------- | --------- | ---- | ------- | ------------------------------ |
| 1.1 | ramp  | 0, 78.67, 20     | 22, 2.67, 20 | 180/0/0 | normal  | primary   |      | none    | snow, 80 → 77.33               |
| 1.2 | ramp  | 0, 76, 40        | 22, 2.67, 20 | 180/0/0 | **ice** | secondary |      | none    | first ice strip                |
| 1.3 | ramp  | 0, 73.33, 60     | 22, 2.67, 20 | 180/0/0 | normal  | primary   |      | none    | snow, 74.67 → 72               |
| 1.4 | ramp  | ±11.25, 76.5, 40 | 0.5, 9, 60   | 180/0/0 | normal  | neutral   |      | none    | side walls ×2 (1 m above lane) |

| id        | type        | pos     | rot | params                                                                                                                     |
| --------- | ----------- | ------- | --- | -------------------------------------------------------------------------------------------------------------------------- |
| s1-snow-1 | boulderLane | 0, 0, 0 | —   | path [(−12, 79.0, 25), (12, 79.0, 25)], ballRadius 1.0, speed 6, spawnInterval 3.0, phase 0, maxBalls 2, knockImpulse 8    |
| s1-snow-2 | boulderLane | 0, 0, 0 | —   | path [(12, 76.3, 45), (−12, 76.3, 45)], ballRadius 1.0, speed 6, spawnInterval 3.0, phase 0.5, maxBalls 2, knockImpulse 8  |
| s1-snow-3 | boulderLane | 0, 0, 0 | —   | path [(−12, 74.2, 60), (12, 74.2, 60)], ballRadius 1.0, speed 7, spawnInterval 2.6, phase 0.25, maxBalls 2, knockImpulse 8 |

(Snowballs cross the slope from snow-cannon holes in the side walls; their
y = surface at that z + radius.)

#### §2 Penguin Slalom (z 70 → 131)

| #   | shape | pos x, y, z         | size x, y, z  | rot | surface | colour    | grab | pattern | note                          |
| --- | ----- | ------------------- | ------------- | --- | ------- | --------- | ---- | ------- | ----------------------------- |
| 2.1 | box   | 0, 71.5, 100.5      | 24, 1, 61     | —   | **ice** | secondary |      | none    | rink floor z 70–131, no rails |
| 2.2 | box   | −5, 72.1, 84        | 5, 0.2, 5     | —   | normal  | primary   |      | dots    | snow island 1 (free step)     |
| 2.3 | box   | 6, 72.1, 100        | 5, 0.2, 5     | —   | normal  | primary   |      | dots    | snow island 2                 |
| 2.4 | box   | −3, 72.1, 116       | 5, 0.2, 5     | —   | normal  | primary   |      | dots    | snow island 3                 |
| 2.5 | box   | ±11.8, 72.02, 100.5 | 0.4, 0.04, 61 | —   | normal  | danger    |      | hazard  | edge stripes (deco)           |
| 2.6 | box   | 0, 72.01, 128       | 24, 0.02, 2   | —   | normal  | safe      |      | checker | cp-1 pad                      |

| id            | type           | pos                                                  | rot | params                                                                                  |
| ------------- | -------------- | ---------------------------------------------------- | --- | --------------------------------------------------------------------------------------- |
| s2-peng-1..4  | bumperPillar   | (−6, 72, 78) (2, 72, 82) (8, 72, 90) (−2, 72, 94)    | —   | radius 0.9, height 1.8, bounceImpulse 9 (penguin mesh)                                  |
| s2-peng-5..6  | bumperPillar   | (−8, 72, 104) (1, 72, 108)                           | —   | radius 0.9, bounceImpulse 9, moveAxis x, moveAmplitude 4, movePeriod 3.5, phase 0 / 0.5 |
| s2-peng-7..10 | bumperPillar   | (6, 72, 112) (−6, 72, 120) (3, 72, 122) (9, 72, 118) | —   | radius 0.9, bounceImpulse 10                                                            |
| s2-cpgate     | checkpointGate | 0, 72, 128                                           | —   | width 24                                                                                |

#### §3 Crack Bridges + The Chute (z 131 → 195.5)

Three 4 m ice bridges of 10 collapsing segments over a crevasse, then a full-
width pad that **funnels into the 7 m tube mouth** (crowd chokepoint).

| #   | shape | pos x, y, z          | size x, y, z   | rot     | surface | colour    | grab | pattern | note                                      |
| --- | ----- | -------------------- | -------------- | ------- | ------- | --------- | ---- | ------- | ----------------------------------------- |
| 3.1 | box   | 0, 71.5, 174         | 22, 1, 6       | —       | normal  | safe      |      | none    | pad z 171–177                             |
| 3.2 | box   | 0, 72.01, 174        | 22, 0.02, 2    | —       | normal  | safe      |      | checker | cp-2 pad                                  |
| 3.3 | ramp  | 0, 71, 186.25        | 7, 2, 18.5     | 180/0/0 | ice     | secondary |      | chevron | The Chute: 72 → 70, z 177–195.5           |
| 3.4 | box   | ±4, 72, 180          | 8.5, 2, 0.5    | ∓35/0/0 | normal  | neutral   |      | stripes | funnel walls ×2 (yaw −35 right, +35 left) |
| 3.5 | ramp  | ±3.75, 72.25, 186.25 | 0.5, 4.5, 18.5 | 180/0/0 | normal  | neutral   |      | none    | chute walls ×2 (2.5 m above lane)         |
| 3.6 | arch  | 0, 70, 195           | 9, 6, 2        | —       | normal  | accent    |      | stripes | tube mouth arch "SPIRAL" sign (deco)      |

| id         | type             | pos         | rot | params                                                                                                           |
| ---------- | ---------------- | ----------- | --- | ---------------------------------------------------------------------------------------------------------------- |
| s3-crack-L | collapsingBridge | −7, 72, 151 | —   | segmentCount 10, segmentLength 4, width 4, thickness 0.6, mode touch, shakeTime 0.7, respawnTime 6 (surface ice) |
| s3-crack-C | collapsingBridge | 0, 72, 151  | —   | as L                                                                                                             |
| s3-crack-R | collapsingBridge | 7, 72, 151  | —   | as L                                                                                                             |

Bridges span z 131–171 exactly (no gap at either end). Collapsed segments
re-form after 6 s with a frost "grow" animation; until then the lane has a 4 m
hole (dive-jumpable at 5.5 m max, so a lane with one missing segment is still
crossable by experts).

#### §4 The Spiral (v0 → v30)

**Generator.** A 12-sided conical helix around centre (0, ·, 215). Vertex `k`
(k = 0…30): angle φ = −90° + 30°·k, radius r = 16 + (8/12)·k, x = r·cos φ,
z = 215 + r·sin φ, y = 70 − 1.6·k. Lane width 7, descent 1.6 m per segment
(slopes 10.7° at the top → 5.0° at the bottom), 2.5 turns, path length 404 m.
Adjacent turns are 19.2 m apart vertically and 1 m apart radially.

Per vertex: a flat pad `cylinder` radius 3.5, height 1, top = vertex y (pos y =
y − 0.5). Per segment k → k+1: a `ramp` (table below; size z includes 0.4 m
overlap), two side walls `box` 0.5 × 2.5 × (L + 0.4) offset ±3.75 m perpendicular,
same yaw, **pitch = slope** (raises the uphill end), centre y = segment mid-
surface + 1.25. Outer-corner gap fillers: a `cylinder` post r 1.0 × 2.5 at
vertex + 3.75 · outward radial. Surfaces: segments 0–23 `ice`, segments 24–29
`slide` (turn 3 gets faster). Colours alternate `primary`/`secondary` per
half-turn so speed reads.

**Vertex table**

| v   | x      | y    | z      | r     |
| --- | ------ | ---- | ------ | ----- |
| v0  | 0.00   | 70.0 | 199.00 | 16.00 |
| v1  | 8.33   | 68.4 | 200.57 | 16.67 |
| v2  | 15.01  | 66.8 | 206.33 | 17.33 |
| v3  | 18.00  | 65.2 | 215.00 | 18.00 |
| v4  | 16.17  | 63.6 | 224.33 | 18.67 |
| v5  | 9.67   | 62.0 | 231.74 | 19.33 |
| v6  | 0.00   | 60.4 | 235.00 | 20.00 |
| v7  | −10.33 | 58.8 | 232.90 | 20.67 |
| v8  | −18.48 | 57.2 | 225.67 | 21.33 |
| v9  | −22.00 | 55.6 | 215.00 | 22.00 |
| v10 | −19.63 | 54.0 | 203.67 | 22.67 |
| v11 | −11.67 | 52.4 | 194.79 | 23.33 |
| v12 | 0.00   | 50.8 | 191.00 | 24.00 |
| v13 | 12.33  | 49.2 | 193.64 | 24.67 |
| v14 | 21.94  | 47.6 | 202.33 | 25.33 |
| v15 | 26.00  | 46.0 | 215.00 | 26.00 |
| v16 | 23.09  | 44.4 | 228.33 | 26.67 |
| v17 | 13.67  | 42.8 | 238.67 | 27.33 |
| v18 | 0.00   | 41.2 | 243.00 | 28.00 |
| v19 | −14.33 | 39.6 | 239.83 | 28.67 |
| v20 | −25.40 | 38.0 | 229.67 | 29.33 |
| v21 | −30.00 | 36.4 | 215.00 | 30.00 |
| v22 | −26.56 | 34.8 | 199.67 | 30.67 |
| v23 | −15.67 | 33.2 | 187.86 | 31.33 |
| v24 | 0.00   | 31.6 | 183.00 | 32.00 |
| v25 | 16.33  | 30.0 | 186.71 | 32.67 |
| v26 | 28.87  | 28.4 | 198.33 | 33.33 |
| v27 | 34.00  | 26.8 | 215.00 | 34.00 |
| v28 | 30.02  | 25.2 | 232.33 | 34.67 |
| v29 | 17.67  | 23.6 | 245.60 | 35.33 |
| v30 | 0.00   | 22.0 | 251.00 | 36.00 |

**Segment ramps** (shape `ramp`, rot = yaw only; slope column informs wall pitch)

| seg | pos x, y, z           | size x, y, z  | yaw    | slope° |
| --- | --------------------- | ------------- | ------ | ------ |
| 0   | 4.17, 69.20, 199.78   | 7, 1.6, 8.88  | −100.6 | 10.7   |
| 1   | 11.67, 67.60, 203.45  | 7, 1.6, 9.22  | −130.8 | 10.3   |
| 2   | 16.51, 66.00, 210.67  | 7, 1.6, 9.57  | −161.0 | 9.9    |
| 3   | 17.08, 64.40, 219.67  | 7, 1.6, 9.91  | 168.9  | 9.5    |
| 4   | 12.92, 62.80, 228.04  | 7, 1.6, 10.26 | 138.7  | 9.2    |
| 5   | 4.83, 61.20, 233.37   | 7, 1.6, 10.60 | 108.6  | 8.9    |
| 6   | −5.17, 59.60, 233.95  | 7, 1.6, 10.94 | 78.5   | 8.6    |
| 7   | −14.40, 58.00, 229.28 | 7, 1.6, 11.29 | 48.4   | 8.4    |
| 8   | −20.24, 56.40, 220.33 | 7, 1.6, 11.63 | 18.3   | 8.1    |
| 9   | −20.81, 54.80, 209.33 | 7, 1.6, 11.98 | −11.8  | 7.9    |
| 10  | −15.65, 53.20, 199.23 | 7, 1.6, 12.32 | −41.9  | 7.6    |
| 11  | −5.83, 51.60, 192.90  | 7, 1.6, 12.67 | −72.0  | 7.4    |
| 12  | 6.17, 50.00, 192.32   | 7, 1.6, 13.01 | −102.1 | 7.2    |
| 13  | 17.14, 48.40, 197.99  | 7, 1.6, 13.36 | −132.2 | 7.0    |
| 14  | 23.97, 46.80, 208.67  | 7, 1.6, 13.70 | −162.2 | 6.9    |
| 15  | 24.55, 45.20, 221.67  | 7, 1.6, 14.05 | 167.7  | 6.7    |
| 16  | 18.38, 43.60, 233.50  | 7, 1.6, 14.39 | 137.6  | 6.5    |
| 17  | 6.83, 42.00, 240.84   | 7, 1.6, 14.74 | 107.6  | 6.4    |
| 18  | −7.17, 40.40, 241.41  | 7, 1.6, 15.08 | 77.5   | 6.2    |
| 19  | −19.87, 38.80, 234.75 | 7, 1.6, 15.43 | 47.5   | 6.1    |
| 20  | −27.70, 37.20, 222.33 | 7, 1.6, 15.77 | 17.4   | 5.9    |
| 21  | −28.28, 35.60, 207.33 | 7, 1.6, 16.11 | −12.7  | 5.8    |
| 22  | −21.11, 34.00, 193.77 | 7, 1.6, 16.46 | −42.7  | 5.7    |
| 23  | −7.83, 32.40, 185.43  | 7, 1.6, 16.80 | −72.8  | 5.6    |
| 24  | 8.17, 30.80, 184.85   | 7, 1.6, 17.15 | −102.8 | 5.5    |
| 25  | 22.60, 29.20, 192.52  | 7, 1.6, 17.49 | −132.8 | 5.3    |
| 26  | 31.43, 27.60, 206.67  | 7, 1.6, 17.84 | −162.9 | 5.2    |
| 27  | 32.01, 26.00, 223.67  | 7, 1.6, 18.18 | 167.1  | 5.1    |
| 28  | 23.84, 24.40, 238.97  | 7, 1.6, 18.53 | 137.0  | 5.0    |
| 29  | 8.83, 22.80, 248.30   | 7, 1.6, 18.87 | 107.0  | 5.0    |

(Yaw points the ramp's rising local +Z back toward vertex k, i.e. uphill.)

**Other spiral geometry**

| #   | shape       | pos x, y, z                                                                       | size x, y, z | rot | surface | colour  | grab | pattern | note                                                                        |
| --- | ----------- | --------------------------------------------------------------------------------- | ------------ | --- | ------- | ------- | ---- | ------- | --------------------------------------------------------------------------- |
| 4.1 | cylinder    | 0, 46, 215                                                                        | 12, 52, —    | —   | normal  | neutral |      | none    | ice mountain core y 20–72 (turn-1 inner wall)                               |
| 4.2 | sphere      | 0, 76, 215                                                                        | 13, —, —     | —   | normal  | primary |      | none    | snow cap (deco)                                                             |
| 4.3 | cylinder ×4 | inner pockets at v14, v18, v22, v26: centre = vertex − 4.5·radial, top = vertex y | 3, 1, —      | —   | normal  | safe    |      | dots    | snowball dodge pockets; inner wall omitted on the half-segments either side |
| 4.4 | cylinder    | 0, 21.5, 251                                                                      | 5, 1, —      | —   | normal  | safe    |      | none    | v30 exit pad (enlarged, r 5)                                                |

| id          | type           | pos                  | rot       | params                                                                                                                                                           |
| ----------- | -------------- | -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s4-ball     | boulderLane    | 0, 1.6, 0            | —         | path = v0…v30 (x, y, z from the vertex table; +1.6 via position), ballRadius 1.6, speed 11, spawnInterval 6, phase 0, maxBalls 7, popAtEnd true, knockImpulse 10 |
| s4-peng-1   | bumperPillar   | 8.77, 62.0, 230.18   | —         | radius 0.8, height 1.8, bounceImpulse 9 (v5, inner side)                                                                                                         |
| s4-peng-2   | bumperPillar   | −11.23, 58.8, 234.46 | —         | as peng-1 (v7, outer side)                                                                                                                                       |
| s4-peng-3   | bumperPillar   | −20.2, 55.6, 215     | —         | as peng-1 (v9, inner side)                                                                                                                                       |
| s4-icicle-1 | pendulumHammer | −11.67, 52.4, 194.79 | yaw 120   | pivotHeight 9, armLength 7.5, headRadius 1.0, headLength 2.4, amplitudeDeg 40, period 2.4, swingAxis z (head travels across the lane), phase 0, knockImpulse 11  |
| s4-icicle-2 | pendulumHammer | 26, 46, 215          | yaw 0     | as icicle-1, phase 0.33                                                                                                                                          |
| s4-icicle-3 | pendulumHammer | −14.33, 39.6, 239.83 | yaw 240   | as icicle-1, phase 0.66                                                                                                                                          |
| s4-gust-1   | fanZone        | 6.83, 42.0, 240.84   | yaw 107.6 | sizeX 7, sizeY 4, sizeZ 15, force 10, direction (0,0,1) (uphill headwind), onTime 2.5, offTime 2.5, telegraph 0.8                                                |
| s4-gust-2   | fanZone        | −27.70, 37.2, 222.33 | yaw 17.4  | as gust-1, phase 0.5                                                                                                                                             |

Snowball maths: balls 66 m apart at 11 m/s ⇒ one passes any point every 6 s. A
competent player on ice runs ≈ 10 m/s, so a ball catches you roughly once per
turn — exactly one "duck into a pocket or sidestep" moment per turn. Lane 7 m −
ball 3.2 m ⇒ 1.9 m strips on either side (sidestep works if you commit early).

#### §5 Glacier Slide (z 255 → 315)

| #   | shape | pos x, y, z    | size x, y, z | rot | surface | colour | grab | pattern | note                                |
| --- | ----- | -------------- | ------------ | --- | ------- | ------ | ---- | ------- | ----------------------------------- |
| 5.1 | box   | 0, 21.5, 253.5 | 12, 1, 5     | —   | normal  | safe   |      | none    | slide lip z 251–256 (joins v30 pad) |
| 5.2 | box   | 0, 5.5, 322.5  | 20, 1, 15    | —   | normal  | safe   |      | none    | run-out z 315–330, top 6            |
| 5.3 | box   | 0, 6.01, 320   | 20, 0.02, 2  | —   | normal  | safe   |      | checker | cp-5 pad                            |

| id        | type           | pos        | rot | params                                                                   |
| --------- | -------------- | ---------- | --- | ------------------------------------------------------------------------ |
| s5-slide  | slideRamp      | 0, 22, 256 | —   | length 61.0, width 12, drop 16 (z 256 → 315, 15.2°), boost 6, walls true |
| s5-cpgate | checkpointGate | 0, 6, 320  | —   | width 20                                                                 |

#### §6 Icicle Hall (z 315 → 370)

| #   | shape | pos x, y, z  | size x, y, z | rot | surface | colour    | grab | pattern | note                                        |
| --- | ----- | ------------ | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------------------- |
| 6.1 | box   | 0, 5.5, 350  | 18, 1, 40    | —   | ice     | secondary |      | none    | hall floor z 330–370                        |
| 6.2 | box   | ±9.5, 9, 350 | 1, 8, 40     | —   | normal  | neutral   |      | none    | hall walls ×2 (ice glass, see-through)      |
| 6.3 | box   | 0, 13.5, 350 | 20, 1, 40    | —   | normal  | neutral   |      | stripes | roof with icicle fringe (deco, collider on) |

| id          | type           | pos       | rot | params                                                                                                          |
| ----------- | -------------- | --------- | --- | --------------------------------------------------------------------------------------------------------------- |
| s6-icicle-1 | pendulumHammer | 0, 6, 338 | —   | pivotHeight 7, armLength 5.5, headRadius 1.1, headLength 2.6, amplitudeDeg 60, period 2.6, swingAxis z, phase 0 |
| s6-icicle-2 | pendulumHammer | 0, 6, 350 | —   | as icicle-1, phase 0.5                                                                                          |
| s6-icicle-3 | pendulumHammer | 0, 6, 362 | —   | as icicle-1, phase 0.25                                                                                         |

(Pivot at y 13 is attached to the roof underside.) Head bottom at swing bottom:
13 − 5.5 − 1.1 = 6.4 ⇒ chest height. At 60° the head is at x ±4.8, y 10.2
(clear). Danger band |x| ≤ 3.3 m; 5.7 m safe strips each side, but on ice.

#### §7 Rink Finale (z 370 → 425)

| #   | shape    | pos x, y, z   | size x, y, z | rot | surface | colour  | grab | pattern | note                                                     |
| --- | -------- | ------------- | ------------ | --- | ------- | ------- | ---- | ------- | -------------------------------------------------------- |
| 7.1 | cylinder | 0, 5.5, 392   | 18, 1, —     | —   | ice     | primary |      | none    | rink, z 374–410                                          |
| 7.2 | box      | 0, 5.5, 372   | 18, 1, 4     | —   | ice     | primary |      | none    | hall → rink joiner z 370–374                             |
| 7.3 | box      | 0, 6.6, 417.5 | 24, 1.2, 15  | —   | normal  | safe    | ✓    | checker | finish deck z 410–425, top 7.2 (1.2 step, lip grabbable) |
| 7.4 | torus    | 0, 6.6, 392   | 18.3, 0.6, — | —   | normal  | neutral |      | none    | rink boards (collide: keeps players in)                  |
| 7.5 | box      | ±18, 10, 410  | 6, 8, 20     | —   | normal  | neutral |      | stripes | crowd stands (deco)                                      |

| id        | type       | pos         | rot | params                                                                                                                 |
| --------- | ---------- | ----------- | --- | ---------------------------------------------------------------------------------------------------------------------- |
| s7-sweep  | sweeperArm | 0, 6, 392   | —   | armLength 16.5, armCount 3, armHeight 0.5, armRadius 0.3, angularSpeed 0.9, hubRadius 1.5, hubHeight 3, knockImpulse 8 |
| s7-finish | finishLine | 0, 7.2, 418 | —   | width 24                                                                                                               |

The rink boards (torus tube 0.6 around r 18.3) have a gap at z 370–374 (entry)
and z 408–410 (exit to the finish deck): split the torus visually; collider is
two arcs. **Schema wish** (§11 #4): arc/partial torus. Fallback: 16 short
`box` board segments (0.4 × 1.0 × 7) around the circle, omitting the two that
cover the entry and exit.

#### Triggers

| id          | kind       | pos                | size      | index | respawn points                                                                                                                | yaw                |
| ----------- | ---------- | ------------------ | --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| cp-0        | checkpoint | 0, 82, 0           | 26, 4, 20 | 0     | spawn grid                                                                                                                    | 0                  |
| cp-1        | checkpoint | 0, 74, 128         | 24, 4, 2  | 1     | x ±7.5/±4.5/±1.5, y 72.1, z 130                                                                                               | 0                  |
| cp-2        | checkpoint | 0, 74, 174         | 22, 4, 2  | 2     | x ±7.5/±4.5/±1.5, y 72.1, z 176                                                                                               | 0                  |
| cp-3        | checkpoint | 0, 52.8, 191 (v12) | 2, 4, 8   | 3     | (1.96, 50.8, 191.42) (2.38, 50.8, 189.46) (1.54, 50.8, 193.38) (3.91, 50.5, 191.84) (4.33, 50.5, 189.88) (3.49, 50.5, 193.80) | 102 (lane heading) |
| cp-4        | checkpoint | 0, 33.6, 183 (v24) | 2, 4, 8   | 4     | (1.95, 31.6, 183.44) (2.39, 31.6, 181.49) (1.51, 31.6, 185.39) (3.90, 31.3, 183.89) (4.34, 31.3, 181.94) (3.46, 31.3, 185.84) | 77                 |
| cp-5        | checkpoint | 0, 8, 320          | 20, 4, 2  | 5     | x ±7.5/±4.5/±1.5, y 6.1, z 323                                                                                                | 0                  |
| void-spiral | void       | 0, 15, 212.5       | 90, 2, 85 | 0     | —                                                                                                                             | —                  |
| finish      | finish     | 0, 9.2, 418        | 24, 4, 2  | 0     | —                                                                                                                             | 0                  |

`void-spiral` catches anyone knocked over a tube wall long before killY (no
walkable surface exists below y 22 in z 170–255), keeping fall-to-respawn under
1.5 s. Respawn yaw at cp-3/cp-4 = the lane's travel heading (three.js yaw).

#### Spawn

origin (0, 80.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (10 s — the spiral deserves it)

| #   | camera       | look-at    |
| --- | ------------ | ---------- |
| 0   | 0, 95, −20   | 0, 80, 10  |
| 1   | 25, 85, 120  | 0, 72, 150 |
| 2   | 45, 75, 215  | 0, 60, 215 |
| 3   | 0, 70, 280   | 0, 45, 215 |
| 4   | −50, 50, 215 | 0, 35, 215 |
| 5   | 20, 30, 300  | 0, 10, 300 |
| 6   | 0, 22, 440   | 0, 7, 400  |

#### Bot nav

| id                 | pos               | r   | next          | action     | timeAgainst | note                                                                                                                                                                        |
| ------------------ | ----------------- | --- | ------------- | ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0                  | 0, 80, 5          | 3   | 1             | run        |             |                                                                                                                                                                             |
| 1                  | 0, 77.3, 30       | 3   | 2             | run        | s1-snow-1   | ice behaviour (all ice nodes): steer 0.6 s earlier, cap input to 80 %                                                                                                       |
| 2                  | 0, 74.7, 50       | 3   | 3             | run        | s1-snow-2   |                                                                                                                                                                             |
| 3                  | 0, 72, 72         | 3   | 4             | run        |             |                                                                                                                                                                             |
| 4                  | −3, 72, 86        | 2.5 | 5             | run        |             | local avoidance around penguins                                                                                                                                             |
| 5                  | 4, 72, 100        | 2.5 | 6             | run        |             |                                                                                                                                                                             |
| 6                  | −3, 72, 116       | 2.5 | 7             | run        |             |                                                                                                                                                                             |
| 7                  | 0, 72, 129        | 3   | 100, 101, 102 | run        |             | bridge pick: the one with the most intact segments ahead                                                                                                                    |
| 100 / 101 / 102    | (−7/0/7), 72, 132 | 1.5 | 110           | run        |             | if a hole ≤ 4 m ahead: Sharp jumpDive, others pick another bridge                                                                                                           |
| 110                | 0, 72, 175        | 3   | 111           | run        |             |                                                                                                                                                                             |
| 111                | 0, 70, 195        | 2   | 400           | run        |             | Chute                                                                                                                                                                       |
| 400 + k (k = 0…29) | vertex k          | 2.5 | 401 + k       | run        |             | follow the vertex table. Snowball rule: if a ball is ≤ 25 m behind on my lane, move to the nearest pocket (v14/18/22/26) or the 1.9 m side strip opposite the ball's offset |
| 411                | v11               | 2.5 | 412           | waitForGap | s4-icicle-1 |                                                                                                                                                                             |
| 415                | v15               | 2.5 | 416           | waitForGap | s4-icicle-2 |                                                                                                                                                                             |
| 416                | v16               | 2.5 | 417           | waitForGap | s4-gust-1   | wait for fan off                                                                                                                                                            |
| 419                | v19               | 2.5 | 420           | waitForGap | s4-icicle-3 |                                                                                                                                                                             |
| 420                | v20               | 2.5 | 421           | waitForGap | s4-gust-2   |                                                                                                                                                                             |
| 430                | v30               | 3   | 500           | run        |             |                                                                                                                                                                             |
| 500                | 0, 22, 254        | 2   | 501           | run        |             | slide: hold forward, steer to centre                                                                                                                                        |
| 501                | 0, 6, 318         | 3   | 600           | run        |             |                                                                                                                                                                             |
| 600                | 4.5, 6, 333       | 1.5 | 601           | run        |             | Icicle Hall: keep to x ±4.5 strips (Sharp go centre with waits)                                                                                                             |
| 601                | 4.5, 6, 368       | 1.5 | 700           | run        |             |                                                                                                                                                                             |
| 700                | 0, 6, 375         | 3   | 701           | run        |             | rink: auto-hop sweeper bars (≤ 0.35 s)                                                                                                                                      |
| 701                | 0, 6, 407         | 2   | 702           | jump       |             | onto finish deck (+1.2)                                                                                                                                                     |
| 702                | 0, 7.2, 418       | 4   | —             | run        |             | finish                                                                                                                                                                      |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.08, 1.16, 1.24, 1.32]** — snowball speed + interval,
pendulum periods, fan cycle, sweeper ω, penguin periods.

| id             | weight | weather | description                                                        | overrides                                                                                                                                                                |
| -------------- | ------ | ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fresh-powder` | 4      | clear   | As authored.                                                       | —                                                                                                                                                                        |
| `blizzard`     | 2      | snow    | Falling snow, fog near 40 / far 220; tube walls get emissive trim. | `s4-gust-1/2`: force 14                                                                                                                                                  |
| `avalanche`    | 2      | clear   | Bigger, more frequent snowballs.                                   | `s4-ball`: ballRadius 1.9, spawnInterval 4.5, maxBalls 9 · `s1-snow-*`: spawnInterval ×0.75                                                                              |
| `aurora-night` | 1      | night   | Aurora sky; turn 2 becomes `slide` too.                            | geometry override: segments 12–23 surface slide (Schema wish §11 #3: geometry overrides in variations; fallback: ship as a separate geometry list flag `auroraSlide`)    |
| `thin-ice`     | 1      | clear   | Penguin Slalom tiles crack.                                        | add `s2-thin` fallingTiles (0, 72, 100.5) cols 8 rows 20, tileSize 3, triggerMode touch, shakeTime 1.2, respawn true, respawnTime 5 — replaces 2.1 (remove 2.1 via flag) |

#### Set dressing & lighting

- A colossal snow globe dome (deco, 400 m radius, faint glass reflections at the
  horizon), pine forests on floating ice floes, a frozen waterfall, skating
  snow-folk crowd around the rink, glittering snow particles, ice-crystal arches
  over the chute. The spiral's mountain core has carved windows glowing warm.
- Sun azimuth 150°, elevation 35°, colour `#e8f4ff`, strong bloom on ice
  highlights. Fog pale blue near 150 / far 700 (blizzard overrides).
- Readability: ice is glossier and lighter than snow; slide surfaces get
  animated chevron sparkles; snowballs throw a large dark blob shadow onto the
  tube 0.5 s ahead of contact.

#### Sanity checks

| Hardest move            | Value           | Envelope                                             |
| ----------------------- | --------------- | ---------------------------------------------------- |
| Rink → finish deck      | +1.2 m from ice | jump ≤ 1.8 ✓ (ice take-off: lip grabbable as backup) |
| Missing bridge segment  | 4 m gap on ice  | dive ≤ 5.5 ✓, not required (other bridges)           |
| Spiral steepest segment | 10.7°           | walkable ✓; ice makes it fast, not dangerous         |
| Slide                   | 15.2°, 61 m     | slide surface (designed for 30–40° max) ✓            |

- **Completion:** competent ≈ 100 s (§1 7 · §2 8 · §3 + Chute 9 · spiral 44 · slide 4
  · §6 8 · §7 8 + ~12 s losses). Sharp bot 112 s, Average 130 s, Clumsy 165 s.
- **Pacing (40 ⇒ 26):** first ≈ 92 s; 26th ≈ 135 s. Spiral spreads the pack, so
  qualification fills smoothly rather than in a clump.

---

### R5 — Hammer Highway

| Field         | Value                                             |
| ------------- | ------------------------------------------------- |
| id            | `hammer-highway`                                  |
| name          | Hammer Highway                                    |
| type          | `race`                                            |
| theme         | `castle`                                          |
| players       | min 12 · max 60 · ideal 40                        |
| qualification | mode `finish`, ratio 0.6 (harder round, more cut) |
| duration      | 270 s, overtime 0                                 |
| fallBehavior  | `respawnCheckpoint`                               |
| killY         | −12                                               |
| bounds        | min (−40, −20, −25) · max (40, 50, 500)           |
| music         | `mus_castle_jestercourt`                          |
| cameraMode    | `orbit`                                           |
| decorSeed     | 1501                                              |

**Objective:** `Dodge the hammers and cross to the throne!` (42 chars)

**Tips:**

1. Hammers swing on a beat — count it before you cross.
2. Shaking stones are about to fall. Wait, or leap.
3. The ladder ledges skip the barrel ramp, if you can climb.

**Fantasy & moments.** A jester's obstacle parade through a toy castle: moat
bridges, battering rams, crumbling causeways and the legendary Highway — a
3 m bridge through a gauntlet of giant swinging hammers.

1. **The Moat Plop** — first hammer on a 4 m bridge: half the lobby learns
   hammers by being bonked into the moat.
2. **Ram Surfing** — a battering ram swings along the bridge; brave players
   sprint right behind it as it swings away.
3. **Causeway Hop** — stones shake and drop in random patterns; a crowd freezes
   on one stone while a daredevil jump-dives the 4 m hole.
4. **The Highway** — eight hammers, two rest towers, one 3 m bridge. Every hit is
   a long arcing fall into the moat with a "bonk" heard across the level.
5. **Royal Hammers** — two colossal double hammers guard the throne dais; the
   crowd splits around them and somebody always picks the wrong side.

#### Layout overview

| §   | Name               | Z range   | Y      | Tests                                       | Checkpoint     |
| --- | ------------------ | --------- | ------ | ------------------------------------------- | -------------- |
| 0   | Gate Plaza         | −10 → 10  | 0      | —                                           | cp-0           |
| 1   | Moat Bridges       | 10 → 64   | 0      | narrow bridges + 1 hammer each              | —              |
| 2   | Ram Run            | 64 → 129  | 0      | rams swinging along the path                | cp-1 (z 124)   |
| 3   | Crumbling Causeway | 129 → 209 | 0      | timed random collapse + giant cross hammers | cp-2 (z 202)   |
| 4   | Hammer Hall        | 209 → 287 | 0      | 3 lanes over pits, 9 hammers, lane swaps    | —              |
| 5   | Rampart Climb      | 287 → 341 | 0 → 8  | barrel ramp vs grab-ledge ladder            | cp-3 (z 333)   |
| 6   | The Highway        | 341 → 432 | 8      | 3 m bridge, 4 hammers, collapsing tail      | cp-4 (z 424)   |
| 7   | Throne Run         | 432 → 492 | 8 → 10 | colossal hammers, dais finish               | finish (z 486) |

#### §0 Gate Plaza

Standard start plaza in castle flagstones (`neutral`), back wall = gatehouse
with portcullis (deco). `s0-gate` startGate (0, 0, 7) width 26 styled as a
lowering portcullis.

#### §1 Moat Bridges (z 10 → 64)

| #   | shape   | pos x, y, z          | size x, y, z | rot | surface | colour  | grab | pattern | note                                                      |
| --- | ------- | -------------------- | ------------ | --- | ------- | ------- | ---- | ------- | --------------------------------------------------------- |
| 1.1 | box     | −8 / 0 / 8, −0.5, 31 | 4, 1, 42     | —   | normal  | primary |      | none    | 3 bridges z 10–52                                         |
| 1.2 | box     | 0, −0.5, 58          | 26, 1, 12    | —   | normal  | safe    |      | none    | pad z 52–64                                               |
| 1.3 | arch ×3 | −8 / 0 / 8, 0, 31    | 7, 11, 1     | —   | normal  | neutral |      | stripes | hammer frames (deco)                                      |
| 1.4 | box     | 0, −8, 31            | 60, 0.2, 60  | —   | normal  | #5fb8ff |      | none    | moat water plane (deco, visual only; killY handles falls) |

| id       | type           | pos       | rot | params                                                                                                                          |
| -------- | -------------- | --------- | --- | ------------------------------------------------------------------------------------------------------------------------------- |
| s1-ham-L | pendulumHammer | −8, 0, 31 | —   | pivotHeight 10, armLength 8, headRadius 1.1, headLength 2.4, amplitudeDeg 60, period 3.0, swingAxis z, phase 0, knockImpulse 12 |
| s1-ham-C | pendulumHammer | 0, 0, 31  | —   | as L, phase 0.33                                                                                                                |
| s1-ham-R | pendulumHammer | 8, 0, 31  | —   | as L, phase 0.66                                                                                                                |

Hammer reaches player height for |θ| < 27.4° ⇒ |x| < 3.7 m around its bridge
(covers the full 4 m width). Blocked ~0.6 s twice per 3 s period.

#### §2 Ram Run (z 64 → 129)

A 6 m bridge with three battering rams swinging **along** the path (swingAxis x).
Each ram is low enough to hit within ±3.6 m of its pivot; the trick is to chase
it as it swings away.

| #   | shape  | pos x, y, z           | size x, y, z  | rot | surface | colour  | grab | pattern | note                    |
| --- | ------ | --------------------- | ------------- | --- | ------- | ------- | ---- | ------- | ----------------------- |
| 2.1 | box    | 0, −0.5, 92           | 6, 1, 56      | —   | normal  | primary |      | none    | ram bridge z 64–120     |
| 2.2 | box    | ±2.9, 0.02, 92        | 0.2, 0.04, 56 | —   | normal  | danger  |      | hazard  | edge stripes (deco)     |
| 2.3 | box    | 0, −0.5, 124.5        | 20, 1, 9      | —   | normal  | safe    |      | none    | pad z 120–129           |
| 2.4 | box    | 0, 0.01, 124          | 20, 0.02, 2   | —   | normal  | safe    |      | checker | cp-1 pad                |
| 2.5 | box ×3 | 0, 9.5, 74 / 88 / 102 | 10, 1, 1      | —   | normal  | neutral |      | stripes | ram gantry beams (deco) |

| id        | type           | pos       | rot | params                                                                                                                             |
| --------- | -------------- | --------- | --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| s2-ram-1  | pendulumHammer | 0, 0, 74  | —   | pivotHeight 9, armLength 7, headRadius 1.0, headLength 4.0, amplitudeDeg 55, period 3.2, swingAxis **x**, phase 0, knockImpulse 10 |
| s2-ram-2  | pendulumHammer | 0, 0, 88  | —   | as ram-1, phase 0.35                                                                                                               |
| s2-ram-3  | pendulumHammer | 0, 0, 102 | —   | as ram-1, phase 0.7                                                                                                                |
| s2-cpgate | checkpointGate | 0, 0, 124 | —   | width 20                                                                                                                           |

Timing: danger zone 7.2 m long; per 3.2 s period the head is low for two 0.6 s
passes and high on one side for ~1.0 s. Following the head as it swings
forward-away gives ~1.4 s of cover — enough to clear the 8 m zone at 9 m/s.

#### §3 Crumbling Causeway (z 129 → 209)

Twin 4 m causeways of 17 four-metre stones. Every 4 s a seeded 30 % of stones
(never adjacent) shake 0.8 s, drop for 2 s and pop back. Two giant cross hammers
sweep the inner halves of both causeways.

| #   | shape   | pos x, y, z     | size x, y, z | rot | surface | colour  | grab | pattern | note                       |
| --- | ------- | --------------- | ------------ | --- | ------- | ------- | ---- | ------- | -------------------------- |
| 3.1 | box     | 0, −0.5, 203    | 24, 1, 12    | —   | normal  | safe    |      | none    | pad z 197–209              |
| 3.2 | box     | 0, 0.01, 202    | 24, 0.02, 2  | —   | normal  | safe    |      | checker | cp-2 pad                   |
| 3.3 | arch ×2 | 0, 0, 150 / 176 | 24, 16, 2    | —   | normal  | neutral |      | stripes | giant hammer towers (deco) |

| id         | type             | pos        | rot | params                                                                                                                                              |
| ---------- | ---------------- | ---------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| s3-cause-L | collapsingBridge | −5, 0, 163 | —   | segmentCount 17, segmentLength 4, width 4, thickness 0.8, mode timed, timedOrder random, timedPeriod 4, shakeTime 0.8, downTime 2, dropFraction 0.3 |
| s3-cause-R | collapsingBridge | 5, 0, 163  | —   | as L, phase 0.5 (independent seed)                                                                                                                  |
| s3-giant-1 | pendulumHammer   | 0, 0, 150  | —   | pivotHeight 14, armLength 12, headRadius 1.6, headLength 4, amplitudeDeg 50, period 4.0, swingAxis z, phase 0, knockImpulse 14                      |
| s3-giant-2 | pendulumHammer   | 0, 0, 176  | —   | as giant-1, phase 0.5                                                                                                                               |
| s3-cpgate  | checkpointGate   | 0, 0, 202  | —   | width 24                                                                                                                                            |

Causeways span z 129–197 (no gaps when intact). Giant hammer danger band |x| <
5.6 m ⇒ inner 2.6 m of each causeway; the outer 1.4 m strips are safe from the
hammer but not from falling stones.

#### §4 Hammer Hall (z 209 → 287)

An 18 m hall split by two 3 m pits into three 4 m lanes; two 2 m cross-bridges
let you swap lanes. Side-lane hammers swing **across** (toward pit/wall), centre-
lane rams swing **along**. Lanes are offset in phase so a lane swap at the right
moment chains three open windows.

| #   | shape | pos x, y, z            | size x, y, z  | rot | surface | colour    | grab | pattern | note                                     |
| --- | ----- | ---------------------- | ------------- | --- | ------- | --------- | ---- | ------- | ---------------------------------------- |
| 4.1 | box   | 0, −0.5, 210           | 18, 1, 2      | —   | normal  | secondary |      | none    | entry sill z 209–211                     |
| 4.2 | box   | −7 / 0 / 7, −0.5, 245  | 4, 1, 68      | —   | normal  | primary   |      | none    | 3 lanes z 211–279                        |
| 4.3 | box   | 0, −0.5, 233           | 18, 1, 2      | —   | normal  | secondary |      | stripes | cross-bridge 1                           |
| 4.4 | box   | 0, −0.5, 257           | 18, 1, 2      | —   | normal  | secondary |      | stripes | cross-bridge 2                           |
| 4.5 | box   | 0, −0.5, 283           | 20, 1, 8      | —   | normal  | safe      |      | none    | exit pad z 279–287                       |
| 4.6 | box   | ±9.5, 4, 245           | 1, 8, 76      | —   | normal  | neutral   |      | none    | hall walls ×2 (banners)                  |
| 4.7 | box   | ±2.1 / ±4.9, 0.02, 245 | 0.2, 0.04, 68 | —   | normal  | danger    |      | hazard  | hazard stripes on the 4 pit edges (deco) |

| id           | type           | pos                    | rot | params                                                                                                                           |
| ------------ | -------------- | ---------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------- |
| s4-hamL-1..3 | pendulumHammer | −7, 0, 221 / 245 / 269 | —   | pivotHeight 8, armLength 6.5, headRadius 1.0, headLength 2.4, amplitudeDeg 45, period 2.4, swingAxis z, phases 0 / 0.33 / 0.66   |
| s4-ramC-1..3 | pendulumHammer | 0, 0, 221 / 245 / 269  | —   | pivotHeight 8, armLength 6.5, headRadius 1.0, headLength 3.6, amplitudeDeg 50, period 2.8, swingAxis x, phases 0.5 / 0.83 / 0.16 |
| s4-hamR-1..3 | pendulumHammer | 7, 0, 221 / 245 / 269  | —   | as hamL, phases 0.16 / 0.5 / 0.83                                                                                                |

#### §5 Rampart Climb (z 287 → 341)

Left: a 12 m ramp (0 → 8 m, 12°) with barrels rolling down two lanes. Right: a
"ladder" of three 2.2 m grab ledges and a 1.4 m jump — no barrels, needs climbing.

| #    | shape   | pos x, y, z                         | size x, y, z | rot | surface | colour    | grab | pattern | note                             |
| ---- | ------- | ----------------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | -------------------------------- |
| 5.1  | ramp    | −3, 4, 306                          | 12, 8, 38    | —   | normal  | primary   |      | none    | barrel ramp x −9…3, z 287–325    |
| 5.2  | box     | 7, 0.6, 291                         | 6, 3.2, 8    | —   | normal  | secondary | ✓    | none    | ledge 1 top 2.2 (z 287–295)      |
| 5.3  | box     | 7, 1.7, 299                         | 6, 5.4, 8    | —   | normal  | secondary | ✓    | none    | ledge 2 top 4.4                  |
| 5.4  | box     | 7, 2.8, 307                         | 6, 7.6, 8    | —   | normal  | secondary | ✓    | none    | ledge 3 top 6.6                  |
| 5.5  | box     | 7, 3.5, 318                         | 6, 9, 14     | —   | normal  | secondary |      | none    | ledge 4 top 8 (z 311–325)        |
| 5.6  | box     | 7, 2.2 / 4.4 / 6.6, 287 / 295 / 303 | 6, 0.3, 0.3  | —   | normal  | accent    | ✓    | none    | yellow grab lips ×3              |
| 5.7  | box     | 0, 7.5, 333                         | 22, 1, 16    | —   | normal  | safe      |      | none    | battlement deck z 325–341, top 8 |
| 5.8  | box     | 0, 8.01, 333                        | 22, 0.02, 2  | —   | normal  | safe      |      | checker | cp-3 pad                         |
| 5.9  | box     | 3.5, 4.5, 306                       | 1, 9, 38     | —   | normal  | neutral   |      | none    | divider wall ramp/ladder         |
| 5.10 | box ×10 | x ±10.5, 9, 325–341                 | 1, 2, 1.2    | —   | normal  | neutral   |      | none    | crenellations (deco)             |

| id          | type           | pos       | rot | params                                                                                                                                                                |
| ----------- | -------------- | --------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s5-barrel-L | boulderLane    | −6, 0, 0  | —   | path [(0, 9.2, 326), (0, 1.2, 287), (0, 1.2, 285)], ballRadius 1.2, speed 8, spawnInterval 3.5, phase 0, maxBalls 4, knockImpulse 10 (barrel mesh, rolls on its side) |
| s5-barrel-C | boulderLane    | 0, 0, 0   | —   | as barrel-L, phase 0.5                                                                                                                                                |
| s5-cpgate   | checkpointGate | 0, 8, 333 | —   | width 22                                                                                                                                                              |

Barrels pop at z 285 against a hay-bale stop (deco). Barrel lanes at x −6 and 0 in
a 12 m ramp ⇒ 1.8 m and 3.0 m dodge strips at x −9…−7.2 / −4.8…−1.2 / 1.2…3.

#### §6 The Highway (z 341 → 432)

The namesake. A 3 m bridge in three spans with two round rest towers. Four
across-swinging hammers, then a 7-stone collapsing tail before the courtyard.

| #   | shape       | pos x, y, z      | size x, y, z  | rot | surface | colour  | grab | pattern | note                         |
| --- | ----------- | ---------------- | ------------- | --- | ------- | ------- | ---- | ------- | ---------------------------- |
| 6.1 | box         | 0, 7.5, 353.5    | 3, 1, 25      | —   | normal  | primary |      | none    | span A z 341–366             |
| 6.2 | cylinder    | 0, 7.5, 370      | 4, 1, —       | —   | normal  | safe    | ✓    | none    | tower T1 top (z 366–374)     |
| 6.3 | box         | 0, 7.5, 386      | 3, 1, 24      | —   | normal  | primary |      | none    | span B z 374–398             |
| 6.4 | cylinder    | 0, 7.5, 402      | 4, 1, —       | —   | normal  | safe    | ✓    | none    | tower T2 top (z 398–406)     |
| 6.5 | cylinder ×2 | 0, −3, 370 / 402 | 3.6, 20, —    | —   | normal  | neutral |      | none    | tower shafts (deco, collide) |
| 6.6 | box         | ±1.45, 8.02, 386 | 0.1, 0.04, 91 | —   | normal  | danger  |      | hazard  | edge stripes (deco)          |
| 6.7 | box         | 0, 7.5, 426      | 24, 1, 12     | —   | normal  | safe    |      | none    | courtyard apron z 420–432    |
| 6.8 | box         | 0, 8.01, 424     | 24, 0.02, 2   | —   | normal  | safe    |      | checker | cp-4 pad                     |

| id        | type             | pos       | rot | params                                                                                                                          |
| --------- | ---------------- | --------- | --- | ------------------------------------------------------------------------------------------------------------------------------- |
| s6-ham-1  | pendulumHammer   | 0, 8, 348 | —   | pivotHeight 10, armLength 8, headRadius 1.1, headLength 2.4, amplitudeDeg 60, period 3.0, swingAxis z, phase 0, knockImpulse 13 |
| s6-ham-2  | pendulumHammer   | 0, 8, 358 | —   | as ham-1, phase 0.5                                                                                                             |
| s6-ham-3  | pendulumHammer   | 0, 8, 381 | —   | as ham-1, phase 0.25                                                                                                            |
| s6-ham-4  | pendulumHammer   | 0, 8, 391 | —   | as ham-1, phase 0.75                                                                                                            |
| s6-tail   | collapsingBridge | 0, 8, 413 | —   | segmentCount 7, segmentLength 2, width 3, thickness 0.6, mode touch, shakeTime 0.6, respawnTime 4 (z 406–420)                   |
| s6-cpgate | checkpointGate   | 0, 8, 424 | —   | width 24                                                                                                                        |

Hammer pairs are half a period apart and 10 m apart (≈ 1.1 s run): cross the
first as it leaves, and the second is just leaving too. Rest towers (8 m Ø) are
the breathing spots the camera frames during the flyover.

#### §7 Throne Run (z 432 → 492)

| #   | shape | pos x, y, z  | size x, y, z | rot | surface | colour  | grab | pattern | note                              |
| --- | ----- | ------------ | ------------ | --- | ------- | ------- | ---- | ------- | --------------------------------- |
| 7.1 | box   | 0, 7.5, 451  | 24, 1, 38    | —   | normal  | primary |      | checker | courtyard z 432–470               |
| 7.2 | ramp  | 0, 9, 476    | 16, 2, 12    | —   | normal  | accent  |      | none    | dais steps-ramp z 470–482, 8 → 10 |
| 7.3 | box   | 0, 9.5, 487  | 22, 1, 10    | —   | normal  | safe    |      | checker | throne platform z 482–492, top 10 |
| 7.4 | box   | 0, 13, 491.5 | 4, 6, 1      | —   | normal  | accent  |      | none    | giant throne back (deco)          |
| 7.5 | box   | ±16, 11, 460 | 6, 6, 40     | —   | normal  | neutral |      | stripes | royal crowd stands (deco)         |

| id         | type           | pos        | rot | params                                                                                                                         |
| ---------- | -------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------ |
| s7-royal-1 | pendulumHammer | 0, 8, 444  | —   | pivotHeight 16, armLength 13, headRadius 2.0, headLength 6, amplitudeDeg 55, period 4.0, swingAxis z, phase 0, knockImpulse 15 |
| s7-royal-2 | pendulumHammer | 0, 8, 458  | —   | as royal-1, phase 0.5                                                                                                          |
| s7-guard-L | bumperPillar   | −8, 8, 451 | —   | radius 1.0, height 2.4, bounceImpulse 10, moveAxis z, moveAmplitude 6, movePeriod 3.0                                          |
| s7-guard-R | bumperPillar   | 8, 8, 451  | —   | as guard-L, phase 0.5                                                                                                          |
| s7-finish  | finishLine     | 0, 10, 486 | —   | width 22                                                                                                                       |

Royal hammer danger band |x| < 4.5 m (6 m-long head). Outer lanes are hammer-
free but patrolled by the moving guard bumpers — every route costs something.

#### Triggers

| id     | kind       | pos        | size      | index | respawn points                   | yaw |
| ------ | ---------- | ---------- | --------- | ----- | -------------------------------- | --- |
| cp-0   | checkpoint | 0, 2, 0    | 26, 4, 20 | 0     | spawn grid                       | 0   |
| cp-1   | checkpoint | 0, 2, 124  | 20, 4, 2  | 1     | x ±7.5/±4.5/±1.5, y 0.1, z 126.5 | 0   |
| cp-2   | checkpoint | 0, 2, 202  | 24, 4, 2  | 2     | x ±7.5/±4.5/±1.5, y 0.1, z 205   | 0   |
| cp-3   | checkpoint | 0, 10, 333 | 22, 4, 2  | 3     | x ±7.5/±4.5/±1.5, y 8.1, z 336   | 0   |
| cp-4   | checkpoint | 0, 10, 424 | 24, 4, 2  | 4     | x ±7.5/±4.5/±1.5, y 8.1, z 427   | 0   |
| finish | finish     | 0, 12, 486 | 22, 4, 2  | 0     | —                                | 0   |

#### Spawn

origin (0, 0.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (9 s)

| #   | camera       | look-at                           |
| --- | ------------ | --------------------------------- |
| 0   | 0, 14, −22   | 0, 4, 20                          |
| 1   | 18, 10, 92   | 0, 2, 92                          |
| 2   | −24, 20, 165 | 0, 2, 165                         |
| 3   | 0, 26, 230   | 0, 0, 250                         |
| 4   | 20, 18, 305  | 0, 5, 310                         |
| 5   | −14, 14, 360 | 0, 9, 386 (low along the Highway) |
| 6   | 0, 24, 510   | 0, 10, 470                        |

#### Bot nav

| id              | pos              | r   | next          | action     | timeAgainst                       | note                                                                                                          |
| --------------- | ---------------- | --- | ------------- | ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0               | 0, 0, 6          | 3   | 1, 2, 3       | run        |                                   | bridge = least crowded                                                                                        |
| 1 / 2 / 3       | (−8/0/8), 0, 24  | 1   | 4 / 5 / 6     | waitForGap | s1-ham-L / C / R                  |                                                                                                               |
| 4 / 5 / 6       | (−8/0/8), 0, 50  | 1.5 | 7             | run        |                                   |                                                                                                               |
| 7               | 0, 0, 62         | 2   | 100           | run        |                                   |                                                                                                               |
| 100             | 0, 0, 68         | 1.2 | 101           | waitForGap | s2-ram-1                          | go when ram head is moving +Z past the pivot (chase it)                                                       |
| 101             | 0, 0, 82         | 1.2 | 102           | waitForGap | s2-ram-2                          |                                                                                                               |
| 102             | 0, 0, 96         | 1.2 | 103           | waitForGap | s2-ram-3                          |                                                                                                               |
| 103             | 0, 0, 125        | 3   | 200, 201      | run        |                                   |                                                                                                               |
| 200 / 201       | ∓6, 0, 130       | 1   | 202 / 203     | run        |                                   | causeway rule: never step onto a shaking stone; if the stone ahead is down: Sharp jumpDive (4 m), others wait |
| 202 / 203       | ∓6, 0, 145       | 1   | 204 / 205     | waitForGap | s3-giant-1                        | outer strip preferred (x ±6)                                                                                  |
| 204 / 205       | ∓6, 0, 171       | 1   | 206           | waitForGap | s3-giant-2                        |                                                                                                               |
| 206             | 0, 0, 204        | 3   | 300, 301, 302 | run        |                                   | lane choice uniform                                                                                           |
| 300 / 301 / 302 | (−7/0/7), 0, 214 | 1   | 310           | waitForGap | s4-hamL-1 / s4-ramC-1 / s4-hamR-1 |                                                                                                               |
| 310             | lane, 0, 233     | 1   | 311           | run        |                                   | Sharp: switch to the lane whose next hammer is open (cross-bridge)                                            |
| 311             | lane, 0, 239     | 1   | 312           | waitForGap | s4-*-2 (current lane)             |                                                                                                               |
| 312             | lane, 0, 257     | 1   | 313           | run        |                                   |                                                                                                               |
| 313             | lane, 0, 263     | 1   | 314           | waitForGap | s4-*-3                            |                                                                                                               |
| 314             | 0, 0, 283        | 3   | 400, 410      | run        |                                   | ramp / ladder: C 90/10 · A 60/40 · S 40/60                                                                    |
| 400             | −7.5, 0, 288     | 1.5 | 401           | run        |                                   | barrel dodge: stay in strip x −8 or −2.4                                                                      |
| 401             | −2.4, 8, 324     | 1.5 | 420           | run        |                                   |                                                                                                               |
| 410             | 7, 0, 286        | 1   | 411           | grab       |                                   | ledge 1                                                                                                       |
| 411             | 7, 2.2, 293.5    | 1   | 412           | grab       |                                   | ledge 2                                                                                                       |
| 412             | 7, 4.4, 301.5    | 1   | 413           | grab       |                                   | ledge 3                                                                                                       |
| 413             | 7, 6.6, 309.5    | 1   | 414           | jump       |                                   | +1.4                                                                                                          |
| 414             | 7, 8, 322        | 1.5 | 420           | run        |                                   |                                                                                                               |
| 420             | 0, 8, 337        | 2   | 500           | run        |                                   |                                                                                                               |
| 500             | 0, 8, 342        | 0.8 | 501           | waitForGap | s6-ham-1                          | Highway: hug the centre line                                                                                  |
| 501             | 0, 8, 353        | 0.8 | 502           | waitForGap | s6-ham-2                          |                                                                                                               |
| 502             | 0, 8, 370        | 2   | 503           | run        |                                   | tower 1                                                                                                       |
| 503             | 0, 8, 375        | 0.8 | 504           | waitForGap | s6-ham-3                          |                                                                                                               |
| 504             | 0, 8, 386        | 0.8 | 505           | waitForGap | s6-ham-4                          |                                                                                                               |
| 505             | 0, 8, 402        | 2   | 506           | run        |                                   | tower 2; wait if tail segments are down                                                                       |
| 506             | 0, 8, 421        | 1.5 | 600           | run        |                                   |                                                                                                               |
| 600             | 0, 8, 435        | 3   | 601, 602, 603 | run        |                                   | centre (time hammers) / left / right guards                                                                   |
| 601             | 0, 8, 439        | 1.5 | 604           | waitForGap | s7-royal-1                        |                                                                                                               |
| 604             | 0, 8, 453        | 1.5 | 610           | waitForGap | s7-royal-2                        |                                                                                                               |
| 602 / 603       | ∓8, 8, 440       | 1.5 | 605 / 606     | waitForGap | s7-guard-L / R                    |                                                                                                               |
| 605 / 606       | ∓8, 8, 466       | 1.5 | 610           | run        |                                   |                                                                                                               |
| 610             | 0, 8, 469        | 3   | 611           | run        |                                   |                                                                                                               |
| 611             | 0, 10, 486       | 4   | —             | run        |                                   | finish                                                                                                        |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.1, 1.2, 1.3, 1.4]** — hammer periods ÷, barrel speed,
causeway timedPeriod ÷ (downTime fixed at 2 s), guard periods ÷.

| id                 | weight | weather | description                                                     | overrides                                                                                               |
| ------------------ | ------ | ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `royal-procession` | 4      | clear   | As authored.                                                    | —                                                                                                       |
| `storm-siege`      | 2      | stormy  | Wind and lightning; Highway hammers get gusts.                  | add `w-crosswind` fanZone (−12, 8, 386) sizeX 3 sizeY 8 sizeZ 90, direction (1,0,0), force 5, gust true |
| `jesters-joke`     | 2      | clear   | Hammers in phase lock-step: whole rows open and close together. | `s4-hamL-*`, `s4-ramC-*`, `s4-hamR-*`: phase 0 · `s6-ham-1..4`: phase 0, period 3.4                     |
| `crumbling-keep`   | 1      | sunset  | More stones drop on the causeway; Highway tail is longer.       | `s3-cause-L/R`: dropFraction 0.45 · `s6-tail`: shakeTime 0.4                                            |
| `night-watch`      | 1      | night   | Torch-lit; hammers have glowing heads; rams faster.             | `s2-ram-1..3`: period 2.8                                                                               |

#### Set dressing & lighting

- Toy castle on a floating island: bunting, pennant flags on every tower, a
  dragon-shaped hot-air balloon, jousting-tent crowd stands, moat with rubber
  ducks (deco), a waterfall pouring off the island edge, cardboard-cutout
  clouds on sticks in the distance (theatrical jester stage feel).
- Sun azimuth 120°, elevation 48°, colour `#fff1d6`. Fog light lilac near 110 / far 620. Banners in the Hall use team-neutral heraldry (no team colours).
- Readability: hammer heads are `danger` with a hazard band; their shadows are
  sharpened (blob shadow under each head projected onto the deck) so players can
  read swing position from below.

#### Sanity checks

| Hardest move       | Value                   | Envelope                               |
| ------------------ | ----------------------- | -------------------------------------- |
| Causeway hole jump | 4 m (one dropped stone) | jump+dive ≤ 5.5 ✓; optional (wait 2 s) |
| Ladder ledges      | +2.2 m ×3               | grab ≤ 2.6 ✓                           |
| Ladder 3 → 4       | +1.4 m                  | jump ≤ 1.8 ✓                           |
| Highway width      | 3 m                     | standard minimum ✓                     |

- **Completion:** competent ≈ 105 s (§1 7 · §2 10 · §3 12 · §4 14 · §5 9 · §6 16 ·
  §7 9 + ~28 s waiting/hits). Sharp bot 120 s, Average 140 s, Clumsy 185 s.
- **Pacing (40, ratio 0.6 ⇒ 24):** first ≈ 95 s; 24th ≈ 145 s. The Highway is the
  main sorter — expect 30–40 % of players to fall there at least once.

---

### R6 — Wind Tunnel Peaks

| Field         | Value                                              |
| ------------- | -------------------------------------------------- |
| id            | `wind-tunnel-peaks`                                |
| name          | Wind Tunnel Peaks                                  |
| type          | `race`                                             |
| theme         | `space`                                            |
| players       | min 10 · max 50 · ideal 36                         |
| qualification | mode `finish`, ratio 0.65                          |
| duration      | 270 s, overtime 0                                  |
| fallBehavior  | `respawnCheckpoint`                                |
| killY         | −10 (plus `void-high` slab under the upper course) |
| bounds        | min (−40, −15, −25) · max (40, 100, 440)           |
| music         | `mus_space_orbitparty`                             |
| cameraMode    | `orbit`                                            |
| decorSeed     | 1601                                               |

**Objective:** `Ride the winds to the top of the sky!` (37 chars)

**Tips:**

1. Glowing columns are updrafts. Jump in and drift onto the ledge.
2. Hide behind rocks when the gust lights turn red.
3. In the purple low-gravity zone you jump much, much farther.

**Fantasy & moments.** A vertical climb up floating peaks that rise from a
sunny sky, through the clouds, into a starry orbit. The sky literally darkens
as you climb (sky gradient keyed to player height — see ART_DIRECTION space).

1. **Updraft Elevator** — a stack of Tumblers rising in a glowing column,
   flailing, while others leapfrog them with a bounce pad.
2. **Gust Gallery Dominoes** — the gust light flips red; anyone not behind a
   wind-break slides across the floor and off the open side.
3. **Jetstream Freeze** — a ramp of Tumblers all freezing behind rocks at the
   same moment, then sprinting together when the wind drops.
4. **Moonwalk** — first time in the low-G zone: comically long, slow-motion
   jumps between drifting asteroids.
5. **The Big Lift** — the final updraft cuts out for 1.5 s; a whole column of
   Tumblers drops back to the deck one metre short of the finish.

#### Layout overview

| §   | Name                 | Z range   | Y       | Tests                                 | Checkpoint                 |
| --- | -------------------- | --------- | ------- | ------------------------------------- | -------------------------- |
| 0   | Launch Pad           | −10 → 10  | 0       | —                                     | cp-0                       |
| 1   | Breezy Base          | 10 → 50   | 0 → 6   | 3 ways up: pad / updraft / steps      | —                          |
| 2   | Gust Gallery         | 50 → 110  | 6       | timed side gusts + wind-breaks        | —                          |
| 3   | Thermal Stairs       | 110 → 187 | 12 → 30 | updraft route vs jump/grab route      | cp-1 (z 116), cp-2 (z 172) |
| 4   | Satellite Spin       | 187 → 263 | 30      | spinning dishes + shuttle             | cp-3 (z 248)               |
| 5   | Jetstream            | 263 → 325 | 30 → 48 | pulsing headwind ramp                 | cp-4 (z 317)               |
| 6   | Asteroid Hop (low-G) | 325 → 400 | 48 → 52 | long floaty jumps, moving rocks       | cp-5 (z 390)               |
| 7   | The Big Lift         | 400 → 425 | 52 → 64 | final pulsing updraft vs ledge ladder | finish (z 412)             |

#### §0 Launch Pad

Standard start plaza with a launch-pad decal (`safe`, `checker`); back wall is a
rocket gantry (deco). `s0-gate` startGate (0, 0, 7), width 26.

#### §1 Breezy Base (z 10 → 50)

Teach the three verbs of the round in a safe, fall-free space: bounce pad (centre),
updraft (left), staircase (right). All lead onto Terrace 1 (top 6).

| #   | shape    | pos x, y, z    | size x, y, z | rot | surface | colour    | grab | pattern | note                                 |
| --- | -------- | -------------- | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------------ |
| 1.1 | box      | 0, −0.5, 20    | 26, 1, 20    | —   | normal  | primary   |      | none    | floor z 10–30                        |
| 1.2 | box      | 0, 2.5, 40     | 26, 7, 20    | —   | normal  | secondary | ✓    | none    | Terrace 1, top 6, z 30–50 (6 m face) |
| 1.3 | box      | 11, 0.75, 28.5 | 3, 1.5, 3    | —   | normal  | accent    |      | none    | step 1 top 1.5                       |
| 1.4 | box      | 8, 1.5, 28.5   | 3, 3, 3      | —   | normal  | accent    |      | none    | step 2 top 3.0                       |
| 1.5 | box      | 5, 2.25, 28.5  | 3, 4.5, 3    | —   | normal  | accent    |      | none    | step 3 top 4.5 (→ terrace +1.5)      |
| 1.6 | cylinder | −8, 0.02, 28.5 | 1.6, 0.04, — | —   | normal  | safe      |      | dots    | updraft floor ring (deco)            |

| id      | type      | pos         | rot | params                                                                                          |
| ------- | --------- | ----------- | --- | ----------------------------------------------------------------------------------------------- |
| s1-pad  | bouncePad | 0, 0, 24    | —   | radius 1.4, targetApex 8, targetRange 10, landingDelta 6                                        |
| s1-lift | fanZone   | −8, 0, 28.5 | —   | sizeX 3, sizeY 8.5, sizeZ 3, direction (0,1,0), gravityFraction 1.7, visual updraft (always on) |

Updraft exit: at the column top (y ≈ 8.5) players drift forward 1.5 m onto the
terrace (front face z 30).

#### §2 Gust Gallery (z 50 → 110)

A 10 m corridor with a fan wall on the left (x −5) and an **open void side** on
the right. Four gust zones pulse (2 s on / 2 s off, staggered). Wind-break rocks
give shelter. At the end, a 6 m wall: two updrafts and a centre pad lift you to
Terrace 2.

| #   | shape | pos x, y, z                   | size x, y, z  | rot | surface | colour    | grab | pattern | note                                    |
| --- | ----- | ----------------------------- | ------------- | --- | ------- | --------- | ---- | ------- | --------------------------------------- |
| 2.1 | box   | 0, 5.5, 80                    | 10, 1, 60     | —   | normal  | primary   |      | none    | gallery floor x −5…5                    |
| 2.2 | box   | −5.5, 9, 80                   | 1, 8, 60      | —   | normal  | neutral   |      | none    | fan wall (deco fans set in it)          |
| 2.3 | box   | 4.8, 6.02, 80                 | 0.4, 0.04, 60 | —   | normal  | danger    |      | hazard  | open-edge stripe                        |
| 2.4 | box   | −2.5, 7.25, 62 / 74 / 86 / 98 | 3, 2.5, 1.5   | —   | normal  | secondary |      | none    | wind-break rocks ×4 (x −4…−1)           |
| 2.6 | box   | 0, 5.5, 120                   | 16, 13, 20    | —   | normal  | secondary | ✓    | none    | Terrace 2 top 12, z 110–130 (bottom −1) |
| 2.7 | box   | 0, 12.01, 116                 | 16, 0.02, 2   | —   | normal  | safe      |      | checker | cp-1 pad                                |

| id        | type           | pos          | rot | params                                                                                                |
| --------- | -------------- | ------------ | --- | ----------------------------------------------------------------------------------------------------- |
| s2-gust-1 | fanZone        | 0, 6, 59     | —   | sizeX 10, sizeY 4, sizeZ 10, direction (1,0,0), force 14, onTime 2, offTime 2, telegraph 0.8, phase 0 |
| s2-gust-2 | fanZone        | 0, 6, 71     | —   | as gust-1, phase 0.25                                                                                 |
| s2-gust-3 | fanZone        | 0, 6, 83     | —   | as gust-1, phase 0.5                                                                                  |
| s2-gust-4 | fanZone        | 0, 6, 95     | —   | as gust-1, phase 0.75                                                                                 |
| s2-lift-L | fanZone        | −3, 6, 108.5 | —   | sizeX 3, sizeY 8, sizeZ 3, direction (0,1,0), gravityFraction 1.7, visual updraft                     |
| s2-lift-R | fanZone        | 3, 6, 108.5  | —   | as lift-L                                                                                             |
| s2-pad    | bouncePad      | 0, 6, 103    | —   | radius 1.2, targetApex 8, targetRange 10, landingDelta 6                                              |
| s2-cpgate | checkpointGate | 0, 12, 116   | —   | width 16                                                                                              |

Gust drift: 14 m/s² for 2 s on a walking player ≈ 6–8 m of push if you just
stand there — always enough to reach the open edge from anywhere in the 10 m
corridor. Shelter or keep running.

#### §3 Thermal Stairs (z 130 → 187)

Two routes from Terrace 2 (y 12) to Terrace 3 (y 30):
**Left (jumper):** updraft → island I2 (18) → bounce pad → I3 (24) → +1.5 block →
+2.2 grab block → +2.3 grab onto T3. **Right (rider):** three pulsing updrafts
between ledges R1 (18), R2 (24), R3 (30). Riders wait for the pulse.

| #    | shape    | pos x, y, z                                | size x, y, z | rot | surface | colour    | grab | pattern | note                                                      |
| ---- | -------- | ------------------------------------------ | ------------ | --- | ------- | --------- | ---- | ------- | --------------------------------------------------------- |
| 3.1  | cylinder | −6, 16, 138                                | 5, 4, —      | —   | normal  | primary   | ✓    | none    | island I2 top 18 (z 133–143)                              |
| 3.2  | cylinder | −6, 22, 152                                | 5, 4, —      | —   | normal  | primary   | ✓    | none    | island I3 top 24 (z 147–157)                              |
| 3.3  | box      | −6, 24.5, 161                              | 6, 2, 4      | —   | normal  | accent    | ✓    | none    | block B1 top 25.5 (z 159–163), gap 2 from I3, +1.5        |
| 3.4  | box      | −6, 25.6, 165                              | 6, 4.2, 4    | —   | normal  | accent    | ✓    | none    | block B2 top 27.7 (z 163–167), +2.2 grab                  |
| 3.5  | box      | 6, 16, 137                                 | 6, 4, 6      | —   | normal  | secondary | ✓    | none    | ledge R1 top 18 (z 134–140)                               |
| 3.6  | box      | 6, 22, 148                                 | 6, 4, 8      | —   | normal  | secondary | ✓    | none    | ledge R2 top 24 (z 144–152)                               |
| 3.7  | box      | 6, 28, 159.5                               | 6, 4, 7      | —   | normal  | secondary | ✓    | none    | ledge R3 top 30 (z 156–163)                               |
| 3.8  | box      | 6, 28, 165                                 | 6, 4, 4      | —   | normal  | secondary |      | none    | R3 → T3 joiner (z 163–167)                                |
| 3.9  | box      | 0, 26, 177                                 | 20, 8, 20    | —   | normal  | secondary | ✓    | none    | Terrace 3 top 30 (z 167–187)                              |
| 3.10 | box      | 0, 30.01, 172                              | 20, 0.02, 2  | —   | normal  | safe      |      | checker | cp-2 pad                                                  |
| 3.11 | sphere   | under each island/ledge, 3 m below its top | 4            | —   | normal  | neutral   |      | none    | floating rock undersides (deco; render squashed 0.6 in Y) |

| id         | type           | pos          | rot | params                                                                                                                           |
| ---------- | -------------- | ------------ | --- | -------------------------------------------------------------------------------------------------------------------------------- |
| s3-lift-I  | fanZone        | −6, 12, 131  | —   | sizeX 4, sizeY 8, sizeZ 3, direction (0,1,0), gravityFraction 1.7, visual updraft (always on) — lifts from T2 edge onto I2       |
| s3-pad-I   | bouncePad      | −6, 18, 140  | —   | radius 1.2, targetApex 7, targetRange 10, landingDelta 6                                                                         |
| s3-lift-R1 | fanZone        | 6, 12, 131.5 | —   | sizeX 4, sizeY 8, sizeZ 3, direction (0,1,0), gravityFraction 1.7, onTime 3, offTime 1.5, telegraph 1.0, phase 0, visual updraft |
| s3-lift-R2 | fanZone        | 6, 18, 141.5 | —   | as R1, sizeY 8 (18 → 26), phase 0.33                                                                                             |
| s3-lift-R3 | fanZone        | 6, 24, 153.5 | —   | as R1, sizeY 8 (24 → 32), phase 0.66                                                                                             |
| s3-cpgate  | checkpointGate | 0, 30, 172   | —   | width 20                                                                                                                         |

Route timings: left ≈ 11 s (2 jumps, 1 pad, 2 grabs); right ≈ 9–14 s depending
on pulse luck. Both end at Terrace 3.

#### §4 Satellite Spin (z 187 → 263)

Two spinning radar dishes (the second in a crosswind), then a shuttle platform.

| #   | shape       | pos x, y, z      | size x, y, z | rot | surface | colour  | grab | pattern | note                        |
| --- | ----------- | ---------------- | ------------ | --- | ------- | ------- | ---- | ------- | --------------------------- |
| 4.1 | box         | 0, 29.5, 253     | 22, 1, 20    | —   | normal  | safe    |      | none    | Terrace 4 z 243–263, top 30 |
| 4.2 | box         | 0, 30.01, 248    | 22, 0.02, 2  | —   | normal  | safe    |      | checker | cp-3 pad                    |
| 4.3 | cylinder ×2 | 0, 22, 197 / 214 | 1, 16, —     | —   | normal  | neutral |      | stripes | dish masts (deco)           |

| id         | type           | pos        | rot | params                                                                                                  |
| ---------- | -------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------- |
| s4-dish-1  | spinningDisc   | 0, 30, 197 | —   | radius 7, thickness 0.8, angularSpeed 0.7, bumpCount 3, bumpRadius 0.8, bumpHeight 1.4                  |
| s4-dish-2  | spinningDisc   | 0, 30, 214 | —   | radius **7.5**, angularSpeed −0.9, bumpCount 0                                                          |
| s4-wind-2  | fanZone        | 0, 30, 214 | —   | sizeX 18, sizeY 4, sizeZ 14, direction (1,0,0), force 8, gust true                                      |
| s4-shuttle | movingPlatform | 0, 30, 226 | —   | sizeX 6, sizeY 0.8, sizeZ 6, path [(0,0,0), (0,0,12)], period 5, ease sine, pingPong true, holdTime 1.0 |
| s4-cpgate  | checkpointGate | 0, 30, 248 | —   | width 22                                                                                                |

Gaps: T3 (187) → dish 1 (190) 3.0 m; dish 1 (204) → dish 2 (206.5) 2.5 m (moving ↔
moving limit 2.5 ✓); dish 2 (221.5) → shuttle near end (223) 1.5 m; shuttle far end (241) → T4 (243) 2.0 m.

#### §5 Jetstream (z 263 → 325)

An 18° ramp (30 → 48 m) under a pulsing headwind. Comet rocks give shelter in a
staggered line. The gust light (red/green) is mounted on an overhead gantry
every 12 m.

| #   | shape | pos x, y, z                                          | size x, y, z | rot | surface | colour    | grab | pattern | note                                    |
| --- | ----- | ---------------------------------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | --------------------------------------- |
| 5.1 | ramp  | 0, 39, 288                                           | 12, 18, 50   | —   | normal  | primary   |      | chevron | jetstream ramp z 263–313, 30 → 48       |
| 5.2 | box   | (3, 37.85, 278) / (−3, 42.17, 290) / (3, 46.49, 302) | 3, 2.5, 2    | —   | normal  | secondary |      | none    | comet rocks ×3 (bases sit on the slope) |
| 5.3 | ramp  | ±6.25, 40, 288                                       | 0.5, 20, 50  | —   | normal  | neutral   |      | none    | side walls ×2 (top ~2 m above ramp)     |
| 5.4 | box   | 0, 47.5, 319                                         | 20, 1, 12    | —   | normal  | safe      |      | none    | Terrace 5 z 313–325, top 48             |
| 5.5 | box   | 0, 48.01, 317                                        | 20, 0.02, 2  | —   | normal  | safe      |      | checker | cp-4 pad                                |

Ramp surface at z is 30 + 0.36·(z − 263); rock centres = surface + 1.25 (the 2 m-deep
rocks are sunk slightly into the slope on their downhill side).

| id        | type           | pos        | rot | params                                                                                                                                |
| --------- | -------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| s5-jet    | fanZone        | 0, 30, 288 | —   | sizeX 12, sizeY 22, sizeZ 50, direction (0,0,−1), force 16, onTime 2.5, offTime 2.0, telegraph 1.0, visual fan (giant fan at the top) |
| s5-cpgate | checkpointGate | 0, 48, 317 | —   | width 20                                                                                                                              |

Wind maths: 16 m/s² against a 9 m/s runner on an 18° slope ⇒ net backward drift;
in 2.5 s an unsheltered player loses ~8–10 m. Calm windows (2 s) cover 18 m —
rock spacing is 12 m, so a rock-to-rock dash always fits a calm window.

#### §6 Asteroid Hop — low-G (z 325 → 400)

The whole section sits in a low-gravity zone (60 % gravity ⇒ ~1.67× jump
distance and height). Five asteroids 5 m apart, two of them drifting.

| #   | shape      | pos x, y, z                         | size x, y, z | rot | surface | colour    | grab | pattern | note                                                                    |
| --- | ---------- | ----------------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | ----------------------------------------------------------------------- |
| 6.1 | cylinder   | 0, 47, 333                          | 3, 2, —      | —   | normal  | secondary | ✓    | dots    | A1 top 48 (z 330–336)                                                   |
| 6.2 | cylinder   | 4, 51, 355                          | 3, 2, —      | —   | normal  | secondary | ✓    | dots    | A3 top 52 (z 352–358)                                                   |
| 6.3 | cylinder   | 0, 51, 377                          | 3, 2, —      | —   | normal  | secondary | ✓    | dots    | A5 top 52 (z 374–380)                                                   |
| 6.4 | box        | 0, 51.5, 396                        | 22, 1, 22    | —   | normal  | safe      |      | none    | Terrace 6 z 385–407, top 52 (extends under the Big Lift and the ladder) |
| 6.5 | box        | 0, 52.01, 390                       | 20, 0.02, 2  | —   | normal  | safe      |      | checker | cp-5 pad                                                                |
| 6.6 | sphere ×12 | random in x ±25, y 40–70, z 325–400 | 1–3          | —   | normal  | neutral   |      | none    | background asteroids (deco, slow tumble)                                |

| id        | type           | pos         | rot | params                                                                                                                                        |
| --------- | -------------- | ----------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| s6-lowg   | fanZone        | 0, 44, 355  | —   | sizeX 30, sizeY 30, sizeZ 60 (z 325–385, y 44–74), direction (0,1,0), gravityFraction 0.4, visual lowG                                        |
| s6-rock-2 | movingPlatform | −4, 50, 344 | —   | shape cylinder, sizeX 3 (radius), sizeY 2, path [(−4,0,0), (4,0,0)], period 4, ease sine, pingPong true, holdTime 0.4 (A2, top 50, z 341–347) |
| s6-rock-4 | movingPlatform | 0, 50, 366  | —   | shape cylinder, sizeX 3, sizeY 2, path [(0,−2,0), (0,2,0)], period 3, ease sine (A4, top 48–52, z 363–369)                                    |
| s6-cpgate | checkpointGate | 0, 52, 390  | —   | width 20                                                                                                                                      |

Gaps (all 5.0 m edge to edge in z): T5 → A1, A1 → A2, A2 → A3, A3 → A4, A4 → A5,
A5 → T6. Low-G design limit = 3.5 × 1.67 = 5.8 m, −0.5 for moving targets = 5.3 ✓.

#### §7 The Big Lift (z 400 → 425)

The finish deck floats 12 m above Terrace 6. The Big Lift updraft carries you up
in ~2 s, but it pulses (3 s on / 1.5 s off, 1 s telegraph): get caught in an
"off" and you drop back to T6 (not lethal — just heartbreaking). The right-side
ledge ladder is slower but certain.

| #    | shape    | pos x, y, z        | size x, y, z  | rot | surface | colour    | grab | pattern | note                                         |
| ---- | -------- | ------------------ | ------------- | --- | ------- | --------- | ---- | ------- | -------------------------------------------- |
| 7.1  | box      | 0, 57.5, 416       | 22, 14, 18    | —   | normal  | secondary | ✓    | none    | finish mesa top 64, z 407–425, bottom 50.5   |
| 7.2  | box      | 8, 53.9, 406.25    | 2.5, 0.6, 1.5 | —   | normal  | accent    | ✓    | none    | shelf 1 top 54.2 (x 6.75–9.25), +2.2 from T6 |
| 7.3  | box      | 10.5, 56.1, 406.25 | 2.5, 0.6, 1.5 | —   | normal  | accent    | ✓    | none    | shelf 2 top 56.4 (x 9.25–11.75)              |
| 7.4  | box      | 8, 58.3, 406.25    | 2.5, 0.6, 1.5 | —   | normal  | accent    | ✓    | none    | shelf 3 top 58.6                             |
| 7.4b | box      | 10.5, 60.5, 406.25 | 2.5, 0.6, 1.5 | —   | normal  | accent    | ✓    | none    | shelf 4 top 60.8                             |
| 7.4c | box      | 8, 62.7, 406.25    | 2.5, 0.6, 1.5 | —   | normal  | accent    | ✓    | none    | shelf 5 top 63.0 → mesa +1.0                 |
| 7.5  | box      | 0, 64.01, 412      | 22, 0.02, 2   | —   | normal  | safe      |      | checker | finish line pad                              |
| 7.6  | cylinder | 0, 70, 422         | 2, 12, —      | —   | normal  | accent    |      | stripes | rocket (deco) with confetti thrusters        |

| id         | type       | pos          | rot | params                                                                                                                                        |
| ---------- | ---------- | ------------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| s7-biglift | fanZone    | 0, 52, 404   | —   | sizeX 6, sizeY 15, sizeZ 6 (y 52–67, z 401–407), direction (0,1,0), gravityFraction 1.8, onTime 3, offTime 1.5, telegraph 1.0, visual updraft |
| s7-nudge   | fanZone    | 0, 63, 405.5 | —   | sizeX 6, sizeY 4, sizeZ 3, direction (0,0,1), force 10 (pushes risers at the top onto the mesa)                                               |
| s7-finish  | finishLine | 0, 64, 412   | —   | width 22                                                                                                                                      |

#### Triggers

| id        | kind       | pos        | size       | index | respawn points                  | yaw |
| --------- | ---------- | ---------- | ---------- | ----- | ------------------------------- | --- |
| cp-0      | checkpoint | 0, 2, 0    | 26, 4, 20  | 0     | spawn grid                      | 0   |
| cp-1      | checkpoint | 0, 14, 116 | 16, 4, 2   | 1     | x ±6/±3.6/±1.2, y 12.1, z 119   | 0   |
| cp-2      | checkpoint | 0, 32, 172 | 20, 4, 2   | 2     | x ±7.5/±4.5/±1.5, y 30.1, z 175 | 0   |
| cp-3      | checkpoint | 0, 32, 248 | 22, 4, 2   | 3     | x ±7.5/±4.5/±1.5, y 30.1, z 251 | 0   |
| cp-4      | checkpoint | 0, 50, 317 | 20, 4, 2   | 4     | x ±7.5/±4.5/±1.5, y 48.1, z 320 | 0   |
| cp-5      | checkpoint | 0, 54, 390 | 20, 4, 2   | 5     | x ±7.5/±4.5/±1.5, y 52.1, z 393 | 0   |
| void-high | void       | 0, 20, 305 | 60, 2, 230 | 0     | —                               | —   |
| finish    | finish     | 0, 66, 412 | 22, 4, 2   | 0     | —                               | 0   |

`void-high` spans z 190–420 at y 19–21: nothing walkable exists below y 30 there.

#### Spawn

origin (0, 0.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (9 s) — ends looking _down_ the climb

| #   | camera       | look-at    |
| --- | ------------ | ---------- |
| 0   | 0, 6, −18    | 0, 6, 30   |
| 1   | 16, 14, 80   | 0, 6, 80   |
| 2   | −18, 26, 150 | 0, 20, 150 |
| 3   | 20, 38, 210  | 0, 30, 205 |
| 4   | −16, 50, 290 | 0, 40, 290 |
| 5   | 18, 60, 360  | 0, 50, 360 |
| 6   | 0, 80, 430   | 0, 30, 250 |

#### Bot nav

| id  | pos             | r   | next          | action     | timeAgainst | note                                                                                    |
| --- | --------------- | --- | ------------- | ---------- | ----------- | --------------------------------------------------------------------------------------- |
| 0   | 0, 0, 6         | 3   | 1, 2, 3       | run        |             | pad / updraft / steps: C 50/30/20 · A 40/30/30 · S 60/20/20                             |
| 1   | 0, 0, 22        | 1   | 10            | run        |             | onto s1-pad                                                                             |
| 2   | −8, 0, 27       | 1   | 10            | jump       |             | into s1-lift, hold forward                                                              |
| 3   | 12, 0, 26       | 1   | 4             | jump       |             |                                                                                         |
| 4   | 11, 1.5, 28.5   | 1   | 5             | jump       |             |                                                                                         |
| 5   | 8, 3, 28.5      | 1   | 6             | jump       |             |                                                                                         |
| 6   | 5, 4.5, 28.5    | 1   | 10            | jump       |             | onto terrace                                                                            |
| 10  | 0, 6, 45        | 3   | 100           | run        |             |                                                                                         |
| 100 | −2.5, 6, 60     | 1.2 | 101           | waitForGap | s2-gust-1   | shelter rule: when a gust zone ahead telegraphs, stop behind the nearest rock (+Z side) |
| 101 | −2.5, 6, 72     | 1.2 | 102           | waitForGap | s2-gust-2   |                                                                                         |
| 102 | −2.5, 6, 84     | 1.2 | 103           | waitForGap | s2-gust-3   |                                                                                         |
| 103 | −2.5, 6, 96     | 1.2 | 104, 105, 106 | waitForGap | s2-gust-4   |                                                                                         |
| 104 | −3, 6, 107      | 1   | 110           | jump       |             | updraft L                                                                               |
| 105 | 0, 6, 101       | 1   | 110           | run        |             | pad                                                                                     |
| 106 | 3, 6, 107       | 1   | 110           | jump       |             | updraft R                                                                               |
| 110 | 0, 12, 122      | 3   | 200, 210      | run        |             | jumper / rider: C 30/70 · A 50/50 · S 70/30                                             |
| 200 | −6, 12, 129     | 1   | 201           | jump       |             | into s3-lift-I                                                                          |
| 201 | −6, 18, 138     | 1.5 | 202           | run        |             | onto s3-pad-I                                                                           |
| 202 | −6, 24, 155     | 1.2 | 203           | jump       |             | B1 +1.5                                                                                 |
| 203 | −6, 25.5, 162   | 1   | 204           | grab       |             | B2 +2.2                                                                                 |
| 204 | −6, 27.7, 166   | 1   | 220           | grab       |             | T3 +2.3                                                                                 |
| 210 | 6, 12, 129      | 1   | 211           | waitForGap | s3-lift-R1  | enter when ≥ 2 s of "on" remain                                                         |
| 211 | 6, 18, 139      | 1   | 212           | waitForGap | s3-lift-R2  |                                                                                         |
| 212 | 6, 24, 151      | 1   | 213           | waitForGap | s3-lift-R3  |                                                                                         |
| 213 | 6, 30, 162      | 1.5 | 220           | run        |             |                                                                                         |
| 220 | 0, 30, 185      | 2   | 300           | jump       |             | 3.0 m to dish 1                                                                         |
| 300 | 0, 30, 197      | 2   | 301           | run        |             |                                                                                         |
| 301 | 0, 30, 203.5    | 1   | 302           | jump       |             | dish 1 → dish 2 (lean into crosswind: aim x −1.5)                                       |
| 302 | −1.5, 30, 214   | 2   | 303           | run        |             |                                                                                         |
| 303 | 0, 30, 220.5    | 1   | 304           | waitForGap | s4-shuttle  | jump when shuttle is at near end                                                        |
| 304 | 0, 30, 226      | 1.5 | 305           | waitForGap | s4-shuttle  | ride; jump at far end                                                                   |
| 305 | 0, 30, 250      | 3   | 400           | run        |             |                                                                                         |
| 400 | 0, 30, 266      | 2   | 401           | waitForGap | s5-jet      | rock-to-rock dashes in calm windows                                                     |
| 401 | 3, 37.6, 280    | 1   | 402           | waitForGap | s5-jet      | behind rock 1 (z +2)                                                                    |
| 402 | −3, 41.9, 292   | 1   | 403           | waitForGap | s5-jet      |                                                                                         |
| 403 | 3, 46.2, 304    | 1   | 404           | waitForGap | s5-jet      |                                                                                         |
| 404 | 0, 48, 320      | 2   | 500           | run        |             |                                                                                         |
| 500 | 0, 48, 324.5    | 1   | 501           | jump       |             | low-G: all jumps from the edge, full hold                                               |
| 501 | 0, 48, 335.5    | 1   | 502           | waitForGap | s6-rock-2   | jump when A2 is at x ≤ −2 → aim its centre                                              |
| 502 | (A2), 50, 346.5 | 1   | 503           | jump       |             |                                                                                         |
| 503 | 4, 52, 357.5    | 1   | 504           | waitForGap | s6-rock-4   |                                                                                         |
| 504 | 0, (A4), 368.5  | 1   | 505           | jump       |             |                                                                                         |
| 505 | 0, 52, 379.5    | 1   | 506           | jump       |             | to T6                                                                                   |
| 506 | 0, 52, 395      | 3   | 600, 610      | run        |             | lift / ladder: C 70/30 · A 60/40 · S 80/20                                              |
| 600 | 0, 52, 403      | 1.2 | 601           | waitForGap | s7-biglift  | enter at the start of an "on" phase                                                     |
| 601 | 0, 64, 410      | 2   | 700           | run        |             |                                                                                         |
| 610 | 9, 52, 401      | 1   | 611           | grab       |             | ladder: 5 grabs then +1 jump                                                            |
| 611 | 9, 63, 406      | 1   | 700           | jump       |             |                                                                                         |
| 700 | 0, 64, 412      | 4   | —             | run        |             | finish                                                                                  |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.06, 1.12, 1.18, 1.24]** — gust/jet/lift periods ÷,
dish ω, shuttle period ÷, rock periods ÷. Gravity fractions are never scaled.

| id              | weight | weather | description                                              | overrides                                                                                                                                                                                                   |
| --------------- | ------ | ------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clear-ascent`  | 4      | clear   | As authored.                                             | —                                                                                                                                                                                                           |
| `solar-storm`   | 2      | stormy  | Stronger, gusty winds everywhere.                        | `s2-gust-1..4`: force 17, gust true · `s5-jet`: force 19, onTime 3.0                                                                                                                                        |
| `deep-space`    | 1      | night   | Starry from the start; low-G zone grows to cover §4 too. | add `s4-lowg` fanZone (0, 26, 225) sizeX 30, sizeY 24, sizeZ 76, direction (0,1,0), gravityFraction 0.4, visual lowG                                                                                        |
| `dead-calm`     | 1      | clear   | All gust fans off; updrafts always on (beginner).        | remove `s2-gust-1..4`, `s5-jet` · `s3-lift-R1..3`, `s7-biglift`: offTime 0                                                                                                                                  |
| `meteor-shower` | 2      | clear   | Space rocks roll across Terrace 4 and 6.                 | add `s4-meteor` boulderLane (0,0,0) path [(−12, 31.2, 253), (12, 31.2, 253)], ballRadius 1.2, speed 7, spawnInterval 3.5 · add `s6-meteor` boulderLane path [(12, 53.2, 395), (−12, 53.2, 395)] same params |

#### Set dressing & lighting

- Altitude-driven sky: y 0–20 bright day (`space` palette "low"), y 20–45
  cloud layer you climb through (instanced flat cloud cards at y 22–28 between
  sections), y 45+ starfield, ringed planet on the horizon, aurora ribbons.
  ART_DIRECTION's space theme defines the blend; renderer interpolates by
  camera Y. Floating peaks have glowing crystal veins; satellites, a space-
  station crowd ring above the finish; rocket launches on finish.
- Sun azimuth 100°, elevation 60° at the bottom, the key light cools toward
  `#c8d4ff` above y 45. Fog thins with altitude (far 500 → 900).
- Readability: updraft columns are visible as spiralling cyan particle tubes
  (`safe`); pulsing ones fade to 20 % and turn red during "off"; gust zones show
  streak particles and a red/green beacon on the fan wall.

#### Sanity checks

| Hardest move        | Value                                                                               | Envelope                               |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| Dish 1 → dish 2     | 2.5 m, both rotating                                                                | moving↔moving limit 2.5 ✓              |
| Ladder shelves      | +2.2 each, shelves alternate x so the one above is never overhead (4.4 m clearance) | grab ✓                                 |
| Low-G asteroid gaps | 5.0 m, Δh +2                                                                        | low-G limit 5.3 ✓                      |
| Ladder ledges       | +2.2 ×5                                                                             | grab ✓                                 |
| Island I3 → B1      | 2.0 m, +1.5                                                                         | ≤ 3.5 − 1.5 = 2.0 ✓ (at limit, static) |
| T3 grab from B2     | +2.3                                                                                | grab ≤ 2.6 ✓                           |

- **Completion:** competent ≈ 105 s (§1 5 · §2 12 · §3 12 · §4 12 · §5 14 · §6 16 ·
  §7 5 + ~29 s waits). Sharp bot 120 s, Average 140 s, Clumsy 180 s.
- **Pacing (36 ⇒ 23):** first ≈ 95 s; 23rd ≈ 150 s. Pulsing lifts compress the
  finish into exciting bunches.

---

### R7 — Cannonball Canyon

| Field         | Value                                   |
| ------------- | --------------------------------------- |
| id            | `cannonball-canyon`                     |
| name          | Cannonball Canyon                       |
| type          | `race`                                  |
| theme         | `beach`                                 |
| players       | min 12 · max 60 · ideal 40              |
| qualification | mode `finish`, ratio 0.65               |
| duration      | 240 s, overtime 0                       |
| fallBehavior  | `respawnCheckpoint`                     |
| killY         | −8                                      |
| bounds        | min (−40, −15, −25) · max (40, 50, 490) |
| music         | `mus_beach_tikitumble`                  |
| cameraMode    | `orbit`                                 |
| decorSeed     | 1701                                    |

**Objective:** `Run the canyon! Dodge the coconut cannons.` (42 chars)

**Tips:**

1. Red rings on the ground show where the next shot lands.
2. Giant balls roll in lanes — hop the low ridges to change lanes.
3. Hide behind crates on the bridge. They block one side only.

**Fantasy & moments.** A tropical canyon run where pirate-parrot cannons lob
foam coconuts and giant beach balls thunder down sandstone lanes. The
spectacle is constant incoming fire with clear landing markers.

1. **Shoreline Splat** — a volley lands in the middle of the starting stampede;
   six Tumblers ragdoll in a starburst.
2. **Lane Hop Panic** — a giant ball in your lane, another in the next: the
   double-hop over two ridges that the crowd tries and botches together.
3. **Crate Huddle** — ten Tumblers crammed behind one crate on the bridge while
   the other side's cannon finds them anyway.
4. **Raft Sniper** — a sweeping cannon picks Tumblers off a moving raft one by
   one; the raft arrives at the island empty.
5. **Treasure Gauntlet** — final straight with six cannons in a ripple volley and
   rolling balls crossing the path; leaders zig-zag as the finish chest opens.

#### Layout overview

| §   | Name              | Z range   | Y       | Tests                                      | Checkpoint     |
| --- | ----------------- | --------- | ------- | ------------------------------------------ | -------------- |
| 0   | Beach Start       | −10 → 10  | 0       | —                                          | cp-0           |
| 1   | Shoreline Shuffle | 10 → 60   | 0       | read landing markers                       | —              |
| 2   | Lane Runner       | 60 → 140  | 0       | giant balls in lanes, ridge hops           | —              |
| 3   | Coconut Crossfire | 140 → 210 | 0       | two-sided cannons, crate shelter           | cp-1 (z 204)   |
| 4   | Boulder Bowl      | 210 → 284 | 0 → 10  | uphill vs 6 m balls, safe centre line      | cp-2 (z 276)   |
| 5   | Raft Run          | 284 → 350 | 10      | moving rafts under sniper fire / rock hops | cp-3 (z 345)   |
| 6   | Sea Stacks        | 350 → 397 | 10 → 16 | ascending stack jumps vs climb wall        | cp-4 (z 381)   |
| 7   | Treasure Gauntlet | 397 → 475 | 16 → 18 | ripple volleys + crossing balls            | finish (z 468) |

#### §0 Beach Start

Standard start plaza in sand (`primary`) with beach-towel stripes; back wall = a
tiki hut row. `s0-gate` startGate (0, 0, 7), width 26, styled as a bamboo fence.

#### §1 Shoreline Shuffle (z 10 → 60)

| #   | shape | pos x, y, z   | size x, y, z | rot | surface | colour    | grab | pattern | note                                            |
| --- | ----- | ------------- | ------------ | --- | ------- | --------- | ---- | ------- | ----------------------------------------------- |
| 1.1 | box   | 0, −0.5, 35   | 30, 1, 50    | —   | normal  | primary   |      | none    | beach z 10–60, x ±15                            |
| 1.2 | box   | −20, 3, 35    | 10, 8, 50    | —   | normal  | secondary |      | none    | left cliff (top 7), cannon perch                |
| 1.3 | box   | 15.5, 0.5, 35 | 1, 1, 50     | —   | normal  | neutral   |      | none    | right rock wall (keeps players out of the surf) |
| 1.4 | box   | 25, −0.6, 35  | 18, 0.2, 80  | —   | normal  | #4fd1ff   |      | none    | surf water (deco)                               |

| id       | type   | pos        | rot    | params                                                                                                                                                                   |
| -------- | ------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| s1-can-1 | cannon | −17, 7, 22 | yaw 90 | fireInterval 3.0, burst 1, targetRange 17, targetApex 10, landingDelta −7, ballRadius 0.8, aim sweep, sweepDeg 30, sweepPeriod 6, phase 0, telegraph 0.9, knockImpulse 9 |
| s1-can-2 | cannon | −17, 7, 37 | yaw 90 | as can-1, phase 0.33                                                                                                                                                     |
| s1-can-3 | cannon | −17, 7, 52 | yaw 90 | as can-1, phase 0.66                                                                                                                                                     |

Landings fall around x ≈ 0 ± 4 within z ±9 of each cannon. One ball every 1 s
somewhere in the section; each with a 0.9 s ground marker. Knock only (no void
nearby) — this section teaches the marker.

#### §2 Lane Runner (z 60 → 140)

Four lanes separated by 0.9 m sandstone ridges (one hop). Giant beach balls (Ø 4 m)
roll toward you in every lane, staggered a quarter period apart. Wall alcoves
at z 85 and 115 give a breather.

| #   | shape | pos x, y, z               | size x, y, z | rot | surface | colour    | grab | pattern | note                           |
| --- | ----- | ------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------ |
| 2.1 | box   | 0, −0.5, 100              | 24, 1, 80    | —   | normal  | primary   |      | none    | canyon floor x ±12             |
| 2.2 | wedge | −6 / 0 / 6, 0.45, 100     | 1.2, 0.9, 80 | —   | normal  | secondary |      | stripes | lane ridges ×3                 |
| 2.3 | box   | ±13, 5, 72.5              | 2, 10, 25    | —   | normal  | secondary |      | none    | canyon wall segment z 60–85 ×2 |
| 2.4 | box   | ±13, 5, 100               | 2, 10, 24    | —   | normal  | secondary |      | none    | wall z 88–112 ×2               |
| 2.5 | box   | ±13, 5, 128.5             | 2, 10, 23    | —   | normal  | secondary |      | none    | wall z 117–140 ×2              |
| 2.6 | box   | ±13.5, −0.5, 86.5 / 114.5 | 3, 1, 3      | —   | normal  | safe      |      | none    | alcove floors (3 × 3) ×4       |
| 2.7 | box   | ±15.5, 5, 86.5 / 114.5    | 1, 10, 3     | —   | normal  | secondary |      | none    | alcove back walls ×4           |

| id        | type        | pos      | rot | params                                                                                                                            |
| --------- | ----------- | -------- | --- | --------------------------------------------------------------------------------------------------------------------------------- |
| s2-ball-1 | boulderLane | −9, 0, 0 | —   | path [(0, 2.0, 141), (0, 2.0, 59)], ballRadius 2.0, speed 8, spawnInterval 5, phase 0, maxBalls 3, popAtEnd true, knockImpulse 11 |
| s2-ball-2 | boulderLane | −3, 0, 0 | —   | as ball-1, phase 0.25                                                                                                             |
| s2-ball-3 | boulderLane | 3, 0, 0  | —   | as ball-1, phase 0.5                                                                                                              |
| s2-ball-4 | boulderLane | 9, 0, 0  | —   | as ball-1, phase 0.75                                                                                                             |

Lane maths: each lane gets a ball every 5 s (40 m spacing); approaching at 9 m/s
against 8 m/s ⇒ a ball reaches you every 2.35 s per lane. A hop over a ridge takes
~0.6 s. A lane always has ≥ 1.25 s of clearance when its neighbour is blocked.
Balls emerge from a cave mouth at z 141 (deco) and pop into foam at z 59.

#### §3 Coconut Crossfire (z 140 → 210)

An 8 m rope bridge over a lagoon, cannons on both banks firing low, flat volleys.
Crates block shots from **one** side.

| #   | shape | pos x, y, z                          | size x, y, z | rot | surface | colour    | grab | pattern | note                                             |
| --- | ----- | ------------------------------------ | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------------------------ |
| 3.1 | box   | 0, −0.5, 170                         | 8, 1, 60     | —   | normal  | primary   |      | stripes | plank bridge z 140–200                           |
| 3.2 | box   | 2.5 / −2.5 / 2.5, 1, 155 / 170 / 185 | 2, 2, 2      | —   | normal  | secondary |      | none    | crates (shelter from the +x / −x / +x side)      |
| 3.3 | box   | ±4.1, 0.6, 170                       | 0.2, 1.2, 60 | —   | normal  | neutral   |      | none    | rope rails (0.6 m posts+rope; collider 1.2 tall) |
| 3.4 | box   | ±21, 1, 172                          | 6, 4, 50     | —   | normal  | secondary |      | none    | cannon banks (deco + collide)                    |
| 3.5 | box   | 0, −0.5, 205                         | 22, 1, 10    | —   | normal  | safe      |      | none    | pad z 200–210                                    |
| 3.6 | box   | 0, 0.01, 204                         | 22, 0.02, 2  | —   | normal  | safe      |      | checker | cp-1 pad                                         |

| id        | type           | pos         | rot     | params                                                                                                                                                        |
| --------- | -------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s3-can-L1 | cannon         | −19, 3, 150 | yaw 90  | fireInterval 2.4, targetRange 19, targetApex 4, landingDelta −3, ballRadius 0.7, aim pattern, patternYaws [−8, 0, 8], telegraph 0.8, knockImpulse 12, phase 0 |
| s3-can-L2 | cannon         | −19, 3, 180 | yaw 90  | as L1, phase 0.5                                                                                                                                              |
| s3-can-R1 | cannon         | 19, 3, 165  | yaw −90 | as L1, phase 0.25                                                                                                                                             |
| s3-can-R2 | cannon         | 19, 3, 195  | yaw −90 | as L1, phase 0.75                                                                                                                                             |
| s3-cpgate | checkpointGate | 0, 0, 204   | —       | width 22                                                                                                                                                      |

Rope rails are only 1.2 m: an 12 m/s knock lifts a Tumbler over them into the
lagoon — the rails stop casual slip-offs, not cannon hits.

#### §4 Boulder Bowl (z 210 → 284)

A 60 m uphill (9.5°) with two lanes of 6 m balls. The 2 m centre line is the
"safe" line; tide-pool alcoves on both sides at mid-climb.

| #   | shape | pos x, y, z                 | size x, y, z | rot | surface | colour    | grab | pattern | note                                                                                     |
| --- | ----- | --------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | ---------------------------------------------------------------------------------------- |
| 4.1 | box   | 0, −0.5, 211                | 16, 1, 2     | —   | normal  | primary   |      | none    | bowl entry z 210–212                                                                     |
| 4.2 | ramp  | 0, 5, 242                   | 16, 10, 60   | —   | normal  | primary   |      | none    | climb z 212–272, 0 → 10                                                                  |
| 4.3 | ramp  | ±8.25, 6, 242               | 0.5, 12, 60  | —   | normal  | secondary |      | none    | side walls (gaps at alcoves: split the wall into 3 pieces z 212–227 / 233–247 / 253–272) |
| 4.4 | box   | ±10, 2.75 / 6.08, 230 / 250 | 4, 0.5, 6    | —   | normal  | safe      |      | none    | tide-pool alcove floors at slope height (z 227–233, 247–253) ×4                          |
| 4.5 | box   | 0, 9.5, 278                 | 22, 1, 12    | —   | normal  | safe      |      | none    | top deck z 272–284                                                                       |
| 4.6 | box   | 0, 10.01, 276               | 22, 0.02, 2  | —   | normal  | safe      |      | checker | cp-2 pad                                                                                 |
| 4.7 | box   | 0, 0.0, 242                 | 2, 0.04, 60  | —   | normal  | safe      |      | none    | painted safe line (deco, follows slope)                                                  |

Alcove floor tops: z 230 ⇒ 3.0 (pos y 2.75); z 250 ⇒ 6.33 (pos y 6.08).

| id        | type           | pos        | rot | params                                                                                                                          |
| --------- | -------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------- |
| s4-ball-L | boulderLane    | −4, 0, 0   | —   | path [(0, 13, 273), (0, 3, 211), (0, 3, 208)], ballRadius 3.0, speed 9, spawnInterval 4.5, phase 0, maxBalls 3, knockImpulse 14 |
| s4-ball-R | boulderLane    | 4, 0, 0    | —   | as L, phase 0.5                                                                                                                 |
| s4-cpgate | checkpointGate | 0, 10, 276 | —   | width 22                                                                                                                        |

Balls emerge from a giant clam (deco) at the top and pop at the bottom. Ball
footprint x −7…−1 / 1…7 ⇒ centre strip 2 m, edge strips 1 m.

#### §5 Raft Run (z 284 → 350)

Main: two shuttling rafts via a mid-lagoon island, with a sweeping sniper cannon.
Alt (left): eight stepping rocks with 3.4 m gaps — longer but out of the sniper's
arc.

| #   | shape       | pos x, y, z                                                                      | size x, y, z | rot | surface | colour    | grab | pattern | note                                 |
| --- | ----------- | -------------------------------------------------------------------------------- | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------------ |
| 5.1 | cylinder    | 0, 9.5, 312                                                                      | 5, 1, —      | —   | normal  | secondary | ✓    | none    | mid island top 10 (z 307–317)        |
| 5.2 | cylinder ×8 | −11, 9.25, 288.98 / 295.56 / 302.14 / 308.72 / 315.30 / 321.88 / 328.46 / 335.04 | 1.6, 1.5, —  | —   | normal  | accent    |      | dots    | stepping rocks top 10                |
| 5.3 | box         | 0, 9.5, 345                                                                      | 26, 1, 10    | —   | normal  | safe      |      | none    | far deck z 340–350                   |
| 5.4 | box         | 0, 10.01, 345                                                                    | 26, 0.02, 2  | —   | normal  | safe      |      | checker | cp-3 pad                             |
| 5.5 | box         | 0, 4, 312                                                                        | 60, 0.2, 60  | —   | normal  | #4fd1ff   |      | none    | lagoon water (deco; falls hit killY) |

| id        | type           | pos           | rot     | params                                                                                                                                |
| --------- | -------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| s5-raft-A | movingPlatform | −2.5, 10, 287 | —       | sizeX 5, sizeY 0.8, sizeZ 5, path [(0,0,0), (0,0,18)], period 6, ease smoothstep, pingPong true, holdTime 1.2                         |
| s5-raft-B | movingPlatform | 2.5, 10, 319  | —       | as raft-A, path [(0,0,0), (0,0,18.5)], phase 0.5                                                                                      |
| s5-sniper | cannon         | 20, 10, 312   | yaw −90 | fireInterval 2.0, targetRange 21, targetApex 5, ballRadius 0.7, aim sweep, sweepDeg 40, sweepPeriod 5, telegraph 0.8, knockImpulse 12 |
| s5-cpgate | checkpointGate | 0, 10, 345    | —       | width 26                                                                                                                              |

Raft fits: raft A spans z 284.5–289.5 at the near end (0.5 m from the deck) and
302.5–307.5 at the far end (0.2 m from the island rim at x −2.5). Raft B spans
316.5–321.5 / 335–340. The sniper's ±20° sweep covers x −7…+7 at the lagoon
centre — the rock route at x −11 is outside it.

#### §6 Sea Stacks (z 350 → 397)

Main: four sea-stack pillars climbing 1.5 m each. Alt (right): a 6 m climb wall
onto a cliff path — exposed to a cannon.

| #   | shape    | pos x, y, z     | size x, y, z | rot | surface | colour    | grab | pattern | note                                 |
| --- | -------- | --------------- | ------------ | --- | ------- | --------- | ---- | ------- | ------------------------------------ |
| 6.1 | cylinder | −3, 9.5, 355    | 3, 4, —      | —   | normal  | secondary | ✓    | none    | S1 top 11.5                          |
| 6.2 | cylinder | 2, 10.25, 361   | 3, 5.5, —    | —   | normal  | secondary | ✓    | none    | S2 top 13.0                          |
| 6.3 | cylinder | −2, 11, 367     | 3, 7, —      | —   | normal  | secondary | ✓    | none    | S3 top 14.5                          |
| 6.4 | cylinder | 2, 11.75, 373   | 3, 8.5, —    | —   | normal  | secondary | ✓    | none    | S4 top 16.0                          |
| 6.5 | box      | 10, 12.5, 364.5 | 4, 7, 25     | —   | normal  | primary   |      | none    | cliff path x 8–12, z 352–377, top 16 |
| 6.6 | box      | 0, 15.5, 387    | 26, 1, 20    | —   | normal  | safe      |      | none    | plateau z 377–397, top 16            |
| 6.7 | box      | 0, 16.01, 381   | 26, 0.02, 2  | —   | normal  | safe      |      | checker | cp-4 pad                             |
| 6.8 | box      | 0, 9.5, 351     | 26, 1, 2     | —   | normal  | primary   |      | none    | (deck lip continues to z 352)        |

| id        | type           | pos          | rot    | params                                                                                                                                  |
| --------- | -------------- | ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| s6-climb  | climbWall      | 10, 10, 352  | —      | width 4, height 6, holdSpacing 0.9, overhangDeg 0 (face normal = local −Z, toward the runner)                                           |
| s6-can    | cannon         | −20, 16, 365 | yaw 90 | fireInterval 2.2, targetRange 30, targetApex 6, ballRadius 0.7, aim sweep, sweepDeg 24, sweepPeriod 4.4, telegraph 0.8, knockImpulse 11 |
| s6-cpgate | checkpointGate | 0, 16, 381   | —      | width 26                                                                                                                                |

Stack gaps: deck lip (352) → S1 rim 0 (S1 spans z 352–358; edge-to-edge 0 at x
−3) — first hop is +1.5 straight up; S1→S2 1.81 m (+1.5); S2→S3 1.21 m (+1.5);
S3→S4 1.21 m (+1.5); S4 (z 376) → plateau (377) 1 m (0).

#### §7 Treasure Gauntlet (z 397 → 475)

| #   | shape | pos x, y, z    | size x, y, z | rot | surface | colour    | grab | pattern | note                                                     |
| --- | ----- | -------------- | ------------ | --- | ------- | --------- | ---- | ------- | -------------------------------------------------------- |
| 7.1 | box   | 0, 15.5, 423.5 | 16, 1, 53    | —   | normal  | primary   |      | none    | sandbar causeway z 397–450, x ±8                         |
| 7.2 | ramp  | 0, 17, 456     | 16, 2, 12    | —   | normal  | accent    |      | chevron | dune ramp z 450–462, 16 → 18                             |
| 7.3 | box   | 0, 17.5, 468.5 | 22, 1, 13    | —   | normal  | safe      |      | checker | finish dune z 462–475, top 18                            |
| 7.4 | box   | ±10, 18, 423.5 | 4, 4, 53     | —   | normal  | secondary |      | none    | cannon berms both sides (collide)                        |
| 7.5 | box   | 0, 21, 474     | 6, 6, 2      | —   | normal  | accent    |      | none    | giant treasure chest (deco; lid opens on first finisher) |
| 7.6 | box   | ±16, 20, 465   | 6, 6, 20     | —   | normal  | neutral   |      | stripes | crowd stands (deco)                                      |

| id            | type        | pos                           | rot     | params                                                                                                                                                                                    |
| ------------- | ----------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s7-can-L1..L3 | cannon      | −11, 20, 405 / 420 / 435      | yaw 90  | fireInterval 3.0, targetRange 11, targetApex 5, landingDelta −4, ballRadius 0.8, aim pattern, patternYaws [−10, 0, 10], telegraph 0.8, knockImpulse 10, phases 0 / 0.166 / 0.333 (ripple) |
| s7-can-R1..R3 | cannon      | 11, 20, 412.5 / 427.5 / 442.5 | yaw −90 | as L, phases 0.5 / 0.666 / 0.833                                                                                                                                                          |
| s7-roll-1     | boulderLane | 0, 0, 0                       | —       | path [(−9, 17.5, 418), (9, 17.5, 418)], ballRadius 1.5, speed 6, spawnInterval 4, phase 0, popAtEnd true                                                                                  |
| s7-roll-2     | boulderLane | 0, 0, 0                       | —       | path [(9, 17.5, 440), (−9, 17.5, 440)], as roll-1, phase 0.5                                                                                                                              |
| s7-finish     | finishLine  | 0, 18, 468                    | —       | width 22                                                                                                                                                                                  |

Rolling balls exit from tunnels in the berms (deco) and cross the full 16 m width
in 2.7 s, once every 4 s per lane.

#### Triggers

| id     | kind       | pos        | size      | index | respawn points                    | yaw |
| ------ | ---------- | ---------- | --------- | ----- | --------------------------------- | --- |
| cp-0   | checkpoint | 0, 2, 0    | 26, 4, 20 | 0     | spawn grid                        | 0   |
| cp-1   | checkpoint | 0, 2, 204  | 22, 4, 2  | 1     | x ±7.5/±4.5/±1.5, y 0.1, z 207    | 0   |
| cp-2   | checkpoint | 0, 12, 276 | 22, 4, 2  | 2     | x ±7.5/±4.5/±1.5, y 10.1, z 279   | 0   |
| cp-3   | checkpoint | 0, 12, 345 | 26, 4, 2  | 3     | x ±7.5/±4.5/±1.5, y 10.1, z 347.5 | 0   |
| cp-4   | checkpoint | 0, 18, 381 | 26, 4, 2  | 4     | x ±7.5/±4.5/±1.5, y 16.1, z 384   | 0   |
| finish | finish     | 0, 20, 468 | 22, 4, 2  | 0     | —                                 | 0   |

#### Spawn

origin (0, 0.1, 0) · yaw 0 · cols 8 · spacing 1.4.

#### Flyover (8 s)

| #   | camera       | look-at    |
| --- | ------------ | ---------- |
| 0   | 22, 10, −10  | 0, 2, 30   |
| 1   | 0, 22, 60    | 0, 0, 100  |
| 2   | −20, 12, 160 | 0, 0, 172  |
| 3   | 18, 20, 240  | 0, 5, 245  |
| 4   | −24, 18, 310 | 0, 10, 312 |
| 5   | 16, 24, 370  | 0, 14, 368 |
| 6   | 0, 28, 490   | 0, 18, 440 |

#### Bot nav

Cannon rule (all sections): if a landing marker overlaps my path in the next 0.9 s,
sidestep perpendicular to travel by 2.5 m (Sharp) / 1.5 m (Average) / none
(Clumsy, 50 %).

| id      | pos             | r   | next       | action     | timeAgainst | note                                                                                                                               |
| ------- | --------------- | --- | ---------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0       | 0, 0, 6         | 3   | 1          | run        |             |                                                                                                                                    |
| 1       | 3, 0, 35        | 4   | 2          | run        |             |                                                                                                                                    |
| 2       | 0, 0, 58        | 3   | 100        | run        |             | lane pick: the lane whose next ball is farthest                                                                                    |
| 100     | lane x, 0, 62   | 2   | 101        | run        |             | ball rule: if ball in lane ≤ 18 m ahead, hop toward the adjacent lane with the larger clearance (action jump); alcoves as fallback |
| 101     | lane x, 0, 100  | 3   | 102        | run        |             |                                                                                                                                    |
| 102     | 0, 0, 138       | 3   | 200        | run        |             |                                                                                                                                    |
| 200     | 0, 0, 142       | 1.5 | 201        | run        |             | bridge: hug crate lee side when the opposite bank's cannon telegraphs                                                              |
| 201     | 1, 0, 157       | 1   | 202        | waitForGap | s3-can-L1   | behind crate 1                                                                                                                     |
| 202     | −1, 0, 172      | 1   | 203        | waitForGap | s3-can-R1   | behind crate 2                                                                                                                     |
| 203     | 1, 0, 187       | 1   | 204        | waitForGap | s3-can-L2   | behind crate 3                                                                                                                     |
| 204     | 0, 0, 206       | 3   | 300        | run        |             |                                                                                                                                    |
| 300     | 0, 0, 213       | 1   | 301        | run        |             | Boulder Bowl: stay on x 0 ± 0.4                                                                                                    |
| 301     | 0, 5, 242       | 1   | 302        | run        |             |                                                                                                                                    |
| 302     | 0, 10, 274      | 2   | 400, 410   | run        |             | rafts / rocks: C 70/30 · A 60/40 · S 40/60                                                                                         |
| 400     | −2.5, 10, 283.5 | 1   | 401        | waitForGap | s5-raft-A   | board when raft at near end                                                                                                        |
| 401     | −2.5, 10, 296   | 1.5 | 402        | waitForGap | s5-raft-A   | ride; step off at far end                                                                                                          |
| 402     | 0, 10, 312      | 2   | 403        | waitForGap | s5-raft-B   |                                                                                                                                    |
| 403     | 2.5, 10, 328    | 1.5 | 420        | waitForGap | s5-raft-B   | step off at far end                                                                                                                |
| 410     | −11, 10, 285    | 1   | 411        | jump       |             | rocks 1…8 (each jump 3.4 m)                                                                                                        |
| 411–418 | −11, 10, rock z | 0.9 | next / 420 | jump       |             |                                                                                                                                    |
| 420     | 0, 10, 344      | 2   | 500, 510   | run        |             | stacks / climb: C 80/20 · A 70/30 · S 70/30                                                                                        |
| 500     | −3, 10, 351     | 1   | 501        | jump       |             | S1 +1.5                                                                                                                            |
| 501     | −3, 11.5, 355   | 1   | 502        | jump       |             |                                                                                                                                    |
| 502     | 2, 13, 361      | 1   | 503        | jump       |             |                                                                                                                                    |
| 503     | −2, 14.5, 367   | 1   | 504        | jump       |             |                                                                                                                                    |
| 504     | 2, 16, 373      | 1   | 520        | jump       |             |                                                                                                                                    |
| 510     | 10, 10, 351     | 1   | 511        | climb      |             |                                                                                                                                    |
| 511     | 10, 16, 353     | 1.5 | 520        | run        | s6-can      |                                                                                                                                    |
| 520     | 0, 16, 384      | 3   | 600        | run        |             |                                                                                                                                    |
| 600     | 0, 16, 400      | 2   | 601        | run        |             | zig-zag between landing markers                                                                                                    |
| 601     | 0, 16, 414      | 2   | 602        | waitForGap | s7-roll-1   |                                                                                                                                    |
| 602     | 0, 16, 436      | 2   | 603        | waitForGap | s7-roll-2   |                                                                                                                                    |
| 603     | 0, 16, 449      | 2   | 604        | run        |             |                                                                                                                                    |
| 604     | 0, 18, 468      | 4   | —          | run        |             | finish                                                                                                                             |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.08, 1.16, 1.24, 1.32]** — fireInterval ÷, ball speeds
and spawn intervals, raft periods ÷, sweep periods ÷. Telegraph never drops below
0.7 s.

| id             | weight | weather | description                                      | overrides                                                                                                                                                      |
| -------------- | ------ | ------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sunny-siege`  | 4      | clear   | As authored.                                     | —                                                                                                                                                              |
| `broadside`    | 2      | clear   | Double-shot volleys everywhere.                  | all cannons: burst 2, burstGap 0.35                                                                                                                            |
| `rogue-wave`   | 2      | windy   | Lagoon wave pushes rafts; balls faster.          | `s5-raft-A/B`: period 4.8 · `s2-ball-1..4`: speed 9.5 · add `w-surf` fanZone (−20, 10, 312) sizeX 40, sizeY 6, sizeZ 50, direction (1,0,0), force 4, gust true |
| `moonlit-cove` | 1      | night   | Glowing coconuts, larger markers.                | all cannons: ballRadius ×1.15, telegraph 1.0                                                                                                                   |
| `ball-pit`     | 1      | sunset  | Lane Runner balls double in size; fewer of them. | `s2-ball-1..4`: ballRadius 2.6, spawnInterval 6.5 (ridges still hop-able: lanes 4.8 m − 5.2 m ball ⇒ must change lane)                                         |

#### Set dressing & lighting

- Sandstone canyon walls with layered stripes, palm trees, parrots on the cannon
  emplacements, a pirate galleon wreck in the lagoon, beach umbrellas and crowd
  on towels along the canyon rim, kites and seagulls overhead, a volcano puffing
  pastel smoke on the horizon.
- Sun azimuth 200°, elevation 50°, colour `#fff2c4`. Fog warm turquoise near 120 /
  far 650.
- Readability: every cannon has a 0.9 s muzzle glow + puff before firing and a
  `danger` landing ring that shrinks to the impact point; giant balls are
  striped beach balls (white/`danger`) so they never blend with sand.

#### Sanity checks

| Hardest move   | Value                  | Envelope                                        |
| -------------- | ---------------------- | ----------------------------------------------- |
| Stepping rocks | 3.38 m ×9 onto 3.2 m Ø | ≤ 3.5 ✓                                         |
| Stack S1 → S2  | 1.81 m, +1.5           | ≤ 2.0 ✓                                         |
| Lane ridge     | 0.9 m tall             | jump ✓ (not a free step: deliberate commitment) |
| Climb wall     | 6 m continuous grab    | climbWall module ✓                              |
| Raft step-off  | 0.2–0.5 m gaps         | ✓                                               |

- **Completion:** competent ≈ 100 s (§1 6 · §2 12 · §3 9 · §4 10 · §5 15 · §6 10 ·
  §7 10 + ~28 s dodges/waits). Sharp bot 112 s, Average 132 s, Clumsy 170 s.
- **Pacing (40 ⇒ 26):** first ≈ 90 s; 26th ≈ 135 s.

---

## 5. Survivals

Common survival rules:

- `fallBehavior: eliminate`. Falling below `killY` (or touching lethal goo) = out.
- Qualification `survive`: the round ends at the timer **or** as soon as
  `ceil(entrants × (1 − ratio))` players are eliminated, whichever is first.
  Everyone still alive qualifies.
- Survival spawns are grids; arenas are designed so the grid fits safely.
- Bot nav for survivals = **behaviour zones** + a few key waypoints (the
  waypoint list is used for "go to safe spot" and climbing, not a path).

---

### S1 — Spin Cycle

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `spin-cycle`                           |
| name          | Spin Cycle                             |
| type          | `survival`                             |
| theme         | `factory`                              |
| players       | min 8 · max 40 · ideal 24              |
| qualification | mode `survive`, ratio 0.7              |
| duration      | 90 s, overtime 0                       |
| fallBehavior  | `eliminate`                            |
| killY         | −8                                     |
| bounds        | min (−35, −15, −35) · max (35, 25, 35) |
| music         | `mus_factory_clockwork`                |
| cameraMode    | `orbit`                                |
| decorSeed     | 2101                                   |

**Objective:** `Jump the low bar, dive under the high bar!` (42 chars)

**Tips:**

1. Bars move slower near the middle — but it's crowded there.
2. Yellow bar = jump. Striped red bar = dive under it.
3. The outer ring falls away later. Don't get caught on the edge.

**Fantasy & moments.** You are laundry inside a giant toy washing machine
drum: two counter-rotating bars at two heights, a floor that shrinks, and a
spin-reversal alarm that catches everyone out.

1. **The Double** — low bar and high bar arrive half a second apart: jump, land,
   dive. A crowd does it in unison like synchronised swimmers.
2. **Reversal Panic** — at 45 s the low bar flips direction after a 2 s alarm;
   players who were timing it from habit get swept.
3. **Ring Drop** — the outer ring of tiles shakes and drops at 60 s; edge-huggers
   scramble inward into the crowd.
4. **Hub Pinball** — the bouncy centre hub flings people who try to hide there
   straight into the bars.

#### Arena

| #   | shape      | pos x, y, z             | size x, y, z | rot | surface | colour  | grab | pattern | note                                        |
| --- | ---------- | ----------------------- | ------------ | --- | ------- | ------- | ---- | ------- | ------------------------------------------- |
| a.1 | torus      | 0, 6, 0                 | 27, 1.2, —   | —   | normal  | neutral |      | none    | porthole rim (deco)                         |
| a.2 | cylinder   | 0, −6, 0                | 24, 0.2, —   | —   | normal  | #bfe9ff |      | none    | suds pool below (deco, killY handles falls) |
| a.3 | sphere ×40 | random r 24–40, y −4…−1 | 0.5–2        | —   | normal  | #ffffff |      | none    | foam bubbles (deco, bob)                    |
| a.4 | torus      | 0, 0.02, 0              | 9, 0.08, —   | —   | normal  | safe    |      | none    | "slow zone" paint ring (deco)               |

| id       | type         | pos     | rot | params                                                                                                                                                                                                                                          |
| -------- | ------------ | ------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| floor    | fallingTiles | 0, 0, 0 | —   | tileShape hex, tileSize 1.6, gap 0.1, thickness 0.6, mask = all hex cells with centre radius ≤ 22, triggerMode **timed**, timedSchedule [{t 60, beyondRadius 17}, {t 75, beyondRadius 13}], shakeTime 1.5, immune [{radius 2.5}], respawn false |
| hub      | bumperPillar | 0, 0, 0 | —   | radius 1.5, height 3.0, bounceImpulse 9                                                                                                                                                                                                         |
| bar-low  | sweeperArm   | 0, 0, 0 | —   | armLength 22, armCount 2, armHeight 0.55, armRadius 0.3, innerRadius 1.6, speedSchedule [{0, 0.8}, {15, 1.0}, {35, 1.2}, {60, 1.4}, {75, 1.6}], reverseTimes [45], hubRadius 1.5, hubHeight 3, knockImpulse 9, colorKey accent                  |
| bar-high | sweeperArm   | 0, 0, 0 | —   | armLength 22, armCount 2, armHeight 6 (parked), heightSchedule [{20, 1.75}], armRadius 0.35, innerRadius 1.6, speedSchedule [{0, −0.6}, {35, −0.8}, {60, −1.0}, {75, −1.2}], reverseTimes [70], phase 0.25, knockImpulse 10, colorKey danger    |

Bar heights: low bar top 0.85 m — jump clears (apex 2.0). High bar spans
1.40–2.10 m — standing (1.8) is hit, a jump is hit, a **dive** (body ≤ 0.7 m) passes.

#### Escalation timeline

| t (s) | Event                                                    | Telegraph                                  |
| ----- | -------------------------------------------------------- | ------------------------------------------ |
| 0     | Low bar only, 0.8 rad/s (tip 17.6 m/s)                   | —                                          |
| 15    | Low bar → 1.0                                            | gear whine pitch-up                        |
| 18.5  | High bar starts lowering from 6 m                        | bar flashes red/striped, 1.5 s             |
| 20    | High bar live at 1.75 m, −0.6 rad/s                      | —                                          |
| 35    | Low 1.2, high −0.8                                       | pitch-up + steam puff                      |
| 43    | **Reversal alarm**                                       | klaxon + chevrons on the low bar flip, 2 s |
| 45    | Low bar reverses (now −1.2)                              | —                                          |
| 58.5  | Outer ring (r > 17) shakes                               | tiles glow orange, 1.5 s                   |
| 60    | Outer ring drops; low 1.4, high −1.0                     | —                                          |
| 68    | High-bar reversal alarm                                  | 2 s                                        |
| 70    | High bar reverses (now +1.0)                             | —                                          |
| 73.5  | Ring r > 13 shakes                                       | 1.5 s                                      |
| 75    | Ring drops (arena r 13); low 1.6, high +1.2 (final 15 s) | music final layer                          |
| 90    | Survivors qualify                                        | —                                          |

#### Spawn

origin (0, 0.1, −9) · yaw 0 · cols 6 · spacing 1.5 (24 players ⇒ 4 rows, all inside
r ≤ 13). Bars start with phase so neither crosses the spawn grid in the first 2 s
(bar-low at t = 0 lies along the x axis; grid is at z −6.75…−11.25 ⇒ first
contact ≈ 1.6 s at 0.8 rad/s for the nearest player).

#### Flyover (5 s)

Orbit: path (30, 20, 0) → (0, 24, 30) → (−30, 20, 0) → (0, 26, −30); lookAt (0, 0, 0).

#### Bot behaviour zones

| Zone       | Rule                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Band       | Hold radius 6–12 m (bars slower; away from the edge and the hub). After 60 s: 5–10; after 75 s: 4–9                                     |
| Jump       | When the low bar will reach my position in ≤ (0.25 s Sharp / 0.32 s Average / 0.4 s ± 0.15 noise Clumsy), jump                          |
| Dive       | When the high bar (once live) will reach me in ≤ 0.35 s, dive toward the bar's direction of travel (slides under, then GetUp behind it) |
| Edge       | If radius > current floor radius − 2.5, move inward                                                                                     |
| Hub        | Never closer than 3 m to the hub                                                                                                        |
| Telegraphs | On reversal alarm, re-predict after the flip (Clumsy keep the old prediction for 1 s)                                                   |

Key waypoints (for "go to band"): 0 (0,0,−8) · 1 (8,0,0) · 2 (0,0,8) · 3 (−8,0,0), all
r 3, ring-connected.

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.05, 1.1, 1.15, 1.2]** (multiplies all speeds in both
schedules; schedule _times_ are not scaled).

| id                 | weight | weather | description                                     | overrides                                                                                                 |
| ------------------ | ------ | ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `normal-wash`      | 4      | clear   | As authored.                                    | —                                                                                                         |
| `heavy-duty`       | 2      | clear   | Three low arms.                                 | `bar-low`: armCount 3                                                                                     |
| `delicates`        | 1      | clear   | Gentler: no reversals, ring drop at 70 s only.  | `bar-low`: reverseTimes [] · `bar-high`: reverseTimes [] · `floor`: timedSchedule [{70, beyondRadius 16}] |
| `soap-slick`       | 2      | night   | Neon suds; floor is slippery.                   | `floor`: surface ice (fallingTiles `surface` param)                                                       |
| `rinse-and-repeat` | 1      | clear   | High bar from the start, low bar joins at 20 s. | `bar-high`: heightSchedule [] armHeight 1.75 · `bar-low`: activeFrom 20                                   |

#### Set dressing & lighting

- Inside a giant toy washing machine: porthole rim (a.1) with a glass reflection
  shader, socks and T-shirts tumbling slowly in the background like clouds,
  soap bubbles, a giant control panel with dials that spin to the bar speeds
  (diegetic speedometer).
- Interior lighting: key from above azimuth 0°, elevation 75°, colour
  `#f2f7ff`, cool fill; fog none (enclosed); bloom on suds.

#### Sanity checks

- Low bar top 0.85 m vs apex 2.0 ✓. High bar bottom 1.40 m ≥ dive clearance 0.7 ✓;
  top 2.10 > apex 2.0 ⇒ cannot be jumped (intended).
- At r 6 with ω 1.6 the low bar moves 9.6 m/s — a single 0.75 s jump airtime vs
  a 0.6 m bar: trivial to clear if timed; the crowd and the second bar make it hard.
- **Expected:** 24 → ~17 by 75 s, ratio cut (7.2 → 8 eliminated) usually reached
  between 70 and 85 s. Stage 3+ shows end ~10 s earlier.

---

### S2 — Tile Panic

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `tile-panic`                           |
| name          | Tile Panic                             |
| type          | `survival`                             |
| theme         | `candy`                                |
| players       | min 10 · max 50 · ideal 32             |
| qualification | mode `survive`, ratio 0.6              |
| duration      | 120 s, overtime 0                      |
| fallBehavior  | `eliminate`                            |
| killY         | −8                                     |
| bounds        | min (−35, −15, −35) · max (35, 45, 35) |
| music         | `mus_candy_sugarrush`                  |
| cameraMode    | `orbit`                                |
| decorSeed     | 2201                                   |

**Objective:** `Tiles crumble when touched. Don't fall!` (39 chars)

**Tips:**

1. Keep moving — every tile you stand on is about to drop.
2. Falling isn't the end: there are three layers. Use them.
3. Jump to save tiles: airtime doesn't crack them.

**Fantasy & moments.** Three floating layers of wafer biscuit tiles above a
chocolate lake. Every step cracks a tile; the crowd carves the floor away.

1. **The Carve** — a pack running in a line leaves a trench that strands
   everyone on the other side.
2. **Layer Rain** — a cluster drops from the top layer onto the middle and
   destroys it on impact (the landing cracks tiles too).
3. **Island Standoff** — the last six players each on a single-tile island,
   hopping in place to save the tile beneath them.
4. **Sprinkle Barrage** — corner cannons at 30 s nudge island campers.

#### Layers

| Layer       | id        | pos      | params                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top (L1)    | `layer-1` | 0, 24, 0 | fallingTiles, tileShape square, tileSize 2.8, gap 0.12, thickness 0.5, cols 13, rows 13 (pitch 2.92 ⇒ 37.96 m), mask: all cells except the 6 cells in each corner triangle (cells with \|i−6\|+\|j−6\| > 10), triggerMode both, shakeTime 0.9, dropDelay 0, fallDepth 40, respawn false, shakeTimeSchedule [{60, 0.75}, {90, 0.55}], timedSchedule [{45, 0.08}, {60, 0.08}, {75, 0.1}, {90, 0.12}, {105, 0.15}], timedOrder random |
| Middle (L2) | `layer-2` | 0, 12, 0 | as L1, mask: cells with centre radius ≤ 17 m (a disc), timedSchedule [{50, 0.08}, {65, 0.1}, {80, 0.12}, {95, 0.15}, {110, 0.15}]                                                                                                                                                                                                                                                                                                  |
| Bottom (L3) | `layer-3` | 0, 0, 0  | as L1, cols 13, rows 13, mask: plus/cross — cells with \|x\| ≤ 7.3 or \|z\| ≤ 7.3, and radius ≤ 19 (a fat "+"), timedSchedule [{70, 0.1}, {90, 0.12}, {105, 0.15}]                                                                                                                                                                                                                                                                 |

Touch rule: a tile starts shaking when a grounded player's capsule overlaps it
(landing counts, airborne passes do not). It drops after `shakeTime`.
Vertical spacing 12 m ⇒ fall time ~1.1 s, enough for a "phew" beat.

Other geometry & hazards:

| #   | shape       | pos x, y, z  | size x, y, z | rot | surface | colour  | grab | pattern | note                                           |
| --- | ----------- | ------------ | ------------ | --- | ------- | ------- | ---- | ------- | ---------------------------------------------- |
| a.1 | cylinder    | 0, −6, 0     | 40, 0.4, —   | —   | normal  | #7b4a2e |      | none    | chocolate lake (deco, swirl shader)            |
| a.2 | cylinder ×4 | ±24, 14, ±24 | 1.2, 32, —   | —   | normal  | accent  |      | stripes | candy-cane corner towers (deco, cannon mounts) |

| id    | type   | pos          | rot      | params                                                                                                                                                             |
| ----- | ------ | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| can-1 | cannon | 24, 30, 24   | yaw −135 | activeFrom 30, fireInterval 4, targetRange 22, targetApex 6, landingDelta −6, ballRadius 0.6, aim sweep, sweepDeg 50, sweepPeriod 8, telegraph 0.9, knockImpulse 7 |
| can-2 | cannon | −24, 30, 24  | yaw 135  | as can-1, phase 0.25                                                                                                                                               |
| can-3 | cannon | −24, 30, −24 | yaw 45   | as can-1, phase 0.5                                                                                                                                                |
| can-4 | cannon | 24, 30, −24  | yaw −45  | as can-1, phase 0.75                                                                                                                                               |

Cannons target the top layer (landingDelta −6: from y 30 to y 24). Foam balls do
**not** crack tiles.

#### Escalation timeline

| t (s)   | Event                                                                        |
| ------- | ---------------------------------------------------------------------------- |
| 0       | Only touch-cracking. 32 players on 157 top tiles                             |
| 30      | Corner sprinkle cannons activate (one shot / s overall)                      |
| 45      | L1 random drops begin (8 %)                                                  |
| 50      | L2 random drops begin                                                        |
| 60      | Shake time 0.75 s (all layers)                                               |
| 70      | L3 random drops begin                                                        |
| 90      | Shake time 0.55 s; drop fractions rise                                       |
| 105–120 | Final 15 s: every 15 s L1/L2/L3 lose 15 % of what remains; music final layer |

#### Spawn

origin (0, 24.1, 0) · yaw 0 · cols 8 · spacing 1.6 (32 ⇒ 4 rows, 11.2 × 4.8 m) on L1.

#### Flyover (5 s)

Path (0, 45, −40) → (35, 30, 0) → (0, 20, 40) → (−30, 8, 0); lookAt (0, 24, 0), (0, 18, 0),
(0, 12, 0), (0, 0, 0) — descends layer by layer.

#### Bot behaviour zones

| Zone   | Rule                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Wander | Keep moving at ≥ 60 % speed along paths over intact, non-shaking tiles; prefer tiles with the most intact neighbours     |
| Hop    | On a lone tile: jump in place (airtime preserves it) — Sharp bots hop between two tiles to keep both                     |
| Drop   | If no intact tile reachable on the current layer, walk off toward the area with the most intact tiles on the layer below |
| Avoid  | Never path through cells adjacent to many shaking tiles; stay 3 m from layer edges after 60 s                            |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.05, 1.1, 1.15, 1.2]** — divides shakeTime (floor 0.45 s)
and cannon intervals.

| id              | weight | weather | description                        | overrides                               |
| --------------- | ------ | ------- | ---------------------------------- | --------------------------------------- |
| `wafer-classic` | 4      | clear   | As authored.                       | —                                       |
| `hex-mix`       | 2      | clear   | Hex tiles on the middle layer.     | `layer-2`: tileShape hex, tileSize 1.8  |
| `quick-crumble` | 2      | sunset  | Faster cracking from the start.    | all layers: shakeTime 0.7               |
| `rebake`        | 1      | clear   | Tiles re-form on the bottom layer. | `layer-3`: respawn true, respawnTime 10 |
| `no-cannons`    | 1      | night   | Glowing tiles; cannons off.        | remove `can-1..4`                       |

#### Set dressing & lighting

- Candy sky world: layers float above a swirling chocolate lake with marshmallow
  rocks; gumdrop mountains, cotton-candy clouds drifting through the gaps between
  layers; corner candy-cane towers with sprinkle cannons.
- Sun azimuth 140°, elevation 60°, colour `#fff4e0`; fog pink near 80 / far 400.
- Readability: each layer has its own wafer colour (L1 `primary`, L2 `secondary`,
  L3 `accent`); shaking tiles turn `danger` and crack-decal in 3 stages.

#### Sanity checks

- Tile 2.8 m with 0.12 gaps: a capsule (0.9) always overlaps ≤ 4 tiles; standing
  on a seam cracks up to 4 (intended punishment for dawdling).
- Jumping between tiles across one dropped tile = 2.8 + 0.24 gap ≈ 3.0 m ✓.
- **Expected:** 32 → 19 (40 % out) at ~80–100 s; often ends before the timer.

---

### S3 — Rising Goo Tower

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `rising-goo-tower`                     |
| name          | Rising Goo Tower                       |
| type          | `survival`                             |
| theme         | `goo`                                  |
| players       | min 10 · max 40 · ideal 30             |
| qualification | mode `survive`, ratio 0.6              |
| duration      | 120 s, overtime 0                      |
| fallBehavior  | `eliminate`                            |
| killY         | −10 (goo is the real killer)           |
| bounds        | min (−40, −15, −40) · max (40, 70, 40) |
| music         | `mus_goo_gloopgroove`                  |
| cameraMode    | `orbit`                                |
| decorSeed     | 2301                                   |

**Objective:** `Climb the tower! The goo is rising.` (35 chars)

**Tips:**

1. Stairs are slow and safe. Bounce pads are fast — if you aim well.
2. The goo surges when the drums kick in. Get above it!
3. The top is tiny. Get there early, or push your way in.

**Fantasy & moments.** A wobbly seven-tier jelly cake slowly drowning in rising
lime goo. Every tier is narrower than the last, so the climb is also a squeeze.

1. **Stair Conga** — a single-file line of Tumblers hopping up a staircase while
   the goo laps at the bottom step.
2. **Pad Overshoot** — a bounce pad flings a player clean over the next tier
   onto the one above — or into the goo on the far side.
3. **Surge** — the goo jumps 7 m in 15 s; a whole tier scrambles for two staircases.
4. **King of the Cake** — the final 15 s on a 10 m-wide top disc, shoving
   matches at the rim with goo bubbling 3 m below.

#### Tower

Seven solid tiers (wedding cake), each a `cylinder` from y −4 to its top:

| Tier | top y | radius | ring width      | pos (cylinder) | size     |
| ---- | ----- | ------ | --------------- | -------------- | -------- |
| T0   | 0     | 28     | 8               | 0, −2, 0       | 28, 4    |
| T1   | 7     | 20     | 3.5             | 0, 1.5, 0      | 20, 11   |
| T2   | 14    | 16.5   | 3.5             | 0, 5, 0        | 16.5, 18 |
| T3   | 21    | 13     | 3               | 0, 8.5, 0      | 13, 25   |
| T4   | 28    | 10     | 2.5             | 0, 12, 0       | 10, 32   |
| T5   | 35    | 7.5    | 2.5             | 0, 15.5, 0     | 7.5, 39  |
| T6   | 42    | 5      | (top disc Ø 10) | 0, 19, 0       | 5, 46    |

All tiers `normal` surface, colours cycle `primary`/`secondary`/`accent` (jelly
layers), tier rims carry a 0.3 m `safe` frosting band (deco). Tier walls are
**not** grabbable (7 m — climbing is via stairs/pads).

**Staircases** — 5 boxes per staircase, each 1.4 m higher than the last (jumps),
3.0 m long tangentially, radial depth = min(3, ring − 0.5), hugging the upper
tier's wall. `pos` is the box centre; size = (depth, height, 3.0); `rot` = yaw.

| Transition | Staircase   | Steps 1 → 5: centre (x, y, z), height, yaw                                                                                                                                                  |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0→T1      | A (base 0°) | (21.31, 0.70, 3.19) h1.4 y−9 · (20.61, 1.40, 6.31) h2.8 y−17 · (19.45, 2.10, 9.29) h4.2 y−26 · (17.86, 2.80, 12.06) h5.6 y−34 · (15.88, 3.50, 14.57) h7.0 y−43 — depth 3                    |
| T0→T1      | B (180°)    | (−21.31, 0.70, −3.19) h1.4 y171 · (−20.61, 1.40, −6.31) h2.8 y163 · (−19.45, 2.10, −9.29) h4.2 y154 · (−17.86, 2.80, −12.06) h5.6 y146 · (−15.88, 3.50, −14.57) h7.0 y137 — depth 3         |
| T1→T2      | A (60°)     | (6.13, 7.70, 16.98) h1.4 y−70 · (3.04, 8.40, 17.79) h2.8 y−80 · (−0.15, 9.10, 18.05) h4.2 y−90 · (−3.33, 9.80, 17.74) h5.6 y−101 · (−6.41, 10.50, 16.87) h7.0 y−111 — depth 3               |
| T1→T2      | B (240°)    | (−6.13, 7.70, −16.98) h1.4 y110 · (−3.04, 8.40, −17.79) h2.8 y100 · (0.15, 9.10, −18.05) h4.2 y90 · (3.33, 9.80, −17.74) h5.6 y79 · (6.41, 10.50, −16.87) h7.0 y69 — depth 3                |
| T2→T3      | A (120°)    | (−9.85, 14.70, 10.71) h1.4 y−133 · (−11.95, 15.40, 8.30) h2.8 y−145 · (−13.47, 16.10, 5.50) h4.2 y−158 · (−14.35, 16.80, 2.43) h5.6 y−170 · (−14.53, 17.50, −0.76) h7.0 y177 — depth 3      |
| T2→T3      | B (300°)    | (9.85, 14.70, −10.71) h1.4 y47 · (11.95, 15.40, −8.30) h2.8 y35 · (13.47, 16.10, −5.50) h4.2 y22 · (14.35, 16.80, −2.43) h5.6 y10 · (14.53, 17.50, 0.76) h7.0 y−3 — depth 3                 |
| T3→T4      | A (180°)    | (−10.85, 21.70, −3.16) h1.4 y164 · (−9.54, 22.40, −6.06) h2.8 y148 · (−7.46, 23.10, −8.49) h4.2 y131 · (−4.79, 23.80, −10.23) h5.6 y115 · (−1.74, 24.50, −11.16) h7.0 y99 — depth 2.5       |
| T3→T4      | B (0°)      | (10.85, 21.70, 3.16) h1.4 y−16 · (9.54, 22.40, 6.06) h2.8 y−32 · (7.46, 23.10, 8.49) h4.2 y−49 · (4.79, 23.80, 10.23) h5.6 y−65 · (1.74, 24.50, 11.16) h7.0 y−81 — depth 2.5                |
| T4→T5      | A (240°)    | (−1.27, 28.70, −8.45) h1.4 y99 · (1.91, 29.40, −8.33) h2.8 y77 · (4.82, 30.10, −7.06) h4.2 y56 · (7.07, 30.80, −4.81) h5.6 y34 · (8.34, 31.50, −1.89) h7.0 y13 — depth 2 (single staircase) |
| T5→T6      | A (300°)    | (5.26, 35.70, −3.00) h1.4 y30 · (6.05, 36.40, 0.06) h2.8 y−1 · (5.19, 37.10, 3.11) h4.2 y−31 · (2.91, 37.80, 5.30) h5.6 y−61 · (−0.16, 38.50, 6.05) h7.0 y−92 — depth 2 (single staircase)  |

(Generator: ρ = r(i+1) + depth/2 + 0.05; step k at angle base + k·(3.2/ρ) rad;
x = ρ cos a, z = ρ sin a; yaw = atan2(−sin a, cos a) in degrees.)

**Bounce pads** (launch inward onto the next tier; `bouncePad` radius 1.0,
targetApex 9, targetRange 3, landingDelta 7):

| id          | pos                                     | yaw                                                      |
| ----------- | --------------------------------------- | -------------------------------------------------------- |
| pad-0a / 0b | (0, 0, 21.55) / (0, 0, −21.55)          | 180 / 0                                                  |
| pad-1a / 1b | (−15.63, 7, 9.02) / (15.63, 7, −9.03)   | 120 / −60                                                |
| pad-2a / 2b | (−12.60, 14, −7.28) / (12.60, 14, 7.28) | 60 / −120                                                |
| pad-3a / 3b | (0, 21, −11.30) / (0, 21, 11.30)        | 0 / 180                                                  |
| pad-4a / 4b | (4.28, 28, 7.40) / (−8.55, 28, 0)       | −150 / 90 (T4→T5: at 60° and 180°, clear of staircase A) |
| pad-5a      | (−5.24, 35, −3.02)                      | 60 (T5→T6: at 210°, clear of staircase A)                |

**Goo**

| id     | type        | pos      | rot   | params                                                                                                                                                                                                                                   |
| ------ | ----------- | -------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| goo    | risingSlime | 0, 0, 0  | —     | sizeX 80, sizeZ 80, startY −3, schedule [{0, −3}, {15, −3}, {25, 3.5}, {40, 7.5}, {55, 14.5}, {70, 21.5}, {85, 28.5}, {100, 35.5}, {120, 38.5}], waveAmplitude 0.3, wavePeriod 2.2, lethal true, surgeTelegraph 2                        |
| drip-1 | cannon      | 0, 50, 0 | yaw 0 | activeFrom 60, fireInterval 3, aim pattern, patternYaws [0, 72, 144, 216, 288], targetRange 6, targetApex 3, landingDelta −15, ballRadius 0.8, knockImpulse 7, telegraph 1.0 (goo blobs dripping from a giant spoon above — knocks only) |

#### Escalation timeline

| t (s)   | Goo y | Safe tiers | Event                                                          |
| ------- | ----- | ---------- | -------------------------------------------------------------- |
| 0–15    | −3    | all        | Climb freely; goo bubbles at the base                          |
| 25      | 3.5   | T1+        | First surge: T0 floods (players must have left the start ring) |
| 40      | 7.5   | T2+        | T1 just covered (+0.5)                                         |
| 55      | 14.5  | T3+        | T2 covered                                                     |
| 60      | —     | —          | Spoon drips begin                                              |
| 70      | 21.5  | T4+        | T3 covered                                                     |
| 85      | 28.5  | T5+        | T4 covered                                                     |
| 100     | 35.5  | T6         | T5 covered — everyone left is on the 10 m top disc             |
| 100–120 | 38.5  | T6         | Final 20 s: goo 3.5 m under the rim, drips, shoving            |

Each step gives 15 s per tier (7 m): a staircase takes ~5 s, a pad ~2 s, so
there's slack — the danger is crowding at staircase mouths and getting shoved.

#### Spawn

origin (0, 0.1, −24) · yaw 180 (facing the tower) · cols 10 · spacing 1.3 (30 ⇒ 3
rows inside the 8 m T0 ring).

#### Flyover (6 s)

Path (0, 8, −45) → (35, 25, −20) → (25, 45, 25) → (0, 60, 0); lookAt (0, 0, −24), (0, 14, 0),
(0, 28, 0), (0, 42, 0) — spirals up the cake.

#### Bot behaviour zones

| Zone      | Rule                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Climb     | Target tier = lowest tier with top ≥ goo(t + 12 s) + 2. Move to nearest staircase/pad of the current tier (Sharp: pad 70 %, Average 40 %, Clumsy 15 %) |
| Waypoints | Staircase entries = waypoints 100 + 10·i (+0/+1 for A/B), pad positions = 150 + 10·i; actions jump (stairs), run (onto pad)                            |
| Crowd     | If > 4 players within 3 m of a staircase entry, prefer the other route                                                                                 |
| Top       | On T6: stay within r 3.5; push (run into) players at the rim if Sharp                                                                                  |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.05, 1.1, 1.15, 1.2]** — compresses goo schedule times
(÷) — at stage 4 the T5 flood is at 83 s; drips interval ÷.

| id               | weight | weather | description                                                 | overrides                                                                                                                                             |
| ---------------- | ------ | ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slow-ooze`      | 4      | clear   | As authored.                                                | —                                                                                                                                                     |
| `surge-storm`    | 2      | stormy  | Steps of 7 m every 15 s become two jumps per step (sudden). | `goo`: schedule [{0,−3},{20,−3},{22,3.5},{35,3.5},{37,7.5},{50,7.5},{52,14.5},{65,14.5},{67,21.5},{80,21.5},{82,28.5},{95,28.5},{97,35.5},{120,38.5}] |
| `sticky-steps`   | 1      | clear   | Staircases T2+ are sticky (slow).                           | add stickyGoo on each staircase top (engineer: generate sizeX = depth, sizeZ 3 at each step top)                                                      |
| `bouncy-cake`    | 2      | sunset  | Extra pads everywhere.                                      | duplicate every pad at +45° around its tier                                                                                                           |
| `midnight-snack` | 1      | night   | Goo glows; tiers outlined.                                  | —                                                                                                                                                     |

#### Set dressing & lighting

- A gooey dessert world: the cake sits in a lime goo lake with fruit-slice
  islands, a giant spoon hovers above (drip source), gummy-bear crowd on floating
  plates, bubbles rise and pop with "gloop".
- Sun azimuth 110°, elevation 50°, colour `#fbffe8`; fog lime-tinted near 100 / far 450. Goo is emissive `danger`-adjacent lime (`goo` theme defines lethal slime).
- Readability: the goo surface has a bright foam line where it meets geometry;
  2 s before each surge the goo flashes and the bass drops out.

#### Sanity checks

- Stair steps +1.4 ✓ (≤ 1.8), tangential 3 m treads, ≥ 2 m radial depth ✓.
- Pad: apex 9 over a 7 m rise ✓; range 3 m inward lands ~1.5–3 m inside the upper rim.
- T6 disc area 78.5 m² for ~18 survivors (ratio 0.6 of 30) — deliberately tight.
- **Expected:** 30 → 18: most eliminations at the 85 s and 100 s floods.

---

### S4 — Jump Rope Royale

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `jump-rope-royale`                     |
| name          | Jump Rope Royale                       |
| type          | `survival`                             |
| theme         | `beach`                                |
| players       | min 8 · max 50 · ideal 30              |
| qualification | mode `survive`, ratio 0.65             |
| duration      | 90 s, overtime 0                       |
| fallBehavior  | `eliminate`                            |
| killY         | −6                                     |
| bounds        | min (−35, −15, −35) · max (35, 20, 35) |
| music         | `mus_beach_tikitumble`                 |
| cameraMode    | `orbit`                                |
| decorSeed     | 2401                                   |

**Objective:** `Jump or dive the spinning ropes. Stay on!` (41 chars)

**Tips:**

1. Two rings spin opposite ways. Watch the one coming at you.
2. Glowing yellow rope = jump. Striped red rope = dive under.
3. The middle ring has a shorter rope, but less room.

**Fantasy & moments.** A beach-party jump-rope game on a round sandbar: an
inner and an outer rope (two concentric beams) spinning opposite ways, randomly
switching between low (jump) and high (dive).

1. **The Switch** — the outer rope rises to dive height and half the ring jumps
   out of habit into it.
2. **Cross-Ring Leap** — a player hops the 1 m dead ring between the two ropes
   to escape a crowd and lands in the inner rope's path.
3. **Double Dutch** — at 50 s a second outer rope joins on the opposite side;
   passes come twice as often.
4. **Sea Splash** — knocked players skid off the edge into the surf.

#### Arena

| #   | shape       | pos x, y, z          | size x, y, z | rot | surface | colour    | grab | pattern | note                                               |
| --- | ----------- | -------------------- | ------------ | --- | ------- | --------- | ---- | ------- | -------------------------------------------------- |
| a.1 | cylinder    | 0, −0.5, 0           | 20, 1, —     | —   | normal  | primary   |      | none    | sandbar disc r 20, top 0                           |
| a.2 | torus       | 0, 0.02, 0           | 10, 0.5, —   | —   | normal  | safe      |      | none    | dead ring paint (r 9.5–10.5) — no rope passes here |
| a.3 | torus       | 0, 0.02, 0           | 19.8, 0.2, — | —   | normal  | danger    |      | hazard  | edge band                                          |
| a.4 | cylinder    | 0, −3, 0             | 45, 0.2, —   | —   | normal  | #4fd1ff   |      | none    | sea (deco)                                         |
| a.5 | cylinder ×6 | r 30, y 4, every 60° | 2, 8, —      | —   | normal  | secondary |      | stripes | tiki towers with crowd (deco)                      |

| id         | type         | pos     | rot | params                                                                                                                                                                                                                                           |
| ---------- | ------------ | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hub        | bumperPillar | 0, 0, 0 | —   | radius 1.5, height 2.5, bounceImpulse 8 (palm-tree hub)                                                                                                                                                                                          |
| rope-in    | jumpRopeBeam | 0, 0, 0 | —   | innerRadius 1.6, armLength 9.5, armCount 1, beamRadius 0.3, beamHeight 4.5 (parked), heightSchedule [{10, 0.55}, {60, 1.75}, {68, 0.55}, {76, 1.75}, {82, 0.55}], speedSchedule [{0, −0.8}, {25, −1.0}, {60, −1.3}, {75, −1.5}], knockImpulse 9  |
| rope-out   | jumpRopeBeam | 0, 0, 0 | —   | innerRadius 10.5, armLength 20, armCount 1, beamRadius 0.3, beamHeight 0.55, heightSchedule [{35, 1.75}, {45, 0.55}, {64, 1.75}, {72, 0.55}, {80, 1.75}, {86, 0.55}], speedSchedule [{0, 0.7}, {25, 1.0}, {60, 1.3}, {75, 1.5}], knockImpulse 10 |
| rope-out-2 | jumpRopeBeam | 0, 0, 0 | —   | as rope-out, phase 0.5 (opposite side), activeFrom 50, same schedules                                                                                                                                                                            |

Heights: low 0.55 (top 0.85: jump); high 1.75 (1.45–2.05: dive). Telegraph 1.5 s.

#### Escalation timeline

| t (s) | Inner rope     | Outer rope(s)                           |
| ----- | -------------- | --------------------------------------- |
| 0     | parked         | low, +0.7 rad/s                         |
| 10    | low, −0.8      | —                                       |
| 25    | −1.0           | +1.0                                    |
| 35    | —              | **high** (dive)                         |
| 45    | —              | low                                     |
| 50    | —              | second outer rope joins (opposite side) |
| 60    | **high**, −1.3 | +1.3                                    |
| 64    | —              | high                                    |
| 68    | low            | —                                       |
| 72    | —              | low                                     |
| 75    | −1.5           | +1.5 (final 15 s)                       |
| 76    | high           | —                                       |
| 80    | —              | high                                    |
| 82    | low            | —                                       |
| 86    | —              | low                                     |
| 90    | end            | end                                     |

#### Spawn

origin (0, 0.1, −14) · yaw 0 · cols 8 · spacing 1.4 (30 ⇒ 4 rows) — in the outer
ring. Outer rope phase puts it along +x at t = 0, so first contact ≥ 2 s.

#### Flyover (5 s)

Path (0, 25, −35) → (35, 18, 0) → (0, 15, 35) → (−20, 10, −10); lookAt (0, 0, 0).

#### Bot behaviour zones

| Zone        | Rule                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ring choice | Outer ring (r 12–18) by default; Sharp bots move to inner ring (r 4–8) when outer has > 2× the inner's density                                     |
| Jump/Dive   | Same timing model as S1 (low ⇒ jump, high ⇒ dive toward rope's travel); read heightSchedule 0.5 s ahead (Sharp) or react at the telegraph (others) |
| Dead ring   | Don't stand on the dead ring (it's a crossing, not a refuge: both ropes' ends sweep within 0.5 m)                                                  |
| Edge        | Keep r ≤ 17.5                                                                                                                                      |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.05, 1.1, 1.15, 1.2]** (speeds only).

| id            | weight | weather | description                                                    | overrides                                                                                                                        |
| ------------- | ------ | ------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `beach-party` | 4      | clear   | As authored.                                                   | —                                                                                                                                |
| `same-way`    | 2      | clear   | Both rings spin the same way (passes sync — tricky crossings). | `rope-in`: speeds × −1                                                                                                           |
| `heatwave`    | 1      | sunset  | Faster earlier.                                                | all speedSchedule times −10 s (clamp ≥ 0)                                                                                        |
| `low-tide`    | 2      | clear   | No dive heights; triple outer ropes.                           | all heightSchedule high values → 0.55 · add `rope-out-3` as rope-out phase 0.333 activeFrom 40, and set `rope-out-2` phase 0.666 |
| `stormy-surf` | 1      | stormy  | Wind pushes toward the edge.                                   | add `w-gust` fanZone (0, 0, 0) sizeX 40, sizeY 4, sizeZ 40, direction (1,0,0), force 4, gust true                                |

#### Set dressing & lighting

- Sandbar in a turquoise lagoon; tiki-tower crowd ring, a DJ booth boat, beach
  balls bouncing in the crowd, inflatable flamingos, sun umbrellas on the tiki
  towers, fireworks over the sea at 75 s.
- Sun azimuth 180°, elevation 55°, colour `#fff2c4`; fog turquoise near 100 / far 500.
- Readability: ropes are thick (0.6 m) twisted candy-rope meshes; low = glowing
  `accent`; high = `danger` with hazard stripes; a ground shadow strip directly
  under each rope makes approach timing readable from any camera angle.

#### Sanity checks

- Outer tip speed at ω 1.5: 30 m/s; at r 12 it is 18 m/s. Airtime 0.75 s ⇒ jump
  window generous; difficulty is the second rope and switches.
- Dead ring 1 m: both rope ends 0.5 m away — capsule (0.9) touches neither if
  centred (intended crossing lane, not a camping spot).
- **Expected:** 30 → ~20 (35 % out) around 60–80 s.

---

## 6. Team rounds

Common team rules:

- Teams are assigned by the server to balance **party integrity first, then
  skill** (parties stay together; sizes differ by ≤ 1). Team colours are
  `TEAM_COLORS[index]` with crest shapes for colour-blind safety (see
  ART_DIRECTION).
- Qualification `teamScore`, `teams` and `teamsEliminated` as listed. Everyone on
  a surviving team qualifies.
- Arenas are **rotationally or mirror symmetric**; every per-team table lists the
  team-0 instance and the transform for the others.
- Spawns use `teamOrigins` (one per team); each team's grid faces its objective.
- Triggers `goal`/`nest` use `index` = **owning team** (the team that defends a
  goal / owns a nest).

---

### T1 — Egg Heist

| Field         | Value                                            |
| ------------- | ------------------------------------------------ |
| id            | `egg-heist`                                      |
| name          | Egg Heist                                        |
| type          | `team`                                           |
| theme         | `jungle`                                         |
| players       | min 9 · max 45 · ideal 30                        |
| qualification | mode `teamScore`, teams **3**, teamsEliminated 1 |
| duration      | 120 s, overtime 0                                |
| fallBehavior  | `respawnCheckpoint` (respawn at own nest)        |
| killY         | −8                                               |
| bounds        | min (−45, −15, −45) · max (45, 25, 45)           |
| music         | `mus_jungle_bongobounce`                         |
| cameraMode    | `orbit`                                          |
| decorSeed     | 3101                                             |

**Objective:** `Bring eggs to your nest. Steal theirs!` (38 chars)

**Tips:**

1. Hold Grab to pick up an egg. You can't jump high while carrying.
2. Golden eggs appear at 60 s and are worth 5.
3. Guard your nest — or raid someone else's.

**Fantasy & moments.** A jungle temple clearing with a giant egg pile in the
middle and three team nests. It starts as a gold rush and turns into a heist
war.

1. **The Rush** — 30 Tumblers converge on the pile at the whistle; eggs squirt out
   of the scrum in every direction.
2. **Nest Raid** — three raiders sprint into an undefended nest and run off with
   half its eggs while the owners argue in the middle.
3. **Golden Hour** — three golden eggs pop out of the temple at 60 s; dogpiles.
4. **Egg Juggle** — a carrier is tackled (grabbed) and the egg bounces down the
   mud slope into another team's hands.
5. **Last-Second Dunk** — a raider dives into their own nest with an egg at 0.5 s.

#### Rules

| Rule          | Value                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eggs          | 30 normal (1 pt) spawned in the centre pile at t = 0; 3 golden (5 pts) at t = 60                                                                          |
| Carry         | Grab an egg to carry (one at a time). Carrier speed 0.85×, jump apex 1.2 m, no dive. Dive into / grab a carrier ⇒ egg pops out (impulse 4 m/s random dir) |
| Scoring       | Score = value of eggs resting inside your nest trigger at the end (live total shown on HUD). Eggs in nests can be picked up by anyone                     |
| Nest guarding | No restriction — defenders may stand in their nest                                                                                                        |
| Tie-break     | Equal lowest scores ⇒ the team that reached its final score **later** is eliminated; if still tied, fewer golden eggs is eliminated                       |
| Egg respawn   | Eggs that fall off the map respawn at the centre after 3 s                                                                                                |

#### Arena (3-fold rotational symmetry about the origin)

Team angles: team 0 = 90° (+z), team 1 = 210°, team 2 = 330°. A point at angle
θ, radius R is (R cos θ, ·, R sin θ). Per-team rows list team 0; rotate by +120° and
+240° for teams 1 and 2.

| #    | shape       | pos x, y, z                                                                                                                                                     | size x, y, z | rot                                              | surface | colour        | grab | pattern | note                                                                            |
| ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------ | ------- | ------------- | ---- | ------- | ------------------------------------------------------------------------------- |
| a.1  | cylinder    | 0, −0.5, 0                                                                                                                                                      | 34, 1, —     | —                                                | normal  | primary       |      | none    | clearing floor r 34, top 0                                                      |
| a.2  | cylinder    | 0, 0.5, 0                                                                                                                                                       | 8, 1, —      | —                                                | normal  | secondary     |      | none    | temple dais r 8, top 1.0 (edge needs a hop; three ramps a.3)                    |
| a.3  | ramp ×3     | team-0: (0, 0.5, 9.5)                                                                                                                                           | 4, 1, 3      | yaw 180                                          | normal  | secondary     |      | chevron | dais ramps toward each nest (z 8–11 for team 0); rotate ×3                      |
| a.4  | cylinder ×3 | team-0: (0, 0.3, 26)                                                                                                                                            | 5, 0.6, —    | —                                                | normal  | (team colour) |      | dots    | nest platform r 5, top 0.6                                                      |
| a.5  | torus ×3    | team-0: (0, 0.9, 26)                                                                                                                                            | 4.6, 0.35, — | —                                                | normal  | (team colour) |      | none    | nest rim (collider: eggs stay in; 0.35 tube — players step over with a hop)     |
| a.6  | box ×3      | team-0: (0, 2, 32)                                                                                                                                              | 10, 4, 1     | —                                                | normal  | neutral       |      | none    | nest back wall (stone carving)                                                  |
| a.7  | box ×3      | at 30° / 150° / 270°, R 24: (20.78, 0.02, 12) …                                                                                                                 | 8, 0.04, 8   | yaw toward centre                                | normal  | #8a5a3c       |      | none    | mud pads (deco for stickyGoo)                                                   |
| a.8  | box ×6      | R 33 at 18°/42°/138°/162°/258°/282°: (31.38, 1.5, 10.20) (24.52, 1.5, 22.08) (−24.52, 1.5, 22.08) (−31.38, 1.5, 10.20) (−6.86, 1.5, −32.28) (6.86, 1.5, −32.28) | 6, 3, 2      | yaw −18 / −42 / −138 / −162 / 102 / 78 (tangent) | normal  | neutral       |      | none    | outer ruin walls flanking each raid lane (eggs roll off only through the lanes) |
| a.10 | cylinder ×4 | (±5, 3, ±5)                                                                                                                                                     | 0.8, 6, —    | —                                                | normal  | neutral       |      | stripes | temple pillars on the dais (deco, collide)                                      |

| id               | type         | pos                                            | rot               | params                                                                                                                                                       |
| ---------------- | ------------ | ---------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| eggs             | propSpawner  | 0, 1.0, 0                                      | —                 | prop egg, count 30, areaX 10, areaZ 10, respawn true, respawnTime 3, scoreValue 1, radius 0.45, mass 0.4, bounciness 0.4                                     |
| eggs-gold        | propSpawner  | 0, 1.0, 0                                      | —                 | prop goldenEgg, count 3, areaX 4, areaZ 4, activeFrom 60, telegraph 2 (temple roof opens), scoreValue 5, radius 0.55                                         |
| bump-0a / 0b     | bumperPillar | (−3, 0, 14) / (3, 0, 14)                       | —                 | radius 0.9, height 2.4, bounceImpulse 8 (tiki heads); rotate ×3 ⇒ team 1: (−10.62, 0, −9.6) / (−13.62, 0, −4.4); team 2: (13.62, 0, −4.4) / (10.62, 0, −9.6) |
| mud-01 / 12 / 20 | stickyGoo    | (20.78, 0, 12) / (−20.78, 0, 12) / (0, 0, −24) | yaw toward centre | sizeX 8, sizeZ 8, speedMul 0.5, jumpMul 0.6 (raid lanes between nests are slow)                                                                              |
| log-0            | rollingDrum  | team-0: (0, 0.6, 19)                           | yaw 0             | length 6, radius 0.6, angularSpeed **−2.0** (negative ⇒ top surface moves toward local +Z = toward the nest: helps carriers home, slows raiders leaving)     |

Rotated `log` instances: team 1 at (−16.45, 0.6, −9.5) yaw **240**; team 2 at (16.45, 0.6, −9.5)
yaw **120** (yaw turns local +Z toward each team's nest; note yaw runs opposite to the
θ used for positions). (Each log lies across its spoke 7 m in front of its nest.)

#### Triggers

| id     | kind       | pos                      | size                  | index | respawn points                                                                  | yaw                                                                              |
| ------ | ---------- | ------------------------ | --------------------- | ----- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| nest-0 | nest       | 0, 1.5, 26               | 8, 3, 8               | 0     | (−2, 0.7, 24) (0, 0.7, 24) (2, 0.7, 24) (−2, 0.7, 27) (0, 0.7, 27) (2, 0.7, 27) | 180                                                                              |
| nest-1 | nest       | −22.52, 1.5, −13         | 8, 3, 8 (rot yaw 240) | 1     | team-0 points rotated to θ 210°                                                 | 60                                                                               |
| nest-2 | nest       | 22.52, 1.5, −13          | 8, 3, 8 (rot yaw 120) | 2     | rotated to θ 330°                                                               | 300                                                                              |
| cp-n   | checkpoint | (per nest, same as nest) | —                     | 0     | —                                                                               | — (respawn at own nest: engineers map `respawnCheckpoint` to team nest respawns) |

#### Spawn

teamOrigins: team 0 (0, 0.7, 22) facing yaw 180 (toward centre); team 1 (−19.05, 0.7, −11)
yaw 60; team 2 (19.05, 0.7, −11) yaw 300 (all on their nest platforms). cols 5, spacing 1.4.

**Schema wish §11 #5:** per-team spawn yaw. Fallback: spawn `yaw` is applied
per team as "face the origin" when `teamOrigins` is non-empty.

#### Flyover (5 s)

Path (0, 30, 45) → (40, 22, 0) → (0, 18, −40) → (−30, 14, 10); lookAt (0, 1, 0) throughout,
ending on the egg pile.

#### Bot behaviour zones

| Role (assigned per team, re-evaluated every 10 s) | Share           | Behaviour                                                                                            |
| ------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Gatherer                                          | 50 %            | Go to the nearest free egg (centre first), carry home along own spoke                                |
| Raider                                            | 30 %            | Target the nest with the highest score (or the leader's), grab an egg, return via the mud-free spoke |
| Guard                                             | 20 %            | Stay within r 6 of own nest; grab carriers who leave with own eggs                                   |
| Golden                                            | all within 15 m | At t ≥ 58, converge on the temple                                                                    |

Key waypoints: centre (0, 1, 0) r 4; per-team spoke points at R 14 and R 22 on the
team's angle; nest centres.

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1, 1, 1, 1]** (no timed obstacles to scale; logs fixed).

| id               | weight | weather | description                                          | overrides                                                                                                                   |
| ---------------- | ------ | ------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `jungle-classic` | 4      | clear   | As authored.                                         | —                                                                                                                           |
| `scramble`       | 2      | clear   | Eggs rain from the sky every 15 s instead of a pile. | `eggs`: count 10, add `eggs-rain` propSpawner (0, 15, 0) prop egg count 5, areaX 50, areaZ 50, respawn true, respawnTime 15 |
| `golden-glut`    | 1      | sunset  | Gold at 30 s and 75 s.                               | `eggs-gold`: activeFrom 30 · add `eggs-gold-2` as eggs-gold with activeFrom 75                                              |
| `monsoon`        | 1      | stormy  | Wind and slippery mud.                               | `mud-*`: speedMul 0.35 · add `w-gust` fanZone (0, 0, 0) sizeX 70 sizeY 5 sizeZ 70, direction (1,0,0), force 3, gust true    |

#### Set dressing & lighting

- Jungle temple clearing: giant stone tiki heads, vine bridges overhead (deco),
  waterfalls on the perimeter, parrots, glowing flowers, a crowd of frog
  spectators on lily pads; each nest is a giant woven basket in team colour
  with a crest banner.
- Sun azimuth 160°, elevation 65° through canopy (god rays), colour `#fff6d8`; fog
  green-gold near 60 / far 300.

#### Sanity checks

- Spokes centre → nest: 26 m ≈ 3.4 s running, ≈ 4.1 s carrying (0.85×).
- Each nest is equidistant (26 m) from the centre and 45 m from each other nest ✓.
- Dais 1.0 m edge needs a hop; carriers (apex 1.2) can still hop it, and three
  ramps exist ✓.
- **Expected:** final totals ≈ 10–14 per team; one team clearly behind ≈ 60 % of
  shows, last-30-s swing in the rest.

---

### T2 — Bounce Ball Blitz

| Field         | Value                                            |
| ------------- | ------------------------------------------------ |
| id            | `bounce-ball-blitz`                              |
| name          | Bounce Ball Blitz                                |
| type          | `team`                                           |
| theme         | `sunset`                                         |
| players       | min 6 · max 40 · ideal 24                        |
| qualification | mode `teamScore`, teams **2**, teamsEliminated 1 |
| duration      | 120 s, overtime **60** (golden goal)             |
| fallBehavior  | `respawnCheckpoint` (own half)                   |
| killY         | −8                                               |
| bounds        | min (−35, −15, −45) · max (35, 30, 45)           |
| music         | `mus_sunset_boardwalk`                           |
| cameraMode    | `orbit`                                          |
| decorSeed     | 3201                                             |

**Objective:** `Knock the giant ball into the other goal!` (41 chars)

**Tips:**

1. Dive into the ball for a big kick.
2. Bounce pads launch you into the action — and the ball too.
3. A second ball joins at 60 seconds. Don't forget your goal!

**Fantasy & moments.** Sunset beach-stadium football with a ball twice your
height. Twenty Tumblers swarm it like ants; every goal is a stampede.

1. **The Swarm** — 24 players converge on the ball at kick-off; it pops out
   sideways and rolls into the crowd.
2. **Own Goal** — a desperate defensive dive slams the ball into your own net.
3. **Pad Volley** — the ball rolls over a bounce pad and launches across the
   field; everyone stops to watch.
4. **Double Trouble** — the second ball appears behind the defence.
5. **Golden Goal** — 0–0 at full time: overtime, first goal wins.

#### Rules

| Rule        | Value                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ball        | radius 1.8, mass 4 (Tumbler = 1), bounciness 0.75, linear damping 0.3, angular damping 0.4. Kick: dive contact adds 9 m/s along dive direction; running contact uses normal physics |
| Goal        | Ball centre fully inside a goal trigger ⇒ +1 for the attacking team; ball despawns with confetti, respawns at the centre spot after 3 s (dropped from y 8)                          |
| Second ball | At t = 60 a second ball drops at the centre (2 s telegraph)                                                                                                                         |
| Overtime    | Tie at 120 s ⇒ 60 s golden goal. Still tied ⇒ team with more **ball-touch seconds in the opponent half** wins                                                                       |
| Respawn     | Falls (only possible off the stand edges) respawn in own half                                                                                                                       |

#### Field (mirror symmetric across z = 0; team 0 defends −z)

| #    | shape           | pos x, y, z                                                                                | size x, y, z  | rot     | surface | colour                  | grab | pattern | note                                                                                        |
| ---- | --------------- | ------------------------------------------------------------------------------------------ | ------------- | ------- | ------- | ----------------------- | ---- | ------- | ------------------------------------------------------------------------------------------- |
| f.1  | box             | 0, −0.5, 0                                                                                 | 40, 1, 64     | —       | normal  | primary                 |      | none    | pitch x ±20, z ±32                                                                          |
| f.2  | box             | 0, 0.01, 0                                                                                 | 40, 0.02, 0.3 | —       | normal  | #ffffff                 |      | none    | halfway line (deco)                                                                         |
| f.3  | torus           | 0, 0.02, 0                                                                                 | 6, 0.15, —    | —       | normal  | #ffffff                 |      | none    | centre circle (deco)                                                                        |
| f.4  | ramp            | 0, 0.4, ±4                                                                                 | 16, 0.8, 8    | 0 / 180 | normal  | secondary               |      | none    | midfield hump (two ramps meeting at z 0, top 0.8) — makes the ball skip unpredictably       |
| f.5  | box             | ±20.5, 2, 0                                                                                | 1, 4, 64      | —       | bouncy  | neutral                 |      | dots    | side walls (bouncy boards)                                                                  |
| f.6  | box             | ±13, 2, ±32.5                                                                              | 14, 4, 1      | —       | bouncy  | neutral                 |      | dots    | end walls either side of each goal (x 6…20)                                                 |
| f.7  | box ×3 per goal | posts (±6.25, 2.75, ±32) size 0.5 × 5.5 × 0.5; crossbar (0, 5.25, ±32) size 13 × 0.5 × 0.5 | —             | —       | normal  | (defending team colour) |      | stripes | goal frames: 12 m × 5 m clear mouth                                                         |
| f.8  | box             | 0, 2.5, ±36.5                                                                              | 12, 5, 1      | —       | normal  | neutral                 |      | none    | goal back walls                                                                             |
| f.9  | box             | ±6.25, 2.5, ±34.5                                                                          | 0.5, 5, 4     | —       | normal  | neutral                 |      | none    | goal side walls                                                                             |
| f.10 | box             | 0, −0.5, ±34.5                                                                             | 12, 1, 4      | —       | normal  | neutral                 |      | none    | goal floors (z 32.5–36.5)                                                                   |
| f.11 | box             | 0, 12.5, 0                                                                                 | 42, 1, 66     | —       | normal  | —                       |      | none    | **ball-only ceiling** (invisible; collision group DYNAMIC_PROP only) keeps the ball in play |
| f.12 | box             | ±26, 4, 0                                                                                  | 10, 8, 70     | —       | normal  | neutral                 |      | stripes | stadium stands (deco, crowd)                                                                |

| id        | type         | pos                                  | rot     | params                                                                                 |
| --------- | ------------ | ------------------------------------ | ------- | -------------------------------------------------------------------------------------- |
| ball      | propSpawner  | 0, 8, 0                              | —       | prop ball, count 1, radius 1.8, mass 4, bounciness 0.75, respawn true, respawnTime 3   |
| ball-2    | propSpawner  | 0, 8, 0                              | —       | as ball, activeFrom 60, telegraph 2                                                    |
| bump-1..4 | bumperPillar | (±10, 0, ±12) (all four sign combos) | —       | radius 1.0, height 2.4, bounceImpulse 10                                               |
| pad-A     | bouncePad    | −17, 0, −6                           | yaw 0   | radius 1.5, targetApex 6, targetRange 14 (launches toward +z: favours team 0's attack) |
| pad-B     | bouncePad    | 17, 0, 6                             | yaw 180 | as pad-A (toward −z: favours team 1) — point-symmetric pair                            |
| pad-gk-0  | bouncePad    | 0, 0, −27                            | yaw 0   | radius 1.2, targetApex 4, targetRange 10 (keeper clearance pad in front of goal 0)     |
| pad-gk-1  | bouncePad    | 0, 0, 27                             | yaw 180 | as pad-gk-0                                                                            |

#### Triggers

| id     | kind       | pos           | size           | index                  | respawn points             | yaw |
| ------ | ---------- | ------------- | -------------- | ---------------------- | -------------------------- | --- |
| goal-0 | goal       | 0, 2.5, −34.5 | 11.4, 4.8, 3.6 | 0 (defended by team 0) | —                          | —   |
| goal-1 | goal       | 0, 2.5, 34.5  | 11.4, 4.8, 3.6 | 1                      | —                          | —   |
| cp-t0  | checkpoint | 0, 2, −20     | 30, 4, 10      | 0                      | x ±9/±5/±1.5, y 0.1, z −22 | 0   |
| cp-t1  | checkpoint | 0, 2, 20      | 30, 4, 10      | 1                      | x ±9/±5/±1.5, y 0.1, z 22  | 180 |

(Checkpoint `index` here = team; engineers: team rounds respawn at the checkpoint
whose index = own team.)

#### Spawn

teamOrigins: team 0 (0, 0.1, −18) yaw 0 · team 1 (0, 0.1, 18) yaw 180. cols 6, spacing 1.6.

#### Flyover (5 s)

Path (−30, 20, −40) → (0, 26, 0) → (30, 20, 40) → (0, 10, −30); lookAt (0, 0, −32), (0, 0, 0),
(0, 0, 32), (0, 2, 0).

#### Bot behaviour zones

| Role        | Share                    | Behaviour                                                                                                   |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Striker     | 50 %                     | Path to a point 2.5 m behind the ball on the line ball→opponent goal, then run through (Sharp: dive at 2 m) |
| Midfield    | 25 %                     | Hold between ball and own goal at 40 % distance; challenge if ball enters own half                          |
| Keeper      | 1 per team (≥ 6 players) | Stay on own goal line x ±5; dive at ball when within 6 m                                                    |
| Second ball | —                        | After 60 s the closest 30 % retarget ball-2                                                                 |

#### Difficulty & variations

`speedScaleByStage`: **[1, 1, 1, 1, 1]**.

| id            | weight | weather | description                            | overrides                                                                                                                                                          |
| ------------- | ------ | ------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sunset-cup`  | 4      | sunset  | As authored.                           | —                                                                                                                                                                  |
| `mega-ball`   | 2      | clear   | One huge ball (r 2.6), no second ball. | `ball`: radius 2.6, mass 6 · remove `ball-2`                                                                                                                       |
| `pinball`     | 2      | night   | Extra bumpers; floodlights.            | add bump-5/6 at (0, 0, ±14), bump-7/8 at (±16, 0, 0)                                                                                                               |
| `windy-final` | 1      | windy   | Crosswind swaps direction every 15 s.  | add `w-cross` fanZone (0, 0, 0) sizeX 40 sizeY 8 sizeZ 64, direction (1,0,0), force 3, onTime 15, offTime 0 (module flips direction each cycle: `alternate: true`) |

#### Set dressing & lighting

- Boardwalk stadium at golden hour: string lights, pastel beach huts as stands,
  a giant inflatable mascot behind each goal in team colour, a scoreboard blimp,
  fireworks on every goal, palm silhouettes against an orange sky.
- Sun azimuth 270°, elevation 15° (low, from the side — no goal faces into the
  sun), colour `#ffb36b`; fog peach near 120 / far 500.

#### Sanity checks

- Goal mouth 12 × 5 m vs ball Ø 3.6 m ⇒ readable, scoreable from midfield ✓.
- Point-symmetric pads/bumpers ⇒ fair ✓.
- **Expected:** 2–5 goals per match; ~15 % go to overtime.

---

### T3 — Paint the Plaza

| Field         | Value                                            |
| ------------- | ------------------------------------------------ |
| id            | `paint-the-plaza`                                |
| name          | Paint the Plaza                                  |
| type          | `team`                                           |
| theme         | `neon`                                           |
| players       | min 8 · max 40 · ideal 24                        |
| qualification | mode `teamScore`, teams **4**, teamsEliminated 1 |
| duration      | 90 s, overtime 0                                 |
| fallBehavior  | `respawnCheckpoint` (own corner)                 |
| killY         | −8                                               |
| bounds        | min (−40, −15, −40) · max (40, 25, 40)           |
| music         | `mus_neon_arcadeheart`                           |
| cameraMode    | `orbit`                                          |
| decorSeed     | 3301                                             |

**Objective:** `Paint the most floor in your team colour!` (41 chars)

**Tips:**

1. Diving splashes a big blob of paint.
2. Grab a paint bucket for a few seconds of super-roller.
3. Stages count double. Rinse arms wash paint away!

**Fantasy & moments.** A neon night plaza where every footstep leaves glowing
paint. It looks like a living abstract painting by the end, and the HUD meter
is a four-way tug of war.

1. **Dive Bombing** — players chain dives across enemy territory, leaving
   splashes like footprints.
2. **Bucket Brawl** — four players grab-fight over one bucket in the centre.
3. **Rinse and Repeat** — the rotating rinse arm wipes a stripe through
   everyone's work.
4. **Stage Takeover** — a team holds a raised double-value stage for the last
   20 s and swings the result.

#### Rules — paint grid

| Rule       | Value                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Grid       | 48 × 48 m plaza, cells 2 × 2 m ⇒ 24 × 24 = 576 cells; stage cells (36 total) count **×2**                                                    |
| Painting   | A grounded Tumbler paints the cell under its capsule centre every sim step (team colour). Dive landing paints a 3 × 3 cell splash            |
| Bucket     | `paintBucket` prop: carrying it for 6 s paints a 3-cell-wide swath (cell + left/right neighbours); bucket then vanishes, respawns 12 s later |
| Rinse arms | Cells under a rinse arm's footprint become neutral (see obstacles)                                                                           |
| Score      | Painted value at the end; HUD shows live % per team. Tie for last ⇒ the team with fewer **stage** cells is eliminated                        |

**Schema wish §11 #6:** a `paintGrid` obstacle/rule type. Fallback: one `zone`
trigger (index 0) covering the plaza, and the round module reads
`designNotes` JSON: `{"paint":{"cell":2,"stageMult":2,"bucketTime":6}}`.

#### Plaza (4-fold symmetry; team corners: 0 = (−x, −z), 1 = (+x, −z), 2 = (+x, +z), 3 = (−x, +z))

| #   | shape    | pos x, y, z                                                                                                                                                                                                                        | size x, y, z | rot                        | surface | colour        | grab | pattern | note                                                                             |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------- | ------- | ------------- | ---- | ------- | -------------------------------------------------------------------------------- |
| p.1 | box      | 0, −0.5, 0                                                                                                                                                                                                                         | 48, 1, 48    | —                          | normal  | neutral       |      | checker | plaza floor (paint shader)                                                       |
| p.2 | box      | 0 / ±18, 0.75, ±18 / 0                                                                                                                                                                                                             | 6, 1.5, 6    | —                          | normal  | neutral       |      | none    | 4 stages at (0, ±18) and (±18, 0), top 1.5 (stage cells: 3 × 3 each = 9 ×4 = 36) |
| p.3 | ramp ×8  | per stage: inner ramp centred 4 m toward the plaza centre from the stage centre (size 3, 1.5, 4), outer ramp 4.5 m outward (size 3, 1.5, 3). Stage (0, 18): (0, 0.75, 13) yaw 0 and (0, 0.75, 22.5) yaw 180; rotate for the others | —            | yaw rises toward the stage | normal  | neutral       |      | chevron | stage ramps                                                                      |
| p.4 | cylinder | 0, 0.3, 0                                                                                                                                                                                                                          | 3, 0.6, —    | —                          | normal  | accent        |      | none    | fountain base (rinse hub)                                                        |
| p.5 | box      | ±24.5, 1, 0                                                                                                                                                                                                                        | 1, 2, 50     | —                          | normal  | neutral       |      | none    | edge walls (neon trim) ×2                                                        |
| p.6 | box      | 0, 1, ±24.5                                                                                                                                                                                                                        | 50, 2, 1     | —                          | normal  | neutral       |      | none    | edge walls ×2                                                                    |
| p.7 | box ×4   | (±21, 0.01, ±21)                                                                                                                                                                                                                   | 6, 0.02, 6   | —                          | normal  | (team colour) |      | checker | team corner pads (pre-painted, spawn)                                            |

| id        | type         | pos         | rot | params                                                                                                                                                                                                                                             |
| --------- | ------------ | ----------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rinse     | sweeperArm   | 0, 0, 0     | —   | armLength 16, armCount 2, armHeight 3.5 (harmless height; water curtain VFX reaches the floor), armRadius 0.4, angularSpeed 0.45, speedSchedule [{60, 0.7}], hubRadius 3, hubHeight 4 — **paint erase footprint: 1.2 m wide strip under each arm** |
| buckets   | propSpawner  | 0, 0.6, 0   | —   | prop paintBucket, count 4, areaX 12, areaZ 12 (spawn at r 6 at 45°/135°/225°/315° — equidistant from all corners), respawn true, respawnTime 12                                                                                                    |
| bump-1..4 | bumperPillar | (±9, 0, ±9) | —   | radius 1.0, height 2.4, bounceImpulse 8                                                                                                                                                                                                            |

#### Triggers

| id         | kind       | pos                       | size      | index | respawn points          | yaw                                    |
| ---------- | ---------- | ------------------------- | --------- | ----- | ----------------------- | -------------------------------------- |
| paint-zone | zone       | 0, 1, 0                   | 48, 3, 48 | 0     | —                       | —                                      |
| cp-t0..t3  | checkpoint | corner pads (±21, 1, ±21) | 6, 3, 6   | team  | 4 points within the pad | facing centre (45°, −45°, −135°, 135°) |

#### Spawn

teamOrigins: (−20, 0.1, −20), (20, 0.1, −20), (20, 0.1, 20), (−20, 0.1, 20); cols 3, spacing 1.5;
yaw faces the centre.

#### Flyover (5 s)

Top-down spin: path (0, 50, −10) → (10, 48, 0) → (0, 46, 10) → (−10, 44, 0) → (0, 30, −30);
lookAt (0, 0, 0).

#### Bot behaviour zones

| Role      | Share | Behaviour                                                                                   |
| --------- | ----- | ------------------------------------------------------------------------------------------- |
| Painter   | 60 %  | Pick the nearest 6 × 6 m block with the most non-own cells; zig-zag it with dives every 3 s |
| Stager    | 20 %  | Hold the nearest stage, repaint it                                                          |
| Bucketeer | 20 %  | Go for buckets when spawned; then run long straight lines through enemy paint               |
| Rinse     | all   | Avoid standing under rinse arms (wasted paint)                                              |

#### Difficulty & variations

| id               | weight | weather | description                                              | overrides                                 |
| ---------------- | ------ | ------- | -------------------------------------------------------- | ----------------------------------------- |
| `neon-night`     | 4      | night   | As authored.                                             | —                                         |
| `slick-paint`    | 2      | night   | Painted cells of other teams are slippery (ice) for you. | designNotes `{"paint":{"enemyIce":true}}` |
| `triple-rinse`   | 1      | night   | Three rinse arms.                                        | `rinse`: armCount 3                       |
| `bucket-bonanza` | 2      | night   | Eight buckets.                                           | `buckets`: count 8                        |

#### Set dressing & lighting

- Neon city plaza at night: billboards showing live team %, light-up dance-floor
  cells, holographic street-art murals, crowd on rooftops, drones with spot
  lights.
- Moonlight azimuth 45°, elevation 50°, colour `#9fb6ff` at low intensity; the
  paint itself is emissive (team colours, 0.6 strength) — the plaza lights up as
  it's painted.

#### Sanity checks

- Each corner is 29.7 m from the centre buckets and 25.5 m from its two nearest
  stages ✓ symmetric.
- 24 players × 9 m/s ⇒ ~216 cells/s potential vs 576 cells: the floor gets fully
  painted within ~10 s; the round is about **repainting**, by design.

---

## 7. Hunt

### H1 — Tail Chase

| Field         | Value                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| id            | `tail-chase`                                                                                                     |
| name          | Tail Chase                                                                                                       |
| type          | `hunt`                                                                                                           |
| theme         | `jungle`                                                                                                         |
| players       | min 8 · max 50 · ideal 30                                                                                        |
| qualification | mode `holdItem`, ratio 0.5 (tails = ceil(entrants × 0.5))                                                        |
| duration      | 90 s, overtime 0                                                                                                 |
| fallBehavior  | `respawnCheckpoint` (nearest of 4 corner pads; falling **drops your tail** at the fall point's nearest platform) |
| killY         | −8                                                                                                               |
| bounds        | min (−45, −15, −45) · max (45, 30, 45)                                                                           |
| music         | `mus_jungle_bongobounce`                                                                                         |
| cameraMode    | `orbit`                                                                                                          |
| decorSeed     | 4101                                                                                                             |

**Objective:** `Hold a tail when time runs out!` (31 chars)

**Tips:**

1. Grab a tail from behind to steal it.
2. Just stole one? You're safe for a moment. Run!
3. Bounce pads on the towers are great escape routes.

**Fantasy & moments.** A jungle ruin playground where half the lobby wears
glowing monkey tails and the other half hunts them. Pure chase comedy.

1. **Tail Ping-Pong** — the same tail changes owners five times in ten seconds.
2. **Tower Escape** — a tail holder flees up a tower, gets cornered, and leaps off
   a bounce pad across the arena.
3. **Conveyor Getaway** — a holder rides the outer conveyor loop with a conga line
   of hunters chasing.
4. **Last-Second Snatch** — a steal at 0.3 s; the stamp lands on the thief.

#### Rules

| Rule     | Value                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tails    | `ceil(N × 0.5)` tails assigned at random at t = 0                                                                                                                |
| Steal    | Grab (hold) on a tail holder within 1.3 m whose **back hemisphere** faces you (±100° from their rear) ⇒ tail transfers. Front grabs only slow them (normal grab) |
| Immunity | New holder: 1.5 s steal immunity (flashing tail)                                                                                                                 |
| Speeds   | Holders 1.0×; hunters 1.05× run speed                                                                                                                            |
| Falls    | Falling drops the tail on the nearest platform edge (a glowing `tail` prop anyone can grab)                                                                      |
| End      | Holders at 0.0 s qualify. Ties impossible (count fixed)                                                                                                          |

#### Arena

Square 60 × 60 m ruin (x, z ±30), four-fold symmetric.

| #   | shape       | pos x, y, z                                                         | size x, y, z | rot                                         | surface | colour    | grab | pattern | note                                       |
| --- | ----------- | ------------------------------------------------------------------- | ------------ | ------------------------------------------- | ------- | --------- | ---- | ------- | ------------------------------------------ |
| r.1 | box         | 0, −0.5, 0                                                          | 56, 1, 56    | —                                           | normal  | primary   |      | none    | ground x, z ±28 (conveyor loop outside it) |
| r.2 | box         | 0, 0.75, 0                                                          | 18, 1.5, 18  | —                                           | normal  | secondary |      | none    | ziggurat tier 1 (top 1.5)                  |
| r.3 | box         | 0, 1.5, 0                                                           | 12, 3, 12    | —                                           | normal  | secondary |      | none    | tier 2 (top 3.0)                           |
| r.4 | box         | 0, 2.25, 0                                                          | 6, 4.5, 6    | —                                           | normal  | accent    |      | none    | tier 3 / summit (top 4.5)                  |
| r.5 | ramp ×4     | (0, 0.75, ±11) / (±11, 0.75, 0)                                     | 4, 1.5, 4    | facing out (yaw 180 at +z, 0 at −z, 90/−90) | normal  | secondary |      | chevron | tier-1 ramps (N/E/S/W)                     |
| r.6 | box ×4      | towers at (±22, 4, ±22)                                             | 6, 8, 6      | —                                           | normal  | neutral   | ✓    | none    | corner towers top 8 (grabbable edges)      |
| r.7 | box ×12     | tower stairs, 3 per tower (exact table below)                       | —            | —                                           | normal  | accent    | ✓    | none    | +1.5 / +1.8 jumps, then +2.2 / +2.5 grabs  |
| r.8 | box ×4      | (0, 0.5, ±30.25) size 61, 1, 0.5 · (±30.25, 0.5, 0) size 0.5, 1, 61 | —            | —                                           | normal  | neutral   |      | none    | 1 m outer rails beyond the conveyor loop   |
| r.9 | cylinder ×4 | (±22, 0.01, 0) / (0, 0.01, ±22)                                     | 4, 0.02, —   | —                                           | normal  | safe      |      | none    | respawn pad paint (deco)                   |

Tower stair exact (tower at (+22, +22); mirror for the other three by sign):
block A (17.5, 0.75, 22) size (3, 1.5, 3) top 1.5 · block B (17.5, 1.65, 18.5) size (3, 3.3, 3)
top 3.3 · block C (21, 2.75, 17.5) size (3, 5.5, 3) top 5.5 · then grab tower lip (top 8,
+2.5) from C. Each step: +1.5, +1.8, +2.2 (grab), +2.5 (grab).

| id                 | type         | pos                                                               | rot                                                | params                                                                                         |
| ------------------ | ------------ | ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| loop-N / E / S / W | conveyorBelt | (0, 0, 29) / (29, 0, 0) / (0, 0, −29) / (−29, 0, 0)               | yaw 90 / 180 / 270 / 0                             | width 2, length 60 (N, S) / 56 (E, W), speed 5, rails false — loop runs N→+x, E→−z, S→−x, W→+z |
| pad-T1..T4         | bouncePad    | (22, 8, 22) / (−22, 8, 22) / (−22, 8, −22) / (22, 8, −22)         | yaw 225 / 135 / 45 / 315 (toward centre)           | radius 1.2, targetApex 6, targetRange 20, landingDelta −3.5 (lands on tier 2 / summit area)    |
| disc               | spinningDisc | 0, 4.5, 0                                                         | —                                                  | radius 3, thickness 0.5, angularSpeed 1.2 (summit merry-go-round)                              |
| log-1..4           | rollingDrum  | (13, 0.6, 13) / (−13, 0.6, 13) / (−13, 0.6, −13) / (13, 0.6, −13) | yaw 45 / −45 / 45 / −45 (axis across the diagonal) | length 6, radius 0.6, angularSpeed 2.5 (trip hazards on the tower–ziggurat diagonals)          |

#### Triggers

| id        | kind       | pos                                    | size    | index | respawn points       | yaw           |
| --------- | ---------- | -------------------------------------- | ------- | ----- | -------------------- | ------------- |
| cp-c0..c3 | checkpoint | mid-edge pads (±22, 1, 0), (0, 1, ±22) | 8, 3, 8 | 0     | 4 points on each pad | facing centre |

#### Spawn

origin (0, 0.1, −16) · yaw 0 · cols 8 · spacing 1.5 (holders and hunters mixed at
random; tails assigned after the countdown so nobody is pre-targeted).

#### Flyover (5 s)

Path (−40, 20, −40) → (40, 26, −40) → (40, 18, 40) → (0, 14, 20); lookAt (0, 3, 0).

#### Bot behaviour zones

| State              | Behaviour                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holder             | Flee: maximise distance to the 3 nearest hunters weighted by their speed toward me; prefer escape features (conveyor with flow, tower pad, ramps). Keep my back away from hunters (face them while backing off when < 3 m, Sharp only) |
| Hunter             | Target the nearest holder not immune, approach from behind (path to a point 1 m behind them), grab when ≤ 1.2 m                                                                                                                        |
| Late game (< 10 s) | Holders head to open ground; hunters swarm the nearest holder                                                                                                                                                                          |

#### Difficulty & variations

| id              | weight | weather | description                                  | overrides                                                                                                          |
| --------------- | ------ | ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ruins-classic` | 4      | clear   | As authored.                                 | —                                                                                                                  |
| `few-tails`     | 2      | clear   | Harsher cut: only 40 % of players get tails. | qualification ratio 0.4 — needs a playlist-level override (Schema wish §11 #8); SHOWS.md uses it only at stage ≥ 2 |
| `fast-loop`     | 1      | sunset  | Conveyor 8 m/s, disc faster.                 | `loop-*`: speed 8 · `disc`: angularSpeed 2                                                                         |
| `jungle-night`  | 1      | night   | Tails glow brighter; fireflies.              | —                                                                                                                  |

#### Set dressing & lighting

- Overgrown temple ruins, vines, banana-leaf canopies over the towers, monkey
  statues, a crowd of toucans; tails are fluffy glowing monkey tails in `accent`.
- Sun azimuth 200°, elevation 55°, colour `#fff1d0`; fog green near 70 / far 350.

#### Sanity checks

- Tower stair steps: +1.5 / +1.8 jump ✓, +2.2 / +2.5 grab ✓.
- Tower pad: drop −3.5 m over 20 m ✓.
- Ziggurat tiers +1.5 each ✓ (jump), ramps on tier 1 only — tier 2 and summit need
  jumps (chase friction).

---

## 8. Logic

### L1 — Pattern Panic

| Field         | Value                                       |
| ------------- | ------------------------------------------- |
| id            | `pattern-panic`                             |
| name          | Pattern Panic                               |
| type          | `logic`                                     |
| theme         | `neon`                                      |
| players       | min 6 · max 40 · ideal 24                   |
| qualification | mode `logicSurvive`, ratio 0.6              |
| duration      | 150 s (hard cap), overtime 0                |
| fallBehavior  | `eliminate`                                 |
| killY         | −10                                         |
| bounds        | min (−30, −15, −30) · max (30, 40, 30)      |
| music         | `mus_logic_ticktock`                        |
| cameraMode    | `topDownTilt` (players may switch to orbit) |
| decorSeed     | 5101                                        |

**Objective:** `Remember the symbols. Stand on the right one!` (45 chars)

**Tips:**

1. Watch the tiles while they're lit — they go dark fast.
2. The big screen shows the symbol you need. Get on it before the timer ends!
3. Later rounds have tricks: two targets, and "NOT" rounds.

**Fantasy & moments.** A neon game-show memory floor. Sixteen giant tiles flash
symbols, go dark, and then the host's screen reveals the safe symbol. Everyone
sprints; most tiles drop.

1. **The Stampede** — 24 players sprint for the same two tiles; shoving decides.
2. **Wrong Moon** — a player confidently stands on the moon… it was the star.
3. **"NOT" Round** — the screen says NOT ★; half the lobby still runs to the star.
4. **Last-Tile Teeter** — two players on the edge of a tile, both jumping as the
   other tiles fall.

#### Board

4 × 4 tiles, each 6 × 6 m, 1 m gaps, top y 0. Tile centres at x, z ∈ {−10.5, −3.5, 3.5,
10.5}. Tile index i = row·4 + col (row along +z, col along +x), row/col 0 at −10.5.

| #   | shape | pos x, y, z | size x, y, z | rot | surface | colour  | grab | pattern | note                                |
| --- | ----- | ----------- | ------------ | --- | ------- | ------- | ---- | ------- | ----------------------------------- |
| b.2 | box   | 0, 12, 22   | 24, 12, 1    | —   | normal  | neutral |      | none    | the Big Screen (deco; shows target) |
| b.4 | torus | 0, −6, 0    | 30, 1, —     | —   | normal  | accent  |      | none    | neon ring under the board (deco)    |

| id    | type         | pos     | rot | params                                                                                                                                                                                                                               |
| ----- | ------------ | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| board | fallingTiles | 0, 0, 0 | —   | tileShape square, tileSize 6, gap 1, cols 4, rows 4, thickness 0.8, triggerMode **timed** (driven by the round rules: drop = all tiles not in the safe set), shakeTime 0.6, dropDelay 0, fallDepth 12, respawn true, respawnTime 2.5 |
| sweep | sweeperArm   | 0, 0, 0 | —   | armLength 14.5, armCount 1, armHeight 0.55, armRadius 0.3, angularSpeed 1.6, activeFrom ∞ (enabled only during "decide" in rounds ≥ 7), hubRadius 0.6, hubHeight 0.9 (hub sits in the central gap cross)                             |

**Schema wish §11 #7:** `fallingTiles` driven by round logic (a `controlledBy:
'round'` flag + per-tile symbol display). Fallback: the L1 round module owns the
board instance and calls its runtime directly.

#### Symbol set

8 symbols, each a distinct **shape and colour** (colour-blind safe; see
ART_DIRECTION iconography): ★ star, ♥ heart, ☾ moon, ⚡ bolt, ✿ flower, 💧 drop,
♛ crown, ☁ cloud. Tiles display their symbol as a 4 m glowing decal; the Big
Screen shows the target symbol (and for NOT rounds, the symbol with a big ✕ and
the word "NOT").

#### Round rule set (one "board round" = SHOW → HIDE → DECIDE → DROP → RESTORE)

| Board round | Symbols in play | Layout                                                      | SHOW (lit)                       | HIDE (dark) before target | DECIDE (target visible, timer) | Safe set                       | Twist                                                       |
| ----------- | --------------- | ----------------------------------------------------------- | -------------------------------- | ------------------------- | ------------------------------ | ------------------------------ | ----------------------------------------------------------- |
| 1           | 4 (★ ♥ ☾ ⚡)    | each on 4 tiles, quadrant-clustered                         | stays lit through DECIDE         | 0                         | 6 s                            | 4 tiles of target              | Teaching round: no memory needed                            |
| 2           | 4               | each on 4 tiles, scattered (no two same adjacent)           | 5 s                              | 1 s                       | 5 s                            | 4 tiles                        | First memory round                                          |
| 3           | 6               | 8 tiles = 4 symbols × 2, 8 tiles = 2 symbols × 4 → total 16 | 4 s                              | 1 s                       | 4.5 s                          | 2 or 4 tiles                   | Target is a 2-tile symbol 70 %                              |
| 4           | 8               | each on 2 tiles, scattered                                  | 4 s                              | 1 s                       | 4 s                            | 2 tiles                        | Full set                                                    |
| 5           | 8               | each on 2 tiles                                             | 3.5 s                            | 1 s                       | 4 s                            | **4 tiles: TWO targets shown** | Double target                                               |
| 6           | 8               | each on 2 tiles                                             | 3 s                              | 1 s                       | 4 s                            | **14 tiles: NOT target**       | Inverse — only the target's 2 tiles drop                    |
| 7           | 8               | each on 2 tiles                                             | 3 s                              | 1 s                       | 4 s                            | 2 tiles                        | Low sweeper bar active during DECIDE (jump it)              |
| 8+          | 8               | each on 2 tiles                                             | 2.5 s (−0.25 per round, min 1.5) | 0.75 s                    | 3.5 s (min 3)                  | 2 tiles                        | Sweeper active; every other round is NOT or DOUBLE (seeded) |

Phase timings: DROP = 0.6 s shake + tiles fall; RESTORE = 2.5 s (tiles rise lit
with _new_ symbols already hidden — next SHOW starts when they lock). One board
round ≈ 12–17 s ⇒ rounds 1–8 ≈ 115 s.

**Layout generation** (seeded per board round): shuffle symbol multiset into the
16 cells; reject layouts where two identical symbols are orthogonally adjacent
(rounds ≥ 2), and where the target's tiles are all in one row/column (round ≥ 4),
so the stampede has to choose.

**Target selection:** uniformly among the symbols in play, excluding the previous
round's target. NOT rounds pick a symbol whose 2 tiles include at least one
centre tile (indices 5, 6, 9, 10) so the "safe" move isn't just "stay on the edge".

**End condition:** after any DROP, if eliminated ≥ `ceil(entrants × 0.4)` ⇒ round
ends, all standing qualify. Hard cap 150 s ⇒ survivors qualify. If a DROP would
eliminate **everyone** remaining, that board round is voided: tiles restore and
nobody is eliminated (announcer: "Nobody? Again!").

**Mid-air rule:** a player airborne during DROP is judged by the tile under them
when they land; if the tile below is gone they fall (eliminated). Jumping does not
save you.

#### Spawn

origin (0, 0.1, −10.5) · yaw 0 · cols 8 · spacing 1.4 — the first row of tiles (players
spread by the first teaching round).

#### Flyover (4 s)

Path (0, 30, −30) → (0, 34, 0) → (0, 20, 25); lookAt (0, 0, 0), (0, 0, 0), (0, 12, 22) (ends on
the Big Screen).

#### Bot behaviour

| Tier    | Memory model                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Sharp   | Remembers each target tile with p = 0.95 per tile in rounds 1–4, 0.85 in 5+; picks the nearest correct tile with fewer than 6 occupants |
| Average | p = 0.8 / 0.65; 10 % chance to misread NOT rounds                                                                                       |
| Clumsy  | p = 0.6 / 0.4; 30 % chance to misread NOT rounds; 0.6 s reaction delay                                                                  |

Failed recall ⇒ the bot runs to a random tile of a wrong-but-plausible symbol.
Waypoints: tile centres (ids 0–15 = tile index), r 2.5, fully connected (run).

#### Difficulty & variations

`speedScaleByStage` scales **phase times** (÷): **[1.0, 1.05, 1.1, 1.15, 1.2]** (floors:
SHOW ≥ 1.5 s, DECIDE ≥ 3 s).

| id                | weight | weather | description                                                                                                                           | overrides                                                                                    |
| ----------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `classic-show`    | 4      | night   | As authored.                                                                                                                          | —                                                                                            |
| `speed-round`     | 2      | night   | Starts at board round 3 timings.                                                                                                      | designNotes `{"pattern":{"startRound":3}}`                                                   |
| `shifting-floor`  | 1      | night   | Rounds ≥ 6: during HIDE the whole board slides one tile column left/right (wrapping visually through a curtain) — remember the shift. | designNotes `{"pattern":{"shiftFrom":6}}` (requires board-shift support: Schema wish §11 #7) |
| `memory-marathon` | 1      | night   | Six tiles per symbol pair; rounds slower but SHOW 2 s from round 2.                                                                   | designNotes `{"pattern":{"showFlat":2}}`                                                     |

(A colour-only variant was considered and rejected: colour-only cues fail
accessibility.)

#### Set dressing & lighting

- A neon TV game-show studio floating in a synthwave night: grid horizon, laser
  fans sweeping the sky (deco only), audience in tiered neon stands at the back,
  the host's giant screen with confetti cannons either side.
- No sun; key spot from above (`#e8e4ff`), coloured rim spots from four corners.
  Fog purple near 60 / far 300.
- Readability: lit symbols are big, high-contrast decals with shape + colour; dark
  tiles are uniform; dropping tiles get a 0.6 s red shake and a down-arrow decal.

#### Sanity checks

- Tile 6 m with 1 m gaps: worst-case run from corner tile to opposite corner tile =
  ~29.7 m ≈ 3.3 s at 9 m/s — under every DECIDE time (≥ 3.5 s from round 8 with
  speedScale ≤ 1.2 ⇒ ≥ 3 s floor). ✓ (crowd collisions make it tense.)
- 1 m gaps are jumpable flat ✓ (and fall-through-able if shoved).
- **Expected:** 24 → 15 (40 % cut) by board round 4–6 (≈ 60–90 s).

---

## 9. Finals

Common final rules:

- One winner. `crownGrab`: first player to grab the Crown wins. `lastStanding`:
  the last non-eliminated player wins; if the final players are eliminated in the
  same server tick, the one whose capsule centre was **higher** at elimination
  wins (then: the one who was eliminated later in sub-tick order).
- Finals use `mus_final_crownfever` with the theme layer.
- Players: min 1 (a lone qualifier still plays it as a victory lap), max 15.
- Every final's last 30 s is designed to be visibly more dangerous than the first
  30 s, and every final has a **hard end** so a show can never stall.

---

### F1 — Crown Climb

| Field         | Value                                   |
| ------------- | --------------------------------------- |
| id            | `crown-climb`                           |
| name          | Crown Climb                             |
| type          | `final`                                 |
| theme         | `castle`                                |
| players       | min 1 · max 15 · ideal 8                |
| qualification | mode `crownGrab`                        |
| duration      | 180 s, overtime **60** (crown lowers)   |
| fallBehavior  | `respawnCheckpoint`                     |
| killY         | −10                                     |
| bounds        | min (−30, −15, −15) · max (30, 50, 170) |
| music         | `mus_final_crownfever` (castle layer)   |
| cameraMode    | `orbit`                                 |
| decorSeed     | 9101                                    |

**Objective:** `Climb the castle. Grab the Crown to win!` (40 chars)

**Tips:**

1. Jump and hold Grab to snatch the Crown.
2. The elevators are slow but safe. The wall is fast — mind the red band.
3. Everyone respawns. It's not over until someone grabs it.

**Fantasy & moments.** A compact sprint up a toy castle to a crown floating
over the highest tower, guarded by a spinning bar. Respawns keep everyone in it
to the very last second.

1. **Door Lottery** — 8 finalists, 4 doors, 2 fakes: the favourite bonks.
2. **Wall Race** — two players climbing side by side; one hits the slip band and
   slides down past the other.
3. **Turret Duel** — a hammer swats the leader from a turret; the second place
   overtakes mid-air.
4. **Crown Scramble** — three players on the dais, all jumping for the crown; the
   sweeper bar takes two out, the third grabs it.

#### Layout

| §   | Name           | Z range       | Y          | Tests                              | Checkpoint   |
| --- | -------------- | ------------- | ---------- | ---------------------------------- | ------------ |
| 0   | Gate           | −6 → 6        | 0          | —                                  | cp-0         |
| 1   | Courtyard      | 6 → 40        | 0          | doors + hammers (walled, no falls) | —            |
| 2   | Rampart Stairs | 40 → 64       | 0 → 7.4    | jumps + grabs, barrels             | cp-1 (z 66)  |
| 3   | Keep Wall      | 64 → 96       | 7.4 → 19.4 | climb wall vs elevators            | cp-2 (z 92)  |
| 4   | Turret Hop     | 96 → 134      | 19.4 → 27  | ascending turrets, hammers         | —            |
| 5   | Crown Deck     | 134.5 → 156.5 | 28.5 → 30  | sweeper + jump-grab                | cp-3 (z 137) |

| #   | shape       | pos x, y, z                                                               | size x, y, z   | rot | surface | colour    | grab | pattern | note                                                                           |
| --- | ----------- | ------------------------------------------------------------------------- | -------------- | --- | ------- | --------- | ---- | ------- | ------------------------------------------------------------------------------ |
| 0.1 | box         | 0, −0.5, 0                                                                | 16, 1, 12      | —   | normal  | safe      |      | checker | start z −6…6                                                                   |
| 1.1 | box         | 0, −0.5, 23                                                               | 16, 1, 34      | —   | normal  | primary   |      | none    | courtyard z 6–40                                                               |
| 1.2 | box         | ±8.25, 2, 23                                                              | 0.5, 4, 34     | —   | normal  | neutral   |      | none    | courtyard walls                                                                |
| 2.1 | box         | 0, 0.25, 43                                                               | 16, 2.5, 6     | —   | normal  | secondary |      | none    | L1 top 1.5 (z 40–46)                                                           |
| 2.2 | box         | 0, 1.0, 49                                                                | 16, 4, 6       | —   | normal  | secondary |      | none    | L2 top 3.0                                                                     |
| 2.3 | box         | 0, 2.1, 55                                                                | 16, 6.2, 6     | —   | normal  | secondary | ✓    | none    | L3 top 5.2 (+2.2 grab)                                                         |
| 2.4 | box         | 0, 3.2, 61                                                                | 16, 8.4, 6     | —   | normal  | secondary | ✓    | none    | L4 top 7.4 (+2.2 grab)                                                         |
| 2.5 | box ×2      | 0, 5.2 / 7.4, 52 / 58                                                     | 16, 0.3, 0.3   | —   | normal  | accent    | ✓    | none    | grab lips                                                                      |
| 3.1 | box         | 0, 6.9, 70                                                                | 16, 1, 12      | —   | normal  | primary   |      | none    | gatehouse court z 64–76, top 7.4                                               |
| 3.2 | box         | 0, 13.15, 86                                                              | 20, 12.5, 20   | —   | normal  | neutral   |      | none    | keep: front face z 76 (7.4 → 19.4), top 19.4 to z 96                           |
| 3.3 | box         | 0, 19.41, 92                                                              | 20, 0.02, 2    | —   | normal  | safe      |      | checker | cp-2 pad                                                                       |
| 4.1 | cylinder ×5 | x −3.5, top 21 / 22.5 / 24 / 25.5 / 27, z 100 / 107.5 / 115 / 122.5 / 130 | 3, top − 10, — | —   | normal  | primary   | ✓    | none    | left turrets (pos y = (top + 10)/2)                                            |
| 4.2 | cylinder ×5 | x +3.5, same tops and z                                                   | 3, top − 10, — | —   | normal  | secondary | ✓    | none    | right turrets                                                                  |
| 5.1 | cylinder    | 0, 28, 145.5                                                              | 11, 1, —       | —   | normal  | safe      |      | checker | crown deck r 11, top 28.5 (z 134.5–156.5)                                      |
| 5.2 | cylinder    | 0, 29.25, 145.5                                                           | 2, 1.5, —      | —   | normal  | accent    | ✓    | none    | dais r 2, top 30                                                               |
| 5.3 | box ×12     | ring r 11.3, y 29.25                                                      | 1.5, 1.5, 1.5  | —   | normal  | neutral   |      | none    | crenellations every 30° (deco, collide — gaps between them still let you fall) |
| 5.4 | arch        | 0, 28.5, 145.5                                                            | 8, 9, 1        | —   | normal  | accent    |      | none    | crown canopy (deco, no collider)                                               |

| id          | type           | pos             | rot | params                                                                                                                                                                                                                                           |
| ----------- | -------------- | --------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| s0-gate     | startGate      | 0, 0, 4.5       | —   | width 16                                                                                                                                                                                                                                         |
| s1-door     | doorGauntlet   | 0, 0, 16        | —   | doorCount 4, doorWidth 3.0, pillarWidth 0.8, doorHeight 3.5, breakableCount 2, halfRule true                                                                                                                                                     |
| s1-ham-1    | pendulumHammer | 0, 0, 27        | —   | pivotHeight 10, armLength 8, headRadius 1.1, headLength 2.4, amplitudeDeg 60, period 2.8, swingAxis z, phase 0                                                                                                                                   |
| s1-ham-2    | pendulumHammer | 0, 0, 35        | —   | as ham-1, phase 0.5                                                                                                                                                                                                                              |
| s2-barrel-L | boulderLane    | −4, 0, 0        | —   | path [(0, 8.6, 63), (0, 8.6, 58.3), (0, 6.4, 57.7), (0, 6.4, 52.3), (0, 4.2, 51.7), (0, 4.2, 46.3), (0, 2.7, 45.7), (0, 2.7, 40.3), (0, 1.2, 39.7), (0, 1.2, 34)], ballRadius 1.2, speed 7, spawnInterval 4, phase 0, maxBalls 3, knockImpulse 9 |
| s2-barrel-R | boulderLane    | 4, 0, 0         | —   | as L, phase 0.5                                                                                                                                                                                                                                  |
| s3-climb    | climbWall      | 0, 7.4, 76      | —   | width 6, height 12, holdSpacing 0.9, slipBands [{y0 6.0, y1 7.5}] (relative to base: world 13.4–14.9; jump over it from just below)                                                                                                              |
| s3-lift-L   | movingPlatform | −6.5, 7.4, 74   | —   | sizeX 4, sizeY 0.6, sizeZ 4, path [(0,0,0), (0,12,0)], period 7, ease smoothstep, pingPong true, holdTime 1.5                                                                                                                                    |
| s3-lift-R   | movingPlatform | 6.5, 7.4, 74    | —   | as L, phase 0.5                                                                                                                                                                                                                                  |
| s4-ham-1    | pendulumHammer | 0, 22.5, 111.25 | —   | pivotHeight 9, armLength 7.5, headRadius 1.0, headLength 2.4, amplitudeDeg 55, period 2.6, swingAxis z, phase 0                                                                                                                                  |
| s4-ham-2    | pendulumHammer | 0, 25.5, 126.25 | —   | as s4-ham-1, phase 0.5                                                                                                                                                                                                                           |
| s5-sweep    | sweeperArm     | 0, 28.5, 145.5  | —   | armLength 10.5, innerRadius 2.1, armCount 1, armHeight 0.5, angularSpeed 1.0, speedSchedule [{0, 1.0}, {60, 1.3}, {120, 1.6}, {180, 1.2}], hubRadius 2.0, hubHeight 0 (the dais is the hub)                                                      |
| crown       | propSpawner    | 0, 30, 145.5    | —   | prop crown, count 1, floatHeight 3.1 (crown centre y 33.1), bob ±0.4 m @ 3 s, floatSchedule [{180, 1.6}] (overtime: lowers to y 31.6, grabbable standing), respawn false                                                                         |
| s5-cpgate   | checkpointGate | 0, 28.5, 137    | —   | width 10                                                                                                                                                                                                                                         |

Wall/elevator: the 12 m climb takes ~5 s (climb speed ≈ 2.4 m/s) minus slip-band
risk; elevators take 3.5 s travel + up to 7 s wait. Turret gaps: 1.5 m edge to edge
with +1.5 rise (limit 2.0 ✓); parallel lines are 1 m apart (switchable).

#### Triggers

| id    | kind       | pos            | size          | index | respawn points                                 | yaw |
| ----- | ---------- | -------------- | ------------- | ----- | ---------------------------------------------- | --- |
| cp-0  | checkpoint | 0, 2, 0        | 16, 4, 12     | 0     | spawn grid                                     | 0   |
| cp-1  | checkpoint | 0, 9.4, 66     | 16, 4, 2      | 1     | x ±5/±2.5/0 ×2 rows, y 7.5, z 68 / 70          | 0   |
| cp-2  | checkpoint | 0, 21.4, 92    | 20, 4, 2      | 2     | x ±5/±2.5/0, y 19.5, z 94                      | 0   |
| cp-3  | checkpoint | 0, 30.5, 137   | 10, 4, 2      | 3     | (±4, 28.6, 139) (±2, 28.6, 139) (0, 28.6, 139) | 0   |
| crown | crown      | 0, 33.1, 145.5 | 1.4, 1.4, 1.4 | 0     | —                                              | —   |

Crown rule: a Tumbler whose capsule overlaps the crown trigger **while Grab is
held** wins (the trigger follows the crown prop's float height).

#### Spawn

origin (0, 0.1, −1) · yaw 0 · cols 4 · spacing 1.8.

#### Flyover (7 s)

Path (0, 6, −15) → (14, 10, 30) → (−14, 16, 70) → (12, 26, 110) → (0, 38, 130); lookAt (0, 2, 16),
(0, 3, 50), (0, 13, 80), (0, 24, 120), (0, 33, 145.5) — ends on the crown glinting.

#### Bot nav

| id    | pos                 | r   | next      | action     | timeAgainst                                  | note                                                         |
| ----- | ------------------- | --- | --------- | ---------- | -------------------------------------------- | ------------------------------------------------------------ |
| 0     | 0, 0, 3             | 2   | 1         | run        |                                              |                                                              |
| 1     | 0, 0, 14            | 6   | 2         | run        | s1-door                                      | door rule as R1                                              |
| 2     | 0, 0, 22            | 2   | 3         | waitForGap | s1-ham-1                                     |                                                              |
| 3     | 0, 0, 31            | 2   | 4         | waitForGap | s1-ham-2                                     |                                                              |
| 4     | ±2, 0, 39           | 1.5 | 5         | jump       |                                              | step to the barrel-free strip x ±2                           |
| 5     | ±2, 1.5, 45         | 1.5 | 6         | jump       |                                              |                                                              |
| 6     | ±2, 3.0, 51         | 1.2 | 7         | grab       |                                              |                                                              |
| 7     | ±2, 5.2, 57         | 1.2 | 8         | grab       |                                              |                                                              |
| 8     | 0, 7.4, 68          | 2   | 9, 10, 11 | run        |                                              | wall / lift L / lift R: C 30/35/35 · A 50/25/25 · S 80/10/10 |
| 9     | 0, 7.4, 75.5        | 1   | 12        | climb      |                                              | jump past the slip band at y 13                              |
| 10    | −6.5, 7.4, 74       | 1.2 | 12        | waitForGap | s3-lift-L                                    | board at bottom, step off +z at top                          |
| 11    | 6.5, 7.4, 74        | 1.2 | 12        | waitForGap | s3-lift-R                                    |                                                              |
| 12    | 0, 19.4, 94         | 2   | 13        | run        |                                              |                                                              |
| 13    | ±3.5, 19.4, 95.5    | 1   | 14        | jump       |                                              | turret line of fewer players                                 |
| 14–18 | ±3.5, top, turret z | 1   | next / 19 | jump       | s4-ham-1 (before 3rd), s4-ham-2 (before 5th) | waitForGap on the turret before each hammer                  |
| 19    | 0, 28.5, 136        | 2   | 20        | run        |                                              |                                                              |
| 20    | 0, 28.5, 141        | 1.5 | 21        | jump       |                                              | onto dais; hop the sweeper                                   |
| 21    | 0, 30, 145.5        | 1   | —         | grab       |                                              | jump + grab the crown                                        |

#### Difficulty & variations

`speedScaleByStage`: **[1.0, 1.0, 1.1, 1.15, 1.2]** (finals usually at stage 3–4).

| id              | weight | weather | description                             | overrides                                                                                                  |
| --------------- | ------ | ------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `coronation`    | 4      | clear   | As authored.                            | —                                                                                                          |
| `stormy-keep`   | 2      | stormy  | Wind on the turrets; lightning flashes. | add `w-turret` fanZone (−12, 19.4, 115) sizeX 4, sizeY 14, sizeZ 40, direction (1,0,0), force 6, gust true |
| `moving-crown`  | 2      | sunset  | The crown orbits the dais (r 1.5, 6 s). | `crown`: orbitRadius 1.5, orbitPeriod 6                                                                    |
| `twin-sweepers` | 1      | night   | Two sweeper arms on the deck.           | `s5-sweep`: armCount 2                                                                                     |

#### Set dressing & lighting

- A pastel toy castle on a floating island at golden hour; flags, a giant
  crowd on the outer walls, confetti cannons on every tower, a dragon blimp
  circling, the crown on a velvet beam of light (godray cone from above).
- Sun azimuth 240°, elevation 30°, colour `#ffd9a0`; fog lilac near 120 / far 600.

#### Sanity checks

- Ledge steps +1.5, +1.5 (jump) then +2.2, +2.2 (grab) ✓.
- Turrets: 1.5 m gaps with +1.5 ✓ (limit 2.0).
- Crown at 3.1 above the dais: standing reach 1.8 ✗, jump reach 3.8 ✓ ⇒ must jump
  (bob ±0.4 ⇒ 2.7–3.5, always jump-reachable).
- **Expected:** first crown attempt at ~55–65 s; typical win 60–90 s.

---

### F2 — Last Tumbler Standing

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `last-tumbler-standing`                |
| name          | Last Tumbler Standing                  |
| type          | `final`                                |
| theme         | `frosty`                               |
| players       | min 1 · max 15 · ideal 8               |
| qualification | mode `lastStanding`                    |
| duration      | 240 s (hard cap), overtime 0           |
| fallBehavior  | `eliminate`                            |
| killY         | −8                                     |
| bounds        | min (−30, −15, −30) · max (30, 40, 30) |
| music         | `mus_final_crownfever` (frosty layer)  |
| cameraMode    | `orbit`                                |
| decorSeed     | 9201                                   |

**Objective:** `Ice cracks under you. Be the last one up!` (41 chars)

**Tips:**

1. Ice hexes crack when you stand on them — keep moving.
2. Break the ice around your rivals to cut them off.
3. Three layers. A fall is only the end on the bottom one.

**Fantasy & moments.** Three floating rings of ice hexes in a snow-globe sky.
Finalists carve each other's footing until one stands alone.

1. **Moat Carving** — a player runs a circle around a rival, leaving them on an
   island.
2. **Layer Drop Chase** — one finalist drops to the layer below, the other follows
   to keep the hunt on.
3. **Snowball Interrupt** — a snow cannon knocks the second-to-last player off the
   last tile.
4. **Hex Standoff** — two players on two hexes 3 m apart, hopping in place as the
   sudden-death timer runs down.

#### Layers

| id      | type         | pos      | params                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| layer-1 | fallingTiles | 0, 20, 0 | tileShape hex, tileSize 1.5, gap 0.08, thickness 0.5, mask: hex cells with centre radius ≤ 16, triggerMode both, shakeTime 1.0, fallDepth 40, respawn false, glareRatio 0.167 (seeded "glare ice" hexes; the rest are grippy snow-hex), shakeTimeSchedule [{150, 0.6}, {180, 0.35}], timedSchedule [{90, 0.1}, {100, 0.1}, {110, 0.1}, {120, 0.1}, {130, 0.12}, {140, 0.12}, {180, 0.2}, {185, 0.2}, {190, 0.2}, {195, 0.2}, {200, 0.25}, {205, 0.25}, {210, 0.3}, {215, 0.3}, {220, 0.4}, {225, 0.5}, {230, 0.6}, {235, 1.0}] |
| layer-2 | fallingTiles | 0, 10, 0 | as layer-1, mask radius ≤ 14                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| layer-3 | fallingTiles | 0, 0, 0  | as layer-1, mask radius ≤ 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

| id         | type   | pos        | rot     | params                                                                                                                                                                |
| ---------- | ------ | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| snow-can-1 | cannon | 0, 34, 22  | yaw 180 | activeFrom 45, fireInterval 3.5, targetRange 22, targetApex 4, landingDelta −14, ballRadius 0.6, aim sweep, sweepDeg 70, sweepPeriod 7, telegraph 1.0, knockImpulse 7 |
| snow-can-2 | cannon | 0, 34, −22 | yaw 0   | as can-1, phase 0.5, activeFrom 60                                                                                                                                    |

(Cannons aim at layer 1 at first; from t 120 their `landingDelta` steps to −24
(layer 2) via variation-free schedule param `landingDeltaSchedule [{120, −24},
{170, −34}]` — follow the survivors down.)

| #   | shape       | pos x, y, z | size x, y, z | rot | surface | colour  | grab | pattern | note                          |
| --- | ----------- | ----------- | ------------ | --- | ------- | ------- | ---- | ------- | ----------------------------- |
| a.1 | cylinder ×2 | 0, 17, ±24  | 1.5, 34, —   | —   | normal  | neutral |      | stripes | cannon pylons (deco, collide) |
| a.2 | sphere      | 0, −30, 0   | 60           | —   | normal  | #e8f6ff |      | none    | snow-globe base glow (deco)   |

#### Escalation timeline

| t (s)  | Event                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 0      | Touch-cracking only (shake 1.0 s)                                                                     |
| 45     | Snow cannon 1 active                                                                                  |
| 60     | Snow cannon 2 active                                                                                  |
| 90–140 | Random drops 10–12 % of remaining per 10 s, all layers                                                |
| 120    | Cannons retarget layer 2                                                                              |
| 150    | Shake 0.6 s                                                                                           |
| 170    | Cannons retarget layer 3                                                                              |
| 180    | **Sudden death**: shake 0.35 s, drops every 5 s escalating to 100 % at 235 s                          |
| 240    | Hard cap — unreachable in practice (all tiles gone at 235 s ⇒ last standing is decided by fall order) |

#### Spawn

origin (0, 20.1, 0) · yaw 0 · cols 4 · spacing 3.0 (8 finalists spread across layer 1;
spacing 3 so nobody starts sharing tiles).

#### Flyover (5 s)

Path (0, 40, −30) → (28, 25, 0) → (0, 12, 28) → (−20, 4, 0); lookAt (0, 20, 0), (0, 15, 0), (0, 10, 0),
(0, 0, 0).

#### Bot behaviour

As S2 (Wander/Hop/Drop) plus **Hunt** (Sharp, < 5 players left): circle the
nearest rival at 4 m radius to crack tiles around them; never stand still > 0.6 s.

#### Difficulty & variations

| id                 | weight | weather | description                          | overrides                              |
| ------------------ | ------ | ------- | ------------------------------------ | -------------------------------------- |
| `glacier`          | 4      | snow    | As authored (light snowfall).        | —                                      |
| `black-ice`        | 2      | night   | More glare ice (1 in 3), aurora sky. | all layers: glareRatio 0.333           |
| `thaw`             | 1      | clear   | Faster cracks from the start.        | all layers: shakeTime 0.7              |
| `blizzard-cannons` | 1      | snow    | Cannons from 30 s, double shots.     | `snow-can-1/2`: activeFrom 30, burst 2 |

#### Sanity checks

- Hex 1.5 circumradius ⇒ 2.6 m flat-to-flat; jumping over one missing hex ≈ 2.6 m ✓.
- 15 players on layer 1 (≈ 800 m²) — room to spread ✓.
- **Expected:** 8 finalists ⇒ winner at 120–190 s.

---

### F3 — Spin Cycle Finale

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `spin-cycle-finale`                    |
| name          | Spin Cycle Finale                      |
| type          | `final`                                |
| theme         | `neon`                                 |
| players       | min 1 · max 15 · ideal 8               |
| qualification | mode `lastStanding`                    |
| duration      | 180 s (hard cap), overtime 0           |
| fallBehavior  | `eliminate`                            |
| killY         | −8                                     |
| bounds        | min (−30, −15, −30) · max (30, 25, 30) |
| music         | `mus_final_crownfever` (neon layer)    |
| cameraMode    | `orbit`                                |
| decorSeed     | 9301                                   |

**Objective:** `Jump, dive, survive. Last one spinning wins!` (44 chars)

**Tips:**

1. Three bars now: low, high… and another low.
2. The drum shrinks every 30 seconds.
3. Push rivals into the bars — it's a final!

**Fantasy & moments.** S1's washing machine, remixed as a neon nightclub final:
three bars, a shrinking floor, and a sudden-death spin-up.

1. **Triple Rhythm** — jump, dive, jump in under 2 s; the crowd chants.
2. **Grab Sabotage** — a finalist grabs another just as the high bar arrives.
3. **The Last Ring** — two players on a 5 m disc with bars at 2.2 rad/s.

#### Arena

| #   | shape    | pos x, y, z | size x, y, z | rot | surface | colour  | grab | pattern | note                               |
| --- | -------- | ----------- | ------------ | --- | ------- | ------- | ---- | ------- | ---------------------------------- |
| a.1 | torus    | 0, 6, 0     | 22, 1.0, —   | —   | normal  | accent  |      | none    | neon porthole rim (deco, emissive) |
| a.2 | cylinder | 0, −6, 0    | 20, 0.2, —   | —   | normal  | #2a1a5e |      | none    | glowing suds pool (deco)           |

| id        | type         | pos     | rot | params                                                                                                                                                                                                                                     |
| --------- | ------------ | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| floor     | fallingTiles | 0, 0, 0 | —   | tileShape hex, tileSize 1.4, mask radius ≤ 18, triggerMode timed, timedSchedule [{30, beyondRadius 15}, {60, beyondRadius 12}, {90, beyondRadius 9}, {120, beyondRadius 6.5}, {150, beyondRadius 5}], shakeTime 1.5, immune [{radius 2.2}] |
| hub       | bumperPillar | 0, 0, 0 | —   | radius 1.4, height 3.0, bounceImpulse 10                                                                                                                                                                                                   |
| bar-low   | sweeperArm   | 0, 0, 0 | —   | armLength 18, innerRadius 1.5, armCount 1, armHeight 0.55, speedSchedule [{0, 1.0}, {30, 1.2}, {60, 1.4}, {90, 1.6}, {120, 1.8}, {150, 2.0}, {165, 2.2}], reverseTimes [50, 100, 140]                                                      |
| bar-high  | sweeperArm   | 0, 0, 0 | —   | armLength 18, innerRadius 1.5, armCount 1, armHeight 1.75, speedSchedule [{0, −0.8}, {30, −1.0}, {60, −1.2}, {90, −1.4}, {120, −1.6}, {150, −1.8}], reverseTimes [75, 130], phase 0.5                                                      |
| bar-low-2 | sweeperArm   | 0, 0, 0 | —   | armLength 18, innerRadius 1.5, armCount 1, armHeight 0.55, activeFrom 40, speedSchedule [{0, 0.7}, {60, 0.9}, {120, 1.2}], phase 0.25 (independent speed ⇒ the gap between bar-low and bar-low-2 drifts — rhythms never repeat)            |

#### Escalation timeline

| t         | Arena radius                                                                                                             | Bars                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 0         | 18                                                                                                                       | low 1.0, high −0.8           |
| 30        | 15                                                                                                                       | low 1.2, high −1.0           |
| 40        | —                                                                                                                        | second low bar joins (0.7)   |
| 50        | —                                                                                                                        | low reverses                 |
| 60        | 12                                                                                                                       | ×1.2                         |
| 75        | —                                                                                                                        | high reverses                |
| 90        | 9                                                                                                                        | low 1.6, high ±1.4           |
| 100       | —                                                                                                                        | low reverses                 |
| 120       | 6.5                                                                                                                      | low 1.8, high 1.6, low-2 1.2 |
| 130 / 140 | —                                                                                                                        | reversals                    |
| 150       | 5                                                                                                                        | low 2.0, high 1.8            |
| 165       | 5                                                                                                                        | low 2.2 — sudden death       |
| 180       | hard cap — remaining players: highest y wins ties; if still tied, the player who was hit fewer times wins (stat tracked) |

#### Spawn

origin (0, 0.1, −8) · yaw 0 · cols 4 · spacing 2.0.

#### Flyover (5 s)

Orbit (25, 18, 0) → (0, 22, 25) → (−25, 18, 0) → (0, 10, −15); lookAt (0, 0, 0).

#### Bot behaviour

As S1, band radius = min(10, floor radius − 2.5); Sharp bots grab rivals when a bar
is ≤ 0.6 s from both (sabotage).

#### Difficulty & variations

| id            | weight | weather | description                                                             | overrides                                            |
| ------------- | ------ | ------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `club-night`  | 4      | night   | As authored.                                                            | —                                                    |
| `strobe`      | 1      | night   | Bars flash with the beat (visual only); reduced-flash setting disables. | —                                                    |
| `heavy-final` | 2      | night   | Two high bars.                                                          | add `bar-high-2` as bar-high, phase 0, activeFrom 60 |

#### Sanity checks

- At r 5 with ω 2.2 the bar moves 11 m/s — still jumpable; bars on a 5 m disc arrive
  every ~0.9–1.4 s combined. A clean player can survive ~30–60 s of sudden death.
- **Expected:** 8 finalists ⇒ winner at 110–170 s.

---

### F4 — Goo Peak Final

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| id            | `goo-peak-final`                       |
| name          | Goo Peak Final                         |
| type          | `final`                                |
| theme         | `goo`                                  |
| players       | min 1 · max 15 · ideal 8               |
| qualification | mode `lastStanding`                    |
| duration      | 200 s (hard cap), overtime 0           |
| fallBehavior  | `eliminate`                            |
| killY         | −10                                    |
| bounds        | min (−35, −15, −35) · max (35, 40, 35) |
| music         | `mus_final_crownfever` (goo layer)     |
| cameraMode    | `orbit`                                |
| decorSeed     | 9401                                   |

**Objective:** `Climb above the goo. Last one standing wins!` (44 chars)

**Tips:**

1. Every ring cracks when you stand on it. Keep climbing.
2. The goo never stops. The summit is tiny.
3. Breaking the ring above a rival can strand them.

**Fantasy & moments.** A stepped jelly mountain of cracking hex rings in a lake
of rising goo. The climb is a race to the summit; the summit is a knife fight.

1. **Ring Snip** — a player cracks the only intact tiles on the ring above a rival.
2. **Goo Splash** — a surge swallows a whole ring with two finalists on it.
3. **Summit Sumo** — the last three on a 6 m summit disc, the goo 1 m below.

#### Peak

Nine tiers. Tier k (k = 0…7) is a **ring** of hex tiles: top y = 1.5·k, radii
r_in = 21 − 3k to r_out = 24 − 3k (3 m wide). Tier 8 (summit) is a disc r ≤ 3 at
y 12. Rising one tier = +1.5 m jump onto the next ring inward (the ring above
starts exactly where the one below ends: zero horizontal gap, +1.5 rise).

| id              | type         | pos         | params                                                                                                                                                                                                                                        |
| --------------- | ------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ring-0 … ring-7 | fallingTiles | 0, 1.5·k, 0 | tileShape hex, tileSize 1.2, gap 0.08, thickness 0.5, mask: annulus r_in…r_out, triggerMode both, shakeTime 1.4, respawn false, shakeTimeSchedule [{120, 1.0}, {160, 0.7}], timedSchedule [{60, 0.08}, {90, 0.1}, {120, 0.12}, {150, 0.15}]   |
| summit          | fallingTiles | 0, 12, 0    | as rings, mask disc r ≤ 3, shakeTime 2.0, timedSchedule [{185, 0.25}, {190, 0.25}, {195, 0.5}]                                                                                                                                                |
| goo             | risingSlime  | 0, 0, 0     | sizeX 70, sizeZ 70, startY −2, schedule [{0, −2}, {20, −2}, {35, 0.5}, {55, 2.0}, {70, 3.5}, {85, 5.0}, {100, 6.5}, {115, 8.0}, {130, 9.5}, {150, 11.0}, {175, 11.6}, {195, 12.4}], waveAmplitude 0.25, surgeTelegraph 2                      |
| spout           | cannon       | 0, 12, 0    | activeFrom 70, fireInterval 4, aim pattern, patternYaws [0, 60, 120, 180, 240, 300], targetRange 12, targetApex 6, landingDelta −6, ballRadius 0.7, knockImpulse 8, telegraph 1.0 (goo blobs lobbed from a geyser in the summit; knocks only) |

| #   | shape      | pos x, y, z          | size x, y, z | rot | surface | colour  | grab | pattern | note                                                                 |
| --- | ---------- | -------------------- | ------------ | --- | ------- | ------- | ---- | ------- | -------------------------------------------------------------------- |
| a.1 | cylinder   | 0, −6, 0             | 26, 8, —     | —   | normal  | neutral |      | none    | jelly mountain core under the rings (deco, no collider: rings float) |
| a.2 | sphere ×20 | lake islands r 30–60 | 2–6          | —   | normal  | accent  |      | none    | fruit islands with gummy crowd (deco)                                |

#### Escalation timeline

| t (s)   | Goo y    | Ring flooded | Event                                                      |
| ------- | -------- | ------------ | ---------------------------------------------------------- |
| 0–20    | −2       | —            | Free climb                                                 |
| 35      | 0.5      | ring 0       |                                                            |
| 55      | 2.0      | ring 1       |                                                            |
| 60      | —        | —            | random drops start                                         |
| 70      | 3.5      | ring 2       | spout lobs begin                                           |
| 85      | 5.0      | ring 3       |                                                            |
| 100     | 6.5      | ring 4       |                                                            |
| 115     | 8.0      | ring 5       |                                                            |
| 120     | —        | —            | shake 1.0 s                                                |
| 130     | 9.5      | ring 6       |                                                            |
| 150     | 11.0     | ring 7       | only the summit (r 3) remains dry                          |
| 160     | —        | —            | shake 0.7 s                                                |
| 175     | 11.6     | —            | goo 0.4 m below summit, waves lap the edge                 |
| 185–195 | —        | —            | summit tiles drop (25 % / 25 % / 50 %)                     |
| 195     | 12.4     | summit       | everyone left is in the goo ⇒ last-eliminated-highest wins |
| 200     | hard cap |              |                                                            |

#### Spawn

origin (0, 0.1, −22.5) · yaw 0 · cols 8 · spacing 1.6 (all on ring 0, south side).

#### Flyover (6 s)

Path (0, 8, −45) → (35, 16, 0) → (0, 22, 30) → (−18, 20, −10); lookAt (0, 0, −22), (0, 6, 0), (0, 12, 0),
(0, 12, 0).

#### Bot behaviour

Climb rule as S3 (target ring = lowest ring with top ≥ goo(t + 10) + 1.5); tile rules
as S2; Sharp: crack the inner edge of a rival's ring when they are 1 ring below.

#### Difficulty & variations

| id               | weight | weather | description                         | overrides                                                                                                  |
| ---------------- | ------ | ------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ooze-peak`      | 4      | clear   | As authored.                        | —                                                                                                          |
| `lava-lamp`      | 2      | night   | Goo glows; surges are sudden steps. | `goo`: schedule as stepped version (same values at the same times, each change over 2 s instead of linear) |
| `slippery-slope` | 1      | clear   | Odd rings are ice.                  | ring-1/3/5/7: surface ice                                                                                  |

#### Sanity checks

- Ring step +1.5 m with zero gap ✓ (≤ 1.8). Ring 3 m wide ⇒ always room to land.
- Summit r 3 (28 m²) for the final 2–4 players ✓ tight by design.
- **Expected:** 8 finalists ⇒ 2–3 alive at 150 s; winner at 160–195 s.

---

## 10. Cross-round summary

| #   | id                      | type     | theme   | players min/ideal/max | qual             | duration (+OT) | fall                 | music                    | competent time / typical end | sections · cps      |
| --- | ----------------------- | -------- | ------- | --------------------- | ---------------- | -------------- | -------------------- | ------------------------ | ---------------------------- | ------------------- |
| R1  | `gumdrop-gauntlet`      | race     | candy   | 12/40/60              | finish 0.65      | 240            | respawn              | `mus_candy_sugarrush`    | 95 s / ~140 s                | 8 · 5               |
| R2  | `conveyor-chaos`        | race     | factory | 12/40/60              | finish 0.65      | 240            | respawn              | `mus_factory_clockwork`  | 100 s / ~145 s               | 8 · 4               |
| R3  | `tilt-town`             | race     | sunset  | 10/36/50              | finish 0.65      | 270            | respawn              | `mus_sunset_boardwalk`   | 110 s / ~165 s               | 7 · 4               |
| R4  | `slip-n-spiral`         | race     | frosty  | 12/40/60              | finish 0.65      | 240            | respawn              | `mus_frosty_snowglobe`   | 100 s / ~135 s               | 7 · 5               |
| R5  | `hammer-highway`        | race     | castle  | 12/40/60              | finish 0.6       | 270            | respawn              | `mus_castle_jestercourt` | 105 s / ~145 s               | 7 · 4               |
| R6  | `wind-tunnel-peaks`     | race     | space   | 10/36/50              | finish 0.65      | 270            | respawn              | `mus_space_orbitparty`   | 105 s / ~150 s               | 7 · 5               |
| R7  | `cannonball-canyon`     | race     | beach   | 12/40/60              | finish 0.65      | 240            | respawn              | `mus_beach_tikitumble`   | 100 s / ~135 s               | 7 · 4               |
| S1  | `spin-cycle`            | survival | factory | 8/24/40               | survive 0.7      | 90             | eliminate            | `mus_factory_clockwork`  | ends 70–90 s                 | escalation 13 steps |
| S2  | `tile-panic`            | survival | candy   | 10/32/50              | survive 0.6      | 120            | eliminate            | `mus_candy_sugarrush`    | ends 80–110 s                | 3 layers            |
| S3  | `rising-goo-tower`      | survival | goo     | 10/30/40              | survive 0.6      | 120            | eliminate            | `mus_goo_gloopgroove`    | ends 85–120 s                | 7 tiers             |
| S4  | `jump-rope-royale`      | survival | beach   | 8/30/50               | survive 0.65     | 90             | eliminate            | `mus_beach_tikitumble`   | ends 60–90 s                 | 2 rings             |
| T1  | `egg-heist`             | team     | jungle  | 9/30/45               | 3 teams, −1      | 120            | respawn (nest)       | `mus_jungle_bongobounce` | 120 s                        | 3-fold              |
| T2  | `bounce-ball-blitz`     | team     | sunset  | 6/24/40               | 2 teams, −1      | 120 (+60)      | respawn (half)       | `mus_sunset_boardwalk`   | 120–180 s                    | mirror              |
| T3  | `paint-the-plaza`       | team     | neon    | 8/24/40               | 4 teams, −1      | 90             | respawn (corner)     | `mus_neon_arcadeheart`   | 90 s                         | 4-fold              |
| H1  | `tail-chase`            | hunt     | jungle  | 8/30/50               | holdItem 0.5     | 90             | respawn (drops tail) | `mus_jungle_bongobounce` | 90 s                         | 4-fold              |
| L1  | `pattern-panic`         | logic    | neon    | 6/24/40               | logicSurvive 0.6 | 150            | eliminate            | `mus_logic_ticktock`     | ends 60–110 s                | 8+ board rounds     |
| F1  | `crown-climb`           | final    | castle  | 1/8/15                | crownGrab        | 180 (+60)      | respawn              | `mus_final_crownfever`   | win 60–90 s                  | 5 · 3               |
| F2  | `last-tumbler-standing` | final    | frosty  | 1/8/15                | lastStanding     | 240 cap        | eliminate            | `mus_final_crownfever`   | win 120–190 s                | 3 layers            |
| F3  | `spin-cycle-finale`     | final    | neon    | 1/8/15                | lastStanding     | 180 cap        | eliminate            | `mus_final_crownfever`   | win 110–170 s                | shrinking drum      |
| F4  | `goo-peak-final`        | final    | goo     | 1/8/15                | lastStanding     | 200 cap        | eliminate            | `mus_final_crownfever`   | win 160–195 s                | 9 tiers             |
| H2  | `comet-catch`           | hunt     | space   | 2/60/100              | scoreTarget 5    | 120            | respawn              | `mus_space_orbitparty`   | ends 35–75 s                 | 40+ landing spots   |
| H3  | `sunbeam-squabble`      | hunt     | sunset  | 2/60/100              | scoreTarget 10   | 120            | respawn              | `mus_sunset_boardwalk`   | ends 25–90 s                 | 1–12 beams          |
| L2  | `colour-cauldron`       | logic    | goo     | 2/60/100              | logicSurvive 0.6 | 150            | eliminate            | `mus_logic_ticktock`     | ends ~70–85 s (100 players)  | 5 × 5 tiles         |
| L3  | `trail-tracer`          | logic    | frosty  | 2/60/100              | logicSurvive 0.6 | 150            | eliminate            | `mus_logic_ticktock`     | ends ~65–80 s (100 players)  | 5 × 5 tiles         |
| F5  | `throne-rush`           | final    | castle  | 1/8/15                | lastStanding     | 150 (+30)      | eliminate            | `mus_final_crownfever`   | win 45–100 s                 | ~11 s cycles        |

**Full-field pacing, measured.** `packages/content/test/rounds-complete.test.ts`
with `TUMBLE_SLOW=1`, 100 bots, seed 101, before and after the bot and pacing
pass (ball roles, logic-floor crowd handling and question difficulty, steering
into crosswinds):

| Round                                | Before                       | After                        |
| ------------------------------------ | ---------------------------- | ---------------------------- |
| T2 Bounce Ball Blitz                 | 2–0 at 120 s                 | 2–3 at 128.7 s (golden goal) |
| L1 Pattern Panic                     | quota at 38.8 s              | quota at 81.2 s              |
| L2 Colour Cauldron                   | quota at 33.5 s              | quota at 73.0 s              |
| L3 Trail Tracer                      | 58 of 60 at 32.9 s           | 59 of 60 at 77.0 s           |
| R7 Cannonball Canyon (`sunny-siege`) | 65 at 168.3 s                | 65 at 168.4 s                |
| R7 Cannonball Canyon (`rogue-wave`)  | 46 of 65 by the 240 s buzzer | 65 at 193.8 s                |

Over seeds 101 / 7 / 3 / 11: Pattern Panic 79–81 s, Colour Cauldron 72–73 s,
Trail Tracer 67–77 s, rogue-wave 164–194 s; Bounce Ball Blitz totals 5–9 goals
at 100 bots (seeds 101 / 7 / 3) and 3–5 at 20–40. Minimum fields: Pattern Panic
at 6 bots ends at 52–71 s; Colour Cauldron and Trail Tracer at 2 bots end on the
first slip (10–50 s); rogue-wave at 12 bots finishes in about 135 s. The harder
logic variations that start at board round 3 or 4 still end sooner (100 bots:
`hot-stove` 40 s, `long-trails` 53 s, `speed-round` 54 s). A logic quota can
undershoot by a few players: everyone on a dropped tile falls in the same step,
and there is no fair way to pick who among them survives.

**Obstacle coverage** (which launch rounds exercise each module — useful for test
priorities):

| Type                                    | Rounds                                           |
| --------------------------------------- | ------------------------------------------------ |
| spinwheel                               | R1                                               |
| pendulumHammer                          | R1, R3, R4, R5, F1                               |
| sweeperArm                              | R1, R4, S1, T3 (harmless rinse), L1, F1, F3      |
| bumperPillar                            | R1, R2, R3, R4, R5, S1, S4, T1, T2, T3, F3       |
| punchWall                               | R2                                               |
| doorGauntlet                            | R1, F1                                           |
| conveyorBelt                            | R2, H1                                           |
| tiltPlatform                            | R3                                               |
| seesaw                                  | R3                                               |
| fanZone                                 | R4, R6, (variations: R3, R5, R7, S4, T1, T2, F1) |
| bouncePad                               | R1, R6, S3, T2, H1                               |
| fallingTiles                            | S1, S2, L1, F2, F3, F4                           |
| risingSlime                             | S3, F4                                           |
| boulderLane                             | R1, R4, R5, R7, F1                               |
| spinningDisc                            | R1, R2, R6, H1                                   |
| movingPlatform                          | R6, R7, F1                                       |
| slideRamp                               | R4                                               |
| iceFloor                                | (geometry `surface: ice` used instead: R4, F2)   |
| stickyGoo                               | T1 (variations: R1, S3)                          |
| popupBlocks                             | R2                                               |
| laserSweep                              | R2                                               |
| cannon                                  | R7, S2, S3, F2, F4                               |
| bumperCar                               | — (post-launch: R10 Bumper Boulevard)            |
| rollingDrum                             | R2, T1, H1                                       |
| collapsingBridge                        | R2, R4, R5                                       |
| jumpRopeBeam                            | S4                                               |
| teleporterPair                          | — (post-launch: R8 Teleport Tangle)              |
| climbWall                               | R7, F1                                           |
| checkpointGate / finishLine / startGate | all races, F1                                    |
| voidTrigger                             | (trigger `void` used in R4, R6)                  |
| propSpawner                             | T1, T2, T3, H1 (tails are round-managed), F1     |
| cometField                              | H2                                               |
| sunbeamZones                            | H3                                               |
| puzzleFloor                             | L2 (`mix`), L3 (`trail`)                         |
| throneFloor                             | F5                                               |
| bumperPillar (post-launch)              | H2, F5 (variation)                               |
| sweeperArm (post-launch)                | H3                                               |

---

## 11. Schema wish list

None of these block the launch set — every round above has a fallback that works
with today's `RoundDefinitionSchema`. They are listed in priority order for the
schema owner (additive, optional fields only).

| #   | Wish                                                                                           | Why                                                                        | Fallback used above                                                           |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `Waypoint.weights?: number[]` (parallel to `next`) or `weightsByTier`                          | Route choice per bot tier (safe vs risky routes)                           | Bots choose uniformly scaled by tier risk tolerance; weights live in this doc |
| 2   | Generated geometry: `StaticPiece` `generator?: { kind: 'helix'                                 | 'stairArc'                                                                 | 'ring', params }`                                                             | R4 spiral (90+ pieces), S3 staircases, F4 rings are formulaic | Pieces pre-expanded in content via a build-time helper in `packages/content`         |
| 3   | `Variation.geometryOverrides` (add/remove/patch static pieces by id; needs `StaticPiece.id?`)  | R4 `aurora-night`, S2 `rebake` floor swaps, R4 `thin-ice`                  | Flags in `designNotes` read by the round module                               |
| 4   | `torus.arcDeg?` (partial torus) and `cylinder.arcDeg?`                                         | Rink boards with gaps, curved rails, ring walls                            | Short boxes around the circle                                                 |
| 5   | `Spawn.teamYaws?: number[]`                                                                    | Team grids must face their objective                                       | Face-the-origin rule when `teamOrigins` is set                                |
| 6   | Round-rule components: `rules?: { kind: 'paintGrid'                                            | 'eggScore'                                                                 | 'ballGoal'                                                                    | 'tails'                                                       | 'pattern'; params }`                                                                 | T1/T2/T3/H1/L1 rules are data, not obstacles | `designNotes` JSON + per-round module |
| 7   | `ObstacleInstance.controlledBy?: 'time'                                                        | 'round'`                                                                   | Pattern Panic board, crown floatSchedule, board shifts                        | Round module owns those runtimes directly                     |
| 8   | `Variation.qualification?` and per-stage `qualificationByStage?`                               | H1 `few-tails`; SHOWS.md's per-stage ratios                                | Playlist (SHOWS) overrides the ratio when instantiating the round             |
| 9   | `Trigger.shape?: 'box'                                                                         | 'cylinder'`                                                                | Round nests, circular checkpoints on the spiral, crown zones                  | Boxes, sized to the inscribed square                          |
| 10  | `StaticPiece.collidesWith?: 'all'                                                              | 'props'                                                                    | 'players'`                                                                    | T2 ball-only ceiling; invisible player-only rails             | Separate collision-group convention keyed off `decorative` + colour `"none"` (hacky) |
| 11  | `lighting?: { sunAzimuth, sunElevation, sunColor, fogNear, fogFar, skyByAltitude? }` per round | Every round lists its own sun/fog; R6 needs altitude-blended sky           | Theme + weather defaults; per-round values in `designNotes`                   |
| 12  | `Trigger.follow?: string` (prop or obstacle id)                                                | Crown trigger follows the floating crown                                   | Round module moves the crown sensor itself                                    |
| 13  | `fallBehavior: 'respawnTeam'`                                                                  | Team rounds respawn in team zones, H1 drops tails                          | `respawnCheckpoint` + checkpoint `index` = team                               |
| 14  | `Waypoint.y-agnostic` / `Waypoint.zoneRadius3D`                                                | Spiral and climbing rounds need vertical arrival checks                    | 2D radius +                                                                   | Δy                                                            | < 2 m convention                                                                     |
| 15  | `RoundDefinition.endRule?: { eliminatedAtLeast?: number                                        | ratio }`                                                                   | Survival "end when the cut is reached" is implied by ratio today              | Implemented as the documented convention (§5 header)          |
| 16  | `ObstacleInstance.attachTo?: string`                                                           | Obstacles riding dynamic bodies (bumpers on tilt tables, hazards on rafts) | Avoided in the launch set                                                     |

---

## 12. Post-launch rounds

Five rounds added after launch, built on four round-specific obstacle modules
(set D) and two additions to the round schema: the `scoreTarget`
qualification mode with `qualification.scoreGoal` (individual points from
obstacles; the first players to bank the goal qualify, the best scores fill
the quota at the buzzer) and an optional per-round `rulesCard`. Obstacles that
name the round's objective (`botObjective`) switch bots to the objective
strategy: race to the spot the obstacle names, after the bot's reaction delay.

Every count below scales with the round's entrants, so each round plays from a
duel to a full lobby; the per-round tests pin the numbers.

### H2 — Comet Catch

| Field         | Value                                                                                                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id / theme    | `comet-catch` / space, `mus_space_orbitparty`, orbit camera                                                                                                                                                                                                       |
| Players       | 2 / 60 / 100                                                                                                                                                                                                                                                      |
| Qualification | `scoreTarget`, goal 5, ratio 0.55; 120 s                                                                                                                                                                                                                          |
| Layout        | 19 m deck; four 1 m crater mounds (r 3.6) on the diagonals with ramps along the ring; four bobbing bumper buoys on the axes; spawn grid in the middle                                                                                                             |
| Mechanic      | `cometField`: 2 + ⌈0.3 × entrants⌉ live comets (3 at 2, 32 at 100) hop between 40+ spots every 6 s ÷ stage speed; 1.2 s of each hop is the flight (landing ring telegraph), the rest catchable. Even hops land on even spots, odd on odd, so a comet always moves |
| Bots          | Run to the nearest resting or landing comet                                                                                                                                                                                                                       |
| Falls         | Respawn near the middle (deck checkpoint)                                                                                                                                                                                                                         |
| Variations    | `clear-orbit` · `golden-comets` (4 worth 2) · `restless-comets` (4.5 s hops) · `pinball-buoys`                                                                                                                                                                    |
| Measured      | 100 bots: 56/56 at ~70 s; 20 bots ~50 s; 2 bots ~30 s                                                                                                                                                                                                             |

### H3 — Sunbeam Squabble

| Field         | Value                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id / theme    | `sunbeam-squabble` / sunset, `mus_sunset_boardwalk`, orbit camera                                                                                                                                                                        |
| Players       | 2 / 60 / 100                                                                                                                                                                                                                             |
| Qualification | `scoreTarget`, goal 10, ratio 0.55; 120 s                                                                                                                                                                                                |
| Layout        | 46 m railed boardwalk plaza, four kiosks, a low sweeper arm (12 m, slowly accelerating) round a lighthouse post; spawn south of its reach                                                                                                |
| Mechanic      | `sunbeamZones`: 1 + ⌊entrants / 9⌋ beams (1 at 2, 12 at 100), r 2.8, drifting on per-beam Lissajous paths. Each beam hands out 1 point/s split between everyone inside; a point is a `score` event. Optional flares double a beam's rate |
| Bots          | Walk to the nearest, least crowded beam, leading its drift                                                                                                                                                                               |
| Variations    | `golden-hour` · `solar-flares` · `sea-breeze` (faster drift) · `wide-beams`                                                                                                                                                              |
| Measured      | 100 bots: 56/56 at ~84 s; 20 bots ~70 s; 2 bots ~23 s                                                                                                                                                                                    |

### L2 — Colour Cauldron

| Field         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id / theme    | `colour-cauldron` / goo, `mus_logic_ticktock`, top-down tilt camera                                                                                                                                                                                                                                                                                                                                                                                    |
| Players       | 2 / 60 / 100                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Qualification | `logicSurvive` 0.6; 150 s                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Layout        | 5 × 5 tiles (5 m, 0.8 m seams) over a cauldron; recipe-board screen behind                                                                                                                                                                                                                                                                                                                                                                             |
| Mechanic      | `puzzleFloor` (`mix`): the screen asks a sum ("RED + BLUE") or difference ("PURPLE − RED"); answer tiles 5 → 2 (at least one per 20 entrants, up to 6, in the first three board rounds), never all in one line, every other colour at least twice. Primaries carry ● ▲ ■ and mixes both parents' shapes, so no colour vision is needed. Round 1 teaches (answer glows), round 3 is the first difference, from round 4 the floor fades to grey part-way |
| Timing        | Reading 9 s → 4.5 s ÷ stage speed (≥ 3.5 s), shake 0.8 s, down 1.8 s, rise 0.6 s; a drop that would leave nobody safe is voided                                                                                                                                                                                                                                                                                                                        |
| Variations    | `house-recipe` · `hot-stove` (from round 3) · `fading-paint` (memory from round 2) · `slow-simmer`                                                                                                                                                                                                                                                                                                                                                     |

### L3 — Trail Tracer

| Field         | Value                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id / theme    | `trail-tracer` / frosty, `mus_logic_ticktock`, top-down tilt camera                                                                                                                                                                                                                                                                                                             |
| Players       | 2 / 60 / 100                                                                                                                                                                                                                                                                                                                                                                    |
| Qualification | `logicSurvive` 0.6; 150 s                                                                                                                                                                                                                                                                                                                                                       |
| Layout        | 5 × 5 ice tiles over a frozen lake; scoreboard behind; signposts and pines off the floor                                                                                                                                                                                                                                                                                        |
| Mechanic      | `puzzleFloor` (`trail`): every tile has an arrow, 3 (later 2) carry a start flag (one per 20 entrants, up to 6, in the first three board rounds); "FOLLOW n STEPS" (2 → 6). Walks never revisit a tile or cross another walk's flag or landing; the landings are the safe tiles. Round 1 lights the walks up near the end; from round 4 arrows frost over part-way (flags stay) |
| Variations    | `fresh-snow` · `long-trails` (from round 4) · `whiteout` (memory from round 2) · `clear-skies`                                                                                                                                                                                                                                                                                  |

### F5 — Throne Rush

| Field         | Value                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id / theme    | `throne-rush` / castle, `mus_final_crownfever`, orbit camera                                                                                                                                                                                                                                                                                                            |
| Players       | 1 / 8 / 15                                                                                                                                                                                                                                                                                                                                                              |
| Qualification | `lastStanding`; 150 s + 30 s overtime (the highest Tumbler, i.e. a seated one, wins at the buzzer)                                                                                                                                                                                                                                                                      |
| Layout        | 13 m floor disc of twelve petals; 16 throne spots on rings of 4.5 m and 9 m; columns and banners off the floor                                                                                                                                                                                                                                                          |
| Mechanic      | `throneFloor` cycles: roam 3–5.5 s → spots glow 0.9 s → thrones rise → scramble 3 s (−0.1 s a cycle, ≥ 2 s) → shake 0.7 s → floor open 1.8 s → restore. Seats = standing − max(1, ⌊standing / 4⌋): 15 → 12 → 9 → 7 → 6 → 5 → 4 → 3 → 2 → 1. First to sit owns a throne, anyone else on it is bounced; a dethroned owner frees it; a cycle with no throne held is voided |
| Bots          | Roam while the floor is plain, then run (and hop) to the nearest free throne                                                                                                                                                                                                                                                                                            |
| Variations    | `royal-court` · `quickstep` · `harsh-court` (a third left out) · `royal-guards` (two orbiting bumpers between the rings)                                                                                                                                                                                                                                                |
| Measured      | 15 bots: winner at ~45–80 s                                                                                                                                                                                                                                                                                                                                             |

---

_End of LEVELS.md — 20 launch rounds and 5 post-launch rounds._
