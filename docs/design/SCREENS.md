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
     ├─ ScreenLayer      current screen (interactive panels pointer-events:auto)
     ├─ HudLayer         only during the round screen
     ├─ ShowChatLayer    chat feed
     ├─ StampLayer       stamp queue
     ├─ ConfettiLayer    one shared canvas
     │   (everything above is hidden, not unmounted, in photo mode)
     ├─ WatchChoiceLayer keep watching / leave after elimination
     ├─ ToastLayer       top-right cards + left feed
     ├─ ReplayLayer      replay viewer
     ├─ ShareLayer       share sheet (card / clip, progress, preview)
     ├─ OverlayLayer     settings, friends, notifications, privateShow, joinCode, inGameMenu
     │   (PhotoModeBar replaces it in photo mode)
     ├─ SocialLayer      player actions, report dialog
     ├─ DialogLayer      confirm / error / purchase dialogs
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
- **Gamepad**: `apps/client/src/input/gamepadNav.ts` calls
  `ui.getState().navigate(dir)` with
  `up|down|left|right|accept|back|tabPrev|tabNext`; the spatial focus system
  is `packages/ui/src/nav/` (`data-nav`, `data-nav-scope`, `data-nav-back`).
  D-pad/stick move, LB/RB = tabs, A = accept, B = back, Start = settings.
  In rounds Start opens the in-game menu instead, and LB/RB cycle the
  spectated player. Held directions repeat after ~380 ms, then every ~110 ms.
  While a menu owns the pad its buttons press nothing in the round. Prompts
  switch to pad glyphs (Ⓐ, RT, Start…) once a controller is the last device.
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
  "100 Tumblers. 1 Crown. Zero dignity.", pulsing "CLICK / TAP / PRESS ANY BUTTON
  TO START" pill at the bottom third. Footer: build, legal, "Original game —
  every Tumbler is hand-squished".
- **Motion**: letters drop in from -120% with `gravity`, land with `squash`,
  staggered 55 ms (T-U-M-B-L-E then R-O-Y-A-L-E); crown spins in last and lands
  with a 6° wobble. Prompt pill breathes (scale 1 ↔ 1.06, 1.4 s). On press:
  cue `music.sting` + `ui.confirm`, logo squashes, confetti puff, wipe out.
- **3D**: the menu sky renders; camera drifts slowly around floating islands.
- **Nav**: any key / click / gamepad button → `onStart`.

### 3.3 Welcome — name + skin — `welcome`

- **Purpose**: guest account creation in < 10 s.
- **Layout**: the 3D Tumbler on the left; a panel with a **required** name
  field (🎲 rolls a random name), the full skin editor (`ColorEditor`: body,
  pattern and face colours plus the pattern grid) and **Let's go!**, which
  stays disabled until there is a name ("Pick a name first — or roll the dice
  for one.").
- **Sign in to an existing Tumbler**: ghost button that expands to one button
  per provider the server offers (email opens a magic-link form). Hidden when
  the server offers no sign-in.
- **Intents**: `previewColors` on every edit, `welcomeDone { name, colors }`,
  `accountAction 'signIn-<provider>'`.

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
┌ TopBar ───────────────────────────────────────────────────────────────────┐
│ [LV 12 ▓▓▓▒▒ 300/900 XP]  [Q PLAY LOCKER STORE PASS CHALLENGES PROFILE    │
│                              RANKS NEWS E]      [● 4,250 +][◆ 0 +][bell][friends][gear]
├───────────────────────────────────────────────────────────────────────────┤
│ ┌ Season card ┐                                       ┌ Start card ──────┐│
│ │ Tier 23 ▓▓▒ │          (3D lobby: your Tumbler,     │[Online][Bots][Private]
│ └─────────────┘           party, candy stage)         │ ◀ Main Show · 40 ▶│
│ ┌ Challenges ─┐                                       │ ◯◯◯◯  [  PLAY  ] ││
│ └─────────────┘                                       └──────────────────┘│
│ ┌ News ───────┐                                                           │
│ [emote]                                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Rule: left side = info only, every start-a-game control lives in the
  start card (bottom-right).** Nothing covers the 3D Tumbler in the centre.
- **TopBar**: level badge + XP bar + "300 / 900 XP" (button → Profile);
  **text-only tab strip** (no emoji, no icons; claimable/unread tabs get a
  small pink dot; Q/E hints); currency pills = coin + amount + `+` only (the
  currency name is in the tooltip/aria label and inside the popovers, never as
  visible text in the bar); round sticker buttons for bell (unread
  notifications only; unread news dots the News tab instead), friends (online
  count) and settings.
- **Info cards (left)**: Season card (tier, progress, next marquee reward
  thumbnail, "N rewards to claim" glow) → Pass; Today's challenges (3 dailies
  with progress, "N ready to claim") → Challenges; latest/featured news post
  with its hero image → opens that post in the News reader.
- **Start card (right)**: mode tiles **Play Online** (live player counts, or
  "Servers offline" + Retry) · **Vs Bots** (always works) · **Private** (opens
  the `privateShow` dialog); playlist picker (Main Show, Duos, Squads, Chaos
  Mode; Ranked only when online); party row (you + 3, empty `+` invites, **Join
  with code**); **PLAY** with a sub-label ("Online · Main Show" / "Vs bots ·
  Duos"). Non-leader party members get **Ready up**. While queueing the same
  card becomes the matchmaking status (§6).
- **Mobile portrait**: tabs scroll horizontally under the bar; info cards
  become one swipeable row at the top; the start card spans the bottom.

### 4.2 Start flow

```
splash ─▶ menu (Play tab)
            ├─ Play Online ──(account + matchmaker reachable)──▶ matchmaking ─▶ matchFound ─▶ preShow ─▶ rounds
            │        └─(unreachable)── tile shows "Servers offline" + Retry; PLAY falls back to Vs Bots
            ├─ Vs Bots ──────────────────── straight to preShow (40 incl. bots, no matchmaking screen) ─▶ rounds
            └─ Private ─▶ privateShow dialog
                     ├─ Invite friends (needs servers) ─▶ private lobby (code, host controls) ─▶ Start show
                     ├─ Have a code? ─▶ joinCode dialog (needs servers)
                     └─ Play with bots (picked rounds, always works) ─▶ preShow ─▶ rounds
rounds ─▶ victory / winnerCam ─▶ playerWall ─▶ rewards ─▶ menu (Play again restarts the same mode)
```

The selected mode is `UIState.playMode`; reachability is `onlineStatus`
(published by the client). `play { playlistId, mode }` carries the mode;
`retryOnline` re-probes; `playCustomOffline { options }` starts a private
show against bots. New players play the First Show playlist for their first
shows (`docs/design/SHOWS.md`).

### 4.3 Tabs and the 3D lobby

| Tab                       | Panel                    | 3D layer                                                                                                          |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `play`                    | §4.1                     | 3/4 lobby framing; idle play on movement keys (3rd-person follow, eases back when idle)                           |
| `locker`, `store`, `pass` | dressing room (§5.1–5.3) | Tumbler eases (~400 ms) into the left 40% (top on phones); drag spins, wheel/pinch zooms; selection = live try-on |
| other tabs                | §5.4–5.7                 | lobby framing                                                                                                     |

- **Tab change**: the incoming panel slides/fades in (200 ms) while the old
  one fades out underneath — no wipe, never a blank frame.
- **Nav**: Q/E/LB/RB cycle tabs; Esc in a dressing room returns to Play.

### 4.4 Button map

Every clickable on the menu and where it goes. `apps/client/e2e/menu.spec.ts`
clicks each top-level control and asserts the destination.

| Control                         | Where             | Result                                                                                                                                                    |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs (8)                        | top bar           | `menuTab` = that tab; panel cross-fades in                                                                                                                |
| Q / E (LB / RB)                 | keyboard / pad    | previous / next tab                                                                                                                                       |
| Level badge + XP                | top bar           | Profile tab                                                                                                                                               |
| Gumballs `+` (or pill)          | top bar           | "Earn Gumballs" popover: shows, challenges, pass; buttons → Challenges, Season Pass, Store. Never a purchase                                              |
| Gems `+` (or pill)              | top bar           | Gems popover: what Gems are for + packs in a disabled "Coming soon — secure checkout via Stripe" state (live packs only when `gemCheckout === 'enabled'`) |
| Bell                            | top bar           | notifications drop-down (toggle)                                                                                                                          |
| Friends                         | top bar           | Party & friends sheet (toggle)                                                                                                                            |
| Gear                            | top bar           | Settings sheet (toggle); Esc/back on the root menu also opens it                                                                                          |
| Season card                     | Play, left        | **Season Pass** tab                                                                                                                                       |
| Today's challenges card ("All") | Play, left        | Challenges tab                                                                                                                                            |
| News card                       | Play, left        | News tab with that post open in the reader                                                                                                                |
| Play Online tile                | start card        | `playMode = 'online'`; when servers are offline: Retry (`retryOnline`)                                                                                    |
| Vs Bots tile                    | start card        | `playMode = 'offline'`                                                                                                                                    |
| Private tile                    | start card        | `privateShow` dialog                                                                                                                                      |
| Join with code                  | start card        | `joinCode` dialog                                                                                                                                         |
| ◀ / ▶ playlist                  | start card        | cycle playlists (`selectPlaylist`)                                                                                                                        |
| Party `+` slots                 | start card        | Party & friends sheet                                                                                                                                     |
| PLAY                            | start card        | `play { playlistId, mode }` → matchmaking (online) or pre-show vs bots                                                                                    |
| Ready up (party member)         | start card        | `ready` toggle                                                                                                                                            |
| Cancel                          | matchmaking card  | `cancelQueue`                                                                                                                                             |
| Emote button / B, 1–4           | Play, bottom-left | lobby emote wheel; plays owned emotes on the 3D Tumbler, locked → Store                                                                                   |
| Item card                       | Store / Locker    | live try-on (emotes play), docked detail; "Trying on" chip + Reset                                                                                        |
| Buy → Confirm                   | Store detail      | `purchase`; then "Equip now" (`equip`)                                                                                                                    |
| Find in Store                   | Locker detail     | Store tab                                                                                                                                                 |
| Reward card                     | Pass track        | select (3D try-on + preview card); claimable → `claimPassTier`                                                                                            |
| Claim all                       | Pass header       | claims every cleared, unclaimed reward                                                                                                                    |
| Unlock Premium                  | Pass header       | `buyPremiumPass` (disabled with "Gems coming soon" when unaffordable)                                                                                     |
| Milestone chips                 | Pass board        | scroll the track to that tier                                                                                                                             |
| Claim / Swap                    | Challenge card    | `claimChallenge` (confetti) / `rerollChallenge` (only when swaps left today)                                                                              |
| Season progress strip           | Challenges        | Season Pass tab                                                                                                                                           |
| Edit banner / Change nameplate  | Profile card      | Locker on that slot                                                                                                                                       |
| History row                     | Profile           | expands per-round results                                                                                                                                 |
| Leaderboard row / podium        | Ranks             | that player's profile card overlay (`inspectPlayer`)                                                                                                      |
| Board / scope chips             | Ranks             | `leaderboardQuery { board, scope }`                                                                                                                       |
| Post / featured                 | News              | reader view; `newsRead` clears the unread badges                                                                                                          |
| All news / Esc                  | News reader       | back to the list                                                                                                                                          |
| Eliminated choice               | show flow         | Keep watching (`spectate`, auto after a countdown) or Leave show (`leaveShow`)                                                                            |
| Results / Rewards               | show flow         | Watch replay (`replayOpen`), Share (§9.19), Back to lobby (`backToLobby`), Play again (`playAgain`, same mode), Continue (`continue`)                     |
| Open replay file                | Profile / History | `replayOpenFile` (a saved `.tumblereplay`)                                                                                                                |

---

## 5. Meta screens (menu tabs)

### 5.1 Locker (dressing room)

- **Layout**: stage (left 40% / top on phones) with the real 3D Tumbler,
  "Trying on: X" chip + Reset, drag-to-spin/scroll-to-zoom hint; shelf on the
  right: text slot chips (**Skin**, Face, Top, Bottoms, Hat, Back item, Emote,
  Celebration, Victory pose, Nameplate, Banner, Trail, Footsteps), loadouts,
  Randomize, rarity filter, owned-only, search, thumbnail grid; docked item
  detail (never a modal over the character) with Equip / Find in Store.
- **Skin** is a single tab with the full skin editor (colours and patterns);
  links to the old pattern slot open it.
- Leaving restores the equipped look. Intents: `tryOn`, `tryOnBundle`,
  `equip`, `selectLoadout`, `customizeColors`, `randomizeOutfit`,
  `dressingRoom`, `turntable`.

### 5.2 Store (dressing room)

- Same stage. Shelf: compact Featured row (rendered thumbnails, rarity band,
  price), rotation countdown, Daily picks grid. Selecting tries the item on
  (bundles try on every piece). Docked detail: Buy (purchase confirm) →
  "Equip now". Gumball items are fully purchasable; Gem items show the price
  and "Gems coming soon" when unaffordable.

### 5.3 Season Pass (dressing room)

- **Stage**: the 3D Tumbler wears/performs the selected reward (default: the
  next marquee reward); preview card under it with track + tier chip, rarity,
  slot, full name, description, and Claim / Equip / "Reach tier N".
- **Header**: season name, days left, big tier badge, progress bar + "% to
  tier N", **Claim all (n)**, Unlock Premium (Gems; "Gems coming soon").
- **Board**: milestone jump chips; full-height track with lane labels
  **FREE** / **TIER** / **PREMIUM**; tier numbers sit on one progress spine
  between the lanes ("You" marker on the next tier); every 10th tier is a big
  milestone card; claimable cards glow mint; claimed get a tick; premium
  shows a lock until bought. Names wrap (no truncation).
- **Input**: snap scrolling, mouse wheel scrolls sideways, arrow keys / d-pad.
- **Content**: 100 tiers, mostly real catalogue cosmetics (headwear, back,
  faces, patterns, colours, emotes, celebrations, victory poses, nameplates,
  banners, trails, footsteps); currency only as filler
  (`packages/content/src/progression/season-pass.ts`).

### 5.4 Challenges

- Daily login card (online): flame, "N-day streak", **Claim day N** (confetti;
  a stamp once claimed), the 7-day ladder with day 7 highlighted, and when the
  streak breaks or the next claim opens.
- Season-progress strip (tier, bar, upcoming reward thumbnails → Pass).
- Daily and Weekly sections: header with "New in 05:12:33", "N to claim" and
  "Swaps 1/1 today"; card grid. Each card: illustrated icon inside a chunky
  progress ring, title, big `2 / 3`, reward chip (coin icon + amount + name,
  bonus XP), and one state: in progress (labelled **Swap** when swaps are
  left), ready (glowing **Claim**), claimed (stamp). Claim bursts confetti
  from the card and pops it.
- Seasonal (online; "Ends in 40d 3h", expire with the season) and Milestones
  (online; "Permanent · 2/8 done") use the same cards; some pay a cosmetic.

### 5.5 Profile

- Left: player card (equipped banner with Edit, level badge, nameplate-styled
  `name#tag` with Change nameplate, XP bar, Crowns + Crown Shards bar, ranked
  badge or "Unranked"), showcase of the 3 rarest owned cosmetics.
- Centre: the 3D Tumbler.
- Right: stats from real history (shows, wins + win rate, finals, rounds
  qualified + rate, best win streak, favourite round, jumps/dives/grabs,
  best race times, recent form dots) and match history (last 20; expandable
  rows with round, type badge, placement, race time, qualified/out).
- The same card opens for other players (`ProfileOverlay`, `inspectPlayer`).
- Sections **Overview · Achievements · Collection** above the card. The other
  two keep the card and replace the centre and right with one wide panel:
  - Achievements: unlocked/total bar, category and locked/unlocked filters,
    cards with tier numeral, progress bar, rewards and unlock date. Hidden
    achievements read "???" with no progress or rewards until unlocked.
  - Collection: completion % and owned/total, slot, rarity and owned/missing
    filters, item grid, and a detail panel listing where the selected item
    comes from (shop, pass tier, achievement, challenge, event, Crown Shard
    shop, Practice Island). Works offline from local ownership.

### 5.6 Ranks

- Ranked ladder: Bronze → Silver → Gold → Platinum → Diamond → Champion →
  Crown League, divisions I–III, your tier highlighted with RP to promote,
  placement-shows note.
- Leaderboards: boards Crowns (season), Crowns (all time), Ranked, Win
  streak, This week; scopes Global / Region / Friends when online (API
  `/leaderboards/:type`). Offline: **Hall of Fame** built only from this
  device's real show history (you + the Tumblers you faced), clearly labelled.
  Podium for the top 3, your row highlighted and pinned when off-screen.

### 5.7 News

- Featured hero carousel (hero image, tag, date, title, summary, Read), post
  list (thumbnail, tag, NEW badge, date, title, summary), reader view (hero,
  headings, paragraphs, lists, tips, images). Content:
  `packages/content/src/news`. Unread posts drive the tab dot and bell count.

### 5.8 Friends / party panel (overlay `friends`)

Right-side sheet: party invite code/link (Copy), party members with ready
states, promote and kick (leader), Leave, **party chat**; add a friend by
`name#tag` or search; friend requests (accept / decline / cancel); friends
by presence (Join, Invite, profile, remove, block); recent players; blocked
list with Unblock; **Join with code**. Offline it shows an empty state with
Retry. Streamer mode masks codes (`••••••` + Reveal).

Any player name opens **player actions**: Add friend, Mute (local), Block
(confirm), Report (Harassment / Offensive name / Cheating / Griefing / Spam
/ Something else, plus details).

Intents: `inviteFriend`, `copyInvite`, `promotePartyMember`,
`kickPartyMember`, `leaveParty`, `sendPartyChat`, `addFriend`,
`searchPlayers`, `requestFriend`, `friendRequestAction`, `removeFriend`,
`joinFriend`, `inspectPlayer`, `mutePlayer`, `blockPlayer`, `unblockPlayer`,
`reportPlayer`.

**Club section** (`ClubPanel.tsx`, a "Friends & party | Club" switch at the
top of the panel). Without a club: invites (Join / Decline), requests waiting
on a club (Cancel), search by name or tag, recommended open and active clubs,
and "Found a club" (name, tag, description, who can join, emblem from the
banner motifs and the Tumbler palette; the shared rules are checked inline;
guests see why they cannot join yet). In a club: emblem, name, `[TAG]`,
members and role, then tabs Roster (presence, role chips, Party up for online
members, Manage for lower roles: make officer / member, make owner, remove,
plus invite friends for officers), Chat, Goals (three weekly goals with
progress bars, Collect, the week's contribution board), Requests (officers,
with a count) and Settings (name and tag for the owner, join mode,
description and emblem for officers, leave, disband, report). Loading, error
with Retry, empty and "switched off" states are explicit. Streamer Mode hides
other players' `#tag` and club tags. Club chat also appears as a Club tab in
the chat widget (`/c`).

Intents: `clubRefresh`, `clubCreate`, `clubSearch`, `clubJoin`,
`clubCancelRequest`, `clubInviteAnswer`, `clubRequestAnswer`, `clubInvite`,
`clubEdit`, `clubMember`, `clubLeave`, `clubGoals`, `clubClaim`,
`clubPartyUp`, `clubChat`, `clubReport`.

### 5.9 Private show (overlays `privateShow`, `joinCode`)

A dialog, not a screen. **Setup**: round picker, house rules (fill with
bots, players 2–60, round length ×0.5–×2, allow spectators); footer **Have a
code?** (→ `joinCode`), **Invite friends** (`createCustom`; disabled with a
note when offline) and **Play with bots** (`playCustomOffline`, always
works). Closing the dialog keeps a joined lobby.

**`joinCode`**: six code cells (A–Z/0–9) → `joinCode { code }`; offline →
empty state with Try again (`retryOnline`). Opened from the start card, the
private-show dialog and the friends sheet.

**Private lobby** (same dialog, once created or joined):

- Code panel with Copy (masked in streamer mode). Host: Lock/Unlock
  (`lockCustom`), New code (`newCustomCode`).
- Host settings apply live (`updateCustom`, debounced): rounds, bots, max
  players, players needed to start, round length, pre-show countdown,
  spectators and spectator slots. Members see a read-only summary.
- Member rows: Make host (`transferCustomHost`), Remove → confirm
  (`kickCustomMember`, also bans from that lobby); the host's Removed list
  has Unban (`unbanCustomMember`).
- Host: **Start show** (`startCustom`); with unready players it asks first
  and offers Start anyway (`startCustom { force: true }`).
- Members: **Ready up** (`readyCustom`), Spectate / Play instead
  (`spectateCustom`), Leave (`leaveCustom`).
- During the show the host can still remove players from the in-game menu.

### 5.10 Settings (overlay `settings`)

Full-height sheet with text-only tabs:

- **Graphics**: preset Auto/Low/Med/High/Ultra, resolution scale, FPS cap
  30/60/120/Off, shadows, post effects, show FPS.
- **Controls**: camera sensitivity, **Lock mouse to camera** (moving or
  clicking in a round grabs the mouse; Esc lets go), invert Y, toggle grab,
  controller vibration, touch buttons side and size, rebinding table (primary
  / secondary per action, including **Menu**; conflicts swap; Reset to
  defaults), and a **Controller** table (jump, dive, grab, emote wheel,
  emotes 1–4, Menu, spectate previous / next) with "press a button" capture.
  Controller conflicts swap only between actions live at the same time
  (gameplay vs spectating may share, e.g. RB); Menu can't take a button menus
  navigate with or lose its last button; Delete clears a secondary slot.
  Every prompt (controls hint, in-game menu, spectate, pre-show, grab,
  tutorial) shows the current keys and buttons.
- **Audio**: Master, Music, Sound effects, Menu sounds, Announcer; Mute when
  unfocused.
- **Accessibility**: colour-blind mode (Protan/Deutan/Tritan, palette
  preview; also recolours teams in 3D), Reduce motion, Reduce flashing,
  Reduce camera shake, Captions, Spoken announcer (off by default), UI scale,
  High-contrast HUD.
- **Gameplay**: nameplates, Streamer mode (hides other players' names and
  lobby codes), show ping, auto-spectate, **Show bot tags**, **Show chat**
  (off also hides quick pings), **Chat filter** (masks swearing; slurs are
  always hidden), **Region** (Auto or a fixed region, each with its measured
  ping; `probeRegions` when shown).
- **Account**: display name with Rename (monthly cooldown online), linked
  logins (Link / Unlink per provider), Sign in to an existing Tumbler, Sign
  out, Delete Tumbler (confirm).

Every change applies live and emits `settingsChange`. Opened from the
in-game menu, closing returns to it.

---

## 6. Matchmaking — `matchmaking`

- **Layout**: the start card becomes the matchmaking card: "Finding
  Tumblers…" / "Show found!", found / needed count, elapsed time, ETA, region
  chip, progress bar, tips carousel, **Cancel** (Escape/B). The menu is not
  dimmed; tabs other than the current one are disabled and lobby emotes hide.
- Only online play queues. Vs Bots and Play with bots skip this and go
  straight to `preShow`.
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
  1–4 emote"). Players move freely in 3D. Online, the platform is a live
  synced lobby: every Tumbler's movement and emotes come from the server, and
  joiners/leavers pop in and out; the join feed and count follow the server
  roster.
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
- **Emote wheel**: hold-to-open radial, pointer angle selects, release emits
  `emote(slot)`; ping slots (Go here! / Watch out! / Nice! / GG!) emit
  `quickPing` and show as speech bubbles over the Tumbler.
- **Toasts / feed**: left-side short feed ("Gloop fell off!", "Team Pink
  scored!"), max 4, 3.5 s each.
- **Chat feed** (online): fading feed of up to 7 lines, 8 s each; Enter (or
  the Chat button on touch) opens the input (`chatInput`, `sendChat`).
  Messages also appear as speech bubbles. Shown on preShow, round, results,
  between rounds, victory and winner cam; respects Show chat, the chat
  filter, mutes and blocks.
- **Camera-lock prompt** (keyboard + mouse): unlocked → "Click or start
  moving to lock the camera"; locked → "Esc frees the mouse · <Menu key>
  menu".
- **Grab status**: "Grabbed by X! Mash Jump to break free" / "Holding X" /
  "Carrying", each with a meter.
- **Bot tags**: bots are labelled in shows unless Show bot tags is off.
- **Ping/FPS**: tiny top-right, coloured by quality; hidden unless setting on.
- **Controls hint**: bottom-left, fades after 10 s or first input; gamepad
  glyphs if last input was a pad.
- **Touch**: `TouchControls` is the only touch layer, shown when touch was
  the last device: floating joystick, Jump / Dive / Grab buttons, an Emote
  button that toggles the wheel, camera drag elsewhere (`touchInput`,
  `touchLook`). Big moments vibrate the phone or controller (Controller
  vibration setting). The same layer serves every place the Tumbler can
  move (`touchMode`): the round and tutorial; the pre-show platform
  (joystick and buttons, no wheel or camera); and menu idle play, party
  hangout and lobby games, where the menu chrome steps aside (a running
  lobby game keeps its score), a Done button returns to the menu, and taps
  on the stage still pick the Games sign or a party member. Opening any menu
  UI hides it again.
- **Gear button** opens the in-game menu (§9.16).
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
style.", "The floor was very welcoming.". Then the **keep-watching choice**
("Knocked out!" in the round; "You're out of the show" over later show
screens): **Keep watching** (auto-selected after a countdown) or **Leave
show**, with a rewards note and "N still in the show".
Intents: `spectate`, `leaveShow`.

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

### 9.16 In-game menu (overlay `inGameMenu`)

Opened in a round with Esc (always), the rebindable **Menu** key, gamepad
Start or the HUD gear. The show keeps running. Shows the show and round
name, round X of N, status, qualified count, objective and control hints;
private-show hosts get Remove player. Actions: Resume · Watch replay
(`replayOpenLive`, when eliminated or spectating) · Settings (returns here
on close) · Photo mode (not while playing) · Leave show (confirm →
`leaveShow`).

### 9.17 Replay viewer

Full-screen layer over a private replay sim (`docs/design/REPLAYS.md`).
Exit, scrub bar with qualify/elimination markers, play/pause, ±5 s, speed
0.25–2×, cameras Follow / Free / Your view, previous/next player, Save replay.
Keys: Space, ←/→ seek, ↑/↓ speed, C camera, WASD free camera. Opened from
round results (Watch replay), the rewards picker, the in-game menu (live
round) and Profile / Match history (open a `.tumblereplay` file). Intents:
`replayOpen`, `replayOpenLive`, `replayOpenFile`, `replayCommand`.

### 9.18 Photo mode

From Victory, Winner cam or the in-game menu (not while playing, never
during a replay). Hides all other UI. Bar: field of view 20–100°, filter
None / Warm / Mono / Vivid, logo watermark, Take photo (`photoCapture`),
Exit (`photoExit`). Per-device hints for keyboard, gamepad and touch.

### 9.19 Share sheet

From the rewards screen's **Share** button, shown when the show earned a
card (a Crown, a final, or a top-quarter finish) or has recorded rounds to
clip. A modal card with two tabs:

- **Card:** Post (1200×630) or Story (1080×1920), and "Show my name" (off by
  default in Streamer Mode; nobody else's name is ever on a card). Make card
  (`shareCard`).
- **Clip:** recorded rounds as chips (defaults to the won final, else the
  latest qualified round), length 5 / 10 / 15 s and a start trimmer (range
  plus ±1 s buttons for pad and keys). Make clip (`shareClip`). Hidden while
  `replays.enabled` is off; a browser that cannot record video gets an
  explanation instead.

While rendering: spinner, progress bar (clips), live-region status and a
focused Cancel that Back/B/Esc also triggers (`shareCancel`). When ready: the
preview (card image, or a muted looping clip that does not autoplay under
Reduce Motion) with Share / Save / Copy as the browser allows
(`shareDeliver`), or an error with Try again. Closing emits `shareClose`.
Focus moves to each state's main action and back to Share on close.

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

Bell drop-down list: party invites (Join / Decline), friend requests
(Accept / Decline), season and shard notices, rewards. Works offline from
local notices. Mark all read; closing marks everything read. The bell count
is unread notifications only.

---

## 13. Screen ids (store `ScreenId`)

`boot`, `splash`, `welcome`, `tutorialPrompt`, `menu`, `matchmaking`,
`matchFound`, `preShow`, `showIntro`, `roundLoading`, `roundIntro`, `rules`,
`round`, `roundResults`, `betweenRounds`, `finalHype`, `victory`, `winnerCam`,
`playerWall`, `rewards`, `matchHistory`.

Overlays (`OverlayId`): `settings`, `friends`, `notifications`,
`privateShow`, `joinCode`, `inGameMenu`.

Sub-states are store fields, not screens: `menuTab`, `overlay`,
`countdown`, `stamps`, `hud.localStatus`, `eliminatedSheet`, `spectate`,
`dialog`, `connection`, the private lobby, the replay viewer and photo mode.

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
