# MASTER SPEC — "TUMBLE ROYALE"

A massively-multiplayer, physics-driven party royale that runs 100% in the browser.
This is the product owner's master brief. Engineering contracts live in
`docs/ARCHITECTURE.md`; detailed game design lives in `docs/design/`.

---

## 0. Mission

Build **Tumble Royale**: a browser-native, real-time multiplayer party royale where up to **40 players** (humans + bots) compete through a "Show" of 3–5 randomly selected rounds — races, survivals, team games, logic games and a final — until one player wins the Crown. It must feel like a premium console party game: bouncy, chaotic, readable, hilarious, colorful, responsive at 60 FPS on a mid-range laptop and playable on modern phones. The product owner wants it **entirely super advanced** — premium polish, rich detail, long full playable levels.

**Non-negotiables**
1. Runs in a browser tab. Desktop (Chrome, Edge, Firefox, Safari) + mobile (iOS Safari, Android Chrome).
2. **Three.js** rendering, **Rapier** (`@dimforge/rapier3d-compat`) physics on client and server.
3. **Server-authoritative**. Clients send inputs only. Server decides positions, qualifications, eliminations, rewards.
4. **100% original IP.** Never use "Fall Guys", "bean", "Mediatonic", "Epic", or any of their round names, sounds, logos, characters or art. Characters are **Tumblers**.
5. Data-driven: rounds, obstacles, cosmetics, shows, tuning live in typed config files.
6. TypeScript strict. No `any` without a comment explaining why.
7. Ship playable slices; never leave main unplayable.

## 1. Tech stack

TypeScript strict · pnpm + Turborepo · Vite (code-split rounds) · three.js `WebGPURenderer` with WebGL2 fallback, TSL node materials · Rapier compat (pinned, same on client and server) · `three-mesh-bvh` (camera collision, picking) · TSL post nodes (bloom, outline, SMAA/FXAA, vignette, LUT) · `troika-three-text` (nameplates, signage) · React 19 + Zustand + Tailwind DOM overlay (game loop NOT React-driven) · procedural animation + AnimationMixer · Web Audio (spatial via PannerNode) · glTF + procedural geometry (playable with zero external assets) · WebSocket binary protocol (custom bit-packed `DataView` snapshots/inputs, msgpackr for low-frequency) · Node 22 game server, many rooms per process · Redis (matchmaking/presence) · Fastify API · Postgres + Drizzle · Guest → Discord/Google/email auth, JWT · Stripe (cosmetics only) · Sentry + Prometheus · Vitest + Playwright.

## 2. Monorepo

`apps/{client,game-server,api,matchmaker,level-editor}`, `packages/{shared,sim,netcode,content,render,audio,ui}`, `tools/{asset-pipeline,bot-swarm,balance}`. `sim` runs on server (authoritative) and client (prediction).

## 3. Core loop & show structure

### 3.1 Show
- Lobby fills to **40** (configurable 20–60). After max wait (default 25 s) fill with **bots**.
- Server selects a **Show Playlist** (Main Show, Duos, Squads, Chaos Mode, events).
- Weighted round selection: Round 1 always a Race (~25–35% eliminated). Middle rounds mix Race/Survival/Team/Hunt/Logic, never the same type twice in a row, never the same round twice per show. Rounds chosen by player count (`minPlayers`, `maxPlayers`, `idealPlayers`). Final: always a Final-type round for the survivor count.
- Qualification targets shrink ~60–70%: 40 → 26 → 14 → 7 → Final.
- Last qualifier in the Final wins the **Crown**. Squads/duos: winning team shares it.

### 3.2 Round types
Race (reach finish; last players eliminated when quota fills) · Survival (don't fall before timer ends) · Team (team score; lowest team(s) out) · Hunt (hold item/score; lowest out) · Logic (memory/puzzle; wrong = fall) · Final (single winner).

### 3.3 Round lifecycle (server state machine mirrored on client)
`LOADING → INTRO_FLYOVER → RULES_CARD → COUNTDOWN (3-2-1-GO) → PLAYING → (OVERTIME) → ROUND_END → RESULTS → TRANSITION`
- LOADING: wait for all humans to ack or 12 s; late loaders treated as eliminated (config flag).
- INTRO_FLYOVER: authored camera spline, title card, type badge, one-line objective, tips carousel.
- COUNTDOWN: players frozen on start gates; can emote and jump in place.
- PLAYING: timer, "QUALIFIED 12 / 26" counter.
- ROUND_END: slow-motion final 1.5 s, "ROUND OVER" stamp.
- RESULTS: qualified/eliminated grid with portraits, then transition.

## 4. The Tumbler

### 4.1 Physical model
Rapier dynamic body, capsule (radius 0.45, half-height 0.45 — tune), X/Z rotation locked while upright, high linear damping on ground, low in air. Velocity targeting from input + camera yaw with separate ground/air acceleration curves. Ground detection via shape-cast down + contact normals; track `groundNormal`, `groundBody` and **inherit platform velocity — players MUST ride moving/rotating platforms correctly**. Slope limit, step-up for small ledges. Collision groups PLAYER, PLAYER_GHOST, STATIC, KINEMATIC_OBSTACLE, DYNAMIC_PROP, TRIGGER, HAZARD.

### 4.2 Abilities & states
States: Idle, Run, Jump, Fall, Dive, DiveSlide, GetUp, Grab, Grabbed, Carry, Stunned (Tumble/Ragdoll), Bounce, Swim/Slime, Emote, Finished, Spectating.

| Action | Desktop | Gamepad | Mobile |
|---|---|---|---|
| Move | WASD | Left stick | Virtual joystick |
| Camera | Mouse (pointer lock) | Right stick | Drag right half |
| Jump | Space | A / Cross | Button |
| Dive | Ctrl / Left click | X / Square | Button |
| Grab | Shift / Right click hold | RT / R2 hold | Hold button |
| Emote | 1–4 / hold E | D-pad | Button |

- **Jump**: fixed impulse, coyote 120 ms, buffer 120 ms, variable height.
- **Dive**: forward-up impulse → belly slide → GetUp (0.45 s). Jump-dive chains must feel great.
- **Grab**: sphere query ahead; players (slows both, drags), ledges (hang, climb with jump), props (eggs, balls, tails). Stamina; grabbed player mashes to break free.
- **Stun/Tumble**: impact impulse above threshold → tumble mode (rotations unlocked, angular impulse, low friction 0.8–1.6 s, auto-recover). Client renders cosmetic ragdoll; never full ragdolls on server.
- **Bounce pads/bumpers**: authored impulse vectors; squash-and-stretch.
- **Respawn**: checkpoints in races. Fall → 1.2 s fade-burst → respawn at checkpoint with lateral offset and 1 s ghost.

### 4.3 Tuning
`packages/content/tuning/character.ts`, hot-reloadable via debug panel: speeds, accelerations, gravity scale, jump/dive impulse, stun threshold, grab force, friction per surface (normal, ice, slime, conveyor, sticky).

## 5. Character art, animation, customization
- **Mesh**: original soft "gumdrop" body, stubby arms with mitten hands, little feet, big expressive face plate. Procedural (lathe + capsule blend), optional glTF override. ~16-bone skeleton.
- **Procedural animation**: speed-driven run cycle, arm swing, lean into acceleration/turns; spring squash & stretch (second-order dynamics); jiggle; verlet chains on costume pieces; animated eyes (blink, look-at), mouth shapes per state (scared falling, determined running, dizzy stars stunned); AnimationMixer layers for emotes/celebrations/victory.
- **Cosmetic ragdoll**: client-only Rapier ragdoll pinned to the server capsule with springs; max 8 near camera, others canned tumble.
- **Customization slots**: color/pattern, face plate, upper, lower, headwear, back item, 4 emotes, celebration, victory pose, nameplate, banner, trail VFX, footstep SFX pack. Primary/secondary/tertiary colours + procedural patterns (stripes, dots, camo, gradient, galaxy, checker…). Rarities Common → Uncommon → Rare → Epic → Legendary → Mythic. Turntable preview, try-on, randomize, 6 loadouts.

## 6. Rendering & art direction
Candy-coloured toy world floating in a bright sky. Pastel + saturated accents, soft shadows, rim light, chunky readable shapes. **Danger = magenta/orange, safe = cyan/mint, interactable = yellow.**
- Toon/PBR hybrid (3-step ramp, Fresnel rim, fake SSS on characters, candy specular). Inverted-hull outline for characters; screen-space edge outline for levels (tiered). Hazard-tape stripes, emissive telegraph pulses. Slime/void with scrolling noise, foam edges, vertex waves. Sky gradient + drifting clouds + floating background islands/balloons/blimps (instanced, parallax). Water/ice/glass variants.
- One sun with cascaded shadows (2–3), hemisphere ambient, SSAO only on High. **Blob shadows under every character always.**
- Post: SMAA/FXAA → selective bloom → LUT per theme → vignette → chromatic punch on hit.
- VFX: confetti, dust puffs, dive speed lines, stun star ring, slime splash, finish fireworks, qualification sparkle column, elimination "poof" balloons, crown shine, bounce rings, fan wind streaks, tile crack previews, team smoke.
- Budgets: 60 FPS on Iris Xe / M1; < 250 draw calls; instancing; shared character geometry with per-instance colour; LODs; < 6 MB gz initial; < 4 MB per round chunk; Low/Medium/High/Ultra/Auto with adaptive resolution.

## 7. Camera
Third-person spring arm, orbit with mouse/stick, smoothed follow with look-ahead; BVH camera collision with occluder fading; modes: free orbit, fixed side cam, top-down tilt; trauma shake (toggle); spectator (cycle Q/E, follow leader/friend, free fly in customs); intro flyover splines; finish slow-mo.

## 8. Obstacle library
**Every moving obstacle's transform is a pure function of synchronised match time + seed** (`pose(t, params)`), driven as kinematic position-based bodies. Each module: zod config schema, `buildMesh()`, `buildColliders()`, `pose(t)`, `onContact()` (server), `telegraph(t)`, audio cues.

1 Spinwheel · 2 Pendulum Hammer · 3 Sweeper Arm · 4 Bumper Pillar · 5 Punch Wall · 6 Door Gauntlet (fake/solid doors seeded) · 7 Conveyor Belt · 8 Tilt Platform (dynamic on joint, replicated) · 9 Seesaw · 10 Fan/Wind Zone · 11 Bounce Pad · 12 Falling Tile (shake, crack, drop; replicated) · 13 Rising Slime/Lava · 14 Rolling Boulder/Giant Ball (spline lanes) · 15 Spinning Disc Platform · 16 Moving Platform (spline, eased) · 17 Slide Ramp · 18 Ice Floor · 19 Sticky Goo · 20 Pop-up Foam Blocks · 21 Laser Sweep (soft beam, stun) · 22 Cannon (foam balls) · 23 Bumper Car · 24 Rotating Drum/Rolling Log · 25 Collapsing Bridge · 26 Jump Rope Beam · 27 Teleporter Pads · 28 Grab Ledge/Climb Wall · 29 Checkpoint Gate, Finish Line, Start Gate, Void Trigger · 30 Props (eggs, balls, tails, crowns, keys, blocks; replicated with ownership).

## 9. Round catalog (original)
Races: R1 Gumdrop Gauntlet (doors, spinwheels, pendulums, finish ramp) · R2 Conveyor Chaos (reversing conveyors, punch walls, bumpers) · R3 Tilt Town (tilting platforms, seesaws over void) · R4 Slip 'n' Spiral (icy downhill spiral, boulders) · R5 Hammer Highway (narrow bridges, pendulums, collapsing segments) · R6 Wind Tunnel Peaks (vertical climb: fans, bounce pads, ledges) · R7 Cannonball Canyon (lanes under cannon fire, giant balls) · R8 Teleport Tangle · R9 Drum Roll Dash · R10 Bumper Boulevard.
Survivals: S1 Spin Cycle (2-layer sweepers accelerate) · S2 Tile Panic (multi-layer falling tiles) · S3 Rising Goo Tower · S4 Jump Rope Royale (concentric beams, 2 heights) · S5 Cannon Crown (survive 90 s barrage) · S6 Shrinking Sundae.
Team: T1 Egg Heist · T2 Bounce Ball Blitz · T3 Paint the Plaza · T4 Tug-o-Bridge · T5 Hoop Hustle.
Hunt: H1 Tail Chase · H2 Key Keeper. Logic: L1 Pattern Panic · L2 Count Up.
Finals: F1 Crown Climb (tower race, grab the floating Crown) · F2 Last Tumbler Standing (hex layers) · F3 Spin Cycle Finale · F4 Goo Peak Final · F5 Tail Finale.

Each round definition contains id, name, type, theme, player range, qualification rule, duration/overtime, spawns, obstacles with params, triggers, camera flyover, music, lighting, difficulty knobs by show stage, bot navigation, tips, thumbnail. Every round has **seeded variations** (door layouts, speed profiles, alternate paths, weather, remix flags).

**Launch set: 20 rounds** — R1–R7, S1–S4, T1–T3, H1, L1, F1–F4. Full detail in `docs/design/LEVELS.md`.

## 10. Netcode
- Server tick 30 Hz (2 × 1/60 Rapier steps), snapshots 20–30 Hz. Client renders at display rate with 60 Hz fixed-step prediction.
- NTP-style clock sync at connect + every 2 s → `matchTime()`; clients run obstacle time ahead by ~RTT/2 + buffer.
- Inputs every client tick: seq, tick, move (8-bit/axis), yaw (16-bit), buttons, emote; last 3 inputs redundantly. Server jitter buffer 1–3 ticks; missing → repeat last.
- Snapshots: position 16-bit/axis in round bounds, smallest-three quaternion (30 bits), quantised velocity, state, grab target, flags. Delta vs last acked; interest management; reliable ordered events channel.
- Local prediction against local Rapier world with kinematic obstacles at `pose(matchTime)`; rewind + replay on error; smooth small corrections (~100 ms), snap large.
- Remote players interpolated ~100 ms behind, hermite with velocity, brief extrapolation.
- Lag compensation for grab/dive hits (≤150 ms rewind). Finish order by server tick with sub-tick interpolation.
- Anti-cheat: never trust client results; rate limits; speed/teleport sanity.
- Reconnect within 30 s with resume token. Region ping probes. Tick budget < 12 ms at 40 players.

## 11. Bots
Same input interface as humans. Waypoint graphs (+ navmesh later), obstacle-aware timing via `pose(t)`. Behaviour per round type. Tiers Clumsy/Average/Sharp with reaction delay, aim noise, mistakes, emotes. Original name generator. Hidden from ranked. First 1–3 shows bot-heavy and easier.

## 12. Progression, ranking, economy
XP & levels; Crowns + Crown Shards; Season Pass (100 tiers, free + premium, cosmetic); daily (3) / weekly (6) challenges. Ranked: OpenSkill Plackett-Luce, tiers Bronze → Silver → Gold → Platinum → Diamond → Champion → Crown League, divisions I–III, visible RP over hidden rating, 5 placements, seasonal soft reset. Leaderboards (Redis live, Postgres history). Currencies **Gumballs** (earned), **Gems** (premium). Rotating store. Never pay-to-win, no paid loot boxes. Profile card + last 20 shows history.

## 13. Social
Friends (name#tag), presence, recent players; parties up to 4 with ready checks and invite links `/join/<code>`; custom lobbies (code, host picks rounds, bots on/off, timers, spectators); lobby/party text chat (filtered); in-match emotes + quick pings; report/mute/block; streamer mode.

## 14. Every screen & flow
14.1 First launch: boot loader (CSS tumbler + real byte progress) → device check (WebGPU/WebGL2, silent GPU benchmark, quality auto-select, "Click to start" splash with logo + music sting) → guest account + display name + quick colour → optional tutorial island (~2 min, coach Tumbler, ends with mini bot race) → first bot-assisted show.
14.2 Main menu: your Tumbler on a floating 3D platform with party members emoting, animated sky, music. Top bar: level/XP, Gumballs, Gems, Season Pass, notifications, friends, settings. Bottom: huge PLAY, playlist selector, party slots, ready toggle. Tabs: Play, Locker, Store, Season Pass, Challenges, Profile, Leaderboards, News. Idle play: run around and knock party members off.
14.3 Matchmaking: "Searching…" with counter, ETA, cancel → pre-show lobby: all 40 on a big waiting platform, free movement, emotes, countdown, show name + round count.
14.4 HUD: timer, qualification counter, objective chip, race progress bar, team scores, ping/FPS, emote wheel, controls hint, spectator banner, event toasts. Mobile variant.
14.5 Qualified: "QUALIFIED!" stamp, confetti, orbit cam, then spectate. Eliminated: "ELIMINATED" stamp with comedy animation, then Spectate / Return to lobby / Play again.
14.6 Between rounds: results grid, "Players remaining: 26", next round tease → flyover → rules.
14.7 Final & victory: slow-mo crown grab, victory screen with celebration, crown counter, music swell, fireworks, photo mode. Others see winner cam then results.
**End of show: the PLAYER WALL** — every player of the show displayed on a giant wall grid; as the show recap plays, eliminated players' cells drop away round by round (they fall out comedically) until only the winner remains, crowned.
14.8 Rewards: XP breakdown, level-up animation, pass progress, unlock rarity reveal, RP change (ranked), Play Again / Back to Lobby.
14.9 Locker · 14.10 Store · 14.11 Season Pass & Challenges · 14.12 Profile, Leaderboards, Match History · 14.13 Settings (graphics, controls + rebinding, audio, accessibility incl. colourblind/reduced shake/flash/captions/UI scale, gameplay, account) · 14.14 Level editor (internal first).

## 15. Audio
Adaptive stem music per theme (intro, loop, intensity, final-30 s, stingers), lobby theme, all original (procedural placeholders OK). Announcer lines with captions. Pooled SFX with pitch/volume variance (footsteps per surface, jump, land, dive, slide, grab, stun boing, bounce, spinwheel whirr, hammer whoosh, conveyor hum, tile crack, slime, fan, cannon, confetti, crowd cheer/aww, UI, rarity fanfares). Spatial audio, 32-voice limit, music ducking under announcer. Procedural (jsfxr-style) placeholders so the game is never silent.

## 16. Backend data model
users, auth_identities, sessions, profiles, player_stats, player_round_stats, inventory_items, cosmetics_catalog, loadouts, currencies_ledger (append-only), purchases, store_rotations, season_pass_progress, challenges, challenge_progress, ratings, rank_history, matches, match_participants, match_rounds, round_results, friendships, parties (Redis), reports, bans, feature_flags, events. APIs `/auth/*`, `/me`, `/profile/:id`, `/inventory`, `/loadouts`, `/store`, `/purchase`, `/pass`, `/challenges`, `/leaderboards/:type`, `/matches/:id`, `/friends`, `/party`, `/report`. Game server posts results via signed internal endpoint; API is the only economy writer; idempotent grants keyed by match id.

## 17. Phases & acceptance
- **P0 Foundations** — ✅ toon test scene 60 FPS on both backends; Rapier identical client/server after 600 steps.
- **P1 Tumbler feels amazing** — ✅ run/jump/dive/grab/ledge-climb/ride moving & rotating platforms; stun + ragdoll; "feels good" in 30 s.
- **P2 Netcode slice** — ✅ 150 ms + 2% loss: local movement instant, remotes smooth, tick < 12 ms at 40, no rubber-banding.
- **P3 First Show** — ✅ full 3-round show, 40 entities, end-to-end, no crashes.
- **P4 Meta & accounts** — ✅ account → customize → party queue → show → XP & unlock persisted.
- **P5 Content MVP** — ✅ 10+ rounds rotating; phones 30+ FPS on Low.
- **P6 Ranked/store/pass/social** — ✅ 40-player rating update unit-tested; idempotent purchases; custom lobby codes.
- **P7 Launch hardening** — ✅ 24 h soak no memory growth; p95 tick < 16 ms; crash-free > 99.5%.
- **P8 Post-launch** — P rounds, creator editor sharing, events, replays/ghosts, WebTransport.

## 18. Code quality
Sim headless. Every obstacle and round has a unit test + bot smoke test. Fixed timesteps; never `Date.now()` in sim. Dispose GPU resources; no growth across 20 rounds. No per-frame allocations in hot paths. Feature flags for experiments. README per package. Unsure → simplest version behind an interface + `DECISIONS.md`.

## 19. Definition of done
A new player opens a link on laptop or phone, is playing a 40-player show within 60 seconds, laughs in the first round, understands every round from its intro card, can party up via a link, earns visible progress every show, can climb a ranked ladder, and wants to hit **Play Again**.
