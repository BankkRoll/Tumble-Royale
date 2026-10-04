# Tumble Royale — Shows & Playlists (SHOWS.md)

> Owner: Lead Game Design. Consumers: match/show server (`apps/game-server`),
> content (`packages/content/shows/*`), economy (`apps/api`), UI (show intro,
> results, rewards). Round ids and per-round data live in `LEVELS.md`.

## Contents

1. Show anatomy & pacing timeline
2. Round selection algorithm (shared by every playlist)
3. Qualification curves (40 / 30 / 20 starting players, plus private-show sizes)
4. Playlists — Main Show · Duos · Squads · Chaos Mode · Ranked · First Show
5. Bots: fill rules and skill mix
6. Rewards: XP, Gumballs, Crown Shards, Crowns
7. Config shape (suggested `ShowPlaylist` data)

---

## 1. Show anatomy & pacing timeline

A **Show** = pre-show lobby → 2–4 elimination rounds → a Final → victory →
Player Wall → rewards. Phases mirror `ShowPhase` / `RoundPhase` in
`packages/shared/src/game.ts`.

### 1.1 Phase durations (defaults; all configurable per playlist)

| Phase                      | Duration                                  | Notes                                                                                                                                                         |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matchmaking                | until lobby target or **25 s** max wait   | Then bot-fill (§5)                                                                                                                                            |
| PreShow (waiting platform) | 8 s after the lobby locks                 | Free movement, emotes; show name + "4 ROUNDS" banner; countdown ring                                                                                          |
| Show intro card            | 5 s                                       | Show title, playlist badge, player count (e.g. "40 TUMBLERS"); announcer `ann_show_intro_*`                                                                   |
| **Per round:** LOADING     | until every connected human acked; ≤ 60 s | Round build + shader compile; slow clients are waited for while they report progress (stall 15 s); late loaders are eliminated (flag `lateLoadersEliminated`) |
| INTRO_FLYOVER              | the round's `flyover.duration` (4–10 s)   | Title card + type badge                                                                                                                                       |
| RULES_CARD                 | 4 s                                       | Objective + 3 tips carousel (≥ 1.3 s per tip)                                                                                                                 |
| COUNTDOWN                  | 3.5 s (3-2-1-GO)                          | Players frozen on start gates; jump/emote allowed                                                                                                             |
| PLAYING                    | per round (see LEVELS §10)                | HUD: timer, "QUALIFIED 12 / 26"                                                                                                                               |
| OVERTIME                   | per round (`overtimeSeconds`)             | Only T2 and F1 at launch                                                                                                                                      |
| ROUND_END                  | 1.5 s slow-mo + 1.5 s "ROUND OVER" stamp  |                                                                                                                                                               |
| RESULTS                    | 6 s                                       | Qualified/eliminated grid, portraits                                                                                                                          |
| TRANSITION                 | 3 s                                       | "PLAYERS REMAINING: 26" + next-round tease (silhouette of the next round's thumbnail)                                                                         |
| Final VICTORY              | 8 s                                       | Winner cam, slow-mo crown grab, fireworks, `mus_victory_crowned`                                                                                              |
| Player Wall                | 12 s (scales: 1.5 s per round + 4 s)      | Every player's cell; eliminated cells drop out round by round                                                                                                 |
| Rewards                    | 10–15 s (skippable after 3 s)             | XP bar, level-ups, pass progress, unlocks, Gumballs, RP                                                                                                       |

### 1.2 Typical show length (40 players, Main Show)

| Segment                       | Seconds                                     |
| ----------------------------- | ------------------------------------------- |
| Lobby wait + pre-show + intro | 25 + 8 + 5 = 38                             |
| Round 1 (race)                | 12 + 9 + 4 + 3.5 + ~140 + 3 + 6 + 3 ≈ 181   |
| Round 2 (survival/team/race)  | ≈ 135                                       |
| Round 3                       | ≈ 130                                       |
| Final                         | 12 + 6 + 4 + 3.5 + ~120 + 3 + 8 ≈ 157       |
| Player Wall + rewards         | 12 + 12 = 24                                |
| **Total**                     | **≈ 665 s ≈ 11 min** (target band 9–14 min) |

Measured at 100 players (Main Show, seed 5, one idle human and 99 bots on
the real server path, `apps/game-server/test/fullShow.test.ts`), round wall
time from round start to result: Tilt Town 100 → 60 in 172 s, Bounce Ball
Blitz 60 → 30 in 134 s, Pattern Panic 30 → 12 in 70 s, Crown Climb 12 → 1
in 74 s. The browser's offline Main Show (`?autoplay=1&playlist=main-show`)
with the same seed went Tilt Town 100 → Bounce Ball Blitz 60 → Pattern
Panic 30 → Crown Climb 12 and reached rewards.

Eliminated players may **Spectate** (follow leader / friend / random, Q/E cycle),
**Return to lobby** (rewards granted immediately for rounds played), or **Play
again** (requeue with party). A player who leaves early still appears on the
Player Wall.

---

## 2. Round selection algorithm

Run by the server between rounds (and once before round 1) with the show seed.

```
input: playlist P, stage s (0-based), alive N, history H (rounds played), prevType, prevTheme
1. If N ≤ P.finalThreshold or s == P.maxEliminationRounds: pick from P.finals (step 5).
2. target T = P.curve(N0, s)            // §3; the round's qualification is overridden to hit T
3. candidates = P.pool[s] filtered by:
     - round not in H                                   (never twice per show)
     - round.players.min ≤ N ≤ round.players.max
     - round.type ≠ prevType                            (unless no other candidate)
     - s == 0 ⇒ type == 'race'                          (round 1 is always a race)
     - team rounds: natural keep fraction (teams − eliminated)/teams within ±0.15 of T/N,
       and N ≥ 3 × teams
     - logic/hunt: only if T/N ≤ 0.7 (they cut cleanly)
4. score = poolWeight × idealFit × themeFactor × freshness
     idealFit    = clamp(1 − |N − ideal| / ideal, 0.35, 1)
     themeFactor = 0.3 if round.theme == prevTheme else 1
     freshness   = 0.5 if the player-majority saw this round in their last show (soft, server-wide cache) else 1
   pick weighted-random with Rng(showSeed ⊕ s).
5. Finals: weight × themeFactor; F-rounds need N ≤ 15 (if more survive, insert one more
   elimination round with T = 10 regardless of maxEliminationRounds).
6. Variation: choose by variation weights (playlist may filter/boost, e.g. Chaos Mode).
7. Apply overrides: qualification ratio = T / N (races, survivals, logic, hunt);
   speedScale = round.speedScaleByStage[s] (+ playlist bonus).
```

**Ratio override rules** (keep cuts readable and fair):

| Type     | Allowed keep fraction | Notes                                             |
| -------- | --------------------- | ------------------------------------------------- |
| race     | 0.45–0.75             | A race never eliminates more than 55 %            |
| survival | 0.45–0.75             | Survival ends when the cut is reached or at timer |
| logic    | 0.4–0.7               |                                                   |
| hunt     | 0.4–0.6               | Tail count = target                               |
| team     | natural only          | 2 teams 0.5 · 3 teams 0.67 · 4 teams 0.75         |

If the computed T falls outside a candidate's allowed band, that candidate is
excluded at step 3.

**Survival safety valve:** if a survival/logic round ends at its timer with more
than T alive, **all survivors qualify** (no random culls). The next round's
target is recomputed from the new N (curves are recomputed every stage).

---

## 3. Qualification curves

**Formula.** Let N₀ = starting players, F = final size = clamp(round(0.18 · N₀), 3, 10).
Round 1 keeps 0.65 (race). Remaining elimination rounds R′ = 2 (N₀ ≥ 14) or 1
(N₀ < 14). Each later stage keeps k = (F / N₁)^(1/R′), where N₁ is the actual
number alive after round 1. Targets round half-up; never below F.

### 3.0 100 players (Main Show since protocol v5)

Every playlist except First Show fills to `MAX_PLAYERS` = 100 and walks it
down with an explicit curve (`packages/content/src/shows`); every non-final
round admits 100, and `packages/content/test/capacity.test.ts` plays 200
seeds per playlist checking each round's field fits its player range.

| Round | Alive in | Target out | Keep | Typical round types            |
| ----- | -------- | ---------- | ---- | ------------------------------ |
| 1     | 100      | **60**     | 0.6  | race                           |
| 2     | 60       | **30**     | 0.5  | survival / team / hunt / logic |
| 3     | 30       | **12**     | 0.4  | any non-final                  |
| Final | 12       | 1          | —    | F1–F4                          |

Duos 0.55 / 0.5 / 0.4 / 0.45, Squads and Chaos 0.5 / 0.45 / 0.4 / 0.4. Team
rounds decide their own cut, so some shows take a fifth round; finals never
receive more than 15.

### 3.1 40 players (SPEC curve, before v5)

| Round | Alive in | Target out | Keep | Typical round types                  |
| ----- | -------- | ---------- | ---- | ------------------------------------ |
| 1     | 40       | **26**     | 0.65 | race                                 |
| 2     | 26       | **14**     | 0.54 | race / survival / T2 (0.5) / L1 / H1 |
| 3     | 14       | **7**      | 0.50 | survival / logic / hunt / race       |
| Final | 7        | 1          | —    | F1–F4                                |

### 3.2 30 players

| Round | Alive in | Target                       | Keep             |
| ----- | -------- | ---------------------------- | ---------------- |
| 1     | 30       | **20**                       | 0.65 (19.5 ⇒ 20) |
| 2     | 20       | **11**                       | 0.55             |
| 3     | 11       | **5** → raised to **6** by F | 0.55             |
| Final | 6        | 1                            | —                |

(F = round(0.18 · 30) = 5; round 3 target becomes max(F, round(11 · 0.548)) = 6.)

### 3.3 20 players

Small shows use **`maxEliminationRounds = 2`** when N₀ ≤ 24 (a 4-player final from
20 felt thin in paper tests), so the curve is:

| Round | Alive in | Target | Keep |
| ----- | -------- | ------ | ---- |
| 1     | 20       | **13** | 0.65 |
| 2     | 13       | **7**  | 0.54 |
| Final | 7        | 1      | —    |

### 3.4 Other sizes (private shows)

| N₀  | F   | Curve                                           |
| --- | --- | ----------------------------------------------- |
| 60  | 10  | 39 → 20 → 10 → Final                            |
| 50  | 9   | 33 → 17 → 9 → Final                             |
| 12  | 3   | 8 → Final (N ≤ finalThreshold 10 after round 1) |
| 6   | 3   | 4 → Final (a race always comes first)           |
| 2–3 | —   | Final only (custom lobbies)                     |

### 3.5 Team-round arithmetic

| Round                | Teams | Keep | Fits (rounds are 1-based here; pool stages are 0-based)                                                                                            |
| -------------------- | ----- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 Egg Heist         | 3     | 0.67 | round 2 (pool stage 1) in 30-player shows (26 → 17: target 14 ⇒ \|0.67 − 0.54\| = 0.13 ✓ within 0.15)                                              |
| T2 Bounce Ball Blitz | 2     | 0.50 | round 2 (26 → 13 ✓) or round 3 (14 → 7 ✓)                                                                                                          |
| T3 Paint the Plaza   | 4     | 0.75 | stage 1 of Main only when the target keep is ≥ 0.6 (e.g. 30-player shows after a soft round 1); Squads when exactly 4 squads remain; Chaos stage 1 |

Odd counts: teams differ by ≤ 1; a team's score is **not** normalised by size
(designs are crowd-tolerant; a 1-player difference over 7+ players is < 15 %). For
T2 with odd N, the smaller team's goal mouth narrows by 1 m (`goalWidth 11`). **Schema wish** (LEVELS §11 #6).

---

## 4. Playlists

### 4.1 Main Show (`main-show`)

| Setting            | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Lobby              | 40 (min 20 humans+bots), max wait 25 s, bot fill on                  |
| Elimination rounds | 3 (2 when N₀ ≤ 24), then Final                                       |
| finalThreshold     | 10                                                                   |
| Party              | solo or party (parties up to 4 queue together; no teaming advantage) |
| speedScale bonus   | 0                                                                    |

**Round pools & weights**

| Round                | Stage 0 | Stage 1 | Stage 2 | Stage 3* |
| -------------------- | ------- | ------- | ------- | -------- |
| R1 Gumdrop Gauntlet  | 25      | 8       | 4       | —        |
| R2 Conveyor Chaos    | 15      | 8       | 6       | —        |
| R3 Tilt Town         | 10      | 8       | 6       | —        |
| R4 Slip 'n' Spiral   | 15      | 8       | 6       | —        |
| R5 Hammer Highway    | 10      | 10      | 8       | —        |
| R6 Wind Tunnel Peaks | 10      | 8       | 6       | —        |
| R7 Cannonball Canyon | 15      | 8       | 6       | —        |
| S1 Spin Cycle        | —       | 8       | 10      | 10       |
| S2 Tile Panic        | —       | 10      | 10      | 8        |
| S3 Rising Goo Tower  | —       | 8       | 10      | 10       |
| S4 Jump Rope Royale  | —       | 10      | 10      | 10       |
| T1 Egg Heist         | —       | 8       | 4       | —        |
| T2 Bounce Ball Blitz | —       | 10      | 8       | 6        |
| T3 Paint the Plaza   | —       | 4       | —       | —        |
| H1 Tail Chase        | —       | 6       | 8       | 10       |
| L1 Pattern Panic     | —       | 6       | 10      | 12       |

\* Stage 3 only exists in 60-player custom shows or when > 15 survive stage 2.

**Finals:** F1 Crown Climb 30 · F2 Last Tumbler Standing 25 · F3 Spin Cycle
Finale 20 · F4 Goo Peak Final 25. Constraints: if stage 2 was S1, F3 weight ×0.2;
if stage 2 was S3, F4 weight ×0.2; if stage 2 was S2, F2 weight ×0.3 (avoid
"same round again" feel).

**Variation filter:** none (all variations at authored weights), except beginner
variations (`stiff-town`, `delicates`, `dead-calm`) are excluded.

### 4.2 Duos (`duos`)

| Setting              | Value                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lobby                | 40 = 20 duos (min 12 duos; bot duos fill)                                                                                                                               |
| Unit                 | **Duo**. Both members play every round of the show while their duo survives                                                                                             |
| Duo points per round | qualified = 3, + placement bonus (top 10 % of qualifiers +2, top 25 % +1); eliminated = 0; team rounds: winning-team members 3 each; final-stage individual cut ignored |
| Cut                  | rank duos by summed points this round (tie: better best-member placement); keep top K duos                                                                              |
| Curve (duos)         | 20 → 13 → 7 → 4 duos (8 Tumblers) → Final                                                                                                                               |
| Final                | individual final played by all 8; **if either duo member wins, both get the Crown**                                                                                     |
| Pools                | as Main Show but T1/T2 keep members of a duo on the same team; T3 allowed at stage 1                                                                                    |
| Comms                | Duo partner nameplate highlight, partner ping wheel                                                                                                                     |

### 4.3 Squads (`squads`)

| Setting        | Value                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Lobby          | 40 = 10 squads of 4 (min 6 squads; bot squads fill; partial squads filled with bots)                                                          |
| Unit           | **Squad** (points as Duos, summed over 4)                                                                                                     |
| Curve (squads) | 10 → 6 → 4 → 2 squads (8 Tumblers) → Final                                                                                                    |
| Team rounds    | Squads are never split across teams                                                                                                           |
| Final          | individual; winning squad shares the Crown (all 4 receive Crown + rewards)                                                                    |
| Pools          | Main pools. T3 Paint the Plaza (weight 10) is eligible only when exactly 4 squads remain, so each squad is one team. Stage 0 is always a race |

### 4.4 Chaos Mode (`chaos-mode`)

Everything louder. Built as `CHAOS_MODE` in `packages/content/src/shows`.

| Setting    | Value                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Lobby      | 40 (bots fill); bots are 2:3 Average:Sharp                                                                   |
| Rounds     | 3–5, Final at ≤ 8 left; harsher cuts (qualify curve 0.55 / 0.45 / 0.45 / 0.4)                                |
| Difficulty | `stageOffset` +2: obstacle speed scales are picked as if two rounds later in the show                        |
| Pool       | all rounds; survival ×1.6, logic ×0.6; Cannonball Canyon, Hammer Highway, Tile Panic, Spin Cycle up-weighted |
| Mutators   | one per show, announced on the intro card and HUD                                                            |

Not built: Chaos-specific variation or weather weights.

Mutators are plain data in `@tumble/sim/mutators` (multipliers on character
tuning, surface response, world gravity and obstacle speed, plus mirrored
steering and a seeded wind schedule). The director picks one per show from the
seed with its own Rng stream, so adding mutators never changes round selection;
it rides in `RoundStartInfo.mutatorId` to every match sim (server, predicting
clients via `joinRound.mutatorId`, offline) and is shown on the round intro card
and the HUD objective chip.

| Mutator             | Effect                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Moon Bounce**     | World gravity ×0.5, jump speed ×0.85 → jumps ~1.45× higher and ~1.7× longer; falls become comedy        |
| **Mirror Mirror**   | Human steering mirrored left ↔ right (bots unaffected)                                                  |
| **Speed Demons**    | +20 % run speed (and snappier acceleration/dives) for everyone, +0.2 obstacle speedScale on top         |
| **Slippery Floors** | Normal, conveyor and bouncy floors respond like ice-lite (accel ×0.3, decel ×0.12, turn ×0.6)           |
| **Gusty**           | From 4 s in, a 3.5 s gust every 9 s from a seeded direction (9 m/s² push, 0.8 s ramp so it reads first) |
| **Bouncy Castle**   | Jump speed ×1.18, bounce pads ×1.35, ground-dive lift ×1.2                                              |

Not shipped yet (they need level transforms rather than tuning): a true
mirrored course, Giant Mode (×1.4 balls/boulders), Sticky Situation (timed goo
patches).

### 4.5 Ranked (`ranked`)

| Setting      | Value                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lobby        | 100 humans; **no bots**. If not full after the queue timeout, start with ≥ 24 humans (curve recomputed)                                                                                                              |
| Rounds       | 4–5, Final at ≤ 12 left, qualify curve 0.6 / 0.5 / 0.4 / 0.5                                                                                                                                                         |
| Pools        | Races R1–R7, Survivals S1–S4, L1 Pattern Panic, H1 Tail Chase (weight ×0.5), Finals F1–F4. **No team rounds** (a teammate's play would move your rating)                                                             |
| Variations   | no mutators. A ranked-only variation filter is not built                                                                                                                                                             |
| Late loaders | eliminated (flag on)                                                                                                                                                                                                 |
| Placement    | Final order = winner, then finalists by elimination time, then by round reached; within a round by in-round rank (race finish order; survival/logic elimination time; hunt: holders > non-holders, then steal count) |
| Rating       | OpenSkill Plackett-Luce on the full order; visible RP derived from rating                                                                                                                                            |

**RP** (`apps/api/src/ranked/rating.ts`): placement moves RP linearly from +30
(winner) to −30 (last), the Crown adds +15, scaled by lobby strength (×0.5–1.5)
and nudged toward the RP the hidden rating implies. The first 5 shows are
placements: they move only the hidden rating, then RP is seeded from it
(capped in Diamond). Tiers and divisions follow SPEC §12.

**Seasonal soft reset** (`apps/api/src/ranked/season.ts`): when a season
starts, every rated player gets a new-season rating compressed halfway
toward the previous season's mean; last season's rows stay as final
standings.

### 4.6 First Show (`first-show`) — tutorial-ish, bot-heavy

Used for a player's first 3 shows (`FIRST_SHOW_COUNT`, then Main Show). Goal:
laugh in round 1, understand every round from its card, reach a final.

Built as one playlist for all three shows: 40 players (deliberately below the
100 of every other playlist: fewer Tumblers to read, lighter on weak devices), 3–4 rounds, Final at
≤ 12 left, generous cuts (0.75 / 0.65 / 0.6), `stageOffset` −1 (gentler
obstacle speeds), bots 4:1 Clumsy:Average, and a pool of 11 friendly rounds (Gumdrop
Gauntlet, Conveyor Chaos, Tilt Town, Slip 'n' Spiral, Spin Cycle, Jump Rope
Royale, Egg Heist, Paint the Plaza, Tail Chase, Crown Climb, Last Tumbler
Standing).

Not built: per-show lobby sizes and bot mixes, a fixed show-1 lineup, bot
finish/crown assists, coach tips on rules cards.

**Tutorial reward**: finishing Practice Island once grants 150 XP and the
`nameplate.mint` nameplate (`packages/content/src/progression/tutorial.ts`);
accounts claim it via `POST /me/tutorial-complete` (idempotent); offline
profiles record it locally.

---

## 5. Bots

### 5.1 Fill rules

| Rule       | Value                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| When       | Lobby reaches max wait (25 s; ranked never) or `minHumans` met with timeout                                    |
| How many   | Fill to the playlist's lobby size; duos/squads fill whole units, partial units get bot partners                |
| Names      | Original generator (adjective + noun + 2 digits, e.g. "WobblyMuffin42"); no collisions with online human names |
| Cosmetics  | Random from the free/common pool + seasonal; 10 % chance of an uncommon                                        |
| Visibility | Bots carry a bot tag in shows (Settings → Show bot tags); ranked has none                                      |
| Leaving    | Bots never leave mid-show; when humans leave, no backfill                                                      |
| Network    | Bots run server-side with the same input interface (§SPEC 11)                                                  |

### 5.2 Skill mix per playlist

Built as a fixed `botSkillMix` per playlist (`packages/content/src/shows`):

| Playlist                   | Clumsy | Average | Sharp |
| -------------------------- | ------ | ------- | ----- |
| Default (Main/Duos/Squads) | 25 %   | 50 %    | 25 %  |
| First Show                 | 80 %   | 20 %    | 0 %   |
| Chaos Mode                 | 0 %    | 40 %    | 60 %  |

Not built: mixes keyed to the lobby's hidden rating (newcomer / regular /
veteran brackets).

### 5.3 Tier parameters (bot engineers tune to these targets)

| Param                              | Clumsy                         | Average     | Sharp       |
| ---------------------------------- | ------------------------------ | ----------- | ----------- |
| Reaction delay                     | 350 ± 120 ms                   | 220 ± 80 ms | 140 ± 40 ms |
| Aim/steer noise                    | ±12°                           | ±6°         | ±2.5°       |
| Jump timing error                  | ±0.15 s                        | ±0.08 s     | ±0.04 s     |
| Mistake chance per hazard          | 18 %                           | 7 %         | 2 %         |
| Risky-route preference             | low                            | medium      | high        |
| Emote frequency                    | high (celebrates near hazards) | medium      | low         |
| Race completion vs competent human | ≈ 1.6×                         | ≈ 1.3×      | ≈ 1.1×      |

**Bot qualification share guard (casual only):** if bots would take more than
70 % of the qualification slots in a round where humans are still running, bot
finishers after the 70 % mark slow to Clumsy pace (never stop). Off in ranked
(no bots) and off in finals except First Show.

---

## 6. Rewards

All grants are computed by the game server and written by the API only
(idempotent per `matchId + userId`), per SPEC §16.

Currencies, free Gem earn paths, season rollover and the Crown Shard shop are
specified in [ECONOMY.md](./ECONOMY.md).

### 6.1 XP, Gumballs and Shards per show

`REWARD_RULES` in `packages/content/src/progression/rewards.ts`:

| Component                          | XP            | Gumballs | Crown Shards |
| ---------------------------------- | ------------- | -------- | ------------ |
| Participation (finishing the show) | 150           | 15       | —            |
| Each round played                  | 40            | 5        | —            |
| Each non-final round qualified     | 90            | 15       | —            |
| Reached the final                  | 250           | 60       | 1            |
| Crown (shared in duos/squads)      | 900           | 250      | —            |
| Placement bonus (top 10/25/50 %)   | 150 / 80 / 30 | —        | —            |
| First show of the day              | ×2 XP         | —        | —            |

Leaving mid-show keeps the per-round rewards earned so far. Not built: team
win, race top-3 and party XP bonuses.

### 6.2 Crowns & Crown Shards

- **Crown**: +1 for a win (every member of a winning duo/squad).
- **Crown Shard**: +1 for reaching a final. Shards are spent in the Crown
  Shard shop, and every 60 combine into a Crown (`SHARDS_PER_CROWN`; see
  ECONOMY.md).

### 6.3 Season Pass & challenges

Season Pass XP = normal XP (no separate currency). Challenges (SPEC §12) grant
bonus XP; example dailies that the round set supports: "Qualify from a door row
in Gumdrop Gauntlet without bouncing off a solid door", "Ride an updraft in Wind
Tunnel Peaks", "Score a goal in Bounce Ball Blitz", "Steal 3 tails in one Tail
Chase", "Survive Pattern Panic's NOT round".

---

## 7. Config shape (suggested)

`packages/content/shows/<id>.ts`, zod-validated:

```ts
export default defineShow({
  id: 'main-show',
  name: 'Main Show',
  lobby: { size: 40, minHumans: 1, maxWaitSeconds: 25, botFill: true },
  unit: 'solo', // 'solo' | 'duo' | 'squad'
  maxEliminationRounds: 3,
  maxEliminationRoundsSmall: { atOrBelow: 24, rounds: 2 },
  finalThreshold: 10,
  curve: { firstKeep: 0.65, finalFraction: 0.18, finalMin: 3, finalMax: 10 },
  speedScaleBonus: 0,
  pools: [
    { stage: 0, rounds: { 'gumdrop-gauntlet': 25, 'conveyor-chaos': 15 /* … */ } },
    { stage: 1, rounds: {/* … */} },
    { stage: 2, rounds: {/* … */} },
  ],
  finals: { 'crown-climb': 30, 'last-tumbler-standing': 25, 'spin-cycle-finale': 20, 'goo-peak-final': 25 },
  finalAvoid: [
    ['spin-cycle', 'spin-cycle-finale', 0.2],
    ['rising-goo-tower', 'goo-peak-final', 0.2],
    ['tile-panic', 'last-tumbler-standing', 0.3],
  ],
  variationFilter: { exclude: ['stiff-town', 'delicates', 'dead-calm'] },
  bots: { mixByBracket: 'default' },
  timings: {
    preShow: 8,
    intro: 5,
    rulesCard: 4,
    countdown: 3.5,
    roundEnd: 3,
    results: 6,
    transition: 3,
    victory: 8,
  },
  rewards: 'standard',
});
```
