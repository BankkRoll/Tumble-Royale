# Tumble Royale — Screens, Flow & Motion Bible

Owner: UI/UX + motion. Implementation: `packages/ui` (React 19 + Zustand + CSS).
Preview every state at `http://localhost:5173/ui.html?screen=<id>`.

This document is the contract for **every screen, every transition and every
animation** in the game's DOM overlay. The 3D canvas (`#game`) always renders
behind the overlay (`#ui`); each section says what the 3D layer is doing so the
two can be choreographed together.

---

## 0. Design language — "Chunky Sticker Candy"

### 0.1 Pillars

1. **Readable at a glance.** Huge type, 3–5 words per card, icons before text.
   A new player understands any round from its intro card in 3 seconds.
2. **Everything is a toy.** Panels look like die-cut vinyl stickers: thick ink
   outline, hard offset drop shadow, glossy top highlight, a 1–3° tilt.
3. **Everything bounces.** No linear motion. Springs for entrances, back-easing
   for exits, gravity curves for falls. Nothing appears; it _arrives_.
4. **Comedy over cruelty.** Losing is funny — wobbly ELIMINATED stamps, falling
   Tumblers with "aww" bubbles, consolation copy. Never red-screen shame.
5. **Respect the player.** Reduce Motion, Reduce Flashing, colour-blind palettes,
   UI scale and Streamer Mode are first-class and honoured by every component.

### 0.2 Tokens (`packages/ui/src/theme/tokens.ts`)

| Token       | Value     | Use                                         |
| ----------- | --------- | ------------------------------------------- |
| `ink`       | `#2b1a5e` | every outline, body text on light           |
| `sky`       | `#5aa9ff` | default backdrop, secondary buttons         |
| `bubblegum` | `#ff4f9a` | PLAY, danger-ish emphasis, eliminated       |
| `grape`     | `#8a5cff` | premium, Season Pass, Gems                  |
| `mint`      | `#3ee6b4` | safe, qualified, success                    |
| `lemon`     | `#ffd23f` | interactable, primary CTAs, Gumballs, crown |
| `tangerine` | `#ff8a3d` | warnings, timers < 10 s                     |
| `cream`     | `#fff7ea` | panel fill                                  |
| `cloud`     | `#ffffff` | highlights                                  |

Rarity: Common `#b8c4d6` · Uncommon `#5fd16a` · Rare `#3fa9ff` · Epic `#b05cff` ·
Legendary `#ffb021` · Mythic animated rainbow (`conic-gradient`, 6 s spin).

Colour-blind palettes swap `--good`, `--bad`, `--warn`, `--team-*` (see §17).

Radii: `sm 0.6em`, `md 1em`, `lg 1.6em`, `pill 999px`. Outline `0.18em` ink.
Shadow: `0 0.28em 0 ink` (hard) + `0 0.9em 1.6em rgba(43,26,94,.25)` (soft).

Type: **Lilita One** (display, all caps for titles, `-webkit-text-stroke` ink +
hard shadow) and **Fredoka** (body, 500/600/700). Fallbacks: `"Arial Rounded MT
Bold", "Trebuchet MS", system-ui`. All sizes are `em` of the root, so UI Scale
multiplies everything.

### 0.3 Motion vocabulary (`theme/motion.ts`, `transitions/`)

| Name         | Curve                                                                   | Duration    | Used for                         |
| ------------ | ----------------------------------------------------------------------- | ----------- | -------------------------------- |
| `spring`     | `linear()` spring (k=170, c=14) fallback `cubic-bezier(.34,1.56,.64,1)` | 520 ms      | panel/card entrances             |
| `springSoft` | k=120, c=16                                                             | 640 ms      | big sheets, carousels            |
| `backOut`    | `cubic-bezier(.34,1.56,.64,1)`                                          | 320 ms      | buttons, chips                   |
| `backIn`     | `cubic-bezier(.36,0,.66,-.56)`                                          | 260 ms      | exits                            |
| `gravity`    | `cubic-bezier(.45,0,.95,.55)`                                           | 900–1300 ms | falling Tumblers, dropped stamps |
| `squash`     | keyframes 1 → (1.15,.85) → (.95,1.05) → 1                               | 280 ms      | presses, landings                |
| `wobble`     | ±4° rotate, decaying                                                    | 600 ms      | hover, eliminated stamp          |

**Stagger rule**: lists enter at 45–70 ms per item, capped at 600 ms total.
**Reduce Motion**: springs → 160 ms opacity fades, no rotation/shake/parallax,
wipes become a 220 ms cross-fade, falls become fade-and-drop 24 px.
**Reduce Flashing**: no strobe/flash > 3 Hz, confetti density × 0.4, no white
screen flashes, wall "flash" becomes a steady tint.

### 0.4 Signature transitions

**Tumble Wipe** (`transitions/TumbleWipe.tsx`) — the screen is swallowed by candy:

1. `0 ms` cue `ui.whoosh`. 7 gumdrop blobs (pink, lemon, mint, grape, sky,
   tangerine, cream) spawn at off-screen points along the bottom-left edge.
2. `0–520 ms` each blob scales from 0 → 2.8× viewport diagonal with `backOut`,
   staggered 45 ms, rotating 0 → 25°; the last (ink-outlined cream) blob fully
   covers. A Tumbler silhouette cartwheels across on top (`600 ms`).
3. **Covered** — emits `transitionCovered`. The game swaps the 3D scene now.
   The wipe may _hold_ (round loading) until `releaseWipe()`.
4. `reveal` (560 ms) blobs shrink toward the top-right in reverse order, the
   new screen's panels spring in from 120 ms.
   Reduce Motion: 220 ms cream cross-fade.

**Stamp Slam** (`transitions/StampLayer.tsx`) — giant sticker text:
`0 ms` scale 2.6, rotate -14°, opacity 0 → `180 ms` scale .92 rotate -4° (impact,
cue `ui.stamp`, screen shake 6 px × 220 ms, ring burst) → `320 ms` scale 1 →
hold 1100 ms → exit: scale 1.08 → 0 with `backIn` 260 ms.

**Springy panels** — every panel enters `translateY(2.4em) scale(.9) rotate(var(--tilt))`
→ rest with `spring`; exits `scale(.94) opacity 0` with `backIn` 200 ms.

**Confetti burst** (`transitions/Confetti.tsx`) — 2D canvas particle burst
(ribbons + dots + mini gumdrops), gravity 1400 px/s², drag, 2.4 s life,
colour sets per event (qualified = mint/lemon/cream, victory = all candy +
gold). Cue `ui.confetti`.

---

## 1. Global architecture

```
#game  (three.js canvas, receives pointer input where UI is transparent)
#ui    (pointer-events: none)
 └─ .tr-root  [data-reduce-motion][data-cb][data-streamer][style --ui-scale]
     ├─ ScreenLayer     current screen (interactive panels pointer-events:auto)
     ├─ HudLayer        only during the round screen
     ├─ StampLayer      stamp queue
     ├─ ConfettiLayer   one shared canvas
     ├─ ToastLayer      top-right cards + left feed
     ├─ OverlayLayer    settings / friends / notifications sheets
     ├─ DialogLayer     confirm / error / purchase dialogs
     ├─ ConnectionLayer reconnecting curtain
     └─ TumbleWipe      always top-most
```

The game never touches React. It drives `ui.getState().<action>()` and listens to
intents with `bindUI({...})` (see `packages/ui/README.md`).

### 1.1 Input & navigation

- **Mouse/touch**: everything clickable is ≥ 44 px (2.75em at default scale).
- **Keyboard**: Arrow keys move focus spatially, Enter/Space accept, Escape
  back/close, `Q`/`E` (or `[`/`]`) cycle menu tabs, `Tab` normal order.
  Keyboard nav is active only on non-gameplay screens (`inputMode === 'menu'`),
  so WASD/arrows in a round go to the Tumbler.
- **Gamepad**: the input system calls `ui.getState().navigate(dir)` with
  `up|down|left|right|accept|back|tabPrev|tabNext`. LB/RB = tabs, A = accept,
  B = back, Start = settings, Y = context action (e.g. Ready / Try on).
- Focus ring: 0.2em lemon ring + 0.36em ink ring outside, gentle 1.2 s pulse.
- Each screen declares its **initial focus** (`data-autofocus`) — usually the
  primary CTA — so a gamepad player can press A immediately.

### 1.2 Pointer events

`#ui` root is `pointer-events: none`. Panels, buttons and sheets opt-in with
`.tr-interactive`. In the main menu the centre (your Tumbler on its platform) is
transparent so the 3D lobby can be clicked/dragged to spin your Tumbler.

### 1.3 Responsive

- **Desktop** ≥ 1024 px: layouts as described.
- **Tablet/phone landscape** (height < 520 px): top bar compresses to icons,
  bottom bar shrinks; HUD uses compact chips; touch controls visible.
- **Phone portrait** (< 640 px wide): menus stack vertically, tabs become a
  scrollable bottom dock, grids drop to 3–4 columns, the player wall goes 5 wide.
- Safe-area insets (`env(safe-area-inset-*)`) pad every edge-anchored element.

---

## 2. Sound cues

UI calls `playCue(name)` (`packages/ui/src/audio-cues.ts`); the client wires it
to `@tumble/audio`. Hierarchical names: if the engine lacks `ui.stamp.qualified`
it should fall back to `ui.stamp` (`cueFallbacks()` helper provided).

| Cue                          | When                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ui.click`                   | any button press                                                                                       |
| `ui.hover`                   | focus/hover change on a button (throttled 60 ms)                                                       |
| `ui.confirm`                 | primary confirm (Play, Ready on, Equip, Purchase confirmed)                                            |
| `ui.back`                    | back / close / cancel                                                                                  |
| `ui.whoosh`                  | Tumble Wipe cover + reveal, panel slides                                                               |
| `ui.stamp`                   | any stamp impact (+ `.qualified`, `.eliminated`, `.roundOver`, `.go`, `.timeUp`, `.final`, `.victory`) |
| `ui.reward`                  | each XP line / currency tick-up chunk                                                                  |
| `ui.levelUp`                 | level-up burst                                                                                         |
| `ui.rarity.<tier>`           | unlock reveal (`common`…`mythic`)                                                                      |
| `ui.countdown.tick`          | 3, 2, 1                                                                                                |
| `ui.countdown.go`            | GO!                                                                                                    |
| `ui.error`                   | error dialog, failed purchase, invalid code                                                            |
| **extra** `ui.tab`           | menu tab change                                                                                        |
| **extra** `ui.toggle`        | switch/checkbox                                                                                        |
| **extra** `ui.slider`        | slider step (throttled 50 ms)                                                                          |
| **extra** `ui.toast`         | toast arrives                                                                                          |
| **extra** `ui.matchFound`    | match found burst                                                                                      |
| **extra** `ui.purchase`      | purchase success (coins pour)                                                                          |
| **extra** `ui.claim`         | claim pass tier / challenge                                                                            |
| **extra** `ui.confetti`      | confetti burst                                                                                         |
| **extra** `ui.wall.flash`    | eliminated cells flash                                                                                 |
| **extra** `ui.wall.trapdoor` | trapdoor opens (per batch, not per cell)                                                               |
| **extra** `ui.wall.fall`     | Tumblers falling whistle (per batch)                                                                   |
| **extra** `ui.wall.aww`      | crowd "aww"                                                                                            |
| **extra** `ui.wall.counter`  | remaining counter ticks down                                                                           |
| **extra** `ui.wall.shake`    | wall rumble before the winner reveal                                                                   |
| **extra** `ui.wall.crown`    | crown lands                                                                                            |
| **extra** `ui.fireworks`     | fireworks pop                                                                                          |
| **extra** `ui.joinTick`      | pre-show player joined (throttled 150 ms)                                                              |
| **extra** `ui.typeOn`        | title cards letter pops (throttled)                                                                    |

Music (`playMusic(track)` hook): `music.menu`, `music.matchmaking`,
`music.preshow`, `music.intro`, `music.results`, `music.final`, `music.victory`,
`music.wall`, `music.rewards`, `music.none` (stop/duck). The splash plays
`music.sting` once.

---

## 3. First launch

### 3.1 Boot loader — `boot`

- **Purpose**: show real byte progress while WASM/GPU/assets load (the static
  `#boot` div in `index.html` covers the first paint; this React version takes
  over as soon as the bundle runs, visually identical).
- **Layout**: centred hopping CSS Tumbler (squash/stretch 700 ms loop), progress
  pill (22em wide, lemon fill with moving candy-stripe), label below, tiny
  version string bottom-right. Background: sky → blush vertical gradient with
  drifting cloud blobs.
- **Copy** (rotates with progress): "Inflating Tumblers…", "Waxing the slides…",
  "Teaching physics to behave…", "Polishing the Crown…", "Almost tumbling…".
- **States**: loading (0–100%), error (`setBoot({error})` → wobbling sad Tumbler +
  "Something got stuck in the chute" + Retry).
- **Motion**: progress fill uses a 200 ms spring; at 100% the Tumbler does a
  big jump and the loader exits via Tumble Wipe to `splash`.
- **3D**: not yet initialised. **Nav**: none (Retry focusable on error).

### 3.2 Click-to-start splash — `splash`

- **Purpose**: unlock audio (user gesture) and land the brand.
- **Layout**: giant **TUMBLE ROYALE** logo (two stacked sticker words, each
  letter a separately-bouncing glyph), crown perched on the "O", subtitle chip
  "40 Tumblers. 1 Crown. Zero dignity.", pulsing "CLICK / TAP / PRESS ANY BUTTON
  TO START" pill at the bottom third. Footer: build, legal, "Original game —
  every Tumbler is hand-squished".
- **Motion**: letters drop in from -120% with `gravity`, land with `squash`,
  staggered 55 ms (T-U-M-B-L-E then R-O-Y-A-L-E); crown spins in last and lands
  with a 6° wobble. Prompt pill breathes (scale 1 ↔ 1.06, 1.4 s). On press:
  cue `music.sting` + `ui.confirm`, logo squashes, confetti puff, wipe out.
- **3D**: the menu sky renders; camera drifts slowly around floating islands.
- **Nav**: any key / click / gamepad button → `onStart`.

### 3.3 Welcome — name + colour — `welcome`

- **Purpose**: guest account creation in < 10 s.
- **Layout (desktop)**: left = big live CSS/3D Tumbler preview bouncing on a
  plinth; right = sticker panel "WHO'S TUMBLING?" with:
  name field (3–16 chars, placeholder is a random generated name, 🎲 reroll
  button), "Pick your colour" swatch grid (12 candy colours in 2 rows, chosen one
  pops out with a ring), pattern quick row (Plain / Stripes / Dots / Checker),
  big **LET'S GO!** button. Small print: "You're a guest — link an account later
  to keep your stuff safe."
- **Mobile**: preview on top (40% height), panel below as bottom sheet.
- **States**: idle · invalid name (field shakes, `ui.error`, helper text
  "Letters, numbers and spaces only — keep it friendly!") · submitting (button
  shows spinning gumball).
- **Motion**: panel springs in from right; each swatch pops on select
  (`squash`); preview Tumbler hops when colour changes.
- **3D**: when the 3D lobby exists it renders the Tumbler with `onTryOn`-style
  colour updates (`colorChange` intent); the DOM preview hides if `use3DPreview`.
- **Nav**: name → reroll → swatches (grid nav) → patterns → LET'S GO. Enter submits.
- **Intent**: `welcomeDone({ name, primary, pattern })`.

### 3.4 Tutorial prompt — `tutorialPrompt`

- **Layout**: centred card with a coach Tumbler (whistle + cap) leaning in from
  the left edge: "Fancy a 2-minute warm-up on Practice Island?" Two buttons:
  **TEACH ME!** (primary) and **I'll wing it** (secondary). Checkbox "Don't ask
  again".
- **Motion**: card drops from top with `gravity` and bounces; coach slides in
  with 200 ms delay and waves.
- **Intent**: `tutorialChoice({ accept })`.

---

## 4. Main menu — `menu`

### 4.1 Layout

```
┌ TopBar ────────────────────────────────────────────────────────────────┐
│ [Lv 12 ███▒▒ XP]   [Tabs: PLAY LOCKER STORE PASS CHALLENGES PROFILE    │
│                     LEADERBOARDS NEWS]      [●Gumballs][◆Gems][🔔][👥][⚙]│
├────────────────────────────────────────────────────────────────────────┤
│                         (3D lobby visible here)                         │
│   [Tab content panel — left or right aligned, never covers the Tumbler]│
├ BottomBar ─────────────────────────────────────────────────────────────┤
│ [Party slots ◯◯◯◯ + invite]     [Playlist ▾ Main Show]   [  PLAY  ]   │
│                                  [Ready ✓]                              │
└────────────────────────────────────────────────────────────────────────┘
```

- **TopBar**: level badge (gumdrop with number) + XP bar; tab strip (active tab
  is a raised lemon sticker, others flat cream); currency pills (Gumball icon /
  Gem icon, count with thousands separators, `+` button opens Store); bell with
  red count dot; friends icon with online count; gear.
- **BottomBar** (Play tab only): party slots (4 circles: you + 3; empty ones
  show `+` and open the friends panel), playlist selector card (name, art
  gradient, player count, "Ends in 3d" chip for events; ◀ ▶ arrows cycle),
  **PLAY** button — 2× size bubblegum sticker, wiggles every 6 s idle; when in a
  party as non-leader it becomes **READY** (toggle; green tick when ready).
- **Mobile portrait**: tabs become a bottom dock with icons; PLAY is a full-width
  pill above the dock; currencies collapse into one pill.

### 4.2 Tabs (`menuTab`) and what the 3D lobby does

| Tab            | Panel                                                            | 3D layer (`menuTab` intent)                            |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `play`         | playlist info card + "Today's challenges" mini list, News ticker | your Tumbler + party on floating platform, idle emotes |
| `locker`       | §5.1                                                             | camera dollies to turntable close-up                   |
| `store`        | §5.2                                                             | Tumbler wears hovered item                             |
| `pass`         | §5.3                                                             | Tumbler wears the tier reward focused                  |
| `challenges`   | §5.4                                                             | wide shot, Tumbler does stretches                      |
| `profile`      | §5.5                                                             | Tumbler strikes victory pose                           |
| `leaderboards` | §5.6                                                             | camera pans to trophy island                           |
| `news`         | §5.7                                                             | wide shot                                              |

- **Motion**: menu enter — TopBar drops from -100% (spring, 0 ms), BottomBar
  rises (spring, 80 ms), tab content springs in (160 ms), PLAY button does a
  `squash` at 500 ms. Tab change: old panel exits sideways in the direction of
  travel (200 ms `backIn`), new panel springs in from the opposite side; active
  tab sticker slides under the labels (FLIP, 320 ms `backOut`); cue `ui.tab`.
- **Nav**: Q/E/LB/RB cycle tabs; down-arrow from tabs enters panel; PLAY is the
  autofocus on the Play tab.
- **Intents**: `menuTab`, `selectPlaylist`, `play`, `ready`, `openOverlay`.

---

## 5. Meta screens (menu tabs)

### 5.1 Locker

- **Layout**: left rail of slot tabs (Colours, Pattern, Face, Upper, Lower,
  Headwear, Back, Emotes, Celebration, Victory, Nameplate, Banner, Trail,
  Footsteps); top filter row (rarity chips, owned-only toggle, search field with
  🔎); item grid (5 cols desktop, 3 mobile) of rarity-framed cards (icon/gradient,
  name, rarity band, ✓ equipped badge, 🔒 if unowned with price); right column:
  loadout chips (1–6), **Randomize**, **Equip** / **Try on**, item detail.
- **Colour/pattern editor** (Colours/Pattern slots): three swatch rows
  (primary/secondary/tertiary, 18 swatches + custom hue slider), pattern tiles
  rendered live with the selected colours.
- **States**: empty search ("No matches. Try 'cone' or 'disco'"), unowned item
  (Try on enabled, Equip replaced by "Get in Store").
- **Motion**: grid items pop in staggered; equip → card `squash` + mint tick
  stamps on (`ui.confirm`); try-on updates 3D instantly.
- **Intents**: `tryOn`, `equip`, `selectLoadout`, `customizeColors`, `randomizeOutfit`.

### 5.2 Store

- **Layout**: featured carousel (big hero cards, 3 visible desktop / 1 mobile,
  auto-advance 6 s, dots), "Daily Picks" grid with a rotation countdown chip
  ("New picks in 05:12:33"), bundles row. Cards show rarity frame, art, name,
  price pill (Gumball or Gem icon), "OWNED" ribbon.
- **Item modal**: large preview, description, rarity, set, price, **Buy** /
  **Try on**. **Purchase confirm** dialog: "Spend ◆ 800 on Disco Visor?" →
  Confirm / Cancel; success = coins pour into the item, `ui.purchase`, toast.
  Insufficient funds: button disabled with "Need 120 more ●".
- **Intents**: `purchase({ offerId })`, `tryOn`.

### 5.3 Season Pass

- **Layout**: header ("SEASON 1: SUGAR RUSH", days left, tier `23/100`, progress
  bar to next tier); horizontal scrolling **tier track**: each tier a column
  with a free reward card (top) and premium reward card (bottom, grape frame,
  🔒 if not premium); current tier marker is a Tumbler pin; claimable tiers
  bounce with a lemon glow. Premium CTA "Unlock Premium ◆ 950".
- **Motion**: on open, the track auto-scrolls (spring) to the current tier;
  claim → card flips (rotateY 180°, 420 ms) revealing the item, rarity cue.
- **Nav**: left/right scroll tiers, up/down switch free/premium row.
- **Intents**: `claimPassTier({ tier, track })`, `buyPremiumPass`.

### 5.4 Challenges

- **Layout**: two columns: DAILY (3, refresh timer) and WEEKLY (6, refresh
  timer). Each card: icon, title ("Qualify from 3 races"), progress bar
  `2/3`, reward (XP / Gumballs / pass stars), **Reroll** (one per day) and
  **Claim** when done.
- **Motion**: completed cards wobble and glow; claim → card slides out and a
  new one drops in.
- **Intents**: `rerollChallenge(id)`, `claimChallenge(id)`.

### 5.5 Profile card

Banner + nameplate + `name#tag`, level, rank emblem, stat tiles (Crowns, Shows,
Final appearances, Rounds qualified, Win %, Best streak), favourite round,
showcase of 3 items, "Match history" button → `matchHistory` screen (last 20
shows: date, playlist, rounds reached chips, result, XP).

### 5.6 Leaderboards

Tabs: Crowns · Ranked · Wins this week · Friends. Table with rank, avatar, name,
value; top 3 have gold/silver/bronze sticker medals. **Your row is pinned** at
the bottom (or highlighted in place if visible). Intent `leaderboardQuery(board)`.

### 5.7 News

Card list: season banner, event ("Goo Weekend — double XP"), patch notes.
Cards tilt alternately ±1.5°.

### 5.8 Friends / party panel (overlay `friends`)

Right-side sheet: invite link box (`tumble.gg/join/AB12CD` + Copy → "Copied!"
chip), party list with ready states and kick (leader), friend search
(`name#tag`), sections Online / In a show / Offline / Recent players. Each row:
avatar, name, status, Invite button. Streamer mode masks the code (`••••••`
with a "Reveal" hold button). Intents: `inviteFriend`, `copyInvite`,
`kickPartyMember`, `leaveParty`, `addFriend`.

### 5.9 Custom lobby — `customLobby`

Two tabs: **Create** (round picker checklist grouped by type, bots on/off,
max players slider, round timer multiplier, spectators allowed, private) and
**Join** (6-character code input with big chunky monospace cells; invalid →
shake + `ui.error`). Created lobby shows the code huge with copy, player list,
host Start button. Intents: `createCustom(opts)`, `joinCode(code)`.

### 5.10 Settings (overlay `settings`)

Full-height sheet with section tabs: **Graphics** (preset Auto/Low/Med/High/
Ultra, resolution scale, FPS cap, shadows, post FX, show FPS), **Controls**
(mouse sensitivity, invert Y, toggle grab, vibration, touch layout & button
size, **rebinding table**: action | primary | secondary; click a cell → "Press a
key…" capture state with 5 s timeout, Escape cancels, conflicts swap with a
warning toast; Reset to defaults), **Audio** (master, music, SFX, UI,
announcer, mute when unfocused), **Accessibility** (colour-blind mode with live
swatch preview, Reduce Motion, Reduce Flashing, Reduce Camera Shake, Captions,
UI Scale 80–140%, High-contrast HUD), **Gameplay** (nameplates, Streamer Mode,
show ping, auto-spectate, chat filter, region), **Account** (name, linked
providers, sign out, delete account → confirm dialog).
Every change applies live and emits `settingsChange`.

---

## 6. Matchmaking — `matchmaking`

- **Layout**: bottom-centre card replaces BottomBar: spinning gumball machine
  icon, "FINDING TUMBLERS…", counter `27 / 40` (each tick pops), elapsed timer,
  "ETA ~0:20", region chip, **CANCEL** (Escape/B). Above it a rotating tips
  carousel ("Dive mid-jump to cover more ground!"). The rest of the menu stays
  visible but dimmed 30% (tabs disabled).
- **Motion**: card rises with spring; counter digits roll; tip cards slide
  every 5 s.
- **3D**: lobby Tumbler sits in a waiting pose, looking at a watch.
- **Cues**: `music.matchmaking` crossfade.
- **Intents**: `cancelQueue`.

## 7. Match found — `matchFound`

- **Burst** (1.4 s): screen flash (disabled with Reduce Flashing), radial
  candy-ray sunburst spins in, "SHOW FOUND!" stamp slams, 40 tiny Tumbler dots
  rain into a funnel; cue `ui.matchFound`. Then Tumble Wipe → `preShow`
  (the game swaps to the pre-show platform scene while covered).

## 8. Pre-show lobby — `preShow`

- **Layout**: top-centre sticker "MAIN SHOW · 5 ROUNDS" with the show logo;
  big countdown ring top-right ("Starting in 0:18"); left ticker of joins
  ("Wobbleton joined!" chips sliding up, max 6 visible); bottom-centre player
  count `32 / 40` with a filling bar; controls hint ("WASD move · Space jump ·
  1–4 emote"). Players move freely in 3D.
- **Motion**: join chips slide up with spring; at 5 s left the ring turns
  tangerine and pulses; at 0 the ring pops and wipe.
- **Cues**: `music.preshow`, `ui.joinTick`, last 5 s `ui.countdown.tick`.

## 9. Round flow

### 9.1 Show intro card — `showIntro` (round 1 only, 2.2 s)

Candy sunburst background, "THE SHOW BEGINS!" header, then a row of round
gumdrops (●○○○○) with the first one bouncing: "ROUND 1 OF 5". Later rounds skip
this and use the between-rounds tease.

### 9.2 Round loading — `roundLoading`

The Tumble Wipe **holds** (game calls `setScreen('roundLoading', {transition:'wipe'})`
then `releaseWipe()` / next `setScreen`). On top: round type badge, "Loading
Gumdrop Gauntlet…", tip, spinning-gumball progress. Minimum display 600 ms.

### 9.3 Flyover title card — `roundIntro`

- **3D**: authored flyover spline runs the whole time.
- **Layout**: lower-left giant title card: type badge (RACE / SURVIVAL / TEAM /
  HUNT / LOGIC / FINAL, each with own colour+icon), round name in display font,
  objective line ("Reach the finish line!"), qualify chip ("26 of 40 qualify"),
  round gumdrops ●●○○○. Bottom-right tips carousel.
- **Motion**: badge slams first (0 ms), title letters type-on with pop
  (30 ms/letter, cap 700 ms), objective slides (600 ms), chips pop (750 ms).
  Exit: everything slides left with `backIn` at the end.

### 9.4 Rules card — `rules`

Centred card with 3 pictogram steps (e.g. 🏁 "Reach the finish", ⚠ "Dodge the
hammers", 👑 "First 26 qualify") — each a sticker that flips in 120 ms apart —
and "Get ready…" footer. 3D: cameras settle behind the Tumbler at the start gate.

### 9.5 Countdown — `round` + `countdown`

HUD visible but dim (60%). Giant numerals 3 · 2 · 1 in lemon/tangerine/
bubblegum, each: scale 0 → 1.25 → 1 (300 ms spring), hold, shrink + fade
(final 200 ms); cue `ui.countdown.tick`. **GO!** is a Stamp Slam with confetti
ring, cue `ui.countdown.go`, HUD brightens to 100%.

### 9.6 In-round HUD — `round`

```
 [⏱ 1:42]                [QUALIFIED 12 / 26]                  [ping 48 · 60fps]
 [Objective chip: Reach the finish!]
 [Feed: "Sprinkles qualified!" ...]                             [Team scores]
 [Race progress bar: ●leaders  ◆you  ...  🏁]
                         [Spectating banner (if spectating)]
 [Controls hint]                                                 [Emote ◎]
 (mobile: joystick bottom-left, Jump/Dive/Grab bottom-right, emote top-right)
```

- **Timer**: pill top-left, `m:ss`; < 30 s tangerine, < 10 s bubblegum with a
  per-second pulse (and `ui.countdown.tick` at 5..1).
- **Qualified counter**: top-centre sticker "QUALIFIED 12 / 26"; each increment
  pops the number; full → turns mint. For survival it reads "ALIVE 18" and for
  hunt/team it's replaced by team scores.
- **Objective chip** under the timer, collapses to icon after 8 s.
- **Race progress bar**: track with finish flag; leader markers (top 3 in
  their colours), your marker a larger bouncing diamond with your colour.
- **Team scores**: up to 4 team pills (colour, score); your team outlined; the
  lead team has a crown icon. Score change pops.
- **Emote wheel**: hold-to-open radial (4 or 8 slots), pointer angle selects,
  release emits `emote(slot)`; also quick pings (Go here / Watch out / Nice!).
- **Toasts / feed**: left-side short feed ("Gloop fell off!", "Team Pink
  scored!"), max 4, 3.5 s each.
- **Ping/FPS**: tiny top-right, coloured by quality; hidden unless setting on.
- **Controls hint**: bottom-left, fades after 10 s or first input; gamepad
  glyphs if last input was a pad.
- **Mobile**: `TouchControls` — joystick (left 40% of screen, floating origin),
  buttons Jump (big), Dive, Grab (hold), Emote; emits `touchInput`.
- **Overtime**: timer becomes "OVERTIME!" flashing (steady with Reduce Flashing).

### 9.7 QUALIFIED! stamp

Mint sticker stamp with sparkles, confetti burst from the stamp, cue
`ui.stamp.qualified`. 3D: orbit cam around the Tumbler celebrating. After 2.5 s
the spectating banner appears automatically (if `autoSpectate`).

### 9.8 ELIMINATED stamp + choice sheet

Bubblegum stamp slams **crooked** (rotate -12°), then one letter ("I") falls off
with gravity and bounces off-screen; stamp wobbles (`wobble`), cue
`ui.stamp.eliminated` + `ui.wall.aww`. Consolation line underneath picked at
random: "Gravity: 1, You: 0", "That was a strategic nap.", "Tumbled with
style.", "The floor was very welcoming.". After 1.6 s the **choice sheet** rises
from the bottom: **SPECTATE** · **BACK TO LOBBY** · **PLAY AGAIN** (play again =
leave and queue). XP-so-far chip on the sheet.
Intents: `spectate`, `backToLobby`, `playAgain`.

### 9.9 Spectating banner

Bottom-centre bar: ◀ Q · player card (avatar, name, place/score, "Qualified ✓"
chip) · E ▶; "SPECTATING" label; mobile has tap arrows. Card swaps with a
horizontal flip on change. Intents: `spectateNext(±1)`.

### 9.10 ROUND OVER stamp

When the round ends: 1.5 s slow-mo in 3D, then cream "ROUND OVER!" stamp with
whistle cue `ui.stamp.roundOver`; or "TIME'S UP!" for timed rounds.

### 9.11 Round results — `roundResults`

- **Layout**: header "GUMDROP GAUNTLET — RESULTS"; grid of portraits (all
  round participants, 8 per row desktop / 5 mobile), each a card with avatar and
  name. Your card has a lemon ring and a "YOU" tag.
- **Motion**: cards enter face-down (rotateY 180°) in a wave; then flip in
  finishing order (40 ms each, cap 1.6 s) to **qualified** (mint frame + ✓) or
  **eliminated** (grey, dimmed, ✗, slight droop rotate 4°). Your card flips last
  with a pause + stamp. Summary chips: "26 QUALIFIED · 14 ELIMINATED".
- **3D**: blurred podium scene or the level from above.

### 9.12 Between rounds — `betweenRounds`

"PLAYERS REMAINING" with a huge rolling counter `40 → 26`, round progress
gumdrops filling, then **NEXT UP** tease card: type badge + "???" silhouette
which shakes then reveals the round name. Cue `ui.reward` per counter tick,
`ui.stamp` on reveal. Then wipe → `roundLoading`.

### 9.13 FINAL ROUND hype — `finalHype`

Gold sunburst, "FINAL ROUND!" stamp (cue `ui.stamp.final`), "7 Tumblers. 1
Crown." subtitle, the 7 finalist avatars slide in as a lineup with names.
`music.final`.

### 9.14 Victory — `victory` (you won)

Crown descends onto your avatar (gravity + squash), "YOU WON THE CROWN!"
stamp, crown counter "Crowns: 4 → 5" rolls, fireworks + confetti loops,
buttons: **PHOTO MODE** (`photoMode` intent), **CONTINUE**. `music.victory`.

### 9.15 Winner cam — `winnerCam` (someone else won)

3D follows the winner's celebration. Overlay: "WINNER!" banner with the
winner's player card, "GG!" quick emote buttons, **CONTINUE**.

---

## 10. THE PLAYER WALL — `playerWall`

### 10.1 Concept

After the final, every participant of the show appears in a giant stadium
wall of cubbies — a framed portrait of each Tumbler in its own little box with a
nameplate. The show is **replayed round by round**: the Tumblers eliminated in
each round have their trapdoors pop open and they tumble out of the wall,
comedically, until only the winner remains, glowing, crowned, under fireworks.
It's the emotional and comedic summary of the whole show — and the best
screenshot moment in the game.

### 10.2 Layout

- **Grid**: `cols × rows` chosen by `wallGrid()` to maximise cell size for the
  player count and viewport (40 → 10×4 at 16:9, 8×5 at 4:3, 6×7 on a portrait
  phone; 20 → 5×4; 60 → 10×6). Cells are
  square-ish (aspect .82), gap 0.5em, inside a chunky stadium frame (grape
  frame with lemon bulbs that chase-light around the border). Cells are
  ordered by **lobby join order** (not by result) so each round's drop pattern
  looks scattered and lively; the winner's cell stays where it is and becomes
  the focal point at the end.
- **Cell**: cream cubby with inner shadow (depth), tiny spotlight from top,
  avatar standing on a **trapdoor floor** (striped hazard plate), nameplate
  below (name truncated, party-mates have a 👥 pip, local player a lemon frame +
  "YOU" tab). Streamer mode replaces other names with "Tumbler 17".
- **Overlay**: top banner "ROUND 2 — CONVEYOR CHAOS" (round type colour);
  top-right **remaining counter** "40 → 26 → 14 → 7 → 1" where the current value
  is huge and past values shrink into a breadcrumb; bottom-right **SKIP ▸▸**
  (hold 0.6 s on gamepad/keyboard Space, click on mouse); bottom-left show
  name chip.

### 10.3 Timeline (default; `playerWallTimeline()` returns these numbers)

| t (ms)       | Event (`PlayerWallEvent.type`) | Visual                                                                                                                                                                                                              | Cue                              |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0            | `wallStart`                    | Wall frame rises from below (spring 700 ms), title "THE TUMBLE WALL"                                                                                                                                                | `music.wall`, `ui.whoosh`        |
| 300–1500     | `cellsIn`                      | cells pop in row by row (row stagger 90 ms, cell 25 ms), avatars blink                                                                                                                                              | `ui.typeOn`                      |
| 1900         | `roundBanner` r=0              | banner slams: "ROUND 1 — GUMDROP GAUNTLET" + type badge                                                                                                                                                             | `ui.stamp`                       |
| +650         | `cellFlash`                    | eliminated cells flash bubblegum 3× (240 ms period; steady tint w/ Reduce Flashing), avatars switch to scared face                                                                                                  | `ui.wall.flash`                  |
| +1450        | `trapdoorOpen`                 | each cell's floor swings down (rotateX 0→-100°, 260 ms backIn, hinge at back) staggered `min(70, 1400/n)` ms in a random-but-seeded order                                                                           | `ui.wall.trapdoor`               |
| +60 per cell | `cellDrop` per player          | avatar hop (−8% 120 ms) then falls: translateY → 120vh with `gravity` 1100 ms, rotate ±(200–560)°, x drift ±30%, a poof of 3 balloons rises from the cubby, 30% chance of an "aww" / "noooo" / "bye!" speech bubble | `ui.wall.fall` (batched)         |
| +700         | `counter`                      | remaining counter rolls 40 → 26                                                                                                                                                                                     | `ui.wall.counter`, `ui.wall.aww` |
| +600         | `roundEnd`                     | empty cubbies dim to 35%, show a ✗ sticker; next round begins                                                                                                                                                       | —                                |
| …            | repeat for each round          | per-round block ≈ 3.4 s + stagger                                                                                                                                                                                   |                                  |
| final        | `winnerFocus`                  | banner "AND THE CROWN GOES TO…", all empties fade to 15%, wall shakes (6 px, 500 ms; off with Reduce Motion)                                                                                                        | `ui.wall.shake`                  |
| +900         | `crownDrop`                    | crown falls from top of screen onto the winner's cell (gravity 700 ms, squash on land), cell scales 1.35× and glows lemon, rays spin behind                                                                         | `ui.wall.crown`                  |
| +700         | `winnerReveal`                 | name plate grows: "SPRINKLES WINS!", fireworks ×3 + confetti, counter shows "1" in gold                                                                                                                             | `ui.fireworks`, `ui.confetti`    |
| +3200        | `wallEnd`                      | CONTINUE button springs in; auto-advance after 6 s to `rewards`                                                                                                                                                     | —                                |

Total ≈ 2 s intro + rounds × 3.4 s + 4.8 s finale ≈ **20 s for a 5-round show**.
**Skip** jumps every cell to its final state, fires `skip` then `wallEnd`.

### 10.4 Sync with the 3D wall

`render/scenes/playerWall` (world-art team) may render the real wall. The DOM
wall is a complete fallback. Integration:

1. Game calls `setPlayerWall(summary, { render3D: true })` → the DOM hides its
   cells (overlay only: banners, counter, skip, nameplates optional).
2. The UI runs the single authoritative timeline and emits every
   `PlayerWallEvent` via `playerWallEvent` intent: `{ type, t, roundIndex?,
playerIds?, playerId?, delayMs? }`.
3. The 3D scene subscribes and animates its cells (drop with real ragdolls!).
   `playerWallTimeline(summary)` is exported and pure, so the 3D scene can
   pre-compute the same schedule (e.g. for camera moves) without the UI.
4. Skip is driven by the UI (`skipPlayerWall` intent + a `skip` wall event).

### 10.5 Comedy details

- Faces: idle (blink every 2–4 s random), scared (O-mouth) during flash,
  dizzy spiral eyes while falling, the winner's grin.
- Some fallers grab the edge for 300 ms before dropping (10% chance, seeded).
- Party members of the local player drop with a 👥 heart that pops.
- The local player's own drop gets a tiny zoom (cell scales 1.15) and a
  "THAT'S YOU!" tag.

### 10.6 Mobile

Portrait: the solver picks ~6 columns, banner wraps to 2 lines, counter beneath the banner, skip
is a pill at the bottom-centre above the safe-area.

---

## 11. Rewards — `rewards`

- **Layout**: left column "SHOW REWARDS" with XP lines; right column level badge
  - XP bar, pass progress, unlocks; bottom buttons **PLAY AGAIN** (primary) and
    **BACK TO LOBBY**.
- **Choreography**:
  1. Lines appear one by one (300 ms apart): "Rounds survived ×3 +450",
     "Qualified in Gumdrop Gauntlet +100", "Crown! +1000", "First show of the
     day +200"; each count-up 400 ms, cue `ui.reward`.
  2. Total XP flies into the level bar (a stream of 8 gumdrop particles), bar
     fills with `springSoft`; on overflow: **LEVEL UP** burst (badge scales 1.6 →
     1 with rays, confetti, cue `ui.levelUp`) and the bar resets and continues.
  3. Gumballs count up with coin cascade; pass tier stars fill
     ("Tier 23 → 24").
  4. **Unlock reveal** per item: a mystery capsule wobbles (600 ms), cracks,
     bursts in rarity colour (`ui.rarity.<tier>`; Legendary/Mythic adds rays
     and a 300 ms freeze), item card flips in.
  5. **Ranked** (if present): emblem with RP bar, "+24 RP" floating up; tier-up
     promotes with a stamp "PROMOTED: GOLD II".
- Skip: any key fast-forwards the current step; second press completes all.
- `music.rewards`.

---

## 12. System overlays

### 12.1 Reconnecting overlay

Full-screen frosted ink curtain (40% opacity), centred card with a Tumbler
running on a hamster wheel, "Reconnecting… (attempt 2 of 5)", progress dots,
**Leave** button. On success: card pops away + toast "Back in the show!". On
failure → error dialog.

### 12.2 Error / disconnect dialogs

Dialog with a dizzy Tumbler icon, title ("Connection lost"), message, code
chip (e.g. `E-NET-04`, copyable), buttons (Retry / Back to menu). Cue `ui.error`.

### 12.3 Confirm dialogs

Generic: title, body, confirm/cancel (danger variant for destructive actions).
Enter = confirm, Escape = cancel, focus starts on the _safe_ option.

### 12.4 Toasts

Top-right stack (max 3), each a sticker card with icon, title, body; slides in
from the right with spring, auto-dismiss (4 s default), swipe/close button,
progress underline. Kinds: `info`, `success`, `warning`, `error`, `reward`,
`social` (invite with Accept/Decline actions). In-round, toasts route to the
left feed (`variant: 'feed'`).

### 12.5 Notifications panel

Bell drop-down list: invites, friend requests, season news, unclaimed rewards.

---

## 13. Screen ids (store `ScreenId`)

`boot`, `splash`, `welcome`, `tutorialPrompt`, `menu`, `matchmaking`,
`matchFound`, `preShow`, `showIntro`, `roundLoading`, `roundIntro`, `rules`,
`round`, `roundResults`, `betweenRounds`, `finalHype`, `victory`, `winnerCam`,
`playerWall`, `rewards`, `customLobby`, `matchHistory`.

Sub-states are store fields, not screens: `menuTab`, `overlay`
(`settings|friends|notifications`), `countdown`, `stamps`, `hud.localStatus`,
`eliminatedSheet`, `spectate`, `dialog`, `connection`.

## 14. The full show flow (happy path)

```
boot ─wipe→ splash ─wipe→ welcome → tutorialPrompt ─wipe→ menu
menu(play) → matchmaking → matchFound ─wipe(cover: load preshow scene)→ preShow
preShow ─wipe→ showIntro → roundLoading(hold) ─release→ roundIntro → rules
→ round[countdown 3-2-1 GO] → round[playing] → stamp qualified|eliminated
→ stamp roundOver → roundResults → betweenRounds ─wipe→ roundLoading …
… (final) finalHype → roundLoading → roundIntro → rules → round
→ victory | winnerCam ─wipe→ playerWall → rewards → (playAgain → matchmaking) | menu
```

## 15. Timing table (auto-play preview uses these)

| Step               | Duration              |
| ------------------ | --------------------- |
| splash logo settle | 1.6 s                 |
| matchmaking (mock) | 4–6 s                 |
| match found burst  | 1.4 s                 |
| pre-show           | 6 s (mock; real 25 s) |
| show intro         | 2.2 s                 |
| round loading      | 1.2 s                 |
| flyover card       | 4 s                   |
| rules              | 2.6 s                 |
| countdown          | 4 s                   |
| round (mock)       | 12–16 s               |
| stamps             | 1.8 s each            |
| results            | 4.5 s                 |
| between rounds     | 3.6 s                 |
| final hype         | 3 s                   |
| victory            | 5 s                   |
| player wall        | ~20 s                 |
| rewards            | ~8 s                  |

## 16. Copy voice

Short, warm, silly, never mean. Exclamation marks are earned. Use the words
_Tumbler_, _show_, _the Crown_, _Gumballs_, _Gems_. Never use names from other
games. Random funny bot names are generated from candy/wobble syllables
(`Sir Wobbleton`, `Gloopy McFlop`, `Sprinkle Bandit`, …).

## 17. Accessibility matrix

| Setting                                           | Effect                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Colour-blind (protanopia/deuteranopia/tritanopia) | swaps good/bad/warn + team colours; qualified/eliminated also differ by icon (✓/✗) and pattern |
| Reduce Motion                                     | no springs/rotation/parallax/shake; wipes cross-fade; falls short fade                         |
| Reduce Flashing                                   | no flashes/strobes; confetti × 0.4; stamps don't flash                                         |
| UI Scale 80–140%                                  | root font-size multiplier (all `em`)                                                           |
| High-contrast HUD                                 | HUD chips gain solid ink backgrounds                                                           |
| Captions                                          | announcer lines appear as caption chips (bottom-centre)                                        |
| Streamer Mode                                     | hides other players' names (→ "Tumbler N"), party/lobby codes masked                           |
