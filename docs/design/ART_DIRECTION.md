# Tumble Royale — Art Direction Bible

> Owner: Art Direction. Audience: render, levels, obstacles, character, VFX, UI.
> Status: **contract**. Values in the _Fixed contract_ tables (theme ids, palette
> keys, team colours, surface kinds, pattern overlays, shapes, weather ids) are
> referenced by round data and code and must not be renamed. Everything else
> (exact hex, intensities, distances) is tunable, but change it here first.
>
> Related: `docs/SPEC.md` §5–7, `docs/ARCHITECTURE.md` (Rendering rules),
> `packages/shared/src/schema/round.ts`, `packages/shared/src/game.ts`.

---

## 0. Fixed contract (quick reference)

| Contract                           | Values                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `ThemeId`                          | `candy`, `factory`, `frosty`, `jungle`, `sunset`, `space`, `beach`, `neon`, `castle`, `goo` |
| Palette keys (`StaticPiece.color`) | `primary`, `secondary`, `accent`, `danger`, `safe`, `neutral` — or a raw `#rrggbb`          |
| Global semantics                   | **danger = magenta/orange**, **safe = cyan/mint**, **interactable / grabbable = yellow**    |
| `TEAM_COLORS` (team 0..3)          | `#ff4f8b`, `#3fa9ff`, `#ffd23f`, `#6ee7a8`                                                  |
| `SurfaceKind`                      | `normal`, `ice`, `slime`, `conveyor`, `sticky`, `bouncy`, `slide`                           |
| `pattern`                          | `none`, `stripes`, `dots`, `checker`, `chevron`, `hazard`                                   |
| `shape`                            | `box`, `cylinder`, `ramp`, `wedge`, `sphere`, `hexPrism`, `torus`, `arch`                   |
| `weather`                          | `clear`, `windy`, `night`, `sunset`, `snow`, `stormy`                                       |

### 0.1 Global constants (all themes)

| Token              | Hex                   | Use                                                                           |
| ------------------ | --------------------- | ----------------------------------------------------------------------------- |
| `ink`              | `#1f1640`             | Outlines, hazard-stripe dark band, UI text stroke, stamp shadow, icon keyline |
| `ink-soft`         | `#3a2f66`             | Secondary keylines, background-tier outlines                                  |
| `paper`            | `#fffaf2`             | UI panels, decal light band, nameplate fill                                   |
| `grab-yellow`      | `#ffd84a`             | Grabbable ledge trim, grab prompts, interactable glow                         |
| `grab-yellow-deep` | `#e6a800`             | Grabbable trim shadow band / underside                                        |
| `crown-gold`       | `#ffcc33` → `#ff9f1a` | The Crown (gradient top → bottom), Crown Shards, final badge                  |
| `slime-lime`       | `#b6f03c`             | Non-lethal `slime` surface film (never used for lethal fluids)                |
| `blob-shadow`      | `#1f1640` @ 35 %      | Character blob shadow (always on)                                             |
| `telegraph-white`  | `#ffffff`             | Telegraph core flash (always paired with theme `danger`)                      |

---

## 1. Pillars & shape language

### 1.1 Pillars

1. **Readable first.** A player who has never seen a round must be able to tell,
   in under one second and from the default camera, _where to stand_, _what
   hurts_, _what can be grabbed_ and _which way to go_. Every other choice yields
   to this.
2. **Toy, not machine.** Everything looks like a moulded, glossy, slightly
   squishy toy: no sharp corners, no grime, no realistic wear, no rust, no blood,
   no scary teeth. Hazards look _mischievous_, not violent.
3. **Bouncy physics you can see.** Squash-and-stretch on contact, overshoot on
   motion, jiggle on settle. If it moves, it eases; if it hits, it squishes.
4. **Bright sky, floating world.** Every level is a toy set suspended in sky.
   The void is always _below_ and always reads darker and cooler than the floor.
5. **Colour has a job.** Saturated magenta/orange, cyan/mint and yellow are
   _reserved_ for gameplay meaning. Decoration gets pastels and the theme's
   non-semantic hues.

### 1.2 Shape language

| Category             | Shape vocabulary                                                        | Rules                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Walkable / safe      | Rounded rectangles, discs (`cylinder`), `hexPrism` tiles, gentle `ramp` | Flat, wide tops; soft bevels; top face is the lightest face of the object                                                       |
| Hazards              | Spheres, `torus` rings, swinging mallets, spinner bars, `wedge` pushers | Rounder and _chunkier_ than walkables; always carry `danger` colour + motion telegraph; no spikes (use rounded "nubs" ≤ 0.25 m) |
| Interactables / grab | Bars, ledge lips, handles, eggs, balls, the Crown                       | Yellow trim band; cylindrical lips ≥ 0.25 m diameter so the hand reads on them                                                  |
| Direction / goals    | `arch` gates, checker banners, chevron floors                           | Arches frame the critical path; finish arch is always checker + confetti cannons                                                |
| Background           | Floating islands, balloons, blimps, giant props                         | Lower contrast, no outline beyond 80 m, never on the critical path silhouette                                                   |

**Silhouette rules**

- Every gameplay object must be identifiable as a flat black silhouette at
  48 px tall: walkables are wide-and-flat, hazards are round-and-heavy,
  interactables are thin-and-handled.
- A hazard silhouette must never be confused with a platform silhouette: if a
  moving platform and a pusher share a shape, the pusher gets nubs or a face.
- Background props are kept **out of the 15° cone around the camera's
  critical-path view** at chest height, and must not overlap the void-edge
  silhouette of any walkable from the default camera.
- Tumblers are the most saturated, most outlined things on screen at mid
  distance. Nothing in the level outlines thicker than a Tumbler.

### 1.3 Squash & stretch

| Object              | Trigger                   | Scale (Y / XZ)    | Duration | Ease                    |
| ------------------- | ------------------------- | ----------------- | -------- | ----------------------- |
| Tumbler land        | Ground contact, v ≥ 4 m/s | 0.78 / 1.14       | 140 ms   | spring (ζ 0.45, f 4 Hz) |
| Tumbler jump        | Take-off                  | 1.18 / 0.90       | 100 ms   | spring                  |
| Bouncy pad          | Contact                   | 0.80 / 1.10       | 220 ms   | spring (ζ 0.30)         |
| Tile (crumble)      | Each crack stage          | 0.96 / 1.03       | 90 ms    | back-out                |
| Pusher / mallet     | End of stroke             | 1.06 along stroke | 120 ms   | back-out                |
| Pickups (egg, ball) | Idle                      | ±0.04 bob, 1.2 Hz | loop     | sine                    |

Visual squash is **render-only**; colliders never change.

### 1.4 Scale references

| Reference                  | Size                         | Notes                                                                |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Tumbler capsule            | **0.9 m wide × 1.8 m tall**  | The unit everything is measured against                              |
| Minimum walkway width      | **≥ 3.0 m** (≈ 3.3 Tumblers) | Critical path in races; 4–6 m for 40-player opening funnels          |
| Narrow beam (skill path)   | 1.2–1.8 m                    | Only as an optional shortcut, never mandatory on the opening stretch |
| Door / gate opening        | 2.4 m wide × 3.0 m tall      | Door gauntlet panels; arch gates ≥ 4 m wide                          |
| Grab ledge lip             | 0.25–0.35 m diameter         | Yellow trim, 0.12 m band                                             |
| Hex tile (survival floors) | 2.2–2.6 m across flats       | Gap between tiles 0.08 m (reads as a crack line, not a hole)         |
| Checkpoint pad             | 6 m × 3 m min                | Checker pattern, `safe` colour                                       |
| Background island          | 15–60 m                      | ≥ 40 m from the nearest walkable                                     |
| Blimp / balloon            | 8–25 m                       | ≥ 70 m away, parallax layer                                          |

### 1.5 Bevel radius guidance

`bevel` (schema default `0.15`) should follow the smallest dimension of the piece:

`bevel = clamp(0.06 × minDimension, 0.06, 0.60)` metres.

| Smallest dimension | Recommended `bevel` | Typical piece                                                                                                      |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ≤ 0.5 m            | 0.06                | Rails, lips, thin beams                                                                                            |
| 0.5–1.0 m          | 0.08                | Posts, steps                                                                                                       |
| 1.0–2.5 m          | 0.12–0.15           | Hex tiles, crates, door panels                                                                                     |
| 2.5–5 m            | 0.20–0.30           | Walkway slabs (thickness ~1 m but use the _width_ for top edges if the slab is ≥ 4 m wide and ≤ 1.2 m thick: 0.25) |
| 5–15 m             | 0.35–0.50           | Large platforms, island tops                                                                                       |
| ≥ 15 m             | 0.60                | Arena floors, background islands                                                                                   |

Rules: `ramp` and `wedge` use the same bevel on all edges except the ramp
lip (0.04 m so the transition reads smooth). `cylinder`/`hexPrism` bevel only
the top and bottom rims. `sphere` and `torus` have no bevel. `arch` bevels the
inner curve at half the outer value.

---

## 2. Palette rules

### 2.1 Semantic colour reservation

Hue bands are given in HSV degrees. A colour is **reserved** when it falls in the
band **and** exceeds the saturation floor.

| Meaning                   | Hue band | Saturation floor | Value    | May appear on                                                                                                              | Must **never** appear on                                                             |
| ------------------------- | -------- | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Danger** (magenta)      | 305–345° | S ≥ 60 %         | V ≥ 85 % | Lethal goo/void fluid, pushers, mallets, spinner bars, lasers, kill-adjacent edges, telegraphs, crumbling-tile final stage | Walkable tops, safe zones, grab trim, decoration, background props, UI "good" states |
| **Danger** (orange)       | 12–35°   | S ≥ 60 %         | V ≥ 85 % | Same as magenta                                                                                                            | Same as magenta                                                                      |
| **Safe** (cyan)           | 165–195° | S ≥ 55 %         | V ≥ 80 % | Checkpoints, finish pads, safe zones, respawn rings, "stand here" telegraphs, qualification VFX                            | Hazards, lethal fluids, decoration                                                   |
| **Safe** (mint)           | 140–165° | S ≥ 55 %         | V ≥ 80 % | Same as cyan                                                                                                               | Same as cyan                                                                         |
| **Interactable** (yellow) | 42–58°   | S ≥ 60 %         | V ≥ 85 % | Grabbable ledges/bars, carryable eggs/balls, buttons, the Crown, grab prompts                                              | Non-grabbable geometry, hazards, decoration                                          |

Each theme picks **one** danger family (magenta _or_ orange) as its `danger`
key, chosen for maximum hue distance from its `primary`. The other family may
still appear on hazards in that theme but only with the `hazard` pattern.

**Team-round exception.** `TEAM_COLORS` overlap the semantic bands
(`#ff4f8b` ≈ magenta, `#6ee7a8` ≈ mint, `#ffd23f` ≈ yellow). In team rounds:
team colour is only ever applied to **team-owned objects** (team zones, team
goals, team smoke, bibs, banners), always together with the team crest shape
(§10.3). Hazards in team rounds use `hazard` stripes + emissive pulse so they
never rely on hue; grabbables keep their yellow trim _and_ the grab-bracket
decal (§5.3).

### 2.2 Value / saturation ranges

| Layer                                                  | Saturation (HSV) | Value (HSV) | CIE L*            | Notes                                                       |
| ------------------------------------------------------ | ---------------- | ----------- | ----------------- | ----------------------------------------------------------- |
| Walkable top faces (`primary`, `secondary`, `neutral`) | 10–60 %          | 65–100 %    | 40–96             | Pastel. Side faces auto-darken by ramp                      |
| Accent (trim, decoration on walkables)                 | 35–70 %          | 75–100 %    | 45–85             | Must sit outside reserved bands                             |
| Hazards (`danger`)                                     | 75–100 %         | 85–100 %    | 50–66             | Plus emissive 0.3 idle / up to 2.5 telegraph                |
| Safe (`safe`)                                          | 55–85 %          | 85–100 %    | 80–90             | Plus emissive 0.25                                          |
| Interactable (`grab-yellow`)                           | 65–80 %          | 95–100 %    | 85–90             | Plus emissive 0.2                                           |
| Background props                                       | 10–45 %          | 50–95 %     | —                 | Additionally fogged; never brighter than walkable `primary` |
| Sky bottom / void                                      | 20–80 %          | 5–70 %      | ≤ primary L* − 25 | The void reads darker than any floor                        |

### 2.3 Contrast minimums

Measured on the albedo before lighting, then re-checked in a lit screenshot.

| Pair                                           | Minimum                                          | How to check                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Walkable `primary` vs sky-bottom / void        | ΔL* ≥ 25 **and** WCAG ratio ≥ 2.2 : 1            | All 10 themes pass (§3.1 table, worst case candy ΔL* 32 / 2.9 : 1)                                            |
| Walkable `secondary` vs sky-bottom / void      | ΔL* ≥ 20                                         | Worst case jungle ΔL* 23                                                                                      |
| Walkable vs adjacent walkable (stripes, tiles) | ΔL* 8–18                                         | Enough to read edges, not enough to look like a hazard                                                        |
| Danger vs walkable it sits on                  | Hue Δ ≥ 90° **plus** pattern or emissive         | Base luminance alone is _not_ required — the `hazard` stripe dark band (`#1f1640`) carries the value contrast |
| Grab trim vs the surface it sits on            | ΔL* ≥ 15 or an `ink` keyline                     | Yellow on a pastel floor always gets the keyline                                                              |
| UI text vs its panel                           | WCAG ≥ 4.5 : 1 (body), ≥ 3 : 1 (display ≥ 32 px) |                                                                                                               |

### 2.4 Pattern overlays

Overlays are world-space triplanar decals multiplied/screened onto the base
colour. They are a **meaning channel**, so they are not decorative.

| `pattern` | Meaning (contract)                            | Look                                                               | Colours                                    | Scale                   | Animated?                                               |
| --------- | --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ----------------------- | ------------------------------------------------------- |
| `none`    | Plain walkable / prop                         | —                                                                  | —                                          | —                       | —                                                       |
| `hazard`  | **Lethal or kill-adjacent edge**, hazard body | 45° diagonal tape                                                  | theme `danger` + `ink` `#1f1640`           | 0.35 m bands            | No (emissive pulses only when telegraphing)             |
| `chevron` | **Direction of travel**; conveyors            | ">" arrows pointing along travel                                   | base + `paper` at 55 %                     | 0.8 m pitch             | Scrolls at surface speed on conveyors; static elsewhere |
| `checker` | **Finish / checkpoint**                       | Square checker                                                     | `safe` + `paper` (finish: `ink` + `paper`) | 0.6 m squares           | Finish banner checker waves (vertex)                    |
| `dots`    | **Bouncy**                                    | Polka dots                                                         | base lightened +20 L*                      | 0.3 m dots, 0.9 m pitch | Dots scale-pulse 1.0→1.15 on contact                    |
| `stripes` | **Moving or collapsing** geometry             | Straight stripes perpendicular to motion axis (collapsing: radial) | base ± 12 L*                               | 0.5 m bands             | Static; crack VFX handles collapse stages               |

Rules:

- `hazard` is reserved: never use it on a walkable top. Use it on the **lip of
  a walkable that borders lethal goo/void** as a 0.3 m band on the _side face_
  only, so the top stays readable.
- One overlay per piece. If a piece is both bouncy and moving, `dots` wins and
  the motion is carried by the obstacle telegraph.
- Overlays fade to 0 beyond 90 m to avoid moiré; replace with a flat average.

---

## 3. Themes

### 3.1 Palette keys (round-data `color` field)

| Theme   | `primary`               | `secondary`            | `accent`                  | `danger`          | `safe`              | `neutral`             |
| ------- | ----------------------- | ---------------------- | ------------------------- | ----------------- | ------------------- | --------------------- |
| candy   | `#f7a8d0` bubblegum     | `#a8c8ff` periwinkle   | `#c58bff` grape           | `#ff5a1f` orange  | `#3ff0d2` cyan      | `#fff1e6` cream       |
| factory | `#8fa3b8` steel         | `#7486a0` slate        | `#4d7cff` cobalt          | `#ff6a14` orange  | `#33e6c4` cyan      | `#d9dde3` aluminium   |
| frosty  | `#dff3ff` snow-ice      | `#9fc4ff` glacier      | `#b08cff` aurora          | `#ff2d9b` magenta | `#5cf2a0` mint      | `#f4f7fb` powder      |
| jungle  | `#8cc45a` leaf          | `#b8956a` bark         | `#9d6cff` orchid          | `#ff5a1a` orange  | `#3ce6e0` cyan      | `#f2ead6` husk        |
| sunset  | `#ffc39a` peach         | `#c79ae6` dusk lilac   | `#6f7cff` twilight        | `#ff1a8c` magenta | `#3ff0e0` cyan      | `#fff0e0` shell       |
| space   | `#b8c2ff` moon-lavender | `#6b6fd6` nebula       | `#c8ff8a` alien lime      | `#ff6b1f` orange  | `#46f5d0` cyan-mint | `#e9ecf7` hull white  |
| beach   | `#f5deb0` sand          | `#8fb8ff` sea-sky      | `#a6d65c` palm            | `#ff2f8f` magenta | `#5cf2a8` mint      | `#fff8ec` foam        |
| neon    | `#6a5cd6` grid violet   | `#4b55b8` night indigo | `#b45cff` electric violet | `#ff7a1a` orange  | `#2ff5e8` cyan      | `#cfd3ff` haze        |
| castle  | `#d9c9a8` sandstone     | `#8f9fbf` slate-blue   | `#5b6cf0` royal           | `#f0168c` magenta | `#52f0c0` mint      | `#f6efe2` parchment   |
| goo     | `#b3a6ff` lilac         | `#7a8fd9` cornflower   | `#c8f26a` lime            | `#e81ca0` magenta | `#3ff2d8` cyan      | `#f0eefc` marshmallow |

Measured contrast of `primary` against sky-bottom / void: candy ΔL* 32 (2.9:1),
factory 44 (4.7:1), frosty 53 (5.4:1), jungle 32 (3.0:1), sunset 50 (5.3:1),
space 74 (10.8:1), beach 43 (4.0:1), neon 44 (3.9:1), castle 43 (4.1:1), goo 50
(5.7:1).

### 3.2 Sky, fog & post

| Theme   | Sky top   | Sky horizon | Sky bottom (void) | Fog colour | Fog near / far (m) | LUT id        | Bloom strength |
| ------- | --------- | ----------- | ----------------- | ---------- | ------------------ | ------------- | -------------- |
| candy   | `#6fb8ff` | `#ffd9ef`   | `#6a5cc4`         | `#f6d6ef`  | 60 / 320           | `lut_candy`   | 0.35           |
| factory | `#5a8fd6` | `#e8eef5`   | `#2b3452`         | `#c9d3df`  | 50 / 280           | `lut_factory` | 0.30           |
| frosty  | `#7fb6ff` | `#f0f8ff`   | `#3f5fa8`         | `#dbeaff`  | 40 / 260           | `lut_frosty`  | 0.45           |
| jungle  | `#4fb0e8` | `#eaf7d8`   | `#2f6b5a`         | `#cfe8c8`  | 45 / 240           | `lut_jungle`  | 0.30           |
| sunset  | `#5b4fb8` | `#ffb37a`   | `#5a3f8f`         | `#f7c0a8`  | 55 / 300           | `lut_sunset`  | 0.50           |
| space   | `#0d0b2e` | `#3b2f7a`   | `#120c33`         | `#2a2466`  | 80 / 420           | `lut_space`   | 0.60           |
| beach   | `#3fa0ff` | `#e6f6ff`   | `#1f6fb8`         | `#d6eefa`  | 60 / 320           | `lut_beach`   | 0.30           |
| neon    | `#120a2e` | `#3a1a66`   | `#07051a`         | `#2a1450`  | 30 / 220           | `lut_neon`    | 0.80           |
| castle  | `#5f9ee8` | `#f3ead8`   | `#4a5a8a`         | `#e3dccd`  | 55 / 300           | `lut_castle`  | 0.30           |
| goo     | `#6a7cf0` | `#e8dcff`   | `#3a2a6a`         | `#d8cff5`  | 40 / 240           | `lut_goo`     | 0.45           |

Sky is a 3-stop vertical gradient (top at zenith, horizon at 0°, bottom at
−90°) with a horizon band ±8°, plus 2 drifting cloud layers (`neutral` at 85 %
and sky-horizon at 60 %, scroll 1.5 m/s and 0.6 m/s).

### 3.3 Lights

| Theme   | Sun colour | Sun intensity | Sun elev / azimuth (°) | Hemi sky  | Hemi ground | Hemi intensity | Rim light colour |
| ------- | ---------- | ------------- | ---------------------- | --------- | ----------- | -------------- | ---------------- |
| candy   | `#fff2dc`  | 3.0           | 55 / 135               | `#cfe6ff` | `#f2b8d6`   | 0.90           | `#ffffff`        |
| factory | `#fff4e6`  | 2.6           | 60 / 210               | `#d6e4f5` | `#7a6a5a`   | 0.80           | `#cfe8ff`        |
| frosty  | `#f2f8ff`  | 2.8           | 35 / 160               | `#e6f2ff` | `#9fb8d9`   | 1.00           | `#bfe6ff`        |
| jungle  | `#fff0c8`  | 3.0           | 62 / 120               | `#d8f0ff` | `#6f8f3f`   | 0.85           | `#fff6d0`        |
| sunset  | `#ffb070`  | 3.2           | 12 / 250               | `#ffd0b0` | `#6a4f8f`   | 0.90           | `#ffcf8a`        |
| space   | `#f4f0ff`  | 3.4           | 45 / 300               | `#7f86ff` | `#2a1f4f`   | 0.70           | `#c8d8ff`        |
| beach   | `#fff6e0`  | 3.2           | 65 / 140               | `#d8eeff` | `#e8d2a0`   | 1.00           | `#ffffff`        |
| neon    | `#b8b0ff`  | 1.6           | 50 / 200               | `#6a5cff` | `#1a0f33`   | 0.60           | `#d8c8ff`        |
| castle  | `#ffeccc`  | 3.0           | 48 / 110               | `#dfe9ff` | `#a08a6a`   | 0.90           | `#fff0d6`        |
| goo     | `#fff0f8`  | 2.8           | 50 / 180               | `#e0dcff` | `#7a4f8f`   | 0.85           | `#f0e0ff`        |

Azimuth is measured clockwise from +Z (course forward). Keep the sun behind or
beside the camera on the critical path (azimuth within ±70° of the camera's
back direction) so faces are lit and shadows fall _ahead_ of the player,
readable on the floor. Rim light is a view-space Fresnel term (not a real
light), intensity 0.35 levels / 0.6 characters.

Cascaded shadows: 2 cascades on Medium (25 m, 90 m), 3 on High/Ultra (15, 50,
140 m). Shadow colour is the hemisphere ground colour at 55 % multiply, never
pure black.

### 3.4 Mood & decor kits

All decor is decorative (`decorative: true` or render-only kit), instanced, on 3
parallax layers: **near** (40–80 m, slow bob 0.3 m @ 0.2 Hz), **mid** (80–200 m),
**far** (200 m+, billboards/impostors). Decor never uses reserved colours at
reserved saturation.

#### candy — Gumdrop Gauntlet, Tile Panic

- **Mood:** "A birthday party that fell into the sky." Sugary, bright, giddy.
- **Decor kit:** gumdrop islands (instanced, 3 sizes), lollipop trees, giant
  wrapped-sweet blimps, swirl-marshmallow clouds, sprinkle confetti drifting in
  the near layer, a cake-tier crowd stand with instanced cheering Tumbler
  impostors, ribbon garlands on arches, giant candy-cane arches framing the
  start. Tile Panic: floating cupcake islands circling the arena.

#### factory — Conveyor Chaos, Spin Cycle

- **Mood:** "A toy factory on overtime." Busy, rhythmic, clacky.
- **Decor kit:** floating gear islands (slowly rotating), giant crane arms
  carrying toy blocks, pipe bundles with puffing steam (white, not grey),
  stacked toy-crate cliffs, a cargo blimp with a gear logo, conveyor ribbons
  looping in the far layer, a gantry crowd stand. Spin Cycle: a giant
  washing-drum ring rotating behind the arena.

#### frosty — Slip 'n' Spiral, Last Tumbler Standing (final)

- **Mood:** "A snow globe someone just shook." Crisp, sparkly, hushed.
- **Decor kit:** iceberg islands with snow caps, frozen waterfalls, giant
  snowflake mobiles, igloo villages, sleigh blimps, aurora ribbons in the far
  layer (accent `#b08cff` → `#7fb6ff`), ice-crystal clusters. Last Tumbler
  Standing: three stacked hex ice layers — each lower layer tinted 8 % darker
  and 10 % more saturated so players can read which layer they are on; a ring
  of floating ice pillars with spectator Tumblers; snow globe dome glint above.

#### jungle — Egg Heist, Tail Chase

- **Mood:** "A treehouse adventure at recess." Leafy, playful, sneaky.
- **Decor kit:** floating tree-root islands, giant leaves and ferns, vine
  bridges (background only), waterfalls pouring into the void, totem-free
  carved fruit statues, parrot-shaped kites, mushroom clusters, firefly
  particles in shade. Egg Heist: nest baskets in team colours with crest flags;
  eggs are yellow (interactable) with a white speckle.

#### sunset — Tilt Town, Bounce Ball Blitz

- **Mood:** "Golden hour at the boardwalk." Warm, lazy, glowing.
- **Decor kit:** silhouetted rooftop islands with string lights, hot-air
  balloons (instanced, 4 patterns), long-shadow palm stumps, a ferris wheel in
  the mid layer, paper lanterns, birds flocking (boids, 30). Bounce Ball Blitz:
  stadium bleachers with instanced crowd and team banners.

#### space — Wind Tunnel Peaks

- **Mood:** "A field trip to orbit." Wondrous, floaty, vast.
- **Decor kit:** ringed toy planets, rocket-shaped blimps, satellite dishes,
  asteroid chunks (rounded), star field (GPU points, 2 000), nebula cards.
  **Altitude blend:** Wind Tunnel Peaks starts with a daylight sky
  (`#6fb8ff` / `#e8f2ff` / `#3a4f9f`) at the base and lerps to the space sky
  between 40 % and 85 % of course height; fog far grows from 240 m to 420 m;
  stars fade in from 50 %. Clouds are left behind below the player.

#### beach — Cannonball Canyon, Jump Rope Royale

- **Mood:** "Summer holiday, first day." Sunny, splashy, breezy.
- **Decor kit:** sandbar islands with palm trees, beach umbrellas, giant
  sandcastles, inflatable ring floats, a toy sailboat-shaped blimp,
  surfboards stuck in sand, seagull flocks, sea below the course (see lethal
  water, §5.3). Cannonball Canyon: canyon walls of layered sand strata,
  cannon barrels in `secondary` with `danger` muzzle rings. Jump Rope Royale:
  pier pilings and a lifeguard-tower crowd stand.

#### neon — Pattern Panic, Paint the Plaza, Spin Cycle Finale

- **Mood:** "An arcade after closing time." Electric, punchy, rhythmic.
- **Decor kit:** floating arcade-cabinet islands, wireframe grid planes in the
  far layer, giant speaker stacks pulsing to music, glowing ring signs in
  `accent`, laser fans in the background (decor lasers are `accent`/`neutral`,
  **never** `danger`), a crowd stand with glow sticks. Neon walkables always
  carry a 0.06 m emissive edge trim (`neutral`, emissive 0.6) because the
  theme is permanently dark.

#### castle — Hammer Highway, Crown Climb (final)

- **Mood:** "A storybook kingdom made of building blocks." Heroic, regal, silly.
- **Decor kit:** turreted islands, pennant flags (non-team, `accent` +
  `neutral`), drawbridges, giant chess-piece statues, dragon-shaped kites
  (friendly), banner blimps. Crown Climb: the Crown sits atop a summit spire
  with a vertical beam of `crown-gold` light (bloom-selected) visible from
  every point of the course; spectator battlements spiral up the tower.

#### goo — Rising Goo Tower, Goo Peak Final

- **Mood:** "A science-fair volcano that got out of hand." Gooey, urgent, giggly.
- **Decor kit:** bubbling beaker islands, lab-glass spires, giant goo drips
  hanging from the sky (decor, `accent` lime only), bubble clusters,
  blimps with a beaker icon. The rising lethal goo is `danger` magenta
  (`#e81ca0`), emissive 0.6, foam edge `#ffd0ec`, so the threat reads instantly
  against the lilac/cornflower platforms.

---

## 4. Weather modifiers

Weather is applied **on top of** the theme values. Multipliers (×) scale theme
values; hex values are overrides (blended at the stated weight, 100 % = replace).

| Property           | `clear` | `windy`                               | `night`                                           | `sunset`                            | `snow`                                            | `stormy`                                |
| ------------------ | ------- | ------------------------------------- | ------------------------------------------------- | ----------------------------------- | ------------------------------------------------- | --------------------------------------- |
| Sky top            | —       | sat ×0.95                             | `#0b1030` 100 %                                   | `#4a3f9f` 60 %                      | sat ×0.6, `#c8d8ee` 40 %                          | `#3a4258` 85 %                          |
| Sky horizon        | —       | —                                     | `#2a2f6a` 100 %                                   | `#ff9f6a` 60 %                      | `#eef3fa` 50 %                                    | `#8a93a8` 85 %                          |
| Sky bottom         | —       | —                                     | `#05071a` 100 %                                   | `#5a3f7f` 60 %                      | ×0.9 value                                        | `#262b3a` 85 %                          |
| Clouds             | —       | speed ×3, stretched 1.4× along wind   | darkened ×0.4, moonlit rims                       | underlit `#ffb37a`                  | thick, ×1.5 coverage                              | ×2 coverage, `#5a6278`                  |
| Fog colour         | —       | —                                     | `#1a1f45`                                         | `#f2a88a` 60 %                      | `#e8f0fa`                                         | `#6a7388`                               |
| Fog near / far     | —       | far ×0.9                              | near ×0.8, far ×0.7                               | far ×1.1                            | near ×0.7, far ×0.75                              | near ×0.6, far ×0.6                     |
| Sun →              | —       | —                                     | becomes moon `#b8c8ff`, intensity ×0.35, elev 40° | `#ffa060`, intensity ×0.9, elev 10° | `#f2f6ff`, intensity ×0.75, shadows softened ×1.5 | intensity ×0.45, `#c8d0e0`              |
| Hemisphere         | —       | —                                     | ×0.55, sky `#4a5aa8`, ground `#1a1430`            | sky `#ffc8a0` 50 %                  | ×1.1, ground `#e8eef8`                            | ×0.8, sky `#8a93a8`                     |
| Rim light          | —       | —                                     | ×1.5, `#9fb8ff`                                   | ×1.4, `#ffcf8a`                     | `#e6f2ff`                                         | ×1.3, `#c8d8ff`                         |
| Bloom              | —       | —                                     | ×1.6                                              | ×1.25                               | ×1.1                                              | ×1.2                                    |
| Particles          | —       | wind streaks 120, leaves/sprinkles 80 | fireflies / motes 150                             | dust motes 80                       | snowflakes 600                                    | rain streaks 800, splash 120, lightning |
| Emissive (hazards) | ×1      | ×1                                    | ×2.0                                              | ×1.3                                | ×1.2                                              | ×1.5                                    |

### 4.1 Readability guarantees per weather

| Weather  | Guarantee                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clear`  | Baseline. All §2.3 contrast checks are signed off in `clear`.                                                                                                                                                                                                                                                                                                |
| `windy`  | Wind streaks always flow in the gameplay wind direction. Any area with wind force shows a ground chevron decal and gust telegraph (§6.10) ≥ 0.8 s before a gust. Streaks are drawn behind Tumblers (depth-tested, alpha ≤ 0.35).                                                                                                                             |
| `night`  | Every walkable top edge gets a 0.06 m emissive trim in theme `neutral` (emissive 0.8). Grabbables glow (`grab-yellow`, emissive 0.6). Safe pads emissive 0.8. Hazards emissive ×2. Each Tumbler gets a soft 3 m point "lantern" (`#fff2dc`, 0.4) — local players and up to 12 nearest only. Void stays darker than floors: fog colour is clamped to ≤ L* 20. |
| `sunset` | If the theme `danger` is orange, it is **swapped to the magenta family** (`#ff1a8c`) for this weather so hazards don't vanish in orange light; LUT gains a warm tint but `safe` is protected (excluded from LUT hue shift via a mask).                                                                                                                       |
| `snow`   | Snow dusting on top faces is capped at 30 % coverage, never on `hazard`, grabbables, `safe` pads or `checker`. Snowflakes are culled within 2 m of the camera and never larger than 6 px at 1080p.                                                                                                                                                           |
| `stormy` | Lightning flash is a **≤ 15 % exposure lift** over 80 ms in, 300 ms out, max once per 6 s, never during a telegraph's final 0.5 s. Reduced-flash mode replaces it with a 1.2 s cloud-glow (no exposure change). Rain is alpha ≤ 0.25 and skipped in a 4 m bubble around the local Tumbler. Walkable edge trim enabled at 0.4.                                |

---

## 5. Materials

### 5.1 Shared toon model

- **Ramp:** 3 steps. N·L thresholds `0.0 / 0.35 / 0.70`, step multipliers
  `0.62 / 0.84 / 1.00`, edge softness 0.04. The shadow step is hue-shifted
  6–10° toward the hemisphere ground colour (never grey).
- **Specular ("candy spec"):** a single stepped highlight, Blinn exponent 48,
  threshold 0.55, colour `#ffffff` at the strengths below.
- **Fresnel rim:** `pow(1 − N·V, 3)`, threshold 0.6, coloured by the theme rim
  light.
- **Fake SSS** (characters, slime, goo, gumdrops): wrap-lighting 0.35, tinted
  with base colour ×1.2 saturation.
- Node materials only (`createToonMaterial`, `createOutlineMaterial`), both
  backends identical.

### 5.2 Surface kinds

| Surface              | Base                                              | Ramp                                       | Specular                                    | Rim           | Emissive                   | UV scroll                                                            | Vertex                             | Foam / edge                          | Decals                                            | Footstep particle                            |
| -------------------- | ------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | ------------- | -------------------------- | -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------------------------- | -------------------------------------------- |
| `normal`             | `color` key                                       | 3-step default                             | 0.25                                        | 0.35          | 0                          | —                                                                    | —                                  | —                                    | Optional `pattern`                                | Dust puff `#fff6e8` @ 60 %, 4 per step       |
| `ice`                | `color` lerp 35 % → `#dff6ff`                     | 3-step, thresholds `0/0.25/0.6` (brighter) | 0.9, exponent 96, plus a second sharp glint | 0.8 `#e6f8ff` | 0.05                       | Sparkle mask scroll 0.05 m/s                                         | —                                  | 0.12 m frosted bevel band `#ffffff`  | Inner crack/bubble parallax decal (depth 0.15 m)  | Ice shards + sparkle `#e6f8ff`, 6 per step   |
| `slime` (non-lethal) | `color` ×0.6 + `slime-lime` `#b6f03c` film 60 %   | 3-step + SSS                               | 0.7 wet                                     | 0.5           | 0.1                        | Noise flow 0.15 m/s                                                  | Wobble 0.03 m @ 1.2 Hz             | Bright rim `#e8ffb0`, 0.1 m          | Drip decals on side faces                         | Splat droplets `#b6f03c`, 5 per step         |
| `conveyor`           | `color` key, belt slats `secondary`               | 3-step                                     | 0.2                                         | 0.35          | 0                          | **`chevron` forced**, scroll = belt speed (m/s) in world units (1:1) | —                                  | Roller ends rotate at matching speed | Side arrow plates at belt ends                    | Dust puff, drifts with belt                  |
| `sticky`             | `color` desat −20 %, warmed toward `#e8c27a` 25 % | 2-step (matte) `0/0.5`, `0.7/1.0`          | 0.1                                         | 0.2           | 0                          | —                                                                    | Stretch strands on foot lift (VFX) | —                                    | Honeycomb hex decal, 0.4 m cells, ΔL* −10         | Stretchy strands `#e8c27a`, 2 per step       |
| `bouncy`             | `color` key, sat +10 %                            | 3-step                                     | 0.6 candy                                   | 0.5           | 0.15 (0.8 flash on bounce) | —                                                                    | Contact squash 0.08 m, spring      | Lip ring `paper` 0.1 m               | **`dots` forced**                                 | Bounce ring (§6.11) + 6 sparkles in `accent` |
| `slide`              | `color` key, value +8 %                           | 3-step                                     | 0.8, anisotropic along fall line            | 0.4           | 0                          | Highlight streak scroll 1.5 m/s down-slope                           | —                                  | —                                    | Speed lines decal along fall line (not `chevron`) | Spray streaks `#ffffff` @ 50 %               |

### 5.3 Special materials

| Material                                                            | Look                                                                                                  | Ramp / spec / rim    | Emissive                                                        | Motion                                                                                                            | Notes                                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Grabbable ledge / bar**                                           | Host surface + `grab-yellow` `#ffd84a` band 0.12 m on the lip, `grab-yellow-deep` `#e6a800` underside | 3-step, spec 0.5     | 0.2 (0.6 when a Tumbler within 2.5 m is airborne and facing it) | Band shimmer 0.5 m/s                                                                                              | Plus a small grab-bracket decal ("⊐ ⊏") every 2 m — the shape channel for colour-blind modes                                                     |
| **Lethal goo**                                                      | Theme `danger` (goo theme `#e81ca0`), translucent depth fade to `#1f1640` at 3 m                      | Toon + SSS, spec 0.8 | 0.6                                                             | Two noise layers scrolling 0.25 m/s and 0.6 m/s (opposed), vertex waves 0.25 m amplitude @ 0.4 Hz, wavelength 6 m | Foam edge where it meets geometry: `#ffd0ec` (magenta) / `#ffe0c8` (orange), 0.4 m wide, intersection-depth based, bubbles popping 1/s per 10 m² |
| **Lethal void (sky)**                                               | Sky bottom gradient; optional thin cloud sea at killY + 6 m                                           | —                    | —                                                               | Clouds 0.6 m/s                                                                                                    | Never place a visible "floor" under the kill plane that reads as walkable                                                                        |
| **Lethal water** (beach)                                            | Deep `#1b5fd1` → `#0e2f7a`; **foam and crest lines in theme `danger`** `#ff2f8f` @ 70 %               | Spec 0.9, sun glint  | 0.3 on foam                                                     | Waves 0.4 m @ 0.3 Hz; scroll 0.4 m/s                                                                              | Water is never `safe`-coloured. Kill-adjacent sand edges carry `hazard` side band                                                                |
| **Glass**                                                           | Tinted `neutral`, alpha 0.35, Fresnel alpha → 0.8 at grazing                                          | Spec 1.0, 2 glints   | 0                                                               | —                                                                                                                 | Always an `ink` outline (tier B) and a 0.1 m frosted rim so it's never invisible; never used for walkable floors over void without the rim       |
| **Hazard object** (pusher, mallet, spinner, cannonball)             | Theme `danger` body + `hazard` pattern on striking faces; `ink` nubs                                  | 3-step, spec 0.5     | 0.3 idle, telegraph up to 2.5                                   | Squash on impact, overshoot ease                                                                                  | Has a cartoon face or bolt-on "eyes" only if the silhouette would otherwise match a platform                                                     |
| **Kinematic obstacle** (moving platforms, rotating discs, see-saws) | Walkable colours (`primary`/`secondary`) + `stripes` overlay                                          | Default              | 0                                                               | Eased motion only                                                                                                 | Side faces carry `secondary` stripes so motion is readable from below/side                                                                       |
| **Crumbling / timed tiles**                                         | `secondary` + `stripes` (radial)                                                                      | Default              | Crack stage 3: `danger` emissive 1.2                            | See §6.3                                                                                                          |                                                                                                                                                  |
| **The Crown**                                                       | `crown-gold` gradient, gem inlays in `accent`                                                         | Spec 1.0, rim 0.8    | 0.5 + bloom selected                                            | Spin 0.5 rev/s, bob 0.15 m                                                                                        | Light beam column (final rounds)                                                                                                                 |
| **Safe pad / checkpoint**                                           | `safe` + `checker` (`paper`)                                                                          | Default              | 0.25 (0.8 for 0.6 s when reached)                               | Checker shimmer                                                                                                   | Respawn rings rise from these pads                                                                                                               |

---

## 6. Telegraph & VFX colour rules

### 6.1 Telegraph pulse (universal)

| Parameter      | Value                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Colour         | Theme `danger` emissive, white core flash `#ffffff` on the last 2 pulses                                        |
| Lead time      | Default **1.2 s**; minimum **0.9 s**; heavy hits (mallets, cannons) 1.5 s                                       |
| Frequency ramp | 1.5 Hz → 6 Hz, exponential, across the lead time                                                                |
| Emissive ramp  | 0.3 → 2.5                                                                                                       |
| Scale cue      | +4 % scale pulse in phase (this carries the telegraph in reduced-flash mode)                                    |
| Ground decal   | Impact zones show a `danger` ring/rect decal on the floor, filling inward over the lead time, edge `ink` 0.05 m |
| Audio sync     | Pulse peaks align with telegraph SFX ticks                                                                      |
| Reduced-flash  | Frequency capped at 3 Hz; emissive cap 1.2; white core disabled; scale pulse and decal fill unchanged           |

### 6.2 Door gauntlets (fake vs real)

Goal: players must recognise "this is a door gauntlet" instantly, and **nothing
may leak which doors break**.

- **Universal look:** door frames are a chunky `arch` in theme `secondary` with
  a `neutral` keystone; panels are theme `accent` with a three-band raised inlay
  and a round "push" plate in `paper`. Every row has a banner "?" pennant above
  it (decor), no other markings.
- **No tells:** fake and real panels share the same mesh, material, UV, colour,
  idle animation, LOD, shadow caster settings, collision visuals and SFX. Any
  cosmetic variation (wobble phase, scuff decal rotation) is seeded from
  `hashString(instanceId)` only, **never** from the solid/breakable flag, and is
  applied to every door.
- Breakable panels resolve on contact only: burst into 8–12 `accent` foam
  chunks + `paper` dust; solid panels do a 0.06 m squash and a dull thud puff
  (`neutral`). Both reactions are generated client-side from the server event.
- Doors must not be placed so their breakability correlates with lighting,
  shadow, decor, or which side the camera spawns on. Level review checks this.

### 6.3 Tile crack stages

| Stage      | Trigger (fraction of tile life) | Visual                                                                                      |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| 0 Intact   | 0 %                             | Base material                                                                               |
| 1 Hairline | 0–40 %                          | 2–3 hairline crack decals (`ink` @ 40 %), dust puff on step                                 |
| 2 Cracked  | 40–80 %                         | Crack decal widens, tile drops 0.04 m, wobble 2° @ 6 Hz, chips fall                         |
| 3 Critical | 80–100 %                        | Cracks glow theme `danger` (emissive 1.2), shake 4° @ 10 Hz, telegraph scale pulse          |
| Gone       | 100 %                           | Burst into 6 instanced shards (inherit tile colour) + puff, shards fall and fade over 1.2 s |

Tile Panic / hex-layer finals preview next-to-fall tiles using stage 1 only;
stage 3 always has ≥ 0.9 s before removal.

### 6.4 Team smoke & team markers

- Team smoke (goal scored, zone captured): 40 soft sprites in the team colour,
  value +10 %, with the team crest (§10.3) as a 1 m decal in the centre burst.
- Team zones: floor tint in team colour at 35 %, border band 0.4 m at 100 % with
  repeating crest icons every 1.5 m.
- Bibs: Tumbler secondary colour band + crest on the back.

### 6.5 Qualification & elimination

| Event                      | VFX                                                                                       | Colours                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Qualified (sparkle column) | Column 1.2 m wide × 8 m tall, 120 sparkles rising 3 m/s, ring burst at feet               | `safe` of theme, `#ffffff`, `crown-gold` `#ffcc33` 20 %                                               |
| Eliminated ("poof")        | Cartoon cloud puff (16 sprites) + 3–5 balloons floating upward with a little "pop" at 4 m | Puff `#ffffff`/`neutral`; balloons in the **player's own** primary/secondary colours (never `danger`) |
| Respawn                    | Rising ring from checkpoint, 0.4 s                                                        | `safe` + `#ffffff`                                                                                    |
| Finish fireworks           | 6 shells, 60 sparks each, staggered 0.25 s                                                | Confetti palette of the theme (§6.6)                                                                  |
| Crown grab (final win)     | Golden burst, 200 confetti, shine sweep on the Crown                                      | `crown-gold` + `#ffffff` + winner's colours                                                           |

### 6.6 Confetti palettes

Confetti is instanced quads (and ribbons), 5 colours per palette.

| Palette            | Colours                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| Default / finish   | `#ff9ec7`, `#8fb8ff`, `#ffe27a`, `#b8f5d8`, `#c8a8ff`                             |
| Victory (Crown)    | `#ffcc33`, `#ff9f1a`, `#ffffff`, `#fff1b8`, winner primary                        |
| Team win           | Team colour, team colour +20 L*, `#ffffff`, `paper` `#fffaf2`, team colour −15 L* |
| Theme accent burst | theme `accent`, theme `neutral`, theme `secondary`, `#ffffff`, `#ffe27a`          |

Confetti never uses theme `danger` hex.

### 6.7 Stun stars

Ring of 5 cartoon stars orbiting the head at 0.45 m radius, 1.5 rev/s, colour
`#ffe27a` with `ink` outline and `#ffffff` sparkle; duration matches stun.

### 6.8 Bounce rings

On `bouncy` contact: 2 concentric flat rings expanding 0.5 → 2.2 m over
0.35 s, colour = pad colour +25 L*, alpha 0.8 → 0; plus pad emissive flash 0.8.

### 6.9 Dive speed lines & dust

Dive: 10 screen-aligned streaks behind the Tumbler, `#ffffff` @ 50 %, 0.25 s.
Landing dust: 8 puffs, surface footstep colour.

### 6.10 Fan wind streaks

Fans and wind zones: 24 streak ribbons per fan, length 1.5–3 m, speed = wind
speed, `#ffffff` @ 35 % (night: `#cfe0ff` @ 45 %). Gusts telegraph with a
streak density ramp ×3 over 0.8 s before force applies. Floor under wind
zones gets a faint `chevron` decal in the wind direction.

### 6.11 Laser beams

Core `#ffffff` 0.06 m, glow in theme `danger` 0.35 m, emissive 3.0 (bloom
selected). Emitters pre-aim with a thin `danger` dotted line at 30 % alpha for
the telegraph lead time. Beams always cast a floor scorch decal line to show
where they sweep. Decorative lasers (neon decor) are `accent` only and never at
gameplay height.

### 6.12 Particle budgets

| Quality | Global live GPU particles | Max simultaneous qualification columns | Confetti per burst | Weather particles |
| ------- | ------------------------- | -------------------------------------- | ------------------ | ----------------- |
| Low     | 1 500                     | 3                                      | 60                 | ×0.3              |
| Medium  | 3 500                     | 6                                      | 120                | ×0.6              |
| High    | 6 000                     | 10                                     | 200                | ×1.0              |
| Ultra   | 10 000                    | 16                                     | 320                | ×1.3              |

Rules: all particles are instanced (one draw per effect type, shared atlas
2048²). Effects beyond 60 m from the camera spawn at 25 % count; beyond 120 m,
only the local player's and spectated player's effects play. Total VFX draw
calls ≤ 20 of the 250 budget.

---

## 7. Character art (Tumblers)

### 7.1 Silhouette & proportions

| Part        | Spec                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Body        | Soft gumdrop (lathe profile, widest at 35 % height), 0.9 m wide × 1.8 m tall matching the capsule                              |
| Face plate  | Oval, top 25 % of body front, 0.55 m wide × 0.42 m tall, slightly inset (0.01 m), `paper` `#fffaf2` default                    |
| Eyes        | Two vertical pill shapes `ink` `#1f1640`, white catch-light; blink every 2.5–6 s random                                        |
| Mouth       | 8 shapes (smile, grin, O-shock, wobble-scared, determined, dizzy-zigzag, open-cheer, flat)                                     |
| Arms        | Stubby, 0.35 m, mitten hands; no fingers                                                                                       |
| Feet        | Two rounded nubs 0.22 m, contrasting tertiary colour                                                                           |
| Readability | Silhouette must stay a single blob at 30 m; costume pieces add ≤ 25 % to silhouette area and never cover the face plate > 30 % |

### 7.2 Default colours

New players get one of 12 defaults (primary / secondary / tertiary), chosen to
avoid reserved hazard saturation:

| #   | Primary   | Secondary | Tertiary  |
| --- | --------- | --------- | --------- |
| 1   | `#ff9ec7` | `#fff1e6` | `#c58bff` |
| 2   | `#8fb8ff` | `#ffffff` | `#4d7cff` |
| 3   | `#b8f5a0` | `#fff8ec` | `#5fbf6a` |
| 4   | `#c8a8ff` | `#ffe9f5` | `#7a5cd6` |
| 5   | `#ffd0a8` | `#fffaf2` | `#d98c5f` |
| 6   | `#a8e8ff` | `#ffffff` | `#3f8fd6` |
| 7   | `#f2f0ea` | `#8fa3b8` | `#4b55b8` |
| 8   | `#ffb8b8` | `#fff1e6` | `#d9606a` |
| 9   | `#d6f07a` | `#ffffff` | `#8fb83f` |
| 10  | `#b3a6ff` | `#e8dcff` | `#6a5cd6` |
| 11  | `#ffe3a8` | `#fffaf2` | `#c99a3f` |
| 12  | `#9fe0d0` | `#f4fffb` | `#3fa08f` |

Cosmetics may use any colour (players may be magenta or yellow); gameplay
meaning is never carried by Tumbler colour.

### 7.3 Outline & shading

- Inverted-hull outline, colour = body primary × 0.35 value blended 50 % with
  `ink`. Thickness **0.025 m** world, clamped to **1.5–3 px** at 1080p
  (scaled by resolution).
- Fake SSS wrap 0.35, rim 0.6 (theme rim colour), candy spec 0.5.
- Blob shadow always on: disc 1.0 m, `ink` @ 35 %, fades with height (100 % at
  0 m, 20 % at 6 m).

### 7.4 Nameplate legibility

| Rule            | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Font            | Nunito 800, 18 px at 1080p (scale with UI scale setting 80–140 %)                         |
| Fill / stroke   | `#ffffff` fill, 3 px `ink` `#1f1640` stroke, drop shadow 0 2 px `#1f1640` @ 50 %          |
| Party / friends | Fill `#ffe27a` + small heart pip                                                          |
| Local player    | No nameplate; a `paper` chevron marker above head appears when occluded                   |
| Distance        | Visible ≤ 30 m (friends/party ≤ 80 m); fades 25–30 m; max 12 on screen, nearest first     |
| Placement       | 0.35 m above head, screen-space, never overlapping another plate (stack with 4 px offset) |
| Occlusion       | Occluded Tumblers show a silhouette x-ray in body colour @ 40 %, local and spectated only |

---

## 8. UI typography

### 8.1 Faces (Google Fonts)

| Role                      | Face           | Weights            | Notes                                                                                                               |
| ------------------------- | -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Display / stamps / titles | **Lilita One** | 400 (only weight)  | Chunky, rounded terminals. All-caps for stamps                                                                      |
| Body / UI copy            | **Nunito**     | 600, 700, 800, 900 | Rounded sans; 700 default for buttons                                                                               |
| Numeric / timer           | **Fredoka**    | 600, 700           | Rendered per-digit in fixed-width cells (`1ch` boxes) so timers never jitter, independent of tabular-figure support |

Fallback stack: `"Lilita One", "Nunito", system-ui, sans-serif`.

### 8.2 Sizes (at 1080p, scale with UI scale)

| Element                     | Face       | Size   | Weight | Tracking              |
| --------------------------- | ---------- | ------ | ------ | --------------------- |
| Stamp ("QUALIFIED!")        | Lilita One | 120 px | 400    | +2 %                  |
| Round title card            | Lilita One | 84 px  | 400    | +1 %                  |
| Screen header               | Lilita One | 48 px  | 400    | 0                     |
| Countdown 3-2-1-GO          | Lilita One | 200 px | 400    | 0                     |
| Timer                       | Fredoka    | 44 px  | 700    | per-digit cells       |
| Qualified counter "12 / 20" | Fredoka    | 36 px  | 700    | per-digit cells       |
| Button label                | Nunito     | 22 px  | 800    | +2 %, uppercase       |
| Body                        | Nunito     | 18 px  | 600    | 0                     |
| Small / tips                | Nunito     | 15 px  | 700    | 0 (never below 14 px) |

### 8.3 Stamp recipe

```
fill:        vertical gradient (top → bottom), see table
stroke 1:    10 px #1f1640 (paint-order: stroke fill, so stroke sits outside)
stroke 2:    4 px #ffffff @ 70 % inner highlight on the top half only
drop shadow: 0 8px 0 #1f1640 @ 55 %   (hard, no blur)
glow:        0 0 24px <fill-top> @ 40 % (disabled in reduced-flash)
motion:      scale 0 → 1.25 → 0.95 → 1.0 over 380 ms, rotate −6° → −3°,
             hold 1.4 s, exit scale 1.0 → 1.1 + fade 200 ms
```

| Stamp             | Fill top → bottom                | Extra                                               |
| ----------------- | -------------------------------- | --------------------------------------------------- |
| QUALIFIED!        | `#8ff7d2` → `#2fd6a8`            | 30 confetti from behind                             |
| ELIMINATED        | `#ff7aa8` → `#e0187a`            | Stamp lands with a small screen shake (trauma 0.15) |
| ROUND OVER        | `#ffffff` → `#cfd3ff`            |                                                     |
| GO!               | `#fff1b8` → `#ffcc33`            |                                                     |
| VICTORY / CROWNED | `#ffe27a` → `#ff9f1a`            | Shine sweep every 1.5 s                             |
| TEAM WINS         | Team colour +25 L* → team colour | Team crest left of text                             |

### 8.4 Round-type badges

Each badge = rounded-square plate + unique icon (§9) + label; colour is never
the only identifier.

| Round type | Plate colour                   | Icon                       | Label    |
| ---------- | ------------------------------ | -------------------------- | -------- |
| race       | `#3d7bff`                      | Flag on a chevron          | RACE     |
| survival   | `#9b5cff`                      | Heart inside a shield      | SURVIVAL |
| team       | `#18b89a`                      | Two overlapping circles    | TEAM     |
| hunt       | `#ff7a2a`                      | Target reticle with a tail | HUNT     |
| logic      | `#ff5fae`                      | Lightbulb / puzzle piece   | LOGIC    |
| final      | `#ffcc33` → `#ff9f1a` gradient | The Crown                  | FINAL    |

### 8.5 Rarity colours

| Rarity    | Hex                                | Shape marker (pips)  | Frame treatment                       |
| --------- | ---------------------------------- | -------------------- | ------------------------------------- |
| Common    | `#b8c0cc`                          | 1 pip                | Flat                                  |
| Uncommon  | `#5fd16a`                          | 2 pips               | Flat                                  |
| Rare      | `#3d8bff`                          | 3 pips               | Inner glow                            |
| Epic      | `#a45cff`                          | 4 pips               | Inner glow + corner gems              |
| Legendary | `#ffb020`                          | 5 pips               | Animated shine sweep                  |
| Mythic    | `#ff4fd8` → `#5fe8ff` (iridescent) | 6 pips (star-shaped) | Animated iridescent border + sparkles |

---

## 9. Iconography

### 9.1 Style rules

- Chunky, rounded, filled shapes; 2 px `ink` `#1f1640` keyline at 48 px
  (scales 1/24 of icon size); 1 highlight blob top-left `#ffffff` @ 60 %.
- Grid: 48 × 48 with 4 px padding; corner radius ≥ 4 px; no hairlines < 2 px.
- Max 3 fills per icon + keyline. Readable as a silhouette at 24 px.
- SVG sprite sheet; icons tint via CSS variables for team/rarity contexts.
- No text inside icons except input-glyph letters.

### 9.2 Required icons

| Group                | Icons                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round types          | race, survival, team, hunt, logic, final (§8.4)                                                                                                                                                                                                                                   |
| Navigation / buttons | play, back, close, settings (cog), locker (hanger), shop (bag), friends (two heads), party (three heads), invite (+head), ready (check), cancel (×), report (flag), mute (speaker slash), emote wheel, spectate (eye), next/prev (arrows), info (i), lock, gift, calendar, trophy |
| Currencies           | **Gumballs** (round sphere in a mini dispenser-glass sheen, `#ff9ec7` + `#8fb8ff` + `#ffe27a` speckles), **Gems** (rounded hex-cut gem `#7a5cff` with `#c8a8ff` facet), **Crown Shards** (triangular gold shard `#ffcc33` with crown notch)                                       |
| Gameplay             | grab (mitten hand), dive (Tumbler with speed lines), jump (up arrow arc), checkpoint (checker flag), respawn (circular arrow), qualified (check in circle), eliminated (cloud puff), timer (stopwatch), players-left (head + number), Crown                                       |
| Input prompts        | Keyboard keycaps (W A S D, Space, Shift, Ctrl, E, Q, Esc, Tab, mouse L/R/wheel), gamepad (A/B/X/Y and Cross/Circle/Square/Triangle shapes rendered as neutral glyphs, LB/RB/LT/RT, sticks L/R, d-pad), touch (tap, hold, swipe)                                                   |
| Pings                | "Go here" (`safe`-coloured pin with arrow), "Danger" (`danger` triangle with !), "Grab this" (yellow mitten), "Look" (eye) — each distinct shape                                                                                                                                  |
| Team badges          | Team 0 triangle, team 1 circle, team 2 square, team 3 diamond (§10.3)                                                                                                                                                                                                             |

### 9.3 Pattern Panic symbol set

Each symbol differs in **shape, colour and luminance tier**, with an `ink`
keyline and a `paper` tile background. Tested distinct under deuteranopia,
protanopia, tritanopia and greyscale by shape alone.

| Symbol | Shape                  | Colour                      | L* tier         | Inner mark (second cue) |
| ------ | ---------------------- | --------------------------- | --------------- | ----------------------- |
| star   | 5-point rounded star   | `#ffd23f`                   | Very light (87) | Centre dot              |
| heart  | Heart                  | `#ff7aa2`                   | Mid-light (66)  | —                       |
| moon   | Crescent               | `#5a4fcf`                   | Dark (38)       | Two small stars         |
| bolt   | Zig-zag lightning bolt | `#1f6fff`                   | Mid-dark (50)   | —                       |
| flower | 5-petal flower         | `#c060ff`                   | Mid (55)        | `paper` centre ring     |
| drop   | Teardrop               | `#22c7b8`                   | Light (72)      | Highlight stripe        |
| crown  | 3-point crown          | `#ffffff` + `ink` fill-line | Lightest (100)  | 3 dots on band          |
| cloud  | 3-lobe cloud           | `#9aa6b8`                   | Mid-light (68)  | Dashed underline        |

Symbols sit at 60 % of tile width, centred, upright toward the camera's
default yaw.

---

## 10. Colour-blind safe modes

### 10.1 Core rule

**No gameplay information is ever conveyed by colour alone.** Every semantic
colour has a mandatory paired cue:

| Meaning             | Shape / pattern cue (always on, every mode)                  |
| ------------------- | ------------------------------------------------------------ |
| Danger              | `hazard` stripes or telegraph scale pulse + floor decal ring |
| Safe                | `checker` + rising ring VFX                                  |
| Interactable        | Grab-bracket decal + glow band + grab prompt icon            |
| Direction           | `chevron`                                                    |
| Bouncy              | `dots`                                                       |
| Moving / collapsing | `stripes` + crack stages                                     |
| Team                | Crest shape + banner texture (§10.3)                         |

### 10.2 Semantic remaps

Modes live in Settings → Accessibility; they remap palette keys globally at the
material layer (theme `danger`/`safe` and `grab-yellow` are replaced).

| Mode         | Danger                                               | Safe                                    | Interactable                                                         | Extra                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default      | Theme `danger` (magenta/orange)                      | Theme `safe` (cyan/mint)                | `#ffd84a`                                                            | —                                                                                                                                                                                     |
| Deuteranopia | `#ff7a00` (orange, all themes)                       | `#2f8cff` (blue)                        | `#ffe14a` + `ink` keyline                                            | Hazard stripe contrast +15 %                                                                                                                                                          |
| Protanopia   | `#ff8c1a` (bright orange; reds look dark to protans) | `#2f8cff` (blue)                        | `#ffe14a` + `ink` keyline                                            | Danger emissive +25 % to offset reduced red sensitivity                                                                                                                               |
| Tritanopia   | `#ff3355` (red)                                      | `#00b8c8` (teal) with `#ffffff` checker | `#f4f4f4` (white) with heavy `ink` dashed keyline and `#ffffff` glow | The blue/yellow axis is unreliable, so value carries the meaning: danger is mid-dark, safe is mid-light with a white checker, interactable is the lightest and has the dashed keyline |

### 10.3 Team colours — alternates and markers

| Team | Default (`TEAM_COLORS`) | CVD alternate | Crest shape | Banner texture  |
| ---- | ----------------------- | ------------- | ----------- | --------------- |
| 0    | `#ff4f8b`               | `#e69500`     | Triangle ▲  | Zig-zag         |
| 1    | `#3fa9ff`               | `#3f7fff`     | Circle ●    | Waves           |
| 2    | `#ffd23f`               | `#f2e85a`     | Square ■    | Grid            |
| 3    | `#6ee7a8`               | `#a05cff`     | Diamond ◆   | Diagonal dashes |

Crests appear on bibs, team zones, goals, scoreboards and team smoke in every
mode. Banner textures are banner/zone textures, **not** `pattern` overlays (so
they don't collide with the surface-overlay meanings).

### 10.4 Verification

- Every round is screenshot-tested in all four modes and in greyscale; a
  reviewer must be able to name hazards, safe zones, grabbables and direction
  without colour.
- Simulated with Machado 2009 matrices at severity 1.0.

---

## 11. Camera & post

### 11.1 Outline tiers

| Tier | Applies to                   | Method                                    | Width (1080p)      | Colour                   | Distance behaviour          |
| ---- | ---------------------------- | ----------------------------------------- | ------------------ | ------------------------ | --------------------------- |
| A    | Tumblers                     | Inverted hull                             | 1.5–3 px (0.025 m) | Body × 0.35 / `ink` 50 % | Constant to 40 m, then 1 px |
| B    | Walkables, glass, grabbables | Screen-space depth + normal edge          | 2 px               | `ink` `#1f1640` @ 70 %   | Fades to 0 between 80–120 m |
| C    | Hazards, kinematic obstacles | Screen-space edge (object-ID mask)        | 2.5 px             | `ink` @ 85 %             | Fades 100–140 m             |
| D    | Background decor             | None (near layer: 1 px `ink-soft` @ 30 %) | 0–1 px             | `ink-soft` `#3a2f66`     | Off beyond 80 m             |

Built: only tier A. The screen-space edge outline (tiers B/C) exists in
`@tumble/render/post` but is **off in every quality preset**: it traced
blob-shadow decals as squares and fringed edges (`DECISIONS.md`, "Bloom only
above rim light; no screen-space edge outline"). Readability comes from tier
A, rim light and the palette rules instead.

### 11.2 Bloom

| Parameter     | Value                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Mode          | Selective: only the scene pass's emissive buffer blooms (Crown, lasers, telegraph peaks, VFX, neon decor). Off on Low |
| Threshold     | 0.75 in every theme, above the toon rim light that also writes emissive (`DECISIONS.md`)                              |
| Strength      | Theme value (`packages/content/src/themes/themes.ts`) × weather multiplier                                            |
| Radius        | 0.45 (0.4 in one theme)                                                                                               |
| Reduced-flash | Strength cap 0.25                                                                                                     |

### 11.3 LUT, vignette, chromatic punch

| Effect                | Value                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colour grade          | Built as per-theme grade parameters (saturation, contrast, tint, vignette) after tone mapping, not 32³ LUT textures; no object-ID hue protection mask |
| Vignette              | Intensity 0.18, smoothness 0.45, colour `ink` `#1f1640`; 0.35 during finish slow-mo; 0.28 while spectating; never > 0.4                               |
| Chromatic punch       | On hit/knockback only: max 0.006 UV offset, 120 ms decay, max 2 triggers per second, never on spectated players; disabled in reduced-flash            |
| Camera shake (trauma) | Max trauma 0.6, decay 1.5/s, toggleable                                                                                                               |
| Finish slow-mo        | 0.35 time scale, 0.8 s, desat background 15 %, Tumbler excluded                                                                                       |

### 11.4 Reduced-flash mode

Enforces WCAG 2.3.1: no more than 3 flashes per second, and no full-screen
luminance change > 10 % within 100 ms.

- Telegraphs capped at 3 Hz, white core disabled, scale pulse kept (§6.1).
- Lightning → slow cloud glow; finish fireworks → slow bloom-less bursts.
- Chromatic punch off, bloom ≤ 0.25, stamp glow off, emissive flashes ≤ 0.5.
- Confetti and particles kept (no luminance flashing).

### 11.5 Camera readability

- Occluders between camera and local Tumbler fade to 25 % with a dithered
  fade (no alpha sorting) and keep tier B outline.
- Intro flyover shows the critical path from start to finish arch along the
  `chevron`/`checker` cues; finish arch must be in frame for ≥ 1.5 s.
- Fixed side-cam rounds (if any) widen outline tier B to 2.5 px.

---

## 12. Review checklist (levels & obstacles)

- [ ] Every walkable `primary`/`secondary` meets §2.3 against the void.
- [ ] No reserved hue at reserved saturation on non-semantic geometry.
- [ ] All kill-adjacent edges have a `hazard` side band; all conveyors `chevron`; all bouncy `dots`; all finishes/checkpoints `checker`; all moving/collapsing `stripes`.
- [ ] All grabbables have the yellow band + grab-bracket decal.
- [ ] Telegraph lead ≥ 0.9 s on every hazard.
- [ ] Door gauntlets have no state-correlated variation.
- [ ] Checked in all six weathers, four colour modes, greyscale and reduced-flash.
- [ ] Decor stays out of the critical-path silhouette; draw calls < 250.
