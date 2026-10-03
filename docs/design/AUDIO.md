# Tumble Royale — Audio Design Bible

Owner: Audio Director · Package: `@tumble/audio` · Status: v1 design, implementation-ready

This document is the single source of truth for every sound in Tumble Royale:
the mix architecture, every music track and its adaptive stems, ambience beds,
the complete SFX list, the announcer, and the engineering contract that maps
`SimEvent`s and `obstacleCue`s to sound. Everything here is **100% procedural**
and buildable with the Web Audio API alone (oscillators, noise buffers, biquads,
envelopes, FM/AM, delay/convolver, waveshaper). Sampled replacements may come
later but MUST keep the same ids.

Related: `docs/SPEC.md` §3, §4, §8, §14, §15 · `docs/ARCHITECTURE.md` ·
`packages/sim/src/events.ts` · `packages/sim/src/obstacles/types.ts` ·
`packages/sim/src/physics/surfaces.ts` · `packages/shared/src/game.ts`.

---

## Contents

0. Notation used in recipes
1. Audio pillars, bus graph, mix, voices, spatial, throttling, unlock
2. Music system & every track (stems, intensity, final-30 s, stingers)
3. Lobby, menu and UI music behaviour
4. Ambience beds (weather, theme, crowd)
5. SFX catalogue (character, obstacles, props, rounds, UI, celebration)
6. Announcer ("Pip Spectacular") and full line list
7. Implementation notes (event map, cue conventions, loudness, budgets, placeholder plan)

---

## 0. Notation used in recipes

All recipes use this shorthand. Times are milliseconds unless marked `s`.

| Token                                    | Meaning                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sin / sqr / saw / tri`                  | `OscillatorNode` types sine / square / sawtooth / triangle                                                                                                                                |
| `pulse(25%)`                             | Pulse wave via `PeriodicWave` (Fourier series of a pulse with given duty) or two phase-offset saws subtracted                                                                             |
| `wn / pn / bn`                           | White / pink / brown noise from a pre-generated 2 s looping `AudioBuffer` (pink via Voss-McCartney or 3-pole filter on white; brown via leaky integrator `y = 0.98y + 0.02x`, normalised) |
| `f: a→b /t exp`                          | Frequency (Hz or note name) ramps from a to b over t ms, `exp` = `exponentialRampToValueAtTime`, `lin` = linear, `set` = instant                                                          |
| `env A/D/S/R`                            | ADSR in ms, S is a level 0–1. `AD a/d` = attack/decay to silence (one-shot)                                                                                                               |
| `LP / HP / BP / PK / NT / LS / HS fc Qx` | `BiquadFilterNode` lowpass / highpass / bandpass / peaking / notch / lowshelf / highshelf; `fc` cutoff Hz; `Q` value                                                                      |
| `filt env a→b /t`                        | Filter cutoff automated from a to b over t ms                                                                                                                                             |
| `FM c:m I a→b /t`                        | Carrier/modulator frequency ratio; modulation index (peak deviation = I × modulator freq) ramps a→b over t ms                                                                             |
| `AM r d`                                 | Amplitude modulation at r Hz, depth d (0–1)                                                                                                                                               |
| `vib r ±c (delay d)`                     | Vibrato LFO at r Hz, ±c cents, fading in after d ms                                                                                                                                       |
| `ws k`                                   | `WaveShaperNode` soft clip `y = tanh(k·x)/tanh(k)` (curve 1024 points)                                                                                                                    |
| `det ±c`                                 | Detune in cents (for stacked oscillators)                                                                                                                                                 |
| `+N dB` / `@ -N dB`                      | Layer gain relative to the recipe's loudest layer                                                                                                                                         |
| `±p st`                                  | Random pitch variance per play, in semitones (uniform)                                                                                                                                    |
| `±v dB`                                  | Random volume variance per play (uniform)                                                                                                                                                 |
| `×n var`                                 | n pre-rendered variants (different noise seeds / small parameter jitter) chosen round-robin with no immediate repeat                                                                      |
| `Pn`                                     | Voice priority class (see §1.5). P0 highest                                                                                                                                               |
| `S` / `NS`                               | Spatial (PannerNode) / non-spatial (stereo, centre or authored pan)                                                                                                                       |
| `loop`                                   | Continuous voice whose parameters are driven every frame                                                                                                                                  |

Notes in scientific pitch notation: A4 = 440 Hz, C4 = 261.63 Hz.
Unless stated, every one-shot is **pre-rendered** at load with `OfflineAudioContext`
(§7.6) and every `loop` is **live** (nodes running, params automated).

---

## 1. Audio pillars, mix architecture and runtime rules

### 1.1 Pillars

1. **Bouncy & funny first.** Every physical action has a rubbery, toy-like
   voice: boings, bloops, squeaks, whooshes. Nothing sounds painful or violent.
   Impacts are "pillow-plus-spring", never bone-crunch.
2. **Readability over realism.** Danger has a sound before it hurts you.
   Every hazard has a **telegraph** that is audible 0.4–1.2 s before it acts,
   and is pitched in the 1–4 kHz "attention band" so it cuts through music.
   Safe things (checkpoints, qualify) are bright major-key chimes;
   danger is dissonant (tritones, minor seconds) or rising noise.
3. **The show is a TV show.** A host (§6), a live studio crowd (§4.3), stingers
   in key with the music, and a clear "on-air" arc: intro → tension → payoff.
4. **Forty players, one clear mix.** The local player's sounds are always
   on top (P1). Other Tumblers are summarised: nearest 8 get detail, the rest
   become crowd texture. No sound may play more than its per-id cap.
5. **Never silent, never broken.** Every id resolves to _something_
   (§7.7 placeholder fallback). Audio errors never throw into the game loop.
6. **Musical coherence.** Every track declares a key. Stingers, UI chimes in
   rounds, and qualification jingles are transposed into the current track's key
   at runtime (`transposeTo(trackKey)`), so the whole show sounds composed.
7. **Cheap.** Pre-rendered buffers for one-shots, a tiny live node budget for
   loops and music, everything pooled; zero allocations per frame in the
   update path (§7.6).

### 1.2 Bus graph

```
                         ┌─────────────── reverbSend (per voice, 0..1) ──────────────┐
                         │                                                           ▼
 [voices: sfx world] ─► sfxWorld ─┐                                       reverb (Convolver / FDN)
 [voices: sfx local] ─► sfxLocal ─┼─► sfx ──► duckSfx ──┐                            │
                                  │                     │                           ▼
 [music sequencer]  ─► musicLoop ─┼─► music ─► musicLP ─► musicHP ─► duckMusic ──┐  reverbReturn
 [stingers]         ─► musicStinger┘                                             │      │
 [ui voices]        ─► ui ───────────────────────────────────────────────────────┤      │
 [announcer]        ─► annComp ─► announcer ──────────────────────────────────────┤      │
 [weather bed]      ─► ambWeather ─┐                                             │      │
 [theme bed]        ─► ambTheme ───┼─► ambience ─► duckAmb ───────────────────────┤      │
 [crowd bed]        ─► ambCrowd ───┘                                             ▼      ▼
                                                                         master ─► masterEQ ─► limiter ─► destination
```

- `limiter`: `DynamicsCompressorNode` threshold -2 dB, knee 0, ratio 20, attack 2 ms,
  release 120 ms. Preceded by `masterEQ` (LS 80 Hz -1.5 dB, HS 10 kHz +1 dB) and a
  safety `ws 1.1` on Low tier mobile speakers only.
- `annComp`: compressor threshold -18 dB, ratio 3, attack 5 ms, release 150 ms,
  then PK 3 kHz +3 dB Q1 for intelligibility.
- `musicLP` / `musicHP`: biquads used by menus, pause, risers and underwater/goo
  states (default LP 20 kHz Q0.7, HP 20 Hz Q0.7).
- `duck*`: plain `GainNode`s driven only by the ducking controller (§1.4), never
  by user settings, so user volume and ducking compose multiplicatively.

### 1.3 Default levels

User sliders (Settings → Audio) map 0–100 to gain with a squared curve
(`g = (x/100)^2`, 0 = hard mute) and multiply the defaults below.

| Bus                              | Default                   | Notes                                                                      |
| -------------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| master                           | 0 dB                      | user Master slider                                                         |
| music                            | -10 dB                    | user Music slider; stems are authored to sum to about -16 LUFS before this |
| musicStinger                     | -7 dB (relative to music) | stingers sit 3 dB above the loop                                           |
| sfx                              | -4 dB                     | user SFX slider                                                            |
| sfxLocal                         | 0 dB (relative to sfx)    | local player                                                               |
| sfxWorld                         | -3 dB (relative to sfx)   | everything else                                                            |
| ui                               | -8 dB                     | user UI slider (shares SFX slider if UI slider hidden on mobile)           |
| announcer                        | -2 dB                     | user Announcer slider; "Announcer: On/Captions only/Off" option            |
| ambience                         | -16 dB                    | user Ambience slider                                                       |
| ambWeather / ambTheme / ambCrowd | 0 / -3 / -6 dB            | relative                                                                   |
| reverbReturn                     | -14 dB                    | per-theme override ±4 dB (castle +3, space +4, factory +1, beach -3)       |

### 1.4 Ducking rules

The ducking controller keeps a set of active duck _requests_; each bus duck
gain = the minimum (most negative) of active requests. Ramps use
`setTargetAtTime` with time constant = attack/3 or release/3.

| Source (while active)                              | music                                  | ambience | sfxWorld                               | sfxLocal | ui  | Attack / Release |
| -------------------------------------------------- | -------------------------------------- | -------- | -------------------------------------- | -------- | --- | ---------------- |
| Announcer line                                     | -6 dB                                  | -4 dB    | -2 dB                                  | 0        | 0   | 80 / 450 ms      |
| Announcer line, priority A (critical)              | -9 dB                                  | -6 dB    | -4 dB                                  | -2 dB    | 0   | 60 / 500 ms      |
| Music stinger (GO, qualify, eliminate, round over) | loop -9 dB (stinger itself not ducked) | -3 dB    | 0                                      | 0        | 0   | 20 / 600 ms      |
| QUALIFIED / ELIMINATED stamp (local)               | -6 dB                                  | -6 dB    | -8 dB                                  | -4 dB    | 0   | 30 / 800 ms      |
| ROUND OVER slow-mo (1.5 s)                         | -4 dB + LP sweep 20k→1.8k              | -6 dB    | -6 dB, playbackRate 0.85 on new voices | same     | 0   | 100 / 900 ms     |
| Local player fall scream                           | -3 dB                                  | 0        | -3 dB                                  | 0        | 0   | 50 / 400 ms      |
| Victory fanfare / crown grab                       | loop -inf (handover)                   | -8 dB    | -6 dB                                  | 0        | 0   | 200 / 1000 ms    |
| Pause menu open                                    | -6 dB + LP 900 Hz                      | -10 dB   | -12 dB                                 | -12 dB   | 0   | 150 / 250 ms     |
| Tab hidden (`visibilitychange`)                    | context `suspend()` after 300 ms fade  | —        | —                                      | —        | —   | 300 / 300 ms     |
| Rarity reveal (Epic+)                              | -8 dB                                  | -10 dB   | n/a                                    | n/a      | 0   | 100 / 900 ms     |

Announcer sidechain is **not** a compressor: it is these fixed gain moves, so
loud music never pumps unexpectedly.

### 1.5 Voice management (32-voice limit)

A _voice_ = one playing SFX/UI instance (a pre-rendered `AudioBufferSourceNode`
or a live loop graph). Music sequencer notes and the announcer have **their own
pools** and do not count (music ≤ 24 live nodes, announcer 1 voice).

| Tier                 | Max voices                                                             | HRTF voices                 | Reverb                                       | Notes                   |
| -------------------- | ---------------------------------------------------------------------- | --------------------------- | -------------------------------------------- | ----------------------- |
| Low (mobile default) | 20                                                                     | 0                           | 2-tap FDN                                    | live loops reduced to 6 |
| Medium               | 32                                                                     | 0                           | Convolver 1.2 s IR                           |                         |
| High                 | 32                                                                     | 8 nearest P0–P3 within 15 m | Convolver theme IR                           |                         |
| Ultra                | 32                                                                     | all spatial                 | Convolver theme IR, stereo early reflections |                         |
| Auto                 | picks from graphics tier + `navigator.hardwareConcurrency` + mobile UA |                             |                                              |                         |

**Priority classes**

| Class         | Contents                                                                                                                           | Can be stolen by                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| P0 Critical   | Countdown, QUALIFIED/ELIMINATED/ROUND OVER stamps, timer final-10 ticks, rarity reveals, crown fanfare, UI clicks                  | never stolen (reserved 4 voices) |
| P1 Local      | Everything the local player does or receives (jump, land, dive, grab, stun, fall scream, checkpoint, respawn, prop pickup by self) | P0 only                          |
| P2 Hazard     | Obstacle telegraphs and hits within 25 m, tile warn/crack under or near the local player, cannon fire, punch wall telegraph        | P0, P1                           |
| P3 Near world | Remote Tumbler actions within 12 m (top 8 nearest), obstacle one-shots 25–45 m                                                     | P0–P2                            |
| P4 Loops      | Obstacle loops (whirr, hum, fan), belly-slide loops of others, slime bubbles                                                       | P0–P3                            |
| P5 Detail     | Remote footsteps, distant one-shots, cosmetic emote sounds, confetti sparkle                                                       | anyone                           |

**Stealing algorithm** (on `play()` when full):

1. Candidate set = voices with priority class strictly lower (larger number) than
   the new sound; if none, candidates = same class.
2. Score each candidate: `score = class*1000 + (1 - audibleGain)*500 + ageMs/10`
   where `audibleGain` is the voice's current distance-attenuated gain × bus gain.
   Steal the highest score.
3. If the new sound's own estimated audible gain is below the quietest candidate's,
   drop the new sound instead (counts as "virtualised" in the debug overlay).
4. A stolen voice fades out over 12 ms (`gain.setTargetAtTime(0, t, 0.004)`),
   then `stop()`. Never hard-stop a playing buffer (clicks).
5. Stolen or culled **loops become virtual**: they keep their phase clock
   (`startTime`) and resume at the correct offset when a voice frees and they
   are in range again (fade in 150 ms).

**Per-id caps** (`maxInstances`, oldest stolen first within the id): footsteps 9
(local + 8), land 6, jump 6, dive 4, stun 4, bounce 5, grab 4, fall scream 3,
tile crack 6, cannon fire 3, ball bounce 4, paint splat 6, confetti 2,
crowd one-shots 2, UI hover 2, every other id 3.

**Retrigger guard**: same id + same emitter within `minIntervalMs` (default 40,
footsteps 90, UI hover 60, tile shake 120) is ignored.

### 1.6 Spatial audio

- One `AudioListener` driven every render frame. **Listener position** =
  `lerp(cameraPos, localTumblerPos, 0.65)`; **orientation** = camera forward/up.
  This keeps the local Tumbler loud and centred while the camera orbits, but
  preserves left/right from the camera's point of view.
- Spatial voices: `PannerNode` with
  - `panningModel`: `HRTF` per tier rules above, else `equalpower`.
  - `distanceModel: 'inverse'`.
  - Defaults: `refDistance 3`, `rolloffFactor 1.1`, `maxDistance 60`.
  - Large obstacles (spinwheel, sweeper, cannon, rising goo, boulders, drum):
    `refDistance 6`, `rolloffFactor 0.8`, `maxDistance 90`.
  - Directional sources (cannon muzzle, fan, punch wall): `coneInnerAngle 90`,
    `coneOuterAngle 220`, `coneOuterGain 0.35`.
- **Air absorption**: every spatial voice has an `LP` whose cutoff =
  `clamp(18000 * (1 - d/120), 2500, 18000)` Hz, updated at 15 Hz (not per frame).
- **Distance culling**: a one-shot is not started if its estimated attenuated gain
  < -48 dB or distance > `maxDistance`. Loops beyond `maxDistance + 10 m` go
  virtual; they come back below `maxDistance` (10 m hysteresis).
- **Occlusion** (High/Ultra only): one BVH raycast per loop per 200 ms from
  listener to source; occluded → extra LP 1.2 kHz and -4 dB over 250 ms.
- Local-player sounds route to `sfxLocal`, **non-spatial**, panned centre with a
  slight stereo width (`StereoPannerNode` ±0.1 jitter) — the player is always
  "in your hands".
- Remote player position for audio uses the **interpolated** render position,
  never extrapolated, so sounds don't jitter.
- Spectator mode: listener follows the spectated Tumbler; their sounds are
  treated as "local" (P1, `sfxLocal`) with -3 dB.

### 1.7 Per-player throttling for 40 players

Recomputed at 10 Hz: sort remote Tumblers by distance to listener.

| Sound family                  | Who gets it                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Footsteps                     | local + **nearest 8** remote within 15 m. Remote steps at -6 dB and P5                                         |
| Jump / land / dive / get-up   | local + nearest 12 within 25 m                                                                                 |
| Grab start/release, struggle  | local + any grab involving the local player + nearest 4                                                        |
| Stun boing                    | local + nearest 6 within 30 m; others contribute to "pile-up" counter                                          |
| Fall scream                   | local + nearest 3 (cooldown 2.5 s per player)                                                                  |
| Bounce pad / bumper hits      | per obstacle instance cap 2 per 150 ms; extra hits raise that voice's gain +1 dB (max +4) instead of new voice |
| Qualify / eliminate of others | never per-player SFX; the crowd bed reacts (§4.3) and HUD ticks                                                |
| Belly slide loop              | local + nearest 3                                                                                              |

**Clustering**: if ≥ 5 `land` or `stun` events occur within 200 ms inside a 6 m
radius, collapse them into one `sfx_crowd_pileup` (§5.9) at the cluster centroid,
and notify the announcer system (pile-up line, §6).

### 1.8 Autoplay unlock & lifecycle

- `AudioContext` is created lazily with `{ latencyHint: 'interactive' }` at boot,
  in `suspended` state. The first `pointerdown`, `touchend` or `keydown` on the
  "Click to start" splash (SPEC §14.1) calls `ctx.resume()` and immediately plays
  a 1-sample silent buffer (iOS Safari requirement), then the logo sting
  (`mus_stinger_logo`, §2.18).
- Keep listening for the gesture on `document` with `{ capture: true, once: false }`
  until `ctx.state === 'running'` — iOS can re-suspend (`'interrupted'`) after
  calls / Siri; on `statechange` back to `suspended`/`interrupted`, re-arm the
  gesture unlock and show a tiny "Tap for sound" chip.
- Where supported set `navigator.audioSession.type = 'playback'` (Safari 16.4+) so
  the hardware mute switch does not silence the game unexpectedly; expose a
  setting "Respect silent switch" (default on → leave `'auto'`).
- `visibilitychange` hidden → fade master 300 ms then `ctx.suspend()`; visible →
  `resume()`, fade in 300 ms, resync the music sequencer to `matchTime()`.
- One-shot pre-rendering (§7.6) may start before unlock: `OfflineAudioContext`
  does not need a gesture.
- Never create more than one `AudioContext`. Sample rate = context default (44.1 or
  48 kHz); pre-renders use the same rate.

### 1.9 Reverb

- **Convolver IRs are procedural**: stereo `wn` multiplied by
  `exp(-t * 6.9 / RT60)`, pre-delay, then LP at `damp` Hz, decorrelated L/R seeds.
  Rendered once per theme at round load (≤ 3 s × 2 ch).
- Theme IRs:

| Theme        | RT60  | Pre-delay | Damp LP                              | Character       |
| ------------ | ----- | --------- | ------------------------------------ | --------------- |
| candy        | 1.1 s | 12 ms     | 7 kHz                                | sweet hall      |
| factory      | 1.6 s | 20 ms     | 5 kHz + PK 900 Hz +3 dB (metallic)   | warehouse       |
| frosty       | 2.0 s | 25 ms     | 9 kHz (bright)                       | ice cavern      |
| jungle       | 0.9 s | 8 ms      | 4 kHz                                | dense foliage   |
| sunset       | 1.0 s | 15 ms     | 6 kHz                                | boardwalk       |
| space        | 2.6 s | 40 ms     | 8 kHz, + 380 ms feedback echo -18 dB | cosmic          |
| beach        | 0.6 s | 5 ms      | 5 kHz                                | open air        |
| neon         | 1.4 s | 18 ms     | 10 kHz                               | arcade hall     |
| castle       | 2.2 s | 30 ms     | 4.5 kHz                              | stone courtyard |
| goo          | 1.3 s | 15 ms     | 3.5 kHz (murky)                      | gloopy pit      |
| menu / lobby | 0.8 s | 10 ms     | 8 kHz                                | studio          |

- Low tier FDN: two `DelayNode`s 37 ms and 53 ms, cross-feedback 0.45 through LP
  4 kHz, wet -16 dB.
- Per-voice reverb send defaults: local 0.12, world 0.25, obstacles 0.3,
  announcer 0.06, UI 0.

---

## 2. Music system

### 2.1 Engine

- **Sequencer**: classic lookahead scheduler — a 25 ms `setInterval` (or a worker
  timer) schedules all notes falling within the next 120 ms on the audio clock.
  Patterns are data (`packages/audio/src/music/tracks/<id>.ts`): per layer, a list
  of `{ bar, step(1/16), note, len, vel }`. 16 steps per bar in 4/4, 12 per bar in
  6/8 and 12/8 (triplet grid).
- **Instruments** are recipes rendered as a small multisample at load: one note
  per octave (C2, C3, C4, C5, C6, 1.5–3 s each) via `OfflineAudioContext`, played
  back with `playbackRate = 2^(semitones/12)` from the nearest root. Exceptions
  that stay **live** (need continuous modulation): mono lead (vibrato, portamento),
  bass (filter envelope), pads (filter automation by game state).
- **Drums** are one-shot buffers (§2.2) triggered by the sequencer.
- **Layers / stems**: every track has these layer gains (each a `GainNode` into
  `musicLoop`): `base` (drums + bass + pad), `melodyA`, `melodyB`, `intensity`,
  `final30`, `colour` (finals only), and the `stinger` path.
- **Sync**: in rounds, bar 1 of loop A is aligned so that the downbeat lands on
  `GO` (COUNTDOWN end). The sequencer clock is derived from `matchTime()` so
  spectators and late joiners hear the same musical position. Track position
  `beat = (matchTime - musicT0) * BPM / 60`.
- **Key transposition**: global `transpose` semitones param applied to note
  numbers at schedule time (used by final-30 s key lifts).
- **Tempo changes** only at bar lines, ramped over one bar (`bpm` interpolated per
  step).

### 2.2 Shared drum kit (pre-rendered, per-track tweaks noted in each track)

| Drum                  | Recipe                                                                                                                    | Length   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| `kick`                | sin f: 150→48 Hz /60 exp; AD 1/220; + click wn HP 2 kHz AD 0/3 @ -18 dB; ws 1.5                                           | 260      |
| `kick_soft`           | sin f: 120→55 /50 exp; AD 2/180; no click                                                                                 | 200      |
| `snare`               | tri 185 Hz + tri 330 Hz AD 0/70 @ -6 dB; wn HP 1.2 kHz → BP 3 kHz Q0.7 AD 0/160                                           | 200      |
| `clap`                | 3× wn bursts 10 ms apart (AD 0/8 each) + tail AD 0/180, all BP 1.1 kHz Q1.2; HP 600                                       | 230      |
| `hat_c`               | 6 sqr at 205.3, 304.4, 369.6, 522.7, 540, 800 Hz summed → BP 10 kHz Q1 → HP 7 kHz; AD 0/40. Low tier: wn HP 8 kHz AD 0/35 | 50       |
| `hat_o`               | as hat_c, AD 0/280; choked by any hat_c on the same track                                                                 | 300      |
| `ride`                | as hat_c ×1.4 freq, BP 8 kHz, AD 0/600 @ -6 dB + sin 3.1 kHz AD 0/400 @ -18                                               | 650      |
| `crash`               | wn HP 3 kHz + hat partials, AD 2/1400, LP filt env 14k→6k /1400                                                           | 1500     |
| `tom_h` / `tom_l`     | sin f: 260→160 /120 exp, AD 1/250 (low: 160→95) + wn BP 1 kHz AD 0/20 @ -20                                               | 280      |
| `rim`                 | sin 1.7 kHz AD 0/15 + wn BP 3 kHz Q4 AD 0/10                                                                              | 30       |
| `shaker`              | wn BP 6 kHz Q2, env 15/60 (attack matters: "shk")                                                                         | 80       |
| `tamb`                | shaker + 3 sin jingles 6.8, 7.9, 9.1 kHz AD 0/120 @ -12                                                                   | 150      |
| `woodblock`           | sin 1.2 kHz + sin 1.8 kHz AD 0/40                                                                                         | 50       |
| `cowbell`             | sqr 540 + sqr 800 Hz → BP 2.6 kHz Q1.5, AD 0/250                                                                          | 260      |
| `bongo_h` / `bongo_l` | sin f: 380→330 /30 (low 260→230), AD 0/120 + wn tick AD 0/2                                                               | 130      |
| `conga`               | sin f: 220→196 /40, AD 0/260 + wn BP 2 kHz AD 0/8 @ -14                                                                   | 280      |
| `clave`               | sin 2.5 kHz AD 0/25                                                                                                       | 30       |
| `tick` (clock)        | sqr 3.2 kHz AD 0/6 → BP 3.2 kHz Q8                                                                                        | 10       |
| `tock`                | sqr 2.1 kHz AD 0/8 → BP 2.1 kHz Q8                                                                                        | 12       |
| `snare_roll`          | snare retriggered at 1/32 with velocity ramp 0.3→1                                                                        | per bars |
| `chip_noise`          | 15-bit LFSR noise (pre-rendered, "NES style") AD 0/60, short mode for hats                                                | 60       |
| `reverse_cymbal`      | crash reversed, 1 bar long at track tempo (rendered per track)                                                            | 1 bar    |

### 2.3 Shared synth voices

| Voice                 | Recipe                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lead_square`         | sqr, env 5/120/0.7/120, vib 5 Hz ±15 c (delay 180), LP 4.5 kHz Q0.8, portamento 30 ms when legato                                                     |
| `lead_whistle`        | sin + wn BP 2 kHz Q3 @ -24 dB (breath), env 30/80/0.85/150, vib 5.5 Hz ±18 c (delay 200)                                                              |
| `lead_saw`            | 2× saw det ±8 c, LP 3 kHz Q2 filt env 6k→3k /200, env 3/150/0.6/180                                                                                   |
| `pluck`               | tri + sqr @ -12 dB, LP filt env 2.4k→600 /180, AD 2/220. Alternative Karplus-Strong (wn burst into 1-sample-period delay with LP 3 kHz feedback 0.96) |
| `marimba`             | FM 1:4 I 3→0 /120, sin carrier, AD 1/500                                                                                                              |
| `glock`               | FM 1:3.5 I 2→0 /300, AD 1/900                                                                                                                         |
| `celesta`             | FM 1:4 I 1.2→0 /150 + sin ×2 @ -18, AD 1/1100                                                                                                         |
| `steel_drum`          | FM 1:2.01 I 2.2→0.4 /250 + sin ×3.99 @ -20, AD 3/700                                                                                                  |
| `bell`                | FM 1:1.4 I 4→0.5 /900, AD 1/2500                                                                                                                      |
| `brass`               | 3× saw det ±6 c, LP filt env 500→3.2k /80 then →1.8k /300, env 30/100/0.8/200, vib 5 Hz ±10 c (delay 300)                                             |
| `strings_pad`         | 4× saw det ±4/±11 c, LP 2.2 kHz Q0.5, env 300/0/1/600, AM 4.5 Hz 0.05                                                                                 |
| `pad_soft`            | 2× tri det ±7 c + saw @ -12, LP 1.1 kHz Q0.5, env 400/0/1/800                                                                                         |
| `organ`               | sin at 1×, 2×, 3×, 4× (drawbars 8 6 4 3), env 5/0/1/40, AM 6.5 Hz 0.15 (Leslie-ish)                                                                   |
| `bass_sub`            | sin + tri @ -6, env 5/300/0.6/80, LP 600                                                                                                              |
| `bass_pluck`          | saw, LP filt env 1.8k→250 /150 Q4, env 2/180/0.4/80                                                                                                   |
| `bass_wah`            | saw, BP LFO-swept 300↔1.4 kHz Q6 (rate locked to 1/8 note), env 5/0/1/60                                                                              |
| `bass_tri_chip`       | tri (4-bit quantised via ws staircase curve), env 0/0/1/20                                                                                            |
| `pulse12` / `pulse25` | pulse(12.5%) / pulse(25%), env 0/60/0.6/40, no filter (chip)                                                                                          |
| `arp_saw`             | saw, LP 2.8 kHz Q6 filt env per note 5k→1.2k /90, env 1/90/0/30                                                                                       |
| `choir_ooh`           | 3× saw → 2 parallel BP formants 400 Hz Q8 + 800 Hz Q8 (vowel "oo"), env 250/0/1/500, vib 5 Hz ±8 c                                                    |
| `kazoo`               | saw → BP 1.1 kHz Q4 + BP 2.4 kHz Q6, ws 3, vib 6 Hz ±25 c                                                                                             |
| `accordion`           | 2× pulse(30%) det ±12 c (musette), env 30/0/1/80, AM 5.5 Hz 0.1                                                                                       |
| `harp`                | pluck with LP 5 kHz, AD 1/1400                                                                                                                        |
| `sitar_twang`         | pluck + ws 4 + BP sweep 2k→600 /200 Q5                                                                                                                |

### 2.4 Global stem & transition rules

| Rule                               | Value                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intro → Loop A                     | at end of intro, sample-accurate (sequencer continuous)                                                                                                            |
| Loop A ↔ Loop B                    | alternate A,A,B,A,B,B… (seeded per round) at 16-bar boundaries                                                                                                     |
| Intensity layer in                 | quantised to **next bar**, fade 1 bar (linear gain 0→1)                                                                                                            |
| Intensity layer out                | quantised to next 2-bar boundary, fade 2 bars; minimum hold 8 bars (hysteresis)                                                                                    |
| Final-30 s layer                   | quantised to **next beat** (urgency), fade 1 beat; tempo ramp over 1 bar; key lift applied at next bar line                                                        |
| Stingers                           | play **immediately** (no quantise) for gameplay events; GO is pre-scheduled on the downbeat; stingers ending ≥ 2 beats are followed by loop resumption at next bar |
| Track change (round → round)       | 1.2 s fade-out of old track on ROUND_END; RESULTS uses `mus_results_wall`; new track starts on INTRO_FLYOVER with intro stem                                       |
| Menu ↔ lobby ↔ matchmaking         | same track (`mus_lobby_tumbletown`), state changes via layers/filters only, never restart                                                                          |
| Crossfade between different tracks | 1.5 s equal-power, aligned to the outgoing track's next bar if ≤ 1.5 s away, else immediate                                                                        |
| Overtime                           | final-30 layer forced on, + `overtime` stinger; tempo +4 % more                                                                                                    |
| ROUND_END slow-mo                  | sequencer tempo ramps to 80 % over 1.5 s, LP 20k→1.8k; then round-over stinger                                                                                     |
| Pause                              | layers unchanged, music bus ducked + LP (§1.4)                                                                                                                     |

**Countdown alignment**: COUNTDOWN is 3 s + GO. The intro stem plays its last
bar during the countdown with `count_tick` UI sounds on beats; the GO stinger is
scheduled exactly at `PLAYING` start = loop A bar 1 downbeat. If tempo makes 3 s
not equal to an integer number of beats, the intro's last bar is time-stretched by
scheduling (tempo nudged ±6 % over the countdown), never the countdown itself.

### 2.5 Adaptive parameter table (all tracks)

| Game state (source)                                                                      | Drives                                                                    | Mapping                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| Race: `qualifiedCount / qualifyTarget` (RoundStatus)                                     | `intensity` layer                                                         | on when ≥ 0.70, off when < 0.60 (hysteresis) |
| Race: qualifiedCount ≥ target − 3 ("last spots")                                         | `last-spots` stinger + hats double-time                                   | one-shot + layer flag                        |
| Race: local player in top 10 % of progress                                               | `leader` sparkle sub-layer (glock/celesta countermelody)                  | on/off, 1-bar fade                           |
| Race: local player qualified                                                             | music LP to 6 kHz, -2 dB (spectating calm)                                | 2 s ramp                                     |
| Survival: `timeLeft`                                                                     | `final30` layer when ≤ 30 s; at ≤ 10 s hats → 1/32 and HP sweep 20→180 Hz | thresholds                                   |
| Survival: `alive / startPlayers`                                                         | `intensity` when ≤ 0.5 or alive ≤ eliminationTarget + 3                   | threshold                                    |
| Team: `                                                                                  | ownScore − leaderScore                                                    | `                                            | `intensity` when own team losing or margin ≤ 1 goal / 5 % | threshold |
| Team: own team leading                                                                   | `melodyB` swapped in at next 16-bar boundary ("winning" variation)        | flag                                         |
| Hunt: `timeLeft` ≤ 30 s                                                                  | `final30`                                                                 | threshold                                    |
| Hunt: local holds tail/key                                                               | `holder` pulse layer (filtered saw 1/8 pulse) + LP opens 2k→12k           | flag                                         |
| Logic: phase (memorise / answer / reveal / drop)                                         | stem selection in `mus_logic_ticktock`                                    | state                                        |
| Final: `alive ≤ 3` or crown height reached by anyone (Crown Climb: leader height ≥ 75 %) | `intensity`                                                               | threshold                                    |
| Final: `alive == 2`                                                                      | `showdown` = final30 layer + key lift +1 st                               | threshold                                    |
| Any: local player stunned                                                                | music LP 20k→2.5k for stun duration, 80 ms in, 300 ms out                 | continuous                                   |
| Any: local player falling into void (Fall + below kill height − 5 m)                     | music HP 20→600 Hz + pitch-free                                           | continuous                                   |
| Any: local in slime/goo (`InSlime` flag)                                                 | music LP 1.2 kHz Q2 ("underwater"), ambience LP same                      | flag                                         |
| Any: local ghost after respawn                                                           | music shimmer (AM 8 Hz 0.1 on pad)                                        | flag                                         |
| Weather `stormy`                                                                         | music LS 120 Hz −2 dB (leaves room for thunder)                           | round const                                  |
| Weather `night`                                                                          | music HS 6 kHz −2 dB, reverb +2 dB                                        | round const                                  |
| Player count alive (lobby)                                                               | crowd bed density                                                         | linear                                       |
| Show stage (round index 1..N)                                                            | +2 BPM per round (rounds 2+), final tracks unaffected                     | per round                                    |
| `RoundPhase.RoundEnd`                                                                    | tempo 100 %→80 %, LP sweep                                                | phase                                        |

### 2.6 Stinger set (shared structure, re-voiced per track)

Each track defines six in-key stingers (note material below is in **track key
degrees**, voiced with the listed instrument of that track). All end on a
sustained chord tone with a 600 ms tail. Stingers are pre-rendered per track at
round load (6 × ≤ 3 s).

| Stinger       | Musical content (degrees)                                                                                      | Length | Common recipe                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| `go`          | Snare flam + crash; lead plays 1-3-5-8 as 1/16 run into 8 held 1 beat; brass stab on I                         | 1 bar  | always on downbeat                                  |
| `qualify`     | 5-6-5-3-2-3-1 (show leitmotif, §2.7), glock + lead, I chord pad swell                                          | 1.8 s  | local qualified only                                |
| `eliminate`   | Descending 5-4-3-♭3 (trombone-ish `brass` with LP 1.2k, portamento 120 ms "wah-wah"), last note vib 6 Hz ±50 c | 2.0 s  | local eliminated only                               |
| `last_player` | Rising chromatic 5-♯5-6-♭7 in 1/8 triplets + snare roll + reverse cymbal into downbeat                         | 1.5 s  | "last spots" / last survivor slot / final 2 players |
| `overtime`    | Clock `tick`×4 accelerating + tritone stab (1 + ♯4) + kick-crash                                               | 1.2 s  | overtime start                                      |
| `round_over`  | Big I chord hit (all layers), crash, then whistle "fwee-oop" (sin 1.2k→2.4k /150 → 900 /200)                   | 2.4 s  | ROUND_END                                           |

### 2.7 The show leitmotif ("Tumble Tune")

Scale degrees **5-6-5-3 | 2-3-1** — rhythm `♪ ♪ ♩ ♩ | ♩. ♪ 𝅗𝅥`. In F major:
C D C A | G A F. It is quoted in: lobby melody A, every `qualify` stinger, the
victory fanfare (augmented), the Player Wall theme, the level-up jingle, and the
logo sting. Hearing it should mean "good things happen".

---

### 2.8 `mus_lobby_tumbletown`

|               |                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------ |
| Use           | Main menu, Locker/Store/Pass/etc., matchmaking, pre-show waiting platform, tutorial island |
| Tempo / meter | 112 BPM, 4/4, 16ths swung 56 %                                                             |
| Key / mode    | F major (Ionian)                                                                           |
| Mood          | Sunny Saturday-morning toy town; welcoming, bouncy, a little cheeky                        |

**Instrumentation**

| Role        | Voice                                                           | Notes                                                              |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Lead        | `lead_whistle`                                                  | plays the leitmotif; vib 5.5 Hz ±18 c after 200 ms                 |
| Counter     | `glock`                                                         | answers lead phrases an octave up                                  |
| Comp        | `pluck` (ukulele)                                               | off-beat 1/8 strums, 4-note voicings in C4–A4                      |
| Bass        | `bass_sub`                                                      | root-fifth bounce on beats 1 and 3, walk-up 1/8 into chord changes |
| Pad         | `pad_soft`                                                      | sustained chords, LP 1.1 kHz                                       |
| Party layer | `kazoo` harmony a 3rd below lead + `tamb` 1/8 + `clap` on 2 & 4 |                                                                    |

**Drums**: `kick_soft` on 1 and 3 (plus the "and" of 4 every 2nd bar), `rim` on 2
and 4, `shaker` swung 1/16, `hat_o` on the "and" of 4 every 4th bar.

**Progressions**

| Section                 | Roman                                                      | Chords (1 bar each)                                    |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| A (8 bars ×2)           | I – vi – IV – V7 – I – vi – ii7 – V7                       | F – Dm – B♭ – C7 – F – Dm – Gm7 – C7                   |
| B (8 bars ×2)           | ii7 – V7 – Imaj7 – IVmaj7 – iii7 – vi7 – ii7 – V7sus4 → V7 | Gm7 – C7 – Fmaj7 – B♭maj7 – Am7 – Dm7 – Gm7 – Csus4→C7 |
| Pre-show riser (4 bars) | IV – V – ♭VI – ♭VII                                        | B♭ – C – D♭ – E♭                                       |

**Motif**: A = leitmotif (5-6-5-3 | 2-3-1) then answer 3-4-5-1' (A B♭ C F) in
1/8s with a held top. B = stepwise call 1-2-3-5 (♩♩♩𝅗𝅥) answered by the glock
3-2-1 in 1/16s.

**Stems**

| Stem                                | Bars    | Content / trigger                                                                                                                                                                                                                       |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intro                               | 4       | pluck + glock leitmotif, no drums; plays after splash or when entering menu from a show                                                                                                                                                 |
| Loop A                              | 16      | full base + lead                                                                                                                                                                                                                        |
| Loop B                              | 16      | base + glock/pluck lead, lead whistle rests (less fatigue when idling)                                                                                                                                                                  |
| Intensity ("party")                 | —       | party layer on when party size ≥ 2, in pre-show lobby, or when the player knocks a party member off in idle play (holds 8 bars)                                                                                                         |
| Final-30 analogue ("show starting") | 4 + hit | pre-show lobby countdown ≤ 10 s: drums switch to `kick` four-on-floor + `snare_roll`, pre-show riser progression, music HP 20→400 Hz over 10 s, then `show_start` hit (I chord + crash + whoosh) and hard handover to round track intro |
| Matchmaking ("searching")           | loops A | drums removed except `shaker` + `tick` on every beat; pad + pluck only; LP 3 kHz; counter ticks UI-synced                                                                                                                               |

**Stingers**: `go` not used. `match_found` = leitmotif on `glock` + `bell` in 1/16
(fast, 1 beat) + cymbal swell 400 ms. `logo` (§2.18). `party_join` = pluck 1-3-5
arpeggio 1/16 + clap.

---

### 2.9 `mus_candy_sugarrush`

|               |                                                  |
| ------------- | ------------------------------------------------ |
| Rounds        | Gumdrop Gauntlet (race), Tile Panic (survival)   |
| Tempo / meter | 150 BPM, 4/4 straight                            |
| Key / mode    | C major with Lydian ♯4 colour in melody B        |
| Mood          | Sugar-high sprint, bubblegum pop, giddy and fast |

| Role      | Voice                                                                               |
| --------- | ----------------------------------------------------------------------------------- |
| Lead      | `lead_square` (pulse 50 %), vib 5 Hz ±15 c, slides of 30 ms between 1/16 neighbours |
| Hook      | `glock` doubling lead on chorus hits                                                |
| Comp      | `pluck` on 1/8 offbeats + `organ` stabs on 2 & 4 (B section)                        |
| Bass      | `bass_pluck` octave-bounce 1/8 (root, root+12)                                      |
| Pad       | `strings_pad` LP 2.5 kHz                                                            |
| Ear candy | "bubble pop" (sin f: 300→900 /40, AD 1/60) on random 1/16 at vel 0.4, 2 per bar     |

**Drums**: `kick` four-on-floor, `clap` on 2 & 4 layered with `snare`, `hat_c`
1/16 with accent on offbeats, `hat_o` on "and" of every beat in intensity.

**Progressions**

| Section                       | Roman                                 | Chords                                                       |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| A                             | I – V – vi – IV (×4)                  | C – G – Am – F                                               |
| B                             | IV – V – iii – vi – ii – V – I – ♭VII | F – G – Em – Am – Dm – G – C – B♭                            |
| Tile Panic variant (survival) | vi – IV – I – V                       | Am – F – C – G (same instruments, minor-leaning for tension) |

**Motif**: A = 3-3-5-3 | 2-1-2-(rest) in 1/8 (E E G E | D C D -), repeated with
answer 3-5-6-♯4-5 (Lydian lick, B section). Hook rhythm: syncopated
`♪ ♪ ♪(tied) ♪ ♩`.

**Stems**

| Stem      | Bars | Trigger / content                                                                                                                                      |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intro     | 8    | 4 bars pad + glock motif filtered LP 800→8k, 4 bars full band without lead (the countdown sits on bars 7–8)                                            |
| Loop A    | 16   | base + lead                                                                                                                                            |
| Loop B    | 16   | base + organ + Lydian lick lead                                                                                                                        |
| Intensity | —    | Race: qualified ≥ 70 %. Survival: alive ≤ 50 %. Adds `hat_o` offbeats, octave-up lead double (`glock`), `clap` rolls every 4th bar, bass becomes 1/16  |
| Final-30  | —    | Survival (Tile Panic) ≤ 30 s, Race last spots: tempo 150→158, key +1 st (C→D♭) at next bar, `snare_roll` on bar 4 of every 4, LP on pad opens to 8 kHz |
| Leader    | —    | celesta countermelody 5-6-8 sparkle 1/16                                                                                                               |

**Stingers**: per §2.6 voiced on `lead_square` + `glock`; `round_over` adds a
"candy wrapper crinkle" (wn BP 4 kHz Q1 with AM 40 Hz random, 300 ms).

---

### 2.10 `mus_factory_clockwork`

|               |                                                             |
| ------------- | ----------------------------------------------------------- |
| Rounds        | Conveyor Chaos (race), Spin Cycle (survival)                |
| Tempo / meter | 128 BPM, 4/4 (machine-tight, no swing)                      |
| Key / mode    | D Dorian                                                    |
| Mood          | Toy factory gone overtime: clanky, funky, mechanical groove |

| Role            | Voice                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Lead            | `lead_saw` with BP 1.6 kHz Q3 ("robot trumpet"), 1/16 staccato                                                           |
| Mechanical perc | "clank" FM 1:1.41 I 6→0 /80, AD 0/120 at D3; "piston" wn LP 900 filt env 300→2k /60 AD 5/90; "ratchet" 8× `tick` at 1/64 |
| Comp            | `organ` with AM 6.5 Hz, stabs on offbeat 8ths                                                                            |
| Bass            | `bass_wah` locked to 1/8                                                                                                 |
| Pad             | `pad_soft` with LP 900 Hz, sidechain-style pump (gain dip 40 % on every kick, recover 120 ms)                            |

**Drums**: `kick` on 1, "and" of 2, 3; `snare` on 2 & 4 with `clap`; `hat_c`
1/16 swung 0 %; `cowbell` on bar-4 fills; clank on every "e" of beat 4.

| Section | Roman                                                  | Chords                                       |
| ------- | ------------------------------------------------------ | -------------------------------------------- |
| A       | i7 – IV7 – i7 – IV7                                    | Dm7 – G7 – Dm7 – G7 (2 bars each, 16 bars)   |
| B       | ♭VIImaj7 – IV7 – i7 – v7 → ♭VII – ♭III – IV – IV7(♯11) | Cmaj7 – G7 – Dm7 – Am7 → C – F – G – G7(♯11) |

**Motif**: Dorian riff 1-♭3-4-6-4-♭3 (D F G B G F) in 1/16, rest, repeat
transposed to 4 (G B♭ C E C B♭). The natural 6 (B) is the "gear click" note.

| Stem                  | Bars | Trigger / content                                                                                                                                                                                   |
| --------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intro                 | 4    | ratchet + piston + filtered bass "machine starting" (tempo ramps 90→128 BPM over 4 bars like a motor spinning up)                                                                                   |
| Loop A                | 16   | base + riff                                                                                                                                                                                         |
| Loop B                | 16   | base + organ lead + clank melody                                                                                                                                                                    |
| Intensity             | —    | Conveyor Chaos: qualified ≥ 70 %. Spin Cycle: second sweeper layer accelerates / alive ≤ 50 %. Adds 1/16 cowbell, "alarm" pad (sqr 2 notes ♭2 apart, LP 1.5k, AM 4 Hz), bass up an octave on beat 4 |
| Final-30              | —    | Spin Cycle ≤ 30 s: tempo +6 % (tracks sweeper acceleration feel), key +2 st (D→E Dorian), snare 1/8, conveyor-reverse "klaxon" quote                                                                |
| Conveyor reverse sync | —    | on any `conveyorBelt.reverseWarn` cue within 30 m, the music does a 1-beat "tape stop" (playbackRate 1→0.5 /200 on base layer) then back                                                            |

**Stingers**: voiced on `lead_saw` + clank; `round_over` ends with a steam hiss
(wn HP 3 kHz AD 20/700) and a factory whistle (sin 880 + 1320 Hz, vib 6 Hz, 600 ms).

---

### 2.11 `mus_sunset_boardwalk`

|               |                                                          |
| ------------- | -------------------------------------------------------- |
| Rounds        | Tilt Town (race), Bounce Ball Blitz (team)               |
| Tempo / meter | 104 BPM, 4/4 with half-time shuffle (16ths swung 62 %)   |
| Key / mode    | B♭ major, Mixolydian (A♭) borrowed in B                  |
| Mood          | Golden-hour seaside pier: warm, groovy, playful funk-pop |

| Role      | Voice                                                                        |
| --------- | ---------------------------------------------------------------------------- |
| Lead      | `organ` (drawbars 8 8 6 0), Leslie AM 6.5 Hz                                 |
| Horns     | `brass` section stabs, 2 voices in 3rds                                      |
| Comp      | `pluck` funk chicken-scratch (wn BP 2.5 kHz burst + muted note) 1/16         |
| Bass      | `bass_pluck` with slide (portamento 60 ms)                                   |
| Pad       | `strings_pad` LP 2 kHz                                                       |
| Ear candy | seagull-ish slide whistle (sin 1.4→2.2 kHz /180 → 1.6 kHz /120) every 8 bars |

**Drums**: `kick_soft` 1 and "a" of 2; `snare` 3 (half-time) + ghost notes vel
0.25; `hat_c` swung 16ths; `tamb` on 2 & 4; `conga` fills.

| Section | Roman                              | Chords                                |
| ------- | ---------------------------------- | ------------------------------------- |
| A       | I – iii – IV – ♭VII                | B♭ – Dm – E♭ – A♭                     |
| B       | vi – ii – V – I → IV – iv – I – V7 | Gm – Cm – F – B♭ → E♭ – E♭m – B♭ – F7 |

**Motif**: 1-2-4-5 | 5-♭7-5 (B♭ C E♭ F | F A♭ F) — the ♭7 gives the boardwalk
swagger. Rhythm `♪. ♬ ♩ | ♩ ♪ ♩.`.

| Stem         | Bars | Trigger / content                                                                                                                                      |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intro        | 4    | organ swell + conga, horns hit on bar 4                                                                                                                |
| Loop A       | 16   | base + organ lead                                                                                                                                      |
| Loop B       | 16   | base + horns lead                                                                                                                                      |
| Intensity    | —    | Tilt Town: qualified ≥ 70 %. Bounce Ball Blitz: own team losing or score margin ≤ 1. Snare moves to 2 & 4 (full time), horn stabs every bar, bass 1/16 |
| Team leading | —    | `melodyB` "victory lap" variant (horns play motif up a 4th)                                                                                            |
| Final-30     | —    | Bounce Ball Blitz ≤ 30 s or Tilt Town last spots: tempo 104→112, `ride` 1/8, key +1 st, crowd bed +3 dB                                                |
| Goal sync    | —    | team goal: 1-bar horn fanfare drop-in (§5.7 goal horn plays in key)                                                                                    |

**Stingers**: voiced on `brass` + `organ`.

---

### 2.12 `mus_frosty_snowglobe`

|               |                                                         |
| ------------- | ------------------------------------------------------- |
| Rounds        | Slip 'n' Spiral (race)                                  |
| Tempo / meter | 138 BPM, 4/4                                            |
| Key / mode    | E minor (Aeolian); melody B in E Dorian (C♯) for a lift |
| Mood          | Snow-globe sleigh-sprint: sparkly, slippery, cosy-tense |

| Role      | Voice                                                                 |
| --------- | --------------------------------------------------------------------- |
| Lead      | `celesta` doubled by `lead_whistle` an octave below                   |
| Sparkle   | sleigh bells: `tamb` with jingle partials ×1.2, 1/8                   |
| Comp      | `harp` arpeggios 1/16 (1-5-8-10)                                      |
| Bass      | `bass_sub` with tri, gliding 40 ms                                    |
| Pad       | `choir_ooh` + `strings_pad` LP 3 kHz                                  |
| Ear candy | "ice tink" (sin 3.1 kHz + 4.7 kHz AD 0/150) on random 1/16, 3 per bar |

**Drums**: `kick` on 1 and 3; `snare` with long tail (AD 0/300 noise, reverb send
0.5) on 2 & 4; `hat_c` 1/8; sleigh bells 1/8; `tom_l` fills.

| Section | Roman                                       | Chords                             |
| ------- | ------------------------------------------- | ---------------------------------- |
| A       | i – VI – III – VII                          | Em – C – G – D                     |
| B       | iv – i – IV(Dorian) – V7 → VI – VII – i – i | Am – Em – A – B7 → C – D – Em – Em |

**Motif**: 5-1'-♭7-5 | ♭6-5-♭3 (B E' D B | C B G) in 1/8 + quarter tail — a
"skating figure" with wide leaps.

| Stem                  | Bars | Trigger / content                                                                                         |
| --------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| Intro                 | 8    | music-box (celesta solo, LP 4k, slight wow AM 0.8 Hz pitch ±8 c) 4 bars, then pad + sleigh bells          |
| Loop A                | 16   | base + lead                                                                                               |
| Loop B                | 16   | Dorian lift, choir lead                                                                                   |
| Intensity             | —    | qualified ≥ 70 %: double-time hats, harp 1/32 runs, boulder-rumble sub (sin 41 Hz AM 3 Hz) under the base |
| Final-30 / last spots | —    | tempo +5 %, key +1 st, sleigh bells 1/16, choir opens LP to 6 kHz                                         |
| Boulder sync          | —    | when a `boulderLane.roll` voice is within 15 m, pad LP dips to 1.5 kHz (room for rumble)                  |

**Stingers**: voiced on `celesta` + `bell`; `eliminate` uses a "snow-globe
shake" (wn BP 7 kHz AM 14 Hz, 600 ms) under the trombone.

---

### 2.13 `mus_castle_jestercourt`

|               |                                                                   |
| ------------- | ----------------------------------------------------------------- |
| Rounds        | Hammer Highway (race)                                             |
| Tempo / meter | 6/8 at dotted-quarter = 100 (eighths at 300/min)                  |
| Key / mode    | G Mixolydian (F natural), B section G Dorian                      |
| Mood          | Silly royal court: jesters, lutes, a pompous-but-goofy procession |

| Role      | Voice                                                                       |
| --------- | --------------------------------------------------------------------------- |
| Lead      | `kazoo` (comic "crumhorn") + `lead_square` LP 2k doubling                   |
| Fanfare   | `brass` (3 voices) in parallel 4ths/5ths                                    |
| Comp      | `harp` (lute) 1/8 arpeggios + `accordion` drones on 1 and 5                 |
| Bass      | `bass_pluck` on dotted quarters (1 and 4 of 6)                              |
| Ear candy | jester bells (`tamb` jingles only, 1/8 triplets) and a "boing" every 8 bars |

**Drums** (6/8 grid): `tom_l` on 1, `tom_h` on 4, `tamb` on 2-3-5-6, `snare`
rolls into phrases, `kick` doubled with tom_l in intensity.

| Section    | Roman              | Chords (1 bar each) |
| ---------- | ------------------ | ------------------- |
| A          | I – ♭VII – IV – I  | G – F – C – G       |
| B          | i – ♭VII – ♭VI – V | Gm – F – E♭ – D     |
| Turnaround | IV – V – I         | C – D – G           |

**Motif**: 1-3-5 | 6-5-♭7-5 (G B D | E D F D) in a galloping `♩ ♪ | ♪ ♪ ♪ ♩ ♪`.
The ♭7 is the jester's wink.

| Stem                  | Bars | Trigger / content                                                                                                                        |
| --------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Intro                 | 4    | herald trumpets (brass) "ta-ta-taaa" (1-1-5) + tom roll                                                                                  |
| Loop A                | 16   | base + kazoo lead                                                                                                                        |
| Loop B                | 16   | Dorian, brass lead, accordion countermelody                                                                                              |
| Intensity             | —    | qualified ≥ 70 % or collapsing bridge cue near local: kick on every dotted quarter, `snare` 1/8, brass stabs on every bar, tempo 100→106 |
| Final-30 / last spots | —    | key +2 st (G→A Mixolydian), `snare_roll` per 2 bars, "chase" lute 1/16                                                                   |

**Stingers**: voiced on `brass` + `kazoo`; `qualify` adds trumpet "royal"
trill; `eliminate` uses a kazoo "wah-wah-waaah".

---

### 2.14 `mus_space_orbitparty`

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| Rounds        | Wind Tunnel Peaks (race, vertical climb)                       |
| Tempo / meter | 120 BPM, 4/4                                                   |
| Key / mode    | A Lydian (D♯)                                                  |
| Mood          | Zero-G disco on a space station: floaty, upward, wonder-filled |

| Role      | Voice                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| Lead      | `lead_saw` with long portamento (80 ms) + delay 3/16 feedback 0.35                                            |
| Arp       | `arp_saw` 1/16 up-down over chord tones, filter opens with intensity                                          |
| Pad       | `strings_pad` + `choir_ooh`, LP 2.5 kHz, slow AM 0.2 Hz pan                                                   |
| Bass      | `bass_sub` octave disco (1/8 root-octave)                                                                     |
| Ear candy | "laser zip" (sin f: 3k→400 /120) on bar 4; "radar ping" (sin 1.8 kHz AD 1/400, delay 1/4 fb 0.5) every 8 bars |

**Drums**: `kick` four-on-floor; `clap` 2 & 4; `hat_o` on offbeats; `hat_c` 1/16
at vel 0.4; reverse cymbal every 8th bar.

| Section | Roman                                        | Chords                                     |
| ------- | -------------------------------------------- | ------------------------------------------ |
| A       | Imaj7 – II – iii7 – II                       | Amaj7 – B/A – C♯m7 – B                     |
| B       | vi7 – II – Imaj7 – ♯iv°/V → IV – V – vi – II | F♯m7 – B – Amaj7 – D♯dim → D – E – F♯m – B |

**Motif**: 1-2-3-♯4-5 (rising Lydian ladder, A B C♯ D♯ E) in 1/8 with a held
♯4 on beat 4 — literally climbing, like the round.

| Stem                  | Bars       | Trigger / content                                                                                                 |
| --------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Intro                 | 8          | radar ping + pad, arp filtered LP 400→3k over 8 bars (lift-off)                                                   |
| Loop A                | 16         | base + lead ladder                                                                                                |
| Loop B                | 16         | choir lead + arp                                                                                                  |
| Intensity             | —          | qualified ≥ 70 % OR local player above 60 % of course height: arp LP opens to 7 kHz, extra octave arp, `ride` 1/8 |
| Height layer          | continuous | `altitude = localY / courseTopY` → pad LP 1.2k→6k, reverb send 0.2→0.45                                           |
| Final-30 / last spots | —          | tempo 120→126, key +2 st (A→B Lydian), snare 1/16 riser per 4 bars                                                |

**Stingers**: voiced on `lead_saw` with delay; `round_over` = "airlock" whoosh
(wn BP 300→3k /600 exp) + I chord.

---

### 2.15 `mus_beach_tikitumble`

|               |                                                                 |
| ------------- | --------------------------------------------------------------- |
| Rounds        | Cannonball Canyon (race), Jump Rope Royale (survival)           |
| Tempo / meter | 116 BPM, 4/4 with calypso/soca 3+3+2 bass                       |
| Key / mode    | G major                                                         |
| Mood          | Tiki-bar party under cannon fire: sunny, bouncy, carefree chaos |

| Role      | Voice                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| Lead      | `steel_drum` (FM 1:2.01), double-stops in 3rds                                                                 |
| Comp      | `pluck` (ukulele) 1/8 + `marimba` offbeats                                                                     |
| Bass      | `bass_pluck` 3+3+2 pattern (dotted-quarter, dotted-quarter, quarter)                                           |
| Pad       | `organ` soft (drawbars 6 0 4 0)                                                                                |
| Ear candy | "tiki whistle" (`lead_whistle` 2 octaves up, 1/16 trills), wave swell (pn LP 600 env 1.5 s / 2 s) every 8 bars |

**Drums**: `kick` on the 3+3+2 accents; `snare` on 3 (+ "and" of 4); `shaker`
1/16; `conga`/`bongo_h`/`bongo_l` interlocking pattern; `cowbell` in
intensity; `clave` son-clave 3-2.

| Section | Roman                                                | Chords                                             |
| ------- | ---------------------------------------------------- | -------------------------------------------------- |
| A       | I – IV – V – I                                       | G – C – D – G                                      |
| B       | vi – ii – V – I → IV – V – iii – vi – ii – V – I – I | Em – Am – D – G → C – D – Bm – Em – Am – D – G – G |

**Motif**: 5-5-6-5-1'-7 | 5-3-2-1 (D D E D G' F♯ | D B A G) in bouncy 1/8 with a
tied syncope across beat 3.

| Stem      | Bars | Trigger / content                                                                                                                                                 |
| --------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intro     | 4    | wave swell + steel drum pickup, conga roll                                                                                                                        |
| Loop A    | 16   | base + steel lead                                                                                                                                                 |
| Loop B    | 16   | marimba lead + whistle answers                                                                                                                                    |
| Intensity | —    | Cannonball: qualified ≥ 70 %. Jump Rope: beam speed tier ≥ 3 or alive ≤ 50 %. Adds cowbell 1/8, `tamb` 1/16, steel drum octave double                             |
| Final-30  | —    | Jump Rope Royale ≤ 30 s: tempo snaps to the jump-rope period multiple (rope period × 2 = 1 bar where possible, clamp 116–132), key +1 st, `snare_roll` per 2 bars |
| Rope sync | —    | Jump Rope Royale: beam pass under local player = `woodblock` accent quantised to nearest 1/16                                                                     |

**Stingers**: voiced on `steel_drum` + `marimba`; `go` uses a cannon "boom" under
the downbeat (see §5.6 cannon fire at -6 dB).

---

### 2.16 `mus_goo_gloopgroove`

|               |                                                                 |
| ------------- | --------------------------------------------------------------- |
| Rounds        | Rising Goo Tower (survival)                                     |
| Tempo / meter | 100 BPM, 4/4, 16ths swung 58 %                                  |
| Key / mode    | E minor pentatonic / E Dorian (funk)                            |
| Mood          | Slimy, sneaky funk; goofy-ominous, the floor is (literally) goo |

| Role      | Voice                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Lead      | `lead_square` through `bass_wah`-style BP envelope follower (fc 500→2.2k per note, Q5) — "talk-box goo"                          |
| Comp      | `organ` clavinet-ish (sqr, LP 2k, AD 1/120) 1/16 funk                                                                            |
| Bass      | `bass_wah` + sub sin octave below                                                                                                |
| Pad       | `pad_soft` LP 700 Hz with slow LFO 0.1 Hz                                                                                        |
| Ear candy | goo bubble "bloop" (sin f: 180→420 /70, AD 3/90, LP 1.2k) on random offbeats; reverse "slurp" (pn BP 400→1.2k /250) every 4 bars |

**Drums**: `kick` 1, "a" of 2, 3; `snare` 2 & 4 with ghost notes; `hat_c` swung
16ths; `clap` stacked on 4 every 2 bars; `conga` fills.

| Section | Roman                   | Chords                     |
| ------- | ----------------------- | -------------------------- |
| A       | i7 – IV7 vamp           | Em7 – A7 (2 bars each, ×4) |
| B       | ♭VImaj7 – V7 – i7 – IV9 | Cmaj7 – B7 – Em7 – A9      |

**Motif**: 1-♭3-4-♭5-4-♭3-1 (E G A B♭ A G E) — the blue note ♭5 "drips" via
60 ms portamento.

| Stem                       | Bars | Trigger / content                                                                                                           |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| Intro                      | 4    | bubbling pad + bass, goo rising "gurgle" (bn LP 300 AM 5 Hz)                                                                |
| Loop A                     | 16   | funk base + talk-box lead                                                                                                   |
| Loop B                     | 16   | clavinet lead + horn stabs (`brass` LP 1.6k)                                                                                |
| Intensity                  | —    | alive ≤ 50 % OR goo surge cue: tempo +4, octave bass, 1/16 hats, goo bubbles ×2 density                                     |
| Goo proximity (continuous) | —    | `d = localY - gooY`: when d < 4 m, music LP lowers 20k→2.2k as d → 0 and a sub drone (sin 38 Hz AM at 2 Hz) rises to -12 dB |
| Final-30                   | —    | ≤ 30 s: key +1 st, tempo 100→108, snare 1/8 on beat 4, horn stabs every bar                                                 |

**Stingers**: voiced on talk-box lead; `eliminate` ends with a "gloop" swallow
(sin 300→80 /250 + bn LP 400 AD 5/300).

---

### 2.17 `mus_jungle_bongobounce`

|               |                                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| Rounds        | Egg Heist (team), Tail Chase (hunt)                                                 |
| Tempo / meter | 124 BPM, 4/4 with 3-against-4 bongo polyrhythm                                      |
| Key / mode    | D Mixolydian                                                                        |
| Mood          | Mischievous jungle caper: tribal-free, toy-like percussion party, sneaky and bouncy |

| Role    | Voice                                                |
| ------- | ---------------------------------------------------- |
| Lead    | `marimba` in octaves                                 |
| Counter | `lead_whistle` "bird calls" (1/32 trills on 5 and 6) |
| Comp    | `pluck` + `kazoo` (jungle "toot") on offbeats in B   |
| Bass    | `bass_sub` round, 1/8 syncopated                     |
| Pad     | `pad_soft` LP 1.4 kHz                                |

**Drums**: `kick` 1 and 3 ("and" of 4); `bongo_h`/`bongo_l` 3-over-4 pattern
(dotted 1/8); `conga` on offbeats; `shaker` 1/16; `woodblock` on 2 & 4; `clap`
in intensity.

| Section | Roman                                   | Chords                          |
| ------- | --------------------------------------- | ------------------------------- |
| A       | I – ♭VII – IV – I                       | D – C – G – D                   |
| B       | ii – IV – ♭VII – I → vi – IV – V – ♭VII | Em – G – C – D → Bm – G – A – C |

**Motif**: 1-2-1-5↓ | ♭7-1 (D E D A↓ | C D) "monkey hop" with octave jumps.

| Stem         | Bars | Trigger / content                                                                                                                      |
| ------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Intro        | 4    | bongo solo + bird calls                                                                                                                |
| Loop A       | 16   | base + marimba lead                                                                                                                    |
| Loop B       | 16   | kazoo/whistle lead                                                                                                                     |
| Intensity    | —    | Egg Heist: own team not 1st, or margin ≤ 2 eggs. Tail Chase: local has no tail. Adds clap, `tom` fills, 1/16 marimba ostinato          |
| Holder layer | —    | Tail Chase: local holds a tail → "sneak" layer: pizzicato-style `pluck` 1/8 walking line + LP opens; Egg Heist: carrying an egg → same |
| Final-30     | —    | ≤ 30 s: tempo 124→132, key +1 st, `snare_roll` per 4 bars, bongos 1/16                                                                 |

**Stingers**: voiced on `marimba` + bird whistle.

---

### 2.18 `mus_neon_arcadeheart`

|               |                                                                     |
| ------------- | ------------------------------------------------------------------- |
| Rounds        | Paint the Plaza (team)                                              |
| Tempo / meter | 140 BPM, 4/4                                                        |
| Key / mode    | F♯ minor (Aeolian)                                                  |
| Mood          | Retro arcade heart-racer: chiptune energy with a modern synth punch |

| Role      | Voice                                                                          |
| --------- | ------------------------------------------------------------------------------ |
| Lead      | `pulse25` with vib 6 Hz ±20 c (delay 150), 1/16 arpeggio ornaments             |
| Harmony   | `pulse12` a 3rd/6th below                                                      |
| Bass      | `bass_tri_chip` 1/8 octave bounce                                              |
| Pad       | `strings_pad` gated 1/16 (gain chopped 0/1 by 1/16 square LFO, duty 60 %)      |
| Ear candy | "coin" blip (sqr B5→E6 1/32) on scoring sync; "power-up" arpeggio every 8 bars |

**Drums**: `chip_noise` hats 1/16; `kick` (+ chip square kick sqr 120→40 /40);
`snare` + `chip_noise` long on 2 & 4; `clap` in B.

| Section | Roman                                | Chords                              |
| ------- | ------------------------------------ | ----------------------------------- |
| A       | i – VI – III – VII                   | F♯m – D – A – E                     |
| B       | iv – v – VI – VII → i – VII – VI – V | Bm – C♯m – D – E → F♯m – E – D – C♯ |

**Motif**: 1-5-♭3'-1' | ♭7-5-♭6-5 (F♯ C♯ A' F♯' | E C♯ D C♯) in 1/16 — "insert coin"
arpeggio rise then a sighing fall.

| Stem         | Bars | Trigger / content                                                                                                |
| ------------ | ---- | ---------------------------------------------------------------------------------------------------------------- |
| Intro        | 4    | "boot-up" chip arpeggio (C major → F♯ minor jump), then a 1-bar silent gap with only `tick`                      |
| Loop A       | 16   | base + pulse lead                                                                                                |
| Loop B       | 16   | gated pad lead + clap                                                                                            |
| Intensity    | —    | own team not leading or margin ≤ 5 % of paint coverage: pulse lead octave up, 1/16 kick rolls, `ride` 1/8        |
| Team leading | —    | `melodyB` "high score" variation                                                                                 |
| Final-30     | —    | ≤ 30 s: tempo 140→150, key +1 st, pad gate 1/32, "warning" chip siren (pulse12 A5↔E5 1/8) on bars 1–2 of every 4 |

**Stingers**: voiced on `pulse25`; `round_over` = "game over" chip descent
(1-5-♭3-1 down an octave, 1/8) + crash.

---

### 2.19 `mus_logic_ticktock`

|               |                                                                      |
| ------------- | -------------------------------------------------------------------- |
| Rounds        | Pattern Panic (logic)                                                |
| Tempo / meter | 96 BPM, 4/4 (clock-steady)                                           |
| Key / mode    | A minor (Aeolian) with whole-tone sparkle for reveals                |
| Mood          | Quiz-show brain teaser: curious, tick-tock tension, playful suspense |

| Role  | Voice                                                           |
| ----- | --------------------------------------------------------------- |
| Lead  | `celesta` + `pluck` pizzicato                                   |
| Clock | `tick`/`tock` alternating on quarters (the "metronome of doom") |
| Comp  | `harp` arpeggios, `organ` low sustain in answer phase           |
| Bass  | `bass_sub` staccato quarters (pizz)                             |
| Pad   | `strings_pad` tremolo AM 8 Hz 0.3 in answer phase               |

**Drums**: sparse: `kick_soft` on 1, `rim` on 3, `tick`/`tock` quarters;
answer phase adds `hat_c` 1/8 and `snare` on 4.

| Section / phase stem | Roman                                 | Chords                                                          |
| -------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Memorise (A)         | i – iv – V – i                        | Am – Dm – E – Am                                                |
| Answer (B)           | i – ♭VI – ♭VII – V7 (repeat, tension) | Am – F – G – E7                                                 |
| Reveal (whole-tone)  | I+ cluster                            | A aug → (resolve) A major or A minor depending on local outcome |

**Motif**: 1-2-♭3-5 | 4-♭3-2-♯7 (A B C E | D C B G♯) in 1/8 "thinking"
figure; answer phase plays it twice as fast.

| Stem                                     | Bars        | Trigger / content                                                                                                                         |
| ---------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Intro                                    | 4           | clock ticks only, then celesta motif                                                                                                      |
| Memorise                                 | loops 4-bar | while symbols are shown (`patternPanic.revealStart` → `revealEnd`)                                                                        |
| Answer                                   | loops 4-bar | after `patternPanic.revealEnd`, until `patternPanic.timerEnd`; adds strings tremolo + hats                                                |
| Intensity                                | —           | answer timer ≤ 3 s: clock 1/8 then 1/16, HP 20→300 Hz                                                                                     |
| Reveal / drop                            | 1 bar       | silence 1 beat (gap), then whole-tone celesta run + `tileDrop`; if local survived: A major "phew" chord; if eliminated: eliminate stinger |
| Final-30 (late rounds of the logic game) | —           | from round 5 of the pattern cycle: tempo +8, key +1 st per pattern round (max +3)                                                         |

**Stingers**: voiced on `celesta` + `bell`; `go` replaced by a quiz "ding-ding"
(bell A5, E6).

---

### 2.20 `mus_final_crownfever`

|               |                                                                                   |
| ------------- | --------------------------------------------------------------------------------- |
| Rounds        | ALL finals: Crown Climb, Last Tumbler Standing, Spin Cycle Finale, Goo Peak Final |
| Tempo / meter | 160 BPM, 4/4 (half-time feel in intro)                                            |
| Key / mode    | C minor (Aeolian/harmonic minor V), resolves to C major on victory                |
| Mood          | Epic-goofy championship anthem: everything on the line, still a toy               |

| Role    | Voice                                                            |
| ------- | ---------------------------------------------------------------- |
| Lead    | `brass` unison ×2 octaves + `lead_saw`                           |
| Choir   | `choir_ooh` on long notes ("aaah" vowel: BP 700 + 1100 Hz)       |
| Strings | `strings_pad` 1/8 ostinato (spiccato: AD 2/90)                   |
| Bass    | `bass_pluck` 1/8 driving + `bass_sub`                            |
| Timpani | sin f: 98→92 /60, AD 2/600 + wn LP 300 AD 0/40, tuned to C and G |
| Bells   | `bell` on bar downbeats in intensity                             |

**Drums**: `kick` 1 and 3 (+ "and" of 4), `snare` 2 & 4, timpani rolls, `crash`
every 8 bars, `hat_c` 1/8 → 1/16 in intensity, `tom` fills.

| Section            | Roman                | Chords                |
| ------------------ | -------------------- | --------------------- |
| A                  | i – ♭VI – ♭VII – i   | Cm – A♭ – B♭ – Cm     |
| B                  | iv – i – ♭VI – V     | Fm – Cm – A♭ – G      |
| Showdown           | ♭VI – ♭VII – V/V – V | A♭ – B♭ – D7 – G      |
| Victory resolution | ♭VI – ♭VII – I       | A♭ – B♭ – C (Picardy) |

**Motif**: the leitmotif **in minor**: 5-♭6-5-♭3 | 2-♭3-1 (G A♭ G E♭ | D E♭ C),
in half notes over driving 1/8 strings — the "Crown Fever" theme. On victory it
flips to major (§2.22).

| Stem                           | Bars       | Trigger / content                                                                                                                                             |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intro                          | 8          | timpani roll + choir pad + brass motif in half-time                                                                                                           |
| Loop A                         | 16         | full band, motif in brass                                                                                                                                     |
| Loop B                         | 16         | strings ostinato lead, choir counter                                                                                                                          |
| Intensity                      | —          | alive ≤ 3, or Crown Climb leader ≥ 75 % height, or Goo Peak goo ≥ 70 % of tower: bells, 1/16 hats, double-time strings, timpani 1/8 on bar 4                  |
| Showdown (final-30 equivalent) | —          | alive == 2 OR timer ≤ 30 s (timed finals): key +1 st (C→C♯ minor), tempo 160→168, Showdown progression, `snare_roll` every 2 bars, `last_player` stinger once |
| Crown proximity (Crown Climb)  | continuous | local distance to crown < 10 m → choir LP opens 1.5k→8k, bells louder                                                                                         |
| Victory handover               | —          | crown grab / last survivor: hard cut on next beat to `crown_grab` stinger then `mus_victory_crowned`                                                          |

**Per-theme colour layer** (`colour` gain, selected from the final round's
theme; one active):

| Theme                     | Colour layer content                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| castle                    | herald `brass` fanfares (1-1-5, 1/16 triplets) every 4 bars, `tamb` 1/8, kazoo doubling motif at -10 dB (jester wink) |
| frosty                    | sleigh bells 1/8, `celesta` 1/16 arpeggio, ice-tink ear candy, choir brighter (LP 6k)                                 |
| neon                      | `pulse25` arpeggio 1/16 over chords, `chip_noise` hats, gated pad 1/16                                                |
| goo                       | `bass_wah` replaces `bass_pluck`, goo bubbles on offbeats, talk-box doubling motif                                    |
| default (any other theme) | `glock` sparkle countermelody + `clap` on 2 & 4                                                                       |

Theme mapping for launch finals (from round data): Crown Climb → its theme,
Last Tumbler Standing → its theme, Spin Cycle Finale → its theme, Goo Peak
Final → goo. The colour layer key is looked up from `round.theme`; unmapped
themes use `default`.

**Stingers**: voiced on `brass` + timpani. Extra finals-only stingers:
`showdown` (timpani roll 1 bar + brass 1-♭3-5-8), `crown_grab` (§5.11).

---

### 2.21 `mus_results_wall`

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| Use           | RESULTS grid between rounds, end-of-show **Player Wall** recap |
| Tempo / meter | 92 BPM, 4/4                                                    |
| Key / mode    | E♭ major                                                       |
| Mood          | Proud, cheeky marching-band recap; reflective but upbeat       |

| Role  | Voice                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------- |
| Lead  | `glock` + `lead_whistle` (leitmotif)                                                              |
| Band  | `brass` (soft, LP 1.8k) chorale                                                                   |
| Comp  | `pluck` 1/8                                                                                       |
| Bass  | `bass_sub` on 1 and 3 (tuba-like: add saw @ -10 dB LP 400)                                        |
| Drums | `snare` march (rudiment: 1/16 drags on beat 4), `kick_soft` 1 & 3, `crash` soft on section starts |

| Section | Roman                                                | Chords                                                 |
| ------- | ---------------------------------------------------- | ------------------------------------------------------ |
| A       | I – IV – ii – V                                      | E♭ – A♭ – Fm – B♭                                      |
| B       | vi – iii – IV – V → I – V/vi – vi – IV – I/V – V – I | Cm – Gm – A♭ – B♭ → E♭ – G – Cm – A♭ – E♭/B♭ – B♭ – E♭ |

**Motif**: leitmotif (5-6-5-3 | 2-3-1 → B♭ C B♭ G | F G E♭) at half speed
("remembering the show").

| Stem                    | Bars | Trigger / content                                                                                                                                                                  |
| ----------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intro                   | 2    | snare drag + brass chord                                                                                                                                                           |
| Loop A                  | 8    | results grid                                                                                                                                                                       |
| Loop B                  | 8    | Player Wall: each round's drop-away is synced to bar downbeats — one round of eliminations per 2 bars, cell drops quantised to 1/16 within that window (§5.11 `ui_wall_cell_drop`) |
| Intensity               | —    | Player Wall final 2 rounds: tempo 92→100, snare roll, choir pad                                                                                                                    |
| Final (winner revealed) | 2    | everything stops on beat 1 except a 1-bar snare roll → `crown_fanfare` (§5.11) → `mus_victory_crowned`                                                                             |

**Stingers**: `next_round_tease` (glock 1-5-8 + whoosh, 1 bar) on "next round"
card; `players_remaining` (brass chord hit).

---

### 2.22 `mus_victory_crowned`

|               |                                                            |
| ------------- | ---------------------------------------------------------- |
| Use           | Victory screen loop, photo mode, winner cam for spectators |
| Tempo / meter | 120 BPM, 4/4                                               |
| Key / mode    | C major (Ionian), the major flip of Crown Fever            |
| Mood          | Pure triumph: fireworks, confetti, the Crown is yours      |

| Role      | Voice                                                                      |
| --------- | -------------------------------------------------------------------------- |
| Lead      | `brass` ×3 octaves (fanfare)                                               |
| Choir     | `choir_ooh` "aah"                                                          |
| Bells     | `bell` + `glock` 1/8 sparkle                                               |
| Strings   | `strings_pad` + 1/16 runs                                                  |
| Bass      | `bass_sub` + timpani on 1 and 3                                            |
| Ear candy | firework pops synced to beat 4 every 2 bars (§5.11), crowd cheer bed +6 dB |

**Drums**: `kick` 1 & 3, `snare` 2 & 4 + marching rolls, `crash` every 4 bars,
`tamb` 1/8.

| Section       | Roman                              | Chords                           |
| ------------- | ---------------------------------- | -------------------------------- |
| Fanfare intro | I – IV/I – I – V                   | C – F/C – C – G                  |
| A             | I – IV – I/V – V → I – vi – IV – V | C – F – C/G – G → C – Am – F – G |
| B (cadence)   | ♭VI – ♭VII – I (×2) → IV – V – I   | A♭ – B♭ – C → F – G – C          |

**Motif**: augmented leitmotif 5-6-5-3 | 2-3-1 in **major** (G A G E | D E C)
in whole/half notes, brass in octaves, choir on top.

| Stem            | Bars | Trigger / content                                                                          |
| --------------- | ---- | ------------------------------------------------------------------------------------------ |
| Intro (fanfare) | 4    | brass fanfare, timpani roll, plays once                                                    |
| Loop A          | 8    | full                                                                                       |
| Loop B          | 8    | strings + bells lead, softer (photo mode friendly)                                         |
| Intensity       | —    | when the celebration emote plays, or photo-mode shutter: +glock, +tamb for 4 bars          |
| Outro           | 2    | on transition to Rewards: B cadence ♭VI–♭VII–I + crash, 1.5 s tail; then lobby track intro |

**Stingers**: none (it is itself the stinger destination).

### 2.23 Extra global stingers

| Id                         | Use                                       | Recipe                                                                                            |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `mus_stinger_logo`         | splash "Click to start"                   | leitmotif on `glock` + `pluck` 1/16 at 140 BPM, then I chord (F) with `bell`, cymbal swell; 2.2 s |
| `mus_stinger_show_start`   | pre-show → round 1                        | F: I – V/♭VI – I hit + whoosh up; 1.5 s                                                           |
| `mus_stinger_next_round`   | TRANSITION card                           | in next track's key: 1-5-8 glock + reverse cymbal; 1.2 s                                          |
| `mus_stinger_final_reveal` | final round title card                    | timpani roll + brass 1-♭3-5 in C minor; 2.5 s                                                     |
| `mus_stinger_spectate`     | after local eliminated, entering spectate | soft pad I chord LP 2k; 1 s                                                                       |

---

## 3. Lobby, menu and UI music behaviour

| Context                                                                           | Track / layers                                                 | Filters & levels                                                         | Notes                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Boot loader (before gesture)                                                      | silence (context suspended)                                    | —                                                                        | no autoplay attempts                                                                |
| Splash "Click to start"                                                           | `mus_stinger_logo` → lobby intro                               | —                                                                        | the first gesture unlocks and triggers the sting                                    |
| Main menu (Play tab)                                                              | lobby Loop A/B                                                 | full, LP 20k                                                             | idle play: knocking a party member off triggers 8 bars of party layer + crowd "ooh" |
| Submenus (Locker, Store, Pass, Challenges, Profile, Leaderboards, News, Settings) | same loop, no restart                                          | `musicLP` 20k → 1.8 kHz Q0.7 over 250 ms, music -3 dB, drums layer -6 dB | returning to Play reopens LP over 400 ms                                            |
| Locker try-on / turntable                                                         | + `glock` shimmer sub-layer                                    | LP 2.5 kHz                                                               | each item equip plays `ui_equip` in lobby key (F)                                   |
| Store                                                                             | + `shaker` 1/8 "shopping" layer                                | LP 2.2 kHz                                                               | purchase success plays `ui_purchase` in key                                         |
| Season Pass                                                                       | + pad swell                                                    | LP 2.5 kHz                                                               | tier claim → `ui_claim`                                                             |
| Settings → Audio page                                                             | music at user level unaltered (no LP) so sliders are judgeable | —                                                                        | each slider release plays a test sound on that bus                                  |
| Matchmaking "Searching…"                                                          | "searching" variant (§2.8)                                     | LP 3 kHz                                                                 | on match found: `match_found` stinger then pre-show                                 |
| Pre-show waiting platform                                                         | lobby full + party layer always on + crowd bed (§4.3)          | —                                                                        | final 10 s: "show starting" riser; at 0 → `mus_stinger_show_start`                  |
| Tutorial island                                                                   | lobby Loop B, drums at -6 dB                                   | —                                                                        | coach lines via announcer channel                                                   |
| In-round pause menu                                                               | round track continues                                          | §1.4 pause duck                                                          |                                                                                     |
| Rewards screen                                                                    | lobby intro → Loop A                                           | LP 6 kHz                                                                 | XP fill loop and level-ups on UI bus are tuned to F major                           |
| Modal dialog (error / confirm)                                                    | —                                                              | music -4 dB extra while open                                             |                                                                                     |
| Window blurred (not hidden)                                                       | —                                                              | music -6 dB, ambience -6 dB (optional setting "Mute when unfocused")     |                                                                                     |

UI sound tuning rule: in menus all pitched UI sounds are in **F major**
(lobby key). In rounds, pitched UI sounds (countdown, qualify counter tick,
toasts) are transposed to the current track key via `transposeTo()`.

---

## 4. Ambience beds

All beds are **live loops** on `ambience` bus, stereo, non-spatial except where
noted ("emitters"). Each bed = 1–3 continuous layers + randomised one-shot
"details" scheduled by a Poisson process (rate λ per minute), each detail
spatialised at a random point 15–40 m from the listener.

### 4.1 Weather beds (`round.weather`)

| Id                   | Layers                                                                                                                     | Details (λ/min)                                                                                                                                      | Level                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `amb_weather_clear`  | pn LP 400 Hz (distant air) -30 dB; gentle breeze pn BP 800 Hz Q0.5 with AM 0.15 Hz depth 0.4                               | birds (sin chirp f: 3.2k→4.1k /60 ×2–4 with 40 ms gaps) λ 6; distant balloon squeak (sin 1.1k→1.3k /200) λ 1                                         | -24 dB                                              |
| `amb_weather_windy`  | pn BP 500 Hz Q0.8 with random-walk gain (0.2–1.0, slew 1.5 s) + pn BP 1.6 kHz Q2 whistle with fc random-walk 1.2–2.4 kHz   | gust swells (pn LP 200→1.8k /1.2 s → back /2 s, +6 dB) λ 4; flag flap (wn BP 300 AM 12–18 Hz random, 800 ms) λ 3                                     | -20 dB; fans in round add +2 dB                     |
| `amb_weather_night`  | pn LP 250 Hz -32 dB; crickets: sqr 4.3 kHz AM 30 Hz (on-off gate 3 pulses then 400 ms rest) BP 4.3k Q10                    | owl-ish hoot (sin 420→380 /300 ×2, vib 4 Hz) λ 0.5; firefly twinkle (sin 5–7 kHz AD 1/80) λ 8                                                        | -24 dB                                              |
| `amb_weather_sunset` | warm air pn LP 600 -28 dB; distant waves (pn LP 500 with gain env 2 s up / 3 s down, cycle 6–9 s)                          | seagull-toy (saw 1.6 kHz → BP 1.8k Q4, f wobble 1.6→2.1k /150 ×3) λ 1.5; wind chime (bell 2.1k/2.6k/3.3k random, AD 1/1500) λ 2                      | -22 dB                                              |
| `amb_weather_snow`   | soft hush wn LP 2.5 kHz -34 dB; muffled air bn LP 150 -30 dB                                                               | sleigh-bell gust (tamb jingles AM 10 Hz 600 ms) λ 1; ice creak (saw 90 Hz FM 1:1.3 I 3 LP 600 AD 30/400) λ 1; snow "flump" (pn LP 500 AD 10/250) λ 3 | -24 dB; global HS 6 kHz -2 dB on sfx (snow dampens) |
| `amb_weather_stormy` | rain wn → LP 6 kHz → HP 400 Hz -26 dB, + droplet ticks (wn HP 5k AD 0/3, λ 600/min random pan); rumble bn LP 120 AM 0.1 Hz | thunder (see below) λ 1.2; wind gust as windy λ 3                                                                                                    | -18 dB                                              |

**Thunder recipe** (`amb_thunder`, pre-rendered ×3 var): crack = wn HP 1.5 kHz
AD 0/80 + ws 3; roll = bn LP filt env 800→120 /3 s, AM random-walk 6–12 Hz,
AD 30/3500; distant variant LP 400, delay 1.2 s after lightning flash (render
fires a `lightning` visual first; audio uses delay = distance / 343 m/s, clamped
0.4–3 s). Ducks music -2 dB for 1 s.

### 4.2 Theme beds (`round.theme`)

| Id                  | Layers                                                                                                                        | Details (λ/min)                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amb_theme_candy`   | sugary shimmer: 3 sin at C7/E7/G7 AM 0.3 Hz random phases -36 dB; soft fizz wn HP 6k AD-random grains (λ 120/min, 15 ms)      | lollipop "pop" (sin 900→300 /40) λ 3; gumdrop wobble (sin 200 vib 9 Hz ±80 c 300 ms) λ 2; distant carousel music-box (celesta 5 notes in F, LP 2k) λ 0.5                                             |
| `amb_theme_factory` | machine hum sqr 60 Hz LP 180 + 120 Hz harmonic -30 dB; distant conveyor rumble bn LP 300 AM 2 Hz                              | steam vent (wn HP 2k AD 80/900) λ 2; clank (FM 1:1.41 I 6 AD 0/200) λ 4; ratchet λ 2; far-off toy robot beep (sqr 1.2k/1.6k 2 notes) λ 1                                                             |
| `amb_theme_frosty`  | icy wind pn BP 1.8k Q3 random fc 1.4–2.4k -32 dB; crystalline drone (sin 2093 + 2637 Hz, AM 0.2 Hz) -40 dB                    | ice tink λ 6; snow flump λ 3; icicle chime run (bell 4 notes descending pentatonic) λ 0.7                                                                                                            |
| `amb_theme_jungle`  | insect bed: 3 cricket gates at 3.8/4.6/5.2 kHz with different gate rates -34 dB; leaf rustle pn BP 2.5k AM random 3–8 Hz      | toy parrot squawk (saw 1.3k f wobble ±300 Hz /30 ×3, BP 2k Q3) λ 2; frog croak (sqr 140 Hz AM 25 Hz 200 ms, BP 600 Q4) λ 3; bongo far-off λ 1; waterfall (pn LP 3k const, spatial emitter if placed) |
| `amb_theme_sunset`  | waves (as weather sunset) + boardwalk hubbub (babble formant voices ×6 at -40 dB, unintelligible)                             | arcade bell far (bell 1.8k) λ 1; wooden plank creak (saw 110 Hz FM, LP 800, f wobble) λ 2                                                                                                            |
| `amb_theme_space`   | deep drone sin 55 Hz + 82.5 Hz with slow beating (det 0.3 Hz) -30 dB; "station hum" sqr 50 Hz LP 150 -36 dB                   | radar ping (sin 1.8 kHz AD 1/400 + delay fb 0.5) λ 1.5; comet whoosh (pn BP sweep 4k→400 /1.5 s, pan sweep) λ 1; bleep-bloop computer (sqr random pentatonic 1/32 ×6) λ 2                            |
| `amb_theme_beach`   | surf: pn LP 700 with wave envelope 2.5 s / 3.5 s cycle 6–8 s + foam wn HP 3k following the same env -6 dB                     | gull-toy λ 2; ukulele far strum (pluck chord LP 2k) λ 0.5; coconut bonk (woodblock 600 Hz) λ 1; ship horn far (saw 110 + 165 Hz LP 500, 1.5 s) λ 0.3                                                 |
| `amb_theme_neon`    | electric buzz: saw 120 Hz → BP 2.4k Q6 + flicker AM random 0–40 Hz -36 dB; arcade room tone pn LP 1k                          | coin drop (sqr B5→E6) λ 2; far cabinet jingle (pulse25 4-note arps) λ 1.5; neon flicker zap (wn BP 3k AD 0/30 ×3) λ 2                                                                                |
| `amb_theme_castle`  | courtyard air pn LP 500 -32 dB; banners flap (wn BP 250 AM 9 Hz) -36 dB                                                       | distant herald (brass 1-5) λ 0.3; chain clink (FM 1:2.7 I 4 AD 0/150 ×3) λ 2; torch crackle (wn HP 1.5k grains λ 300/min, 2–6 ms, -40 dB) continuous near torches (emitter)                          |
| `amb_theme_goo`     | bubbling bed: Poisson "blup"s (sin f: 120→360 /50 + LP 800, AD 3/80) λ 200/min at -34 dB; low gloop drone bn LP 140 AM 0.4 Hz | big belch bubble (sin 70→200 /120 + bn) λ 2; drip (sin 1.2k→2.4k /20, AD 0/60 + delay 180 ms fb 0.3) λ 4                                                                                             |

Theme bed and weather bed always play together; the theme bed sits 3 dB under
weather when weather is `windy` or `stormy`.

### 4.3 Crowd bed (`amb_crowd`)

The "live studio audience" around every arena (implied off-screen). Non-spatial
stereo, plus a reaction system.

| Layer        | Recipe                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Murmur       | 8 babble voices (formant synth §6.2 with random vowels, pitch 140–260 Hz, syllable rate 5–8/s) at -38 dB each, panned ±0.8, LP 2.5 kHz |
| Swell        | pn BP 900 Hz Q0.6, gain = `excitement` (0–1) × -18 dB                                                                                  |
| Clap texture | Poisson `clap` grains (BP 1.4k, AD 0/40) λ = excitement × 600/min                                                                      |

`excitement` (0–1, slewed 0.5 s up / 3 s down) is raised by: qualifications
(+0.03 each), eliminations (+0.02), pile-ups (+0.2), big falls near camera
(+0.1), final-30 (+0.3 floor), overtime (+0.4 floor), showdown (0.8 floor).

**Reaction one-shots** (pre-rendered, §5.11): `crowd_cheer`, `crowd_aww`,
`crowd_gasp`, `crowd_laugh`, `crowd_ooh`, `crowd_applause`, triggered by the
rules in §7.2. Max 1 reaction per 1.5 s; reactions duck the murmur -6 dB.

---

## 5. SFX catalogue

Columns: **Id** · **Trigger** (SimEvent, character state transition, `obstacleCue`
as `<type>.<cue>`, or UI action) · **Recipe** (§0 notation) · **Dur** (ms) ·
**Var** (pitch st / volume dB / variants) · **S** spatial (Y/N; local-player
instances are always N, see §1.6) · **P** priority (local instance is P1 unless
P0 is listed).

### 5.1 Character — locomotion & footsteps

Footsteps are not sim events: the render animation emits a footfall callback at
each foot contact phase of the run cycle (`TumblerVisual` stride phase), which
the audio layer turns into `sfx_step_<surface>` using the replicated ground
surface (`SurfaceKind`). Footstep volume = `0.4 + 0.6 * clamp(speed / runSpeed)`.

| Id                       | Trigger                                         | Recipe                                                                                                                           | Dur  | Var                  | S   | P             |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- | --- | ------------- |
| `sfx_step_normal`        | footfall on `normal`                            | pn burst BP 900 Hz Q1.2 AD 1/25 + sin f: 140→90 /30 AD 1/35 @ -6 dB (soft rubber thump)                                          | 45   | ±2 st, ±2 dB, ×4 var | Y   | P5            |
| `sfx_step_ice`           | footfall on `ice`                               | wn HP 3 kHz AD 0/12 (tick) + sin f: 2.2k→1.8k /40 AD 0/40 @ -16 dB (glassy ping) + squeak sin 1.6k→2.0k /30 @ -20 dB 30 % chance | 60   | ±3 st, ±2 dB, ×4     | Y   | P5            |
| `sfx_step_slime`         | footfall on `slime`                             | bn LP 500 AD 3/60 + pn BP sweep 300→900 /90 Q4 ("schlup") + bubble sin f: 200→420 /60 AD 2/50 @ -8 dB                            | 110  | ±2 st, ±2 dB, ×4     | Y   | P5            |
| `sfx_step_conveyor`      | footfall on `conveyor`                          | sqr 320 + sqr 487 Hz → BP 1.8 kHz Q3 AD 0/50 (metal tread) + pn LP 600 AD 1/30 thump                                             | 60   | ±1.5 st, ±2 dB, ×4   | Y   | P5            |
| `sfx_step_sticky`        | footfall on `sticky`                            | pn BP 600 Hz Q6 env 40/120 with BP fc rising 400→1.2k /120 (suction release) + sin 90 Hz AD 2/60                                 | 160  | ±2 st, ±2 dB, ×4     | Y   | P5            |
| `sfx_step_bouncy`        | footfall on `bouncy`                            | sin f: 180→320 /80 AD 2/90 + tri @ -10 dB, LP 1.5 kHz ("boink-lite")                                                             | 95   | ±3 st, ±2 dB, ×3     | Y   | P5            |
| `sfx_step_slide`         | on `slide` surface                              | no discrete steps; uses `sfx_slide_surface_loop` (below)                                                                         | —    | —                    | —   | —             |
| `sfx_slide_surface_loop` | grounded on `slide`, speed > 1 m/s              | pn LP 1.2 kHz + wn HP 4 kHz @ -18 dB (plastic hiss); gain = speed/12 (max 0 dB), LP fc = 600 + 120·speed Hz                      | loop | —                    | Y   | P4 (local P1) |
| `sfx_skid_ice_loop`      | grounded on `ice`, lateral slip > 2 m/s         | wn BP 3 kHz Q2 + sin 1.9 kHz vib 11 Hz ±40 c @ -14 dB (rubber squeak on glass), gain ∝ slip                                      | loop | —                    | Y   | P4            |
| `sfx_turn_squeak`        | ground, direction change > 120° at > 70 % speed | sin f: 1.4k→2.1k /60 AD 2/70 (sneaker squeak)                                                                                    | 80   | ±2 st                | Y   | P5            |

**Footstep SFX packs** (cosmetic slot "footstep SFX pack", SPEC §5): a pack
replaces only `sfx_step_normal` and adds a top layer to other surfaces at -6 dB.

| Pack id                    | Rarity    | Recipe for step_normal                                                              |
| -------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `fsp_soft_socks` (default) | Common    | as `sfx_step_normal`                                                                |
| `fsp_squeaky_toy`          | Uncommon  | sin f: 1.2k→1.6k /50 AD 2/60 + thump                                                |
| `fsp_clacky_clogs`         | Uncommon  | `woodblock` at 900/1350 Hz alternating feet                                         |
| `fsp_jelly_feet`           | Rare      | sin f: 260→520 /70 vib 14 Hz ±60 c AD 3/110                                         |
| `fsp_robo_boots`           | Epic      | FM 1:1.41 I 4→0 /60 at 220 Hz + `rim` (servo whirr: saw 400→800 /40 LP 2k @ -14 dB) |
| `fsp_tiny_trumpet`         | Legendary | `brass` single note pentatonic random (F major), AD 10/120                          |
| `fsp_star_steps`           | Mythic    | `glock` note ascending pentatonic per step + sparkle wn HP 8k AD 0/40               |

### 5.2 Character — actions & states

| Id                       | Trigger                                                                                                                         | Recipe                                                                                                                                                                                                                                                 | Dur        | Var                  | S   | P             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------- | --- | ------------- |
| `sfx_jump`               | `jump`                                                                                                                          | sin f: 260→620 /110 exp AD 2/110 + sqr 1 octave up @ -18 dB LP 2 kHz + cloth whoosh pn BP 1.5 kHz Q1 AD 10/80 @ -10 dB. Carrying a prop: -2 st                                                                                                         | 130        | ±1.5 st, ±1.5 dB, ×3 | Y   | P3            |
| `sfx_jump_vocal`         | `jump`, 1 in 4 local jumps (never twice in a row)                                                                               | babble 1 syllable "hup" (formant /ʌ/, pitch 300 Hz → 340, 90 ms) per Tumbler voice seed                                                                                                                                                                | 90         | ±2 st                | Y   | P5            |
| `sfx_land_soft`          | `land` with `impact < 0.35`                                                                                                     | pn LP 700 AD 2/70 + sin f: 110→70 /60 AD 1/60 + squish BP 400 Q3 f: 500→300 /60 @ -10 dB                                                                                                                                                               | 80         | ±2 st, ±2 dB, ×4     | Y   | P3            |
| `sfx_land_hard`          | `land` with `impact ≥ 0.35`                                                                                                     | sin f: 120→45 /140 exp AD 1/150 + pn LP 1.2 kHz AD 1/120 + rubber "bwomp" saw 90 Hz LP 400 env 10/150 @ -6 dB; gain +0..6 dB with impact; `impact ≥ 0.8` adds ws 2.5 crunch + `sfx_land_squash`                                                        | 180        | ±1.5 st, ±1.5 dB, ×3 | Y   | P3            |
| `sfx_land_squash`        | layer for hard landings ≥ 0.8 and bounce pads                                                                                   | sin f: 400→150 /60 then →260 /90 (squash-and-stretch "bwoing")                                                                                                                                                                                         | 160        | ±1 st                | Y   | P3            |
| `sfx_land_double`        | `land` within 250 ms after a `dive` (dive-landing) or landing on another Tumbler's head (ground body is a player)               | two soft thumps 70 ms apart: body (pn LP 700, sin 100 Hz AD 1/50) then belly (pn LP 500 AD 2/90, BP 300 Q2) + head-bonk variant: `woodblock` 700 Hz "bonk" on top                                                                                      | 170        | ±2 st, ±2 dB, ×3     | Y   | P3            |
| `sfx_dive`               | `dive`                                                                                                                          | whoosh pn BP sweep 600→2.4k /180 Q2 env 20/200 + "hyah" babble syllable @ -10 dB                                                                                                                                                                       | 220        | ±1.5 st, ±1.5 dB, ×3 | Y   | P3            |
| `sfx_dive_land`          | state Dive → DiveSlide (belly contact)                                                                                          | pn LP 800 AD 1/90 + sin 140→80 /80 (belly flop "flomp") + BP 350 Q2 slap @ -8 dB                                                                                                                                                                       | 120        | ±2 st, ±2 dB, ×3     | Y   | P3            |
| `sfx_belly_slide_loop`   | while state `DiveSlide`                                                                                                         | pn LP 900 Hz, gain = speed/8 (−∞..−4 dB); surface: ice → + wn HP 2 kHz shimmer @ -10 dB; slime → BP 600 Q3 AM 7 Hz wobble; sticky → gain ×0.4 + squelch grains λ 6/s; conveyor → + metal rattle sqr 300/487 AM 18 Hz @ -14 dB. Fade out 120 ms on exit | loop       | —                    | Y   | P4 (local P1) |
| `sfx_getup`              | `getUp`                                                                                                                         | tri f: 300→520 /90 AD 2/90 ("boing-up") + cloth rustle pn BP 2 kHz AD 5/60 @ -10 dB + optional "hmph" babble 1 in 3                                                                                                                                    | 120        | ±2 st, ±1.5 dB, ×3   | Y   | P3            |
| `sfx_grab_start_player`  | `grabStart` targetKind `player`                                                                                                 | pn BP 1.8 kHz Q2 two bursts 25 ms apart AD 1/30 (cloth tug) + sin 400→300 /50 "fwump"                                                                                                                                                                  | 90         | ±2 st, ±2 dB, ×3     | Y   | P3            |
| `sfx_grab_start_ledge`   | `grabStart` targetKind `ledge`                                                                                                  | `woodblock` 1.1 kHz + mitten squeak sin 1.3k→1.0k /40 @ -8 dB                                                                                                                                                                                          | 70         | ±2 st, ±1 dB, ×3     | Y   | P3            |
| `sfx_grab_start_prop`    | `grabStart` targetKind `prop`                                                                                                   | "bloop" sin f: 300→700 /60 AD 2/80 + pn BP 1 kHz AD 2/40                                                                                                                                                                                               | 90         | ±2 st, ×3            | Y   | P3            |
| `sfx_grab_hold_loop`     | while state `Grab` on a player                                                                                                  | pn BP 1.4 kHz Q4 AM 6 Hz 0.4 (cloth strain) + creak sqr 70 Hz LP 300 @ -8 dB; stamina < 30 %: creak 70→110 Hz, AM 10 Hz tremble. Gain -16 dB                                                                                                           | loop       | —                    | Y   | P4 (local P1) |
| `sfx_grab_release`       | `grabEnd` reason `release`                                                                                                      | pn HP 2 kHz BP sweep 2k→800 /50 + tri 500→300 /60 ("fwip")                                                                                                                                                                                             | 70         | ±2 st, ×3            | Y   | P3            |
| `sfx_grab_broken`        | `grabEnd` reason `broken` or `stamina`                                                                                          | saw f: 900→200 /70 exp AD 0/80 (elastic snap) + `rim` click + pn AD 0/30                                                                                                                                                                               | 110        | ±2 st, ×3            | Y   | P3            |
| `sfx_grabbed_struggle`   | local player in `Grabbed`, each mash input (client-side)                                                                        | sin f: 700→900 /50 AD 2/50 squeak, random ±3 st, base pitch rises with break-free progress 0 → +7 st + cloth rustle pn BP 2.2 kHz AD 2/40 @ -10 dB                                                                                                     | 60         | ±3 st, ±2 dB         | N   | P1            |
| `sfx_grabbed_alert`      | `grabStart` where `target` = local player                                                                                       | 2-note "hey!" babble + tri 600→450 /80                                                                                                                                                                                                                 | 160        | ±1 st                | N   | P1            |
| `sfx_ledge_hang_loop`    | state `LedgeHang`                                                                                                               | effort breath: babble "hnn" (formant /n/, 220 Hz) 200 ms every 1.2 s @ -24 dB + fingertip creak sqr 85 Hz LP 250 AM 3 Hz @ -26 dB                                                                                                                      | loop       | —                    | Y   | P4 (local P1) |
| `sfx_climb`              | state → `LedgeClimb`                                                                                                            | "hup" babble + scramble: 3 pn taps BP 1.2 kHz AD 1/30, 40 ms apart, +2 st each                                                                                                                                                                         | 180        | ±2 st, ×3            | Y   | P3            |
| `sfx_stun_boing`         | `stun`                                                                                                                          | spring: sin 180 Hz with pitch LFO 18 Hz depth ±40 % decaying to 0 over duration, FM 1:2 I 1.5→0 + impact pn LP 900 AD 1/60; duration = 350 + 350·`strength` ms                                                                                         | 350–700    | ±1.5 st, ±1.5 dB, ×3 | Y   | P3            |
| `sfx_stun_stars_loop`    | while state `Stunned` (local + nearest 4)                                                                                       | 3 sin bells 2.1/2.6/3.2 kHz AD 1/150 cycling every 180 ms, slight pan rotation (StereoPanner sin 1.5 Hz) @ -24 dB                                                                                                                                      | loop       | —                    | Y   | P5 (local P1) |
| `sfx_tumble_loop`        | while Stunned with angular speed > 3 rad/s                                                                                      | random pn thumps LP 600 AD 1/50 every 90–160 ms (gain ∝ ang speed) + rising "woo" babble (vowel /u/ 280→360 Hz) once per tumble                                                                                                                        | loop       | —                    | Y   | P4            |
| `sfx_respawn_whoosh`     | `respawn`                                                                                                                       | reverse whoosh pn BP 400→3 kHz /500 exp, env 450/50 + sparkle sin arpeggio C6-E6-G6-C7 1/32 (transposed to track key) AD 1/120 each                                                                                                                    | 650        | ±1 st (whoosh only)  | Y   | P3            |
| `sfx_ghost_shimmer_loop` | flag `Ghost` (local only)                                                                                                       | sin C6 + G6 AM 8 Hz 0.6, HP 1 kHz @ -26 dB                                                                                                                                                                                                             | loop (1 s) | —                    | N   | P1            |
| `sfx_fall_scream`        | state `Fall`, vel.y < -14 m/s and below the round's `killY + 8 m` (about to fall out); local + nearest 3; cooldown 2.5 s/player | babble "waaaah": vowel /a/→/o/, pitch 420→220 Hz over 1.2 s, vib 7 Hz ±60 c; Tumbler voice seed shifts pitch ±4 st                                                                                                                                     | 1200       | ±3 st                | Y   | P3 (local P1) |
| `sfx_fall_whistle`       | same trigger, layered                                                                                                           | slide-whistle sin f: 2.4k→600 /1400 lin, vib 6 Hz ±30 c, AD 30/1400 @ -6 dB                                                                                                                                                                            | 1400       | ±1 st                | Y   | P3            |
| `sfx_fellout_poof`       | `fellOut` (void)                                                                                                                | balloon pop pn HP 1 kHz AD 1/80 + sin 900→200 /40 + soft "fwump" pn LP 400 AD 5/200                                                                                                                                                                    | 250        | ±2 st, ×3            | Y   | P3            |
| `sfx_fellout_splash`     | `fellOut` when round void kind is slime/goo/water                                                                               | bn LP 1.5 kHz AD 2/400 + 6 droplet sines 600–1600 Hz random within 300 ms AD 1/60 + gloop sin 300→80 /250                                                                                                                                              | 500        | ±2 st, ×3            | Y   | P3            |
| `sfx_slime_enter`        | flag `InSlime` set                                                                                                              | sin 250→120 /200 + bn LP 800 AD 5/250 ("sploosh")                                                                                                                                                                                                      | 260        | ±2 st                | Y   | P3            |
| `sfx_slime_swim_loop`    | state `Slime`                                                                                                                   | bn LP 600 AM 4 Hz 0.6 + bubble grains λ 8/s                                                                                                                                                                                                            | loop       | —                    | Y   | P4            |
| `sfx_finish_cross_self`  | `finish` (local)                                                                                                                | see `sfx_finish_line_cross` §5.4 + local layer: glock leitmotif first 3 notes                                                                                                                                                                          | 600        | —                    | N   | P1            |
| `sfx_emote_pop`          | `emote`                                                                                                                         | sin f: 500→1000 /60 AD 1/80 + per-emote sound (cosmetic data `emote.sfx` id; default `ui_confetti_small`)                                                                                                                                              | 120        | ±2 st                | Y   | P5            |
| `sfx_player_bump`        | client contact between two Tumblers > 2 m/s (render-side contact detection; not a sim event)                                    | pn LP 900 AD 1/50 + tri 220→160 /60 ("bonk")                                                                                                                                                                                                           | 70         | ±3 st, ±3 dB, ×3     | Y   | P5            |

### 5.3 Obstacles (cue names are exact; see §7.3)

Loops marked "pose-driven" read the obstacle's `pose(t)` / angular speed on the
client each frame (no network cue needed). Discrete cues come from
`obstacleCue` events or `tileWarn`/`tileFell`/`bounce` events.

| Id                           | Trigger                                                                                          | Recipe                                                                                                                                                                                      | Dur         | Var                                                 | S           | P                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `sfx_spinwheel_whirr_loop`   | pose-driven, `spinwheel`                                                                         | saw at f = 40 + 25·ω Hz (ω rad/s) → LP 600 Hz Q2 + pn BP 300 Hz AM at blade-pass rate (ω·bladeCount/2π Hz) depth 0.6 ("whum-whum")                                                          | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_spinwheel_hit`          | `spinwheel.hit` (+ player `stun`)                                                                | `sfx_bumper_hit` at -3 st + pn LP 1 kHz AD 1/90                                                                                                                                             | 200         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_pendulum_whoosh`        | `pendulumHammer.swing` (emitted at each swing apex → bottom transit, ~0.3 s before lowest point) | pn BP sweep 250→1.2k→350 Hz over 600 ms Q1.5, env 250/350, doppler-ish pitch: playbackRate 0.9→1.1 by direction                                                                             | 600         | ±1 st, ±2 dB, ×3                                    | Y           | P2                                                                                                            |
| `sfx_pendulum_creak`         | `pendulumHammer.apex`                                                                            | saw 70 Hz FM 1:1.3 I 2 → LP 500 AD 40/300 (rope/hinge creak)                                                                                                                                | 340         | ±2 st, ×3                                           | Y           | P4                                                                                                            |
| `sfx_pendulum_hit`           | `pendulumHammer.hit`                                                                             | big pillow thwack: sin 90→50 /150 + pn LP 1.4 kHz AD 1/160 + `sfx_stun_boing` layer handled by stun; + wood "tok" woodblock 500 Hz @ -6 dB                                                  | 260         | ±1.5 st, ×3                                         | Y           | P2                                                                                                            |
| `sfx_sweeper_hum_loop`       | pose-driven, `sweeperArm`                                                                        | saw + sqr @ -6 dB at f = 55 + 18·                                                                                                                                                           | ω           | Hz (pitch tracks angular speed), LP fc = 300 + 400· | ω           | Hz Q3, + pn BP 2 kHz whoosh with gain ∝ tip speed; Doppler: arm tip position emitter (PannerNode follows tip) | loop | —   | Y   | P4  |
| `sfx_sweeper_accel`          | `sweeperArm.accel` (speed tier change)                                                           | rising servo saw 200→600 /800 LP 1.5k + `sfx_alarm_blip` ×2                                                                                                                                 | 900         | —                                                   | Y           | P2                                                                                                            |
| `sfx_sweeper_hit`            | `sweeperArm.hit`                                                                                 | foam smack: pn BP 800 Q1 AD 1/120 + sin 180→90 /100                                                                                                                                         | 150         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_bumper_hit`             | `bumperPillar.hit` / `bounce` with obstacle type bumperPillar                                    | "boing-bonk": sin f: 300→600 /40 then →240 /150 + FM 1:1.5 I 3→0 /120 + pn LP 1.2k AD 1/40                                                                                                  | 200         | ±2 st, ±2 dB, ×4                                    | Y           | P2                                                                                                            |
| `sfx_bumper_idle`            | `bumperPillar.pulse` (visual pulse)                                                              | sin 120 Hz AM 2 Hz AD 100/300 @ -20 dB                                                                                                                                                      | 400         | —                                                   | Y           | P5                                                                                                            |
| `sfx_punchwall_telegraph`    | `punchWall.telegraph` (0.6–0.8 s before punch)                                                   | 3 rising blips sqr 880/1046/1318 Hz (A5 C6 E6) AD 1/60 at 180 ms spacing + spring wind-up saw 120→360 /600 LP 1k (in the 2–4 kHz cut, readable)                                             | 700         | —                                                   | Y           | P2                                                                                                            |
| `sfx_punchwall_punch`        | `punchWall.punch`                                                                                | piston: pn LP 2k filt env 300→3k /30 AD 1/120 + sin 140→60 /120 + spring "doing" sin 220 vib 25 Hz ±30 % AD 2/250 @ -6 dB                                                                   | 260         | ±1.5 st, ×3                                         | Y           | P2                                                                                                            |
| `sfx_punchwall_retract`      | `punchWall.retract`                                                                              | pneumatic hiss wn HP 2.5k AD 10/250 @ -10 dB + clunk woodblock 300                                                                                                                          | 280         | ±2 st                                               | Y           | P4                                                                                                            |
| `sfx_door_burst`             | `doorGauntlet.burst` (fake door broken through)                                                  | paper/foam burst: wn BP 2 kHz Q0.8 AD 1/150 + 8 pn crackle grains (2–6 ms) in 120 ms + cardboard flap pn BP 400 AM 20 Hz AD 5/200 + "ta-da" sin 523→784 /60 @ -14 dB                        | 350         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_door_thud`              | `doorGauntlet.thud` (solid door bump)                                                            | dull thud sin 95→60 /120 + pn LP 500 AD 1/120 + "nope" muted tri 300→200 /150 @ -12 dB                                                                                                      | 200         | ±2 st, ±2 dB, ×3                                    | Y           | P3                                                                                                            |
| `sfx_conveyor_hum_loop`      | per `conveyorBelt` (emitter at belt centre; long belts use nearest point on segment to listener) | sqr 60 Hz LP 200 + rattle pn BP 1.1k AM at roller rate (belt speed × 4 Hz) @ -10 dB; pitch ×(0.9 + 0.05·speed)                                                                              | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_conveyor_reverse_alarm` | `conveyorBelt.reverseWarn` (1 s before reverse)                                                  | 2-tone klaxon sqr 740↔554 Hz at 4 Hz, BP 1.5k Q2, 2 cycles + amber "whoop" saw 400→800                                                                                                      | 1000        | —                                                   | Y           | P2                                                                                                            |
| `sfx_conveyor_reverse`       | `conveyorBelt.reverse`                                                                           | hum pitch ramps down to 0.3× /250 then up to 1× /300 (motor reverse) + `woodblock` clack                                                                                                    | 600         | —                                                   | Y           | P2                                                                                                            |
| `sfx_tilt_creak_loop`        | pose/state-driven, `tiltPlatform`                                                                | saw 60 Hz FM 1:1.25 I = 2·                                                                                                                                                                  | angular vel | → LP 400 Q4; gain ∝                                 | angular vel | (max -10 dB); random grain creaks λ ∝ tilt angle                                                              | loop | —   | Y   | P4  |
| `sfx_tilt_hit_limit`         | `tiltPlatform.limit` (reaches max tilt stop)                                                     | wood clunk sin 160→110 /80 + woodblock 420 Hz                                                                                                                                               | 140         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_seesaw_clunk`           | `seesaw.clunk` (end hits stop)                                                                   | heavy woodblock 260 Hz + sin 110→70 /100 + pn LP 700 AD 1/120                                                                                                                               | 180         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_seesaw_pivot_loop`      | pose-driven `seesaw`                                                                             | as tilt creak at 75 Hz                                                                                                                                                                      | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_fan_wind_loop`          | `fanZone` while on                                                                               | pn BP 500 Hz Q0.7 + blade-pass AM at 12 Hz depth 0.3 + motor sqr 90 Hz LP 250 @ -14 dB; directional cone along wind axis; inside the zone: + pn HP 1.5k @ -6 dB (ear buffeting)             | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_fan_on`                 | `fanZone.on`                                                                                     | motor spin-up: saw 30→90 Hz /600 LP 300 + wind fade-in 600 ms                                                                                                                               | 600         | —                                                   | Y           | P2                                                                                                            |
| `sfx_fan_off`                | `fanZone.off`                                                                                    | spin-down 90→20 Hz /900 + wind fade-out                                                                                                                                                     | 900         | —                                                   | Y           | P3                                                                                                            |
| `sfx_fan_warn`               | `fanZone.warn` (0.5 s before on)                                                                 | 2× sqr 1.2 kHz AD 1/40 blips + whoosh pre-swell                                                                                                                                             | 500         | —                                                   | Y           | P2                                                                                                            |
| `sfx_bounce_pad`             | `bounce` (obstacle type bouncePad) / `bouncePad.launch`                                          | trampoline "BOIIING": sin f: 120→520 /90 then vib 22 Hz ±25 % decaying over 500 ms + sqr @ -16 dB + rubber pn LP 900 AD 1/40; +2 st per launch strength tier                                | 550         | ±1 st, ±1.5 dB, ×3                                  | Y           | P3                                                                                                            |
| `sfx_tile_shake`             | `tileWarn`                                                                                       | rattle: pn BP 1.2 kHz AM 28 Hz depth 0.8 + ceramic tick wn HP 3k grains λ 40/s, AD 20/450; under/adjacent to local: +3 dB and P2                                                            | 450         | ±2 st, ×3                                           | Y           | P2 (near) / P4                                                                                                |
| `sfx_tile_crack`             | `fallingTiles.crack` (mid-warning)                                                               | crack: wn HP 1.5 kHz AD 0/40 ws 3 + 3 crackle grains + glassy sin 2.8k→2.2k /80 @ -12 dB                                                                                                    | 120         | ±2 st, ±2 dB, ×4                                    | Y           | P2                                                                                                            |
| `sfx_tile_drop`              | `tileFell`                                                                                       | release "plunk" sin 220→110 /90 + falling whistle sin 900→300 /600 @ -14 dB (only for tiles within 12 m, max 2 whistles)                                                                    | 650         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_tile_respawn`           | `fallingTiles.respawn` (if configured)                                                           | pop-in sin 300→600 /50                                                                                                                                                                      | 60          | ±2 st                                               | Y           | P5                                                                                                            |
| `sfx_slime_bubble_loop`      | `risingSlime` surface emitter (follows nearest point of slime plane under listener)              | bubble grains: sin f: 140→380 /50 AD 3/80 LP 900, λ 6–14/s; + bn LP 160 AM 0.4 Hz; gain rises as listener nears surface (refDistance 4)                                                     | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_slime_surge`            | `risingSlime.surge` (rise speed-up)                                                              | big gloop: bn LP filt env 200→1.2k /600 AD 50/900 + 8 big bubbles sin 80→240 /120 in 800 ms + choir-ish "uh-oh" tri 330→247 Hz 2 notes                                                      | 1000        | —                                                   | N (global)  | P2                                                                                                            |
| `sfx_slime_warn`             | `risingSlime.warn`                                                                               | low horn sqr 110 Hz + 165 Hz LP 600 AD 100/700, vib 4 Hz                                                                                                                                    | 800         | —                                                   | N           | P2                                                                                                            |
| `sfx_boulder_roll_loop`      | pose-driven `boulderLane` per active ball                                                        | bn LP 220 Hz with AM at rotation rate (v / (2πr) Hz) depth 0.5 + rumble sin 45 Hz + surface grit pn BP 600 Q1 @ -12 dB; gain ∝ speed                                                        | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_boulder_spawn`          | `boulderLane.spawn`                                                                              | release thunk sin 80→50 /200 + pn LP 400 AD 5/300                                                                                                                                           | 300         | ±2 st                                               | Y           | P3                                                                                                            |
| `sfx_boulder_impact`         | `boulderLane.hit`                                                                                | sin 70→40 /180 + pn LP 900 AD 1/220 + rubbery sin 200 vib 15 Hz AD 2/200                                                                                                                    | 260         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_boulder_exit`           | `boulderLane.despawn` (falls off end)                                                            | falling whistle sin 700→250 /800 @ -10 dB                                                                                                                                                   | 800         | ±2 st                                               | Y           | P5                                                                                                            |
| `sfx_spinning_disc_loop`     | pose-driven `spinningDisc`                                                                       | low turntable whirr sqr 50 + 25·ω Hz LP 250 + bearing hiss pn BP 3k @ -24 dB                                                                                                                | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_spinning_disc_reverse`  | `spinningDisc.reverse`                                                                           | turntable brake: pitch ramp 1→0.2 /400 → 1 /400                                                                                                                                             | 800         | —                                                   | Y           | P3                                                                                                            |
| `sfx_moving_platform_loop`   | pose-driven `movingPlatform` while speed > 0.2 m/s                                               | soft servo: sqr 110 Hz LP 300 + pn BP 900 @ -12 dB, gain ∝ speed                                                                                                                            | loop        | —                                                   | Y           | P5                                                                                                            |
| `sfx_moving_platform_stop`   | `movingPlatform.arrive` (end of spline segment)                                                  | soft clunk woodblock 320 + air puff wn LP 2k AD 2/80                                                                                                                                        | 120         | ±2 st                                               | Y           | P5                                                                                                            |
| `sfx_slide_ramp_enter`       | `slideRamp.enter` (actor enters ramp trigger)                                                    | "wheee" babble 1 syllable (/i/ 360→480 Hz) 1 in 2 + whoosh start                                                                                                                            | 300         | ±2 st                                               | Y           | P3                                                                                                            |
| `sfx_ice_crackle`            | `iceFloor.crackle` (player lands hard on ice) or random λ 2/min per ice zone                     | wn HP 2 kHz grains (6–12) over 300 ms + sin 3.2k→2.6k /200 @ -18 dB (creak-ping)                                                                                                            | 320         | ±2 st, ×3                                           | Y           | P4                                                                                                            |
| `sfx_sticky_squelch`         | `stickyGoo.enter` / `stickyGoo.exit`                                                             | enter: bn LP 900 AD 5/180 + BP 500 Q5 f: 700→300 /150; exit: suction pop BP 400→1.4k /120 Q6 + sin 600→1200 /30                                                                             | 200         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_popup_block_rise`       | `popupBlocks.up`                                                                                 | foam "whomp-up" sin 140→320 /120 + pn BP 700 AD 5/120                                                                                                                                       | 150         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_popup_block_down`       | `popupBlocks.down`                                                                               | sin 320→120 /150 + air hiss wn HP 3k AD 5/150 @ -12 dB                                                                                                                                      | 170         | ±2 st, ×3                                           | Y           | P4                                                                                                            |
| `sfx_popup_block_warn`       | `popupBlocks.warn`                                                                               | 2 soft beeps tri 660 Hz AD 1/50                                                                                                                                                             | 250         | —                                                   | Y           | P3                                                                                                            |
| `sfx_laser_hum_loop`         | pose-driven `laserSweep` while active                                                            | saw 110 Hz + saw 110.6 Hz (beating) → BP 900 Q4 + sin 2.2 kHz AM 30 Hz @ -20 dB (buzz); emitter on beam point nearest listener                                                              | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_laser_charge`           | `laserSweep.charge`                                                                              | sin f: 200→2k /700 exp + AM 20→60 Hz, LP 4k                                                                                                                                                 | 700         | —                                                   | Y           | P2                                                                                                            |
| `sfx_laser_zap`              | `laserSweep.zap` (player hit, soft beam stun)                                                    | FM 1:3.5 I 8→0 /150 at 1.2 kHz + wn HP 4k AD 0/60 + "bzzt" saw 80 Hz AM 50 Hz AD 0/200                                                                                                      | 250         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_cannon_telegraph`       | `cannon.telegraph` (0.8 s before fire)                                                           | fuse hiss wn HP 4 kHz AM random 20–60 Hz AD 50/750 + rising tri 300→900 /750 @ -10 dB + 2 "tick"                                                                                            | 800         | —                                                   | Y           | P2                                                                                                            |
| `sfx_cannon_fire`            | `cannon.fire`                                                                                    | "foom-poof": sin 80→35 /250 + bn LP filt env 2k→300 /300 AD 1/350 + pop pn HP 1.5k AD 0/30 + ws 2; cone directional                                                                         | 400         | ±1.5 st, ±1.5 dB, ×3                                | Y           | P2                                                                                                            |
| `sfx_cannon_ball_bounce`     | `cannon.bounce` (foam ball hits ground/player)                                                   | foam "bwomf": sin 200→110 /90 + pn LP 800 AD 1/90; gain ∝ impact speed                                                                                                                      | 120         | ±3 st, ±2 dB, ×4                                    | Y           | P3                                                                                                            |
| `sfx_cannon_ball_whistle`    | foam ball in flight within 10 m of listener (client-side)                                        | sin 1.5k→900 /flight time, vib 9 Hz ±20 c @ -16 dB                                                                                                                                          | var         | —                                                   | Y           | P4                                                                                                            |
| `sfx_bumper_car_loop`        | pose-driven `bumperCar`                                                                          | toy motor sqr 80 + 40·speed Hz LP 400 + electric buzz saw 200 AM 60 Hz @ -22 dB                                                                                                             | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_bumper_car_hit`         | `bumperCar.hit`                                                                                  | `sfx_bumper_hit` -2 st + horn "meep" sqr 660 Hz AD 5/120                                                                                                                                    | 200         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_rolling_drum_loop`      | pose-driven `rollingDrum`                                                                        | hollow drum rumble: bn LP 300 AM at rotation rate × ribCount + tom-like resonance sin 75 Hz @ -10 dB; slats "tok" per rib passing under listener-near point                                 | loop        | —                                                   | Y           | P4                                                                                                            |
| `sfx_rolling_drum_hit`       | `rollingDrum.hit`                                                                                | `tom_l` + pn LP 900 AD 1/90                                                                                                                                                                 | 200         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_bridge_creak`           | `collapsingBridge.creak` (warning)                                                               | wood creak saw 70→55 Hz FM 1:1.3 I 3 LP 600 AD 80/600 + rope strain BP 900 Q8 sin vib 6 Hz                                                                                                  | 700         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_bridge_snap`            | `collapsingBridge.snap`                                                                          | snap: wn HP 1k AD 0/50 ws 4 + crack sin 600→150 /80 + planks: 4 woodblock 400–700 Hz random over 400 ms + falling whistle @ -12 dB                                                          | 700         | ±2 st, ×3                                           | Y           | P2                                                                                                            |
| `sfx_jumprope_whoosh_loop`   | pose-driven `jumpRopeBeam` per beam                                                              | pn BP fc = 400 + 120·tipSpeed Hz Q1.5, gain peaks when beam passes nearest to listener (gain ∝ 1/(1 + angleDist²)), pitch & fc track rotational speed; beam emitter = closest point on beam | loop        | —                                                   | Y           | P4 (P2 when within 6 m)                                                                                       |
| `sfx_jumprope_pass`          | `jumpRopeBeam.pass` (beam crosses local player's angle, client-side from pose)                   | swoosh pn BP 800→2.2k→900 /250 + `woodblock` accent in music key                                                                                                                            | 260         | ±1 st                                               | N           | P1                                                                                                            |
| `sfx_jumprope_speedup`       | `jumpRopeBeam.speedUp`                                                                           | crank ratchet ×6 accelerating + saw 150→300 /600                                                                                                                                            | 700         | —                                                   | N           | P2                                                                                                            |
| `sfx_teleport_in`            | `teleport` (at `from`)                                                                           | FM 1:1.5 I 6→0 /300 sweep sin 400→2.4k /300 + wn HP 5k AD 0/100 ("zwip")                                                                                                                    | 320         | ±1 st                                               | Y           | P3                                                                                                            |
| `sfx_teleport_out`           | `teleport` (at `to`)                                                                             | reverse of in: sin 2.4k→400 /250 + pop                                                                                                                                                      | 280         | ±1 st                                               | Y           | P3                                                                                                            |
| `sfx_teleporter_idle_loop`   | `teleporterPair` pads                                                                            | sin 220 + 330 Hz AM 3 Hz + shimmer wn BP 6k AM 0.5 Hz @ -26 dB                                                                                                                              | loop        | —                                                   | Y           | P5                                                                                                            |
| `sfx_climbwall_grip`         | `climbWall.grip` (grab on climb wall)                                                            | as `sfx_grab_start_ledge` but plastic: sin 1.6k→1.2k /40 + rim                                                                                                                              | 70          | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_climbwall_pull`         | `climbWall.pull` (climb step)                                                                    | effort "hup" + pn BP 1k AD 2/60                                                                                                                                                             | 120         | ±2 st, ×3                                           | Y           | P3                                                                                                            |
| `sfx_checkpoint`             | `checkpoint` (local only; remote → none)                                                         | bright chime glock 1-3-5 arpeggio 1/32 (track key) + flag flap pn BP 400 AM 20 Hz AD 10/200 + sparkle wn HP 8k AD 0/150                                                                     | 450         | —                                                   | N           | P1                                                                                                            |
| `sfx_checkpoint_gate_idle`   | `checkpointGate` emitter                                                                         | gentle hum sin 523 + 659 Hz AM 1 Hz @ -32 dB                                                                                                                                                | loop        | —                                                   | Y           | P5                                                                                                            |
| `sfx_finish_line_cross`      | `finish`                                                                                         | air horn party "PAAARP": saw 466 + 587 Hz + sqr 698 (B♭ major triad) LP 2.5k AD 10/500 + confetti cannon (§5.11) + crowd cheer; remote finishes within 20 m: horn only @ -10 dB             | 700         | —                                                   | Y (remote)  | P1 / P3                                                                                                       |
| `sfx_finish_line_idle`       | `finishLine` emitter                                                                             | festival hum: crowd murmur emitter + flag flaps                                                                                                                                             | loop        | —                                                   | Y           | P5                                                                                                            |
| `sfx_start_gate_open`        | `startGate.open` (on GO, global)                                                                 | pneumatic gate: wn HP 2k AD 5/300 + clunk sin 120→60 /120 + spring "doing" @ -8 dB                                                                                                          | 400         | —                                                   | N           | P0                                                                                                            |
| `sfx_start_gate_rattle`      | `startGate.bump` (players jumping into the gate during countdown)                                | plastic rattle pn BP 1.4k AM 30 Hz AD 2/120                                                                                                                                                 | 130         | ±2 st, ×3                                           | Y           | P5                                                                                                            |
| `sfx_void_whoosh`            | `voidTrigger.enter` (prefer `fellOut`; cue used only if a void has custom audio)                 | as `sfx_fellout_poof`                                                                                                                                                                       | —           | —                                                   | Y           | P3                                                                                                            |
| `sfx_prop_spawn`             | `propSpawner.spawn`                                                                              | pop sin 400→900 /40 + sparkle                                                                                                                                                               | 120         | ±2 st, ×3                                           | Y           | P4                                                                                                            |

### 5.4 Props & round-specific

| Id                        | Trigger                                                                                        | Recipe                                                                                                                                                          | Dur  | Var              | S            | P             |
| ------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------- | ------------ | ------------- |
| `sfx_egg_pickup`          | `propPickup` where prop kind = egg                                                             | "bloop-up" sin 350→700 /70 + shell tick wn BP 4k AD 0/15                                                                                                        | 100  | ±2 st, ×3        | Y            | P3 (local P1) |
| `sfx_egg_drop`            | `propDrop` egg                                                                                 | wobble bounce sin 300 vib 14 Hz ±30 % AD 2/250 + shell clack woodblock 1.4k                                                                                     | 260  | ±2 st, ×3        | Y            | P3            |
| `sfx_egg_score`           | `score` (Egg Heist, delta > 0, own team)                                                       | coin-ish glock 5-8 in key + basket "plop" sin 200→120 /90 + team chime                                                                                          | 400  | ±1 st            | N (own) / Y  | P1 / P3       |
| `sfx_egg_steal`           | `score` delta < 0 for own team (egg stolen from basket)                                        | descending pulse25 5-4-♭3 1/32 + "hey" crowd gasp small                                                                                                         | 350  | —                | N            | P2            |
| `sfx_ball_kick`           | `ball.kick` (round-rule cue, Bounce Ball Blitz: a Tumbler or dive imparts impulse to the ball) | rubber thump sin 160→90 /80 + pn LP 1.5k AD 1/60 + ball ring sin 420 AD 1/150 @ -14 dB; gain ∝ impulse                                                          | 150  | ±2 st, ±2 dB, ×4 | Y            | P3            |
| `sfx_ball_bounce`         | `ball.bounce` (ground/wall)                                                                    | sin 180→120 /60 + ring 380 Hz AD 1/120 @ -14                                                                                                                    | 120  | ±3 st, ±2 dB, ×4 | Y            | P4            |
| `sfx_goal_horn`           | `score` in Bounce Ball Blitz                                                                   | stadium horn: saw 233 + 294 + 349 Hz (B♭ triad, track key) LP 1.8k, env 30/0/1/600, 1.2 s + `crowd_cheer` + confetti                                            | 1800 | —                | N            | P0            |
| `sfx_tail_grab`           | `propPickup` prop kind = tail (from player)                                                    | velcro rip wn BP 2.5k Q1 AM random 80–200 Hz AD 2/180 + "yoink" sin 400→1200 /80                                                                                | 220  | ±2 st, ×3        | Y            | P3 (local P1) |
| `sfx_tail_stolen`         | `propDrop` tail where player = local (lost tail)                                               | "aw" descending tri 600→300 /250 + velcro                                                                                                                       | 300  | ±1 st            | N            | P1            |
| `sfx_tail_hold_loop`      | local `HasTail` flag                                                                           | soft jingle tamb jingles AM 4 Hz @ -28 dB (you are the target)                                                                                                  | loop | —                | N            | P1            |
| `sfx_key_pickup`          | `propPickup` key                                                                               | bell 2 notes 5-8 in key                                                                                                                                         | 300  | ±1 st            | Y            | P3            |
| `sfx_crown_grab`          | `propPickup` prop kind = crown (Crown Climb)                                                   | see `sfx_crown_fanfare` §5.11 + grab "shing" FM 1:3.5 I 6→0 /500 at E6 + wn HP 6k AD 0/400                                                                      | 900  | —                | N            | P0            |
| `sfx_crown_hover_loop`    | Crown prop emitter                                                                             | magical hum: sin C6 + G6 + E7 AM 0.5 Hz + sparkle grains wn HP 7k λ 12/s @ -24 dB                                                                               | loop | —                | Y            | P4            |
| `sfx_paint_splat`         | `paint.splat` cue (Paint the Plaza: player paints a tile) / `score` small delta                | wet splat: bn LP 1.2k AD 1/120 + pn BP 600→300 /100 Q3 + droplets 3 sin 800–1600 AD 1/40; team pitch: team index × +2 st                                        | 140  | ±2 st, ±2 dB, ×4 | Y            | P4 (local P1) |
| `sfx_paint_steal`         | `paint.overpaint` (painting over enemy tile)                                                   | splat + "thwip" sin 900→1300 /40                                                                                                                                | 150  | ±2 st, ×3        | Y            | P4 (local P1) |
| `sfx_paint_meter_tick`    | team coverage % changes by ≥ 1 % (HUD)                                                         | `woodblock` 1/16 in key, pitch = team rank                                                                                                                      | 40   | —                | N            | P5            |
| `sfx_pattern_reveal`      | `patternPanic.revealStart`                                                                     | whole-tone celesta run 8 notes 1/32 + shimmer wn HP 6k AD 50/600 + each symbol pop (sin 500→1000 /40, pitched per symbol: ★ C6, ● E6, ▲ G6, ■ B♭6, ♥ D7, ◆ F♯6) | 900  | —                | N            | P1            |
| `sfx_pattern_symbol_show` | `patternPanic.symbol` (per symbol in sequence)                                                 | symbol pop (pitch per symbol as above) + glock                                                                                                                  | 160  | —                | N            | P1            |
| `sfx_pattern_hide`        | `patternPanic.revealEnd`                                                                       | reverse shimmer + cloth whoosh                                                                                                                                  | 400  | —                | N            | P1            |
| `sfx_pattern_timer_tick`  | `patternPanic.tick` (each answer-timer second)                                                 | `tick`/`tock` alternate; ≤ 3 s: tick + sqr 1.5 kHz AD 0/40, louder +3 dB per second                                                                             | 50   | —                | N            | P0            |
| `sfx_pattern_tile_drop`   | `patternPanic.drop` (wrong tiles fall)                                                         | trapdoor: woodblock 300 + sin 200→60 /300 + group falling whistle (single voice, -6 dB)                                                                         | 500  | —                | Y (centroid) | P2            |
| `sfx_pattern_safe`        | `patternPanic.safe` (local survived drop)                                                      | 1-3-5 major celesta + soft crowd "phew" (crowd_aww variant pitched +3 st, short)                                                                                | 500  | —                | N            | P1            |
| `sfx_hex_tile_touch`      | `fallingTiles.touch` (Last Tumbler Standing hex layers: first touch starts the fall timer)     | soft ceramic "tink" sin 1.8k→1.6k /40 + wn HP 4k AD 0/10                                                                                                        | 50   | ±3 st, ×4        | Y            | P5 (local P3) |
| `sfx_layer_fall_warn`     | `fallingTiles.layerWarn` (a hex layer about to drop — custom finals)                           | low rumble bn LP 150 AD 400/800 + pitched creak                                                                                                                 | 1200 | —                | N            | P2            |

### 5.5 Round flow & HUD (UI bus unless noted)

| Id                             | Trigger                                        | Recipe                                                                                                                                                                                   | Dur           | Var              | S   | P   |
| ------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------- | --- | --- |
| `ui_countdown_3` / `_2` / `_1` | COUNTDOWN each second                          | marimba + sqr @ -12 dB, note 5 of key (3), 5 (2), 5 (1) one octave down from GO; + `tick`                                                                                                | 300           | —                | N   | P0  |
| `ui_countdown_go`              | PLAYING start (scheduled on music downbeat)    | note 1' (octave up) brass stab + `crash` + whistle "FWEET" sin 2.2 kHz vib 30 Hz ±80 c AD 5/350                                                                                          | 600           | —                | N   | P0  |
| `ui_stamp_qualified`           | local `qualified`                              | stamp thud sin 120→50 /150 + pn LP 1.5k AD 1/100 + ink "chk" wn BP 2k AD 0/40 → then `qualify` music stinger + confetti + crowd_cheer                                                    | 300 + stinger | —                | N   | P0  |
| `ui_stamp_eliminated`          | local `eliminated`                             | stamp thud (lower, sin 100→40) + "bwomp" saw 80 Hz LP 300 AD 10/400 → `eliminate` stinger + crowd_aww                                                                                    | 450 + stinger | —                | N   | P0  |
| `ui_stamp_round_over`          | ROUND_END                                      | double stamp (2 thuds 120 ms apart) + whistle "fwee-oop" → `round_over` stinger                                                                                                          | 600           | —                | N   | P0  |
| `ui_qualify_counter_tick`      | any `qualified` (others)                       | soft `woodblock` in key, pitch steps up a scale degree as counter fills (wraps each octave) @ -12 dB; batched max 8/s                                                                    | 40            | —                | N   | P5  |
| `ui_last_spots`                | qualified ≥ target − 3                         | `last_player` stinger + HUD pulse "whoosh"                                                                                                                                               | 1500          | —                | N   | P0  |
| `ui_timer_final10_tick`        | timer 10..1 s (survival/hunt/team/final timed) | sqr 1 kHz AD 0/40 + `tick` (≥ 4 s); 3..1 s: sqr 1.4 kHz + sin 2.1 kHz AD 1/90, +2 dB each second                                                                                         | 90            | —                | N   | P0  |
| `ui_timer_end`                 | timer reaches 0                                | buzzer sqr 220 + 233 Hz (dissonant) LP 1.5k AD 5/500 → round over flow                                                                                                                   | 500           | —                | N   | P0  |
| `ui_overtime`                  | OVERTIME phase                                 | `overtime` stinger + siren saw 600↔900 1 Hz ×2                                                                                                                                           | 2000          | —                | N   | P0  |
| `ui_toast`                     | HUD event toast (generic)                      | sin 880→1320 /40 AD 1/120 @ -10 dB                                                                                                                                                       | 120           | —                | N   | P5  |
| `ui_team_lead_change`          | team leader changes                            | 2-note chime 3→5 (gain) / 5→3 (lose) in key, glock                                                                                                                                       | 300           | —                | N   | P2  |
| `ui_players_left_tick`         | survival: alive count decrements (others)      | soft pop sin 600→400 /40 @ -16 dB, batched                                                                                                                                               | 40            | —                | N   | P5  |
| `ui_spectate_switch`           | spectate target change (Q/E)                   | camera whoosh pn BP 1.5k→600 /150 @ -12 dB                                                                                                                                               | 150           | ±1 st            | N   | P0  |
| `ui_ping`                      | quick ping placed                              | sin 1.2k + 1.8k AD 1/180 + pin "tock"                                                                                                                                                    | 200           | —                | Y   | P3  |
| `ui_results_card`              | each results card flips                        | card flip pn BP 2.5k AD 2/50 + glock note rising                                                                                                                                         | 80            | ±0 (scale steps) | N   | P5  |
| `ui_next_round_tease`          | TRANSITION next round card                     | `mus_stinger_next_round`                                                                                                                                                                 | 1200          | —                | N   | P0  |
| `ui_flyover_title`             | INTRO_FLYOVER title card slam                  | whoosh + stamp + crowd ooh; type badge plays type chime (race: rising 1-3-5; survival: 1-♭3-5 pulse; team: 2 chords alternating; hunt: 5-♭6-5; logic: 1-♯4 tick; final: timpani + brass) | 900           | —                | N   | P0  |
| `ui_rules_card`                | RULES_CARD shown                               | soft page turn + bell                                                                                                                                                                    | 300           | —                | N   | P5  |

### 5.6 UI (menus)

All pitched UI in **F major** in menus (§3).

| Id                               | Trigger                                                        | Recipe                                                                                                                              | Dur  | Var     | P                          |
| -------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- | ------- | -------------------------- |
| `ui_hover`                       | pointer enters a button / focus moves (gamepad)                | sin 1.8 kHz AD 1/25 @ -18 dB (tiny tick)                                                                                            | 25   | ±0.5 st | P0 (cap 2, interval 60 ms) |
| `ui_click`                       | button activate                                                | sin f: 700→1100 /30 AD 1/60 + tri @ -12 dB ("blip")                                                                                 | 70   | ±0.3 st | P0                         |
| `ui_click_big`                   | PLAY button                                                    | `ui_click` + `bell` F5+C6 + whoosh pn BP 800→2.5k /200                                                                              | 300  | —       | P0                         |
| `ui_back`                        | back / close                                                   | sin f: 1100→700 /40 AD 1/60                                                                                                         | 70   | —       | P0                         |
| `ui_tab`                         | tab switch                                                     | pn BP 2 kHz Q2 AD 2/40 (card swipe) + sin 1320 AD 1/50 @ -10                                                                        | 60   | —       | P0                         |
| `ui_toggle_on` / `ui_toggle_off` | toggle                                                         | on: sin 880→1320 /20 + tick; off: 1320→880                                                                                          | 60   | —       | P0                         |
| `ui_slider_tick`                 | slider step (every 5 %)                                        | `tick` at -20 dB, pitch rises with value 0→+12 st                                                                                   | 15   | —       | P0                         |
| `ui_equip`                       | equip cosmetic                                                 | glock 5-1' in F + cloth fwump                                                                                                       | 250  | —       | P0                         |
| `ui_randomize`                   | Locker randomize                                               | slot-machine 8 ticks accelerating + ding                                                                                            | 600  | —       | P0                         |
| `ui_purchase`                    | purchase success                                               | cash "ka-ching": `bell` C6+E6+G6 1/32 + coin shake wn HP 5k AM 25 Hz AD 5/200 + chord F major glock                                 | 700  | —       | P0                         |
| `ui_error`                       | invalid action / insufficient funds                            | sqr 220 + 233 Hz AD 5/180 LP 1.2k ("bwonk") ×2 at 100 ms                                                                            | 300  | —       | P0                         |
| `ui_notification`                | notification arrives                                           | bell 2 notes C6→F6 AD 1/400                                                                                                         | 450  | —       | P0                         |
| `ui_friend_online`               | friend online                                                  | glock 3 notes 1-3-5 soft                                                                                                            | 300  | —       | P0                         |
| `ui_party_join`                  | party member joins                                             | `party_join` stinger (§2.8)                                                                                                         | 400  | —       | P0                         |
| `ui_ready`                       | ready toggle on                                                | clap + glock 5                                                                                                                      | 200  | —       | P0                         |
| `ui_match_found`                 | matchmaking success                                            | `match_found` stinger                                                                                                               | 700  | —       | P0                         |
| `ui_chat_message`                | chat message (unfocused)                                       | sin 1.5k AD 1/60 @ -20 dB                                                                                                           | 60   | —       | P5                         |
| `ui_currency_tick_gumballs`      | Gumball counter increment (rewards, per visual tick, max 20/s) | gumball "plink": sin 1.6k→1.9k /20 AD 1/60 + rattle wn BP 3k AD 0/20 @ -12 dB; pitch climbs 0→+7 st over the count                  | 60   | ±0.5 st | P0                         |
| `ui_currency_tick_gems`          | Gem counter increment                                          | crystal: FM 1:2.76 I 3→0 /120 at 2.4 kHz AD 1/250, pitch climbs                                                                     | 250  | ±0.3 st | P0                         |
| `ui_currency_tick_shards`        | Crown Shard increment                                          | metallic chime FM 1:1.41 I 2 at 1.2 kHz AD 1/400 + shimmer                                                                          | 400  | —       | P0                         |
| `ui_currency_total`              | counter lands on final value                                   | chord hit (glock + bell F major)                                                                                                    | 400  | —       | P0                         |
| `ui_xp_fill_loop`                | XP bar filling                                                 | saw + saw det 7 c → LP filt fc = 400 + 3000·fill Hz Q4, pitch 220→440 Hz linear with fill fraction + sparkle grains λ 20/s @ -16 dB | loop | —       | P0                         |
| `ui_xp_segment`                  | XP breakdown line appears                                      | `woodblock` + glock 1 note ascending                                                                                                | 100  | —       | P0                         |
| `ui_level_up`                    | level up                                                       | leitmotif on brass + glock 1/16, crash, `crowd_cheer` small, sparkle sweep wn HP 6k→12k                                             | 1800 | —       | P0                         |
| `ui_pass_tier`                   | Season Pass tier gained                                        | glock 1-3-5-1' + stamp                                                                                                              | 700  | —       | P0                         |
| `ui_challenge_done`              | challenge completed                                            | 2 chords IV→I with brass + check "tick"                                                                                             | 800  | —       | P0                         |
| `ui_rp_up` / `ui_rp_down`        | ranked RP change                                               | up: rising glock pentatonic run 6 notes; down: descending tri 3 notes soft                                                          | 600  | —       | P0                         |
| `ui_rank_promote`                | rank tier promotion                                            | rarity Epic fanfare re-voiced with timpani + crowd cheer                                                                            | 2500 | —       | P0                         |

**Rarity reveal fanfares** (unlock reveal, store reveals, Pass rewards). Each is
a build (pre-roll) + hit + tail. Build begins when the box/capsule shakes; the
hit lands on reveal. All in F major (menu) and transposable.

| Id                    | Build (pre-roll)                                                                                                               | Hit                                                                                                                                              | Tail                                                                                              | Total |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----- |
| `ui_rarity_common`    | none                                                                                                                           | pluck F4-A4 + soft pop                                                                                                                           | 300 ms                                                                                            | 0.4 s |
| `ui_rarity_uncommon`  | 300 ms shaker swell                                                                                                            | glock F5-A5-C6 1/32 + pop                                                                                                                        | 500 ms                                                                                            | 0.9 s |
| `ui_rarity_rare`      | 500 ms snare roll pp→mf                                                                                                        | glock + bell F major triad + wn sparkle HP 6k                                                                                                    | 800 ms                                                                                            | 1.4 s |
| `ui_rarity_epic`      | 800 ms snare roll + rising saw 200→800 Hz LP                                                                                   | brass stab B♭→F (IV–I) + crash + glock arpeggio up 2 octaves                                                                                     | 1.2 s, choir "aah"                                                                                | 2.4 s |
| `ui_rarity_legendary` | 1.2 s timpani roll + reverse cymbal + rising choir                                                                             | full brass leitmotif first 4 notes (C D C A) → F major chord, crash, `crowd_cheer`                                                               | 1.6 s with bells                                                                                  | 3.4 s |
| `ui_rarity_mythic`    | 1.6 s: heartbeat kicks accelerating (60→160 BPM) + whole-tone celesta run + HP-swept noise riser 20→4 kHz + 400 ms **silence** | massive hit: brass + choir + timpani on D♭ (♭VI) → E♭ (♭VII) → F (I) in 3 eighth-notes, crash ×2, firework pops ×3, `crowd_cheer` + `crowd_gasp` | 2.0 s, shimmer loop that continues while the item card is shown (glock 1/16 pentatonic at -20 dB) | 4.5 s |

### 5.7 Celebration, crowd & show

| Id                          | Trigger                                                                | Recipe                                                                                                                                                                                                         | Dur  | Var                      | S             | P             |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------ | ------------- | ------------- |
| `ui_confetti`               | qualify, finish line, level up, victory                                | confetti cannon: pop pn HP 1k AD 0/30 + sin 300→120 /60, then flutter: wn BP 5 kHz Q1 with random AM grains (λ 80/s) AD 20/1400 decaying                                                                       | 1500 | ±2 st, ×3                | N (local) / Y | P0 local / P4 |
| `ui_confetti_small`         | emotes, small wins                                                     | pop + 400 ms flutter                                                                                                                                                                                           | 500  | ±2 st                    | Y             | P5            |
| `sfx_firework_launch`       | victory / finish fireworks                                             | whistle sin 600→2.4k /900 lin vib 12 Hz ±20 c + hiss wn HP 3k AD 50/900 @ -12                                                                                                                                  | 900  | ±3 st, ×3                | Y             | P4            |
| `sfx_firework_burst`        | launch + 900 ms                                                        | boom sin 70→35 /300 + bn LP 1.2k AD 1/700 + crackle: 30 wn grains (2–5 ms) spread over 1.2 s, HP 3k                                                                                                            | 1600 | ±2 st, ±3 dB, ×4         | Y             | P4            |
| `crowd_cheer`               | local qualify, finish 1st, goal, crown, final showdown events          | 24 babble voices vowel /a/ /e/ pitch 180–420 Hz random glides up, env 80/0/1/900 over 1.6 s + whistles (sin 2.2–3k vib 8 Hz, 3 voices) + `clap` texture λ 900/min                                              | 1800 | ±1 st, ±2 dB, ×3         | N             | P2            |
| `crowd_aww`                 | local eliminated, near-miss qualify, team loses goal                   | 20 babble voices vowel /a/→/o/ pitch glide down 300→200 Hz over 1.2 s, LP 2k                                                                                                                                   | 1300 | ±1 st, ×3                | N             | P2            |
| `crowd_gasp`                | huge fall, big stun near camera, mythic reveal, last-second save       | 20 voices inhaled noise: pn BP 1.2k filt env 600→2k /150 env 30/0/1/250 + vowel /a/ short                                                                                                                      | 500  | ±1 st, ×3                | N             | P2            |
| `crowd_laugh`               | pile-up, belly-flop into void, door thud chains, funny stuns           | 16 babble voices syllable "ha" at 6–9 Hz rate, pitch 200–350 Hz, AM 7 Hz, env 50/1200                                                                                                                          | 1400 | ±1 st, ×3                | N             | P2            |
| `crowd_ooh`                 | close calls (sweeper missed by < 0.5 m, cannon near-miss), title cards | 20 voices vowel /u/ pitch rise 220→300 Hz over 700 ms                                                                                                                                                          | 800  | ±1 st, ×3                | N             | P2            |
| `crowd_applause`            | results grid, rewards                                                  | `clap` grains λ 1500/min, decaying over 3 s, + 4 whistles                                                                                                                                                      | 3000 | ×2                       | N             | P4            |
| `sfx_crowd_pileup`          | clustered land/stun (§1.7)                                             | 4 thumps (pn LP 600) in 300 ms + `sfx_stun_boing` ×3 detuned ±3 st + `crowd_laugh`                                                                                                                             | 900  | ×3                       | Y             | P3            |
| `ui_wall_cell_drop`         | Player Wall: each eliminated cell drops (quantised to music 1/16)      | cell "pluck-off" sin 400→250 /60 + tiny falling whistle sin 1.2k→500 /400 @ -12 dB; pitch = random pentatonic note in E♭; > 6 cells in one 1/16 → single grouped "clatter" (6 woodblocks randomised in 120 ms) | 400  | pentatonic random, ±2 dB | N             | P0            |
| `ui_wall_round_label`       | Player Wall round label appears                                        | glock 1 note (round index → scale degree) + whoosh                                                                                                                                                             | 300  | —                        | N             | P0            |
| `ui_wall_winner`            | last cell remains                                                      | `crown_fanfare`                                                                                                                                                                                                | —    | —                        | N             | P0            |
| `sfx_crown_fanfare`         | crown grabbed / last survivor / Player Wall winner                     | 3 brass hits (I–IV/I–I) + timpani roll, then leitmotif augmented (major), bells, choir, crash ×2, `crowd_cheer` + fireworks ×3 staggered; hands over to `mus_victory_crowned` intro                            | 3500 | —                        | N             | P0            |
| `sfx_victory_slowmo_whoosh` | crown grab slow-mo                                                     | pn BP 200→1.5k /1.5 s + reverse cymbal + all sfx playbackRate 0.6 for 1.5 s                                                                                                                                    | 1500 | —                        | N             | P0            |
| `sfx_photo_shutter`         | photo mode capture                                                     | wn BP 3k AD 0/20 + click 30 ms later + film advance saw 80 Hz AM 40 Hz 120 ms                                                                                                                                  | 200  | —                        | N             | P0            |

### 5.8 Announcer support SFX

| Id                    | Use                                 | Recipe                               |
| --------------------- | ----------------------------------- | ------------------------------------ |
| `ann_mic_on`          | before a priority-A line (optional) | soft "ding-dong" bell C6→A5 @ -18 dB |
| `ann_babble_syllable` | announcer placeholder voice (§6.2)  | runtime formant synth                |

---

## 6. Announcer — "Pip Spectacular"

### 6.1 Concept

**Pip Spectacular** is the show's host: a pocket-sized, sparkly, hovering
microphone with a tiny bow tie and a voice that is always one exclamation mark
away from bursting. Pip adores every Tumbler equally, narrates disasters like
they are triumphs, and never mocks a player — eliminations are framed as
"spectacular exits". Tone: warm, punny, fast, kid-friendly, TV-game-show energy.

Voice direction (for future TTS / VO): bright mid-high pitch, rapid delivery
(≈ 190 wpm), big pitch swings on key words, dramatic pauses before reveals.
Catchphrases: "Tumble on!", "That's showbiz, baby!", "Spectacular!".

### 6.2 Synthesis & placeholder approach

Phase 1 (ships now) — **procedural babble + caption**:

- Every line plays as a stylised babble voice (think "toy radio host"),
  synthesised live from the caption text, while the caption appears.
- Source: `saw` glottal at f0 with contour (below) + `wn` @ -24 dB (breath),
  → 3 parallel `BP` formant filters (Q 8/10/12) → sum → `PK 3 kHz +4 dB` → `annComp`.
- Syllables: count vowel groups in the caption (min 2, max 24). Syllable length
  85–140 ms (shorter for priority-A lines), 15 ms gaps; word gaps 40 ms;
  punctuation: `,` 120 ms, `.`/`!`/`?` 220 ms.
- Per syllable choose vowel from the letter's vowel (a, e, i, o, u map to formant
  sets F1/F2/F3: a 800/1200/2500, e 400/2000/2600, i 300/2300/3000,
  o 500/900/2400, u 350/700/2400 Hz). Formant frequencies ramp 20 ms between
  syllables (smooth "talking").
- Consonants: for each plosive letter (p, t, k, b, d, g) a 6 ms `wn` burst BP
  2–4 kHz; for s/z/sh 40 ms `wn` HP 5 kHz; nasal m/n lowers F1 to 250 for 30 ms.
- Pitch (f0): base 240 Hz, vib 6 Hz ±25 c. Contour: declarative = start +3 st,
  fall to -2 st; `!` = rise +5 st on the last stressed syllable then drop;
  `?` = rise +7 st at the end. Random ±1.5 st per syllable.
- Env per syllable: 8/40/0.8/30 ms. Line ends with 200 ms release.
- Deterministic: seed = hash(line id) so a line always "sounds" the same.
- Settings → Audio → Announcer: **On (voice + captions)**, **Captions only**, **Off**.

Phase 2 — TTS bake: offline TTS (licensed voice) rendered to Opus files per
line id, same ids, loaded lazily per round; babble remains the fallback when a
file is missing or fails to decode.

### 6.3 Playback rules

- **One line at a time** (single announcer voice). Queue max 2; lines older than
  `maxLatency` (default 2.5 s, priority A 4 s) are dropped from the queue.
- Priority: **A** critical (interrupts B/C after a 100 ms fade), **B** normal
  (queues), **C** flavour (dropped if anything else is playing or queued).
- Cooldowns: per line id (table) + per category global cooldown (flavour lines
  ≥ 12 s apart, team status lines ≥ 15 s apart).
- Variations: ids ending `_01`, `_02`… are alternatives; pick random without
  repeating the last used for that group within a show.
- Never speak during countdown numbers except the dedicated countdown lines;
  never speak over `qualify`/`eliminate` stinger hits (delay 600 ms).
- Lines referencing a player's name (future) insert `{name}`; captions always
  show the name; babble just adds syllables.

### 6.4 Caption style rules & accessibility

- **Captions are ON by default** for the announcer (accessibility setting
  "Announcer captions": default On; separate "Sound captions" for SFX like
  "[crowd cheers]", default Off).
- Caption ≤ 60 characters, single line on desktop, may wrap to 2 lines on
  mobile. Sentence case, max one exclamation mark, no ALL CAPS except the
  stamp words (QUALIFIED, ELIMINATED, GO).
- Speaker label "PIP:" in the accent colour (yellow = interactable, never
  danger magenta), white text on 70 % black rounded pill, bottom-centre above the
  controls hint, 22 px at 1080p (scales with UI scale setting; min 16 px).
- Show duration = max(1.6 s, 0.06 s × characters + 0.8 s) and at least the babble
  length + 300 ms. Fade in 120 ms, out 200 ms. Reduced-motion: no slide/bounce.
- Never put critical rules ONLY in the announcer: every rule line duplicates
  information already on the rules card or HUD.
- Captions never cover the timer or qualification counter; on mobile they sit
  above the jump/dive buttons.
- Colourblind-safe: no information carried by caption colour alone.
- Screen-reader: captions mirrored to an `aria-live="polite"` region (priority A
  lines `assertive`).
- Language: plain words, puns allowed, no slang that needs cultural knowledge to
  understand the instruction. Localisation keys = line ids.

### 6.5 Line list

Priority: A critical / B normal / C flavour. Cooldown is per id ("show" = once
per show, "round" = once per round).

#### Show & lobby

| Id                    | Trigger                           | Caption                                                    | Pri | Cooldown |
| --------------------- | --------------------------------- | ---------------------------------------------------------- | --- | -------- |
| `ann_show_intro_01`   | pre-show lobby, 15 s before start | Welcome to Tumble Royale! I'm Pip, and you're spectacular! | B   | show     |
| `ann_show_intro_02`   | alt                               | Forty Tumblers, one Crown. Let's get wobbly!               | B   | show     |
| `ann_show_intro_03`   | alt                               | Lights! Cameras! Questionable balance!                     | B   | show     |
| `ann_show_intro_04`   | alt                               | It's showtime, Tumblers! Stretch those little legs!        | B   | show     |
| `ann_show_start`      | show start stinger                | And the show begins... now!                                | A   | show     |
| `ann_lobby_idle_01`   | pre-show, player idle 10 s        | Warm-up tip: jumping is free. Use it!                      | C   | 60 s     |
| `ann_lobby_idle_02`   | alt                               | Go on, bump a friend. For science.                         | C   | 60 s     |
| `ann_lobby_full`      | lobby reaches 40                  | Full house! Every seat's a wobbly one!                     | B   | show     |
| `ann_lobby_bots_fill` | bots fill remaining slots         | Our robo-Tumblers are joining. Be nice!                    | C   | show     |
| `ann_round_count`     | pre-show, after intro             | Tonight's show: {n} rounds of pure chaos!                  | B   | show     |

#### Round type intros (RULES_CARD)

| Id                     | Trigger             | Caption                                           | Pri | Cooldown |
| ---------------------- | ------------------- | ------------------------------------------------- | --- | -------- |
| `ann_type_race_01`     | race rules card     | It's a race! First to the finish, qualify!        | B   | round    |
| `ann_type_race_02`     | alt                 | Run, jump, dive! Cross that finish line!          | B   | round    |
| `ann_type_survival_01` | survival rules card | Survival round! Stay on your feet till time's up! | B   | round    |
| `ann_type_survival_02` | alt                 | Don't fall. That's it. That's the whole plan!     | B   | round    |
| `ann_type_team_01`     | team rules card     | Team round! Lowest-scoring team goes home!        | B   | round    |
| `ann_type_team_02`     | alt                 | Teamwork makes the dream work. Mostly!            | B   | round    |
| `ann_type_hunt_01`     | hunt rules card     | Hunt round! Grab it, hold it, keep it!            | B   | round    |
| `ann_type_hunt_02`     | alt                 | Hold on tight when the clock runs out!            | B   | round    |
| `ann_type_logic_01`    | logic rules card    | Brain time! Remember the pattern, find the tile!  | B   | round    |
| `ann_type_logic_02`    | alt                 | Think fast, Tumblers. Wrong tiles drop!           | B   | round    |
| `ann_type_final_01`    | final rules card    | It's the Final! One Tumbler takes the Crown!      | A   | round    |
| `ann_type_final_02`    | alt                 | This is it! Win this one and wear the Crown!      | A   | round    |

#### Rounds by name (INTRO_FLYOVER title; `_tip` = first 20 s of PLAYING, C)

| Id                                    | Trigger                    | Caption                                             | Pri | Cooldown |
| ------------------------------------- | -------------------------- | --------------------------------------------------- | --- | -------- |
| `ann_round_gumdrop_gauntlet`          | flyover title              | Gumdrop Gauntlet! Doors, wheels and a sugar rush!   | B   | round    |
| `ann_round_gumdrop_gauntlet_tip`      | early play                 | Some doors are fake. Some doors are very real!      | C   | round    |
| `ann_round_conveyor_chaos`            | flyover                    | Conveyor Chaos! The floor has opinions!             | B   | round    |
| `ann_round_conveyor_chaos_tip`        | early play / first reverse | Belts reverse! Listen for the klaxon!               | C   | round    |
| `ann_round_tilt_town`                 | flyover                    | Tilt Town! Where every step is a tiny earthquake!   | B   | round    |
| `ann_round_tilt_town_tip`             | early play                 | Stay near the middle and the world stays flat!      | C   | round    |
| `ann_round_slip_n_spiral`             | flyover                    | Slip 'n' Spiral! Ice, slopes and rolling boulders!  | B   | round    |
| `ann_round_slip_n_spiral_tip`         | early play                 | On ice, steer early. Brakes are a rumour!           | C   | round    |
| `ann_round_hammer_highway`            | flyover                    | Hammer Highway! Mind the swing, mind the gap!       | B   | round    |
| `ann_round_hammer_highway_tip`        | first bridge creak         | Hear that creak? That bridge won't wait!            | C   | round    |
| `ann_round_wind_tunnel_peaks`         | flyover                    | Wind Tunnel Peaks! Climb high, don't blow away!     | B   | round    |
| `ann_round_wind_tunnel_peaks_tip`     | early play                 | Fans push you around. Grab ledges to hold on!       | C   | round    |
| `ann_round_cannonball_canyon`         | flyover                    | Cannonball Canyon! Foam balls incoming!             | B   | round    |
| `ann_round_cannonball_canyon_tip`     | first cannon telegraph     | Hiss means duck! Dodge those foam cannonballs!      | C   | round    |
| `ann_round_spin_cycle`                | flyover                    | Spin Cycle! Jump the low arm, duck the high one!    | B   | round    |
| `ann_round_spin_cycle_tip`            | first accel                | The arms are speeding up. Hop happy!                | C   | round    |
| `ann_round_tile_panic`                | flyover                    | Tile Panic! Every tile you touch gets wobbly!       | B   | round    |
| `ann_round_tile_panic_tip`            | early play                 | Keep moving and save tiles for later!               | C   | round    |
| `ann_round_rising_goo_tower`          | flyover                    | Rising Goo Tower! The goo is coming up. You aren't! | B   | round    |
| `ann_round_rising_goo_tower_tip`      | first surge                | The goo just sped up. Climb, climb, climb!          | C   | round    |
| `ann_round_jump_rope_royale`          | flyover                    | Jump Rope Royale! Hop the beams, high and low!      | B   | round    |
| `ann_round_jump_rope_royale_tip`      | first speed-up             | Faster beams! Time those hops!                      | C   | round    |
| `ann_round_egg_heist`                 | flyover                    | Egg Heist! Fill your basket, raid theirs!           | B   | round    |
| `ann_round_egg_heist_tip`             | early play                 | Golden eggs count extra. Guard them well!           | C   | round    |
| `ann_round_bounce_ball_blitz`         | flyover                    | Bounce Ball Blitz! Boot that ball into the goal!    | B   | round    |
| `ann_round_bounce_ball_blitz_tip`     | early play                 | Dive into the ball for a big kick!                  | C   | round    |
| `ann_round_paint_the_plaza`           | flyover                    | Paint the Plaza! Cover the floor in team colour!    | B   | round    |
| `ann_round_paint_the_plaza_tip`       | early play                 | Steal enemy tiles by running over them!             | C   | round    |
| `ann_round_tail_chase`                | flyover                    | Tail Chase! Grab a tail and keep it!                | B   | round    |
| `ann_round_tail_chase_tip`            | early play                 | No tail? Chase someone who has one!                 | C   | round    |
| `ann_round_pattern_panic`             | flyover                    | Pattern Panic! Watch the symbols, trust your brain! | B   | round    |
| `ann_round_pattern_panic_tip`         | first reveal               | Remember it! The screen goes dark soon!             | C   | round    |
| `ann_round_crown_climb`               | flyover                    | Crown Climb! First to grab the Crown wins it all!   | A   | round    |
| `ann_round_crown_climb_tip`           | early play                 | The Crown is at the top. Just... get up there!      | C   | round    |
| `ann_round_last_tumbler_standing`     | flyover                    | Last Tumbler Standing! Floors vanish under you!     | A   | round    |
| `ann_round_last_tumbler_standing_tip` | early play                 | Each tile drops after you touch it. Plan ahead!     | C   | round    |
| `ann_round_spin_cycle_finale`         | flyover                    | Spin Cycle Finale! One survivor wears the Crown!    | A   | round    |
| `ann_round_spin_cycle_finale_tip`     | first accel                | Those arms mean business now!                       | C   | round    |
| `ann_round_goo_peak_final`            | flyover                    | Goo Peak Final! Highest Tumbler standing wins!      | A   | round    |
| `ann_round_goo_peak_final_tip`        | first surge                | The goo wants a Crown too. Don't let it!            | C   | round    |

#### Countdown & start

| Id                    | Trigger         | Caption                  | Pri | Cooldown |
| --------------------- | --------------- | ------------------------ | --- | -------- |
| `ann_countdown_ready` | COUNTDOWN start | Tumblers, on your marks! | A   | round    |
| `ann_countdown_3`     | 3               | Three!                   | A   | —        |
| `ann_countdown_2`     | 2               | Two!                     | A   | —        |
| `ann_countdown_1`     | 1               | One!                     | A   | —        |
| `ann_countdown_go_01` | GO              | Go!                      | A   | —        |
| `ann_countdown_go_02` | alt (final)     | Go for the Crown!        | A   | —        |
| `ann_countdown_go_03` | alt (survival)  | Survive!                 | A   | —        |

#### Race qualification flow

| Id                         | Trigger                        | Caption                                    | Pri | Cooldown |
| -------------------------- | ------------------------------ | ------------------------------------------ | --- | -------- |
| `ann_first_qualifier_01`   | first `qualified` of the round | We have our first qualifier! Speedy!       | B   | round    |
| `ann_first_qualifier_02`   | alt                            | First across the line! Somebody stretched! | B   | round    |
| `ann_first_qualifier_self` | local player is first          | You're first! Pure spectacle!              | A   | round    |
| `ann_half_full_01`         | qualified ≥ 50 %               | Half the spots are gone! Pick up the pace! | B   | round    |
| `ann_half_full_02`         | alt                            | We're halfway full. Hustle, Tumblers!      | B   | round    |
| `ann_last_spots_01`        | qualified ≥ target − 3         | Only a few spots left! Run, run, run!      | A   | round    |
| `ann_last_spots_02`        | alt                            | Last spots! Dive for that finish!          | A   | round    |
| `ann_last_spot`            | qualified = target − 1         | One spot left! Who wants it most?          | A   | round    |
| `ann_qualified_self_01`    | local qualified (non-first)    | You're through! Take a bow!                | B   | 20 s     |
| `ann_qualified_self_02`    | alt                            | Qualified! Smooth moves out there!         | B   | 20 s     |
| `ann_qualified_self_last`  | local takes the very last spot | Last spot, but it counts! Phew!            | A   | round    |

#### Overtime, round over, results

| Id                         | Trigger                      | Caption                                   | Pri | Cooldown |
| -------------------------- | ---------------------------- | ----------------------------------------- | --- | -------- |
| `ann_overtime_01`          | OVERTIME                     | Overtime! It's not over till Pip says so! | A   | round    |
| `ann_overtime_02`          | alt                          | Sudden overtime! Next point wins it!      | A   | round    |
| `ann_round_over_01`        | ROUND_END                    | And... that's the round!                  | A   | round    |
| `ann_round_over_02`        | alt                          | Time! Hands off the obstacles!            | A   | round    |
| `ann_round_over_03`        | alt                          | Round over! What a mess. I loved it!      | A   | round    |
| `ann_results_players_left` | RESULTS grid                 | {n} Tumblers left in the show!            | B   | round    |
| `ann_results_next_round`   | TRANSITION                   | Next up... something wobbly!              | C   | round    |
| `ann_results_big_cut`      | > 40 % eliminated this round | That round was hungry! Big cut!           | C   | round    |

#### Survival milestones

| Id                               | Trigger                        | Caption                                | Pri | Cooldown |
| -------------------------------- | ------------------------------ | -------------------------------------- | --- | -------- |
| `ann_survival_60s`               | 60 s left                      | One minute left! Keep those feet busy! | B   | round    |
| `ann_survival_30s_01`            | 30 s left                      | Thirty seconds! Hang in there!         | A   | round    |
| `ann_survival_30s_02`            | alt                            | Half a minute to glory!                | A   | round    |
| `ann_survival_10s`               | 10 s left                      | Ten seconds! Don't you dare fall now!  | A   | round    |
| `ann_survival_players_left_half` | alive ≤ 50 %                   | Half the field is gone! Stay sharp!    | B   | round    |
| `ann_survival_players_left_n`    | alive hits 10 / 5 / 3          | Only {n} Tumblers still standing!      | B   | 10 s     |
| `ann_survival_almost_done`       | alive = elimination target + 1 | One more fall and the round's over!    | A   | round    |
| `ann_survival_survived`          | local survives to timer end    | You survived! Legendary stubbornness!  | B   | round    |

#### Team rounds

| Id                        | Trigger                         | Caption                                   | Pri | Cooldown |
| ------------------------- | ------------------------------- | ----------------------------------------- | --- | -------- |
| `ann_team_assign`         | team round PLAYING start        | Find your colour and stick together!      | B   | round    |
| `ann_team_leading_pink`   | pink team takes the lead        | Pink team takes the lead!                 | B   | 15 s     |
| `ann_team_leading_blue`   | blue team takes lead            | Blue team pulls ahead!                    | B   | 15 s     |
| `ann_team_leading_yellow` | yellow team takes lead          | Yellow team is on top!                    | B   | 15 s     |
| `ann_team_leading_green`  | green team takes lead           | Green team grabs the lead!                | B   | 15 s     |
| `ann_team_tied`           | scores tied after a change      | It's all tied up! Anyone's game!          | B   | 20 s     |
| `ann_team_own_losing`     | own team last, ≤ 30 s           | Your team's in trouble! Rally!            | A   | round    |
| `ann_team_own_winning`    | own team first, ≤ 30 s          | Your team's ahead! Hold the line!         | B   | round    |
| `ann_team_comeback`       | a team rises from last to first | What a comeback! Never count them out!    | B   | round    |
| `ann_team_goal_01`        | `score` in Bounce Ball Blitz    | Goooal! What a boot!                      | B   | 8 s      |
| `ann_team_goal_02`        | alt                             | Into the net! The crowd goes wild!        | B   | 8 s      |
| `ann_team_egg_golden`     | golden egg scored               | A golden egg! That's worth a lot!         | B   | 15 s     |
| `ann_team_paint_half`     | any team ≥ 50 % coverage        | Half the plaza is one colour! Paint back! | B   | round    |
| `ann_team_win`            | own team survives               | Your team made it! High fives all round!  | B   | round    |
| `ann_team_lose`           | own team eliminated             | Your team's out. Great teamwork though!   | B   | round    |

#### Hunt rounds

| Id                      | Trigger                    | Caption                                 | Pri | Cooldown |
| ----------------------- | -------------------------- | --------------------------------------- | --- | -------- |
| `ann_hunt_got_tail`     | local grabs tail           | You've got a tail! Now run!             | B   | 15 s     |
| `ann_hunt_lost_tail`    | local loses tail           | Your tail got swiped! Get it back!      | B   | 15 s     |
| `ann_hunt_30s`          | 30 s left                  | Thirty seconds! Tails are precious now! | A   | round    |
| `ann_hunt_10s`          | 10 s left                  | Ten seconds! Hold on tight!             | A   | round    |
| `ann_hunt_steal_streak` | same player steals 3 tails | Sticky fingers! Three steals in a row!  | C   | 30 s     |

#### Logic rounds

| Id                    | Trigger                    | Caption                             | Pri | Cooldown |
| --------------------- | -------------------------- | ----------------------------------- | --- | -------- |
| `ann_logic_watch_01`  | `patternPanic.revealStart` | Watch the symbols!                  | A   | 6 s      |
| `ann_logic_watch_02`  | alt                        | Eyes up! Memorise this!             | A   | 6 s      |
| `ann_logic_remember`  | `patternPanic.revealEnd`   | Now find the right symbol!          | A   | 6 s      |
| `ann_logic_hurry`     | answer timer 3 s           | Hurry! Pick a tile!                 | A   | 6 s      |
| `ann_logic_drop`      | `patternPanic.drop`        | Wrong tiles... drop!                | A   | 6 s      |
| `ann_logic_safe_self` | local survives drop        | Correct! Big brain energy!          | B   | 10 s     |
| `ann_logic_mass_drop` | ≥ 30 % fell in one drop    | Ooh, that one fooled a lot of you!  | C   | 20 s     |
| `ann_logic_faster`    | pattern speeds up          | Faster patterns now. Focus!         | B   | round    |
| `ann_logic_harder`    | more symbols per pattern   | More symbols! Your brain can do it! | B   | round    |

#### Final

| Id                           | Trigger                             | Caption                                        | Pri | Cooldown |
| ---------------------------- | ----------------------------------- | ---------------------------------------------- | --- | -------- |
| `ann_final_intro_01`         | final title card                    | Welcome to the Final! Only one wins the Crown! | A   | show     |
| `ann_final_intro_02`         | alt                                 | The Crown is waiting. Who's worthy?            | A   | show     |
| `ann_final_halfway`          | Crown Climb leader at 50 % height   | They're halfway to the Crown!                  | B   | round    |
| `ann_final_crown_close`      | Crown Climb leader ≥ 85 % height    | Someone's reaching for the Crown!              | A   | round    |
| `ann_final_three_left`       | alive = 3                           | Three Tumblers left! The tension!              | A   | round    |
| `ann_final_showdown_01`      | alive = 2                           | It's a showdown! Two Tumblers, one Crown!      | A   | round    |
| `ann_final_showdown_02`      | alt                                 | Final two! Don't blink!                        | A   | round    |
| `ann_final_goo_rising`       | Goo Peak goo ≥ 70 %                 | The goo is almost at the top!                  | A   | round    |
| `ann_final_self_in_showdown` | local in final two                  | It's you and one other. Breathe!               | A   | round    |
| `ann_final_layer_gone`       | Last Tumbler Standing layer empties | A whole floor just vanished!                   | B   | 10 s     |

#### Crown winner & victory

| Id                         | Trigger                                   | Caption                                       | Pri | Cooldown |
| -------------------------- | ----------------------------------------- | --------------------------------------------- | --- | -------- |
| `ann_crown_winner_01`      | someone wins the Crown                    | We have a winner! Long live the Crown!        | A   | show     |
| `ann_crown_winner_02`      | alt                                       | Crowned! Spectacular! Absolutely spectacular! | A   | show     |
| `ann_crown_winner_self_01` | local wins                                | You did it! You won the Crown!                | A   | show     |
| `ann_crown_winner_self_02` | alt                                       | All hail the new champion... you!             | A   | show     |
| `ann_crown_winner_team`    | squads/duos team wins                     | Team victory! Everybody gets a Crown!         | A   | show     |
| `ann_crown_last_second`    | crown grabbed with an opponent < 2 m away | By a whisker! What a finish!                  | A   | show     |
| `ann_crown_no_winner`      | final ends with no winner (all fell)      | Nobody?! Wow. That's showbiz, baby!           | A   | show     |

#### Eliminated consolation

| Id                  | Trigger                     | Caption                                  | Pri | Cooldown       |
| ------------------- | --------------------------- | ---------------------------------------- | --- | -------------- |
| `ann_elim_01`       | local eliminated            | Eliminated! But what a spectacular exit! | B   | show (rotates) |
| `ann_elim_02`       | alt                         | Out of the show, but never out of style! | B   | —              |
| `ann_elim_03`       | alt                         | So close! The next show is yours!        | B   | —              |
| `ann_elim_04`       | alt                         | Gravity wins this time. Rematch?         | B   | —              |
| `ann_elim_05`       | alt (eliminated in final)   | Runner-up! That's still pretty royal!    | B   | —              |
| `ann_elim_06`       | alt (eliminated in round 1) | Early exit! Shake it off and tumble on!  | B   | —              |
| `ann_elim_spectate` | 4 s after elimination       | Stick around and cheer on the rest!      | C   | show           |

#### Chaos moments

| Id                 | Trigger                                | Caption                                        | Pri | Cooldown |
| ------------------ | -------------------------------------- | ---------------------------------------------- | --- | -------- |
| `ann_pileup_01`    | `sfx_crowd_pileup` cluster (≥ 5)       | Pile-up! Somebody call a tow truck!            | C   | 20 s     |
| `ann_pileup_02`    | alt                                    | Tumbler pancake stack! Delicious!              | C   | 20 s     |
| `ann_pileup_03`    | ≥ 10 in cluster                        | That's the biggest pile-up I've ever seen!     | B   | round    |
| `ann_huge_fall_01` | local falls out with airtime > 2.5 s   | That was a long way down! Ouch-ish!            | C   | 30 s     |
| `ann_huge_fall_02` | alt                                    | Look at that flight! Ten out of ten!           | C   | 30 s     |
| `ann_huge_fall_03` | ≥ 6 players fall out within 2 s        | Mass exodus! Bye, everybody!                   | C   | 30 s     |
| `ann_comeback_01`  | local from bottom 25 % to qualified    | What a comeback! From the back to the bag!     | B   | round    |
| `ann_comeback_02`  | alt                                    | Never give up! Never stop tumbling!            | B   | round    |
| `ann_comeback_03`  | local survives at 1 tile / last ledge  | Clinging on by a mitten! Amazing!              | B   | round    |
| `ann_near_miss`    | sweeper/hammer misses local by < 0.4 m | Ooh, that was close!                           | C   | 25 s     |
| `ann_stun_streak`  | local stunned 3× in 20 s               | Rough day? Shake it off!                       | C   | 60 s     |
| `ann_grab_fest`    | ≥ 4 simultaneous grabs on one player   | Everybody hug! Wait, that's grabbing!          | C   | 45 s     |
| `ann_bounce_big`   | local bounce pad airtime > 1.5 s       | Wheee! Frequent flyer miles!                   | C   | 45 s     |
| `ann_door_fail`    | local hits 3 solid doors               | That door was real. And so was that one!       | C   | round    |
| `ann_respawn_tip`  | local respawns 3× at same checkpoint   | Try a different path. Or the same one, faster! | C   | round    |
| `ann_slow_start`   | local not moved 5 s after GO           | Psst! The race already started!                | C   | round    |

#### Player Wall & rewards

| Id                            | Trigger                       | Caption                                | Pri | Cooldown |
| ----------------------------- | ----------------------------- | -------------------------------------- | --- | -------- |
| `ann_wall_intro`              | Player Wall opens             | Let's look back at tonight's Tumblers! | B   | show     |
| `ann_wall_round_n`            | each round's drop-away starts | Round {n}! And off they tumble!        | C   | —        |
| `ann_wall_final`              | final round drop              | And in the Final...                    | B   | show     |
| `ann_wall_winner`             | last cell remains             | Your champion! Wearing the Crown!      | A   | show     |
| `ann_wall_self_survived_long` | local survived to round ≥ 3   | You made it a long way. Bravo!         | C   | show     |
| `ann_rewards_intro`           | Rewards screen                | Time for goodies!                      | C   | show     |
| `ann_rewards_level_up`        | level up                      | Level up! Look at you grow!            | B   | show     |
| `ann_rewards_rare_unlock`     | Rare+ unlock                  | Ooh, shiny! That's a good one!         | B   | show     |
| `ann_rewards_mythic_unlock`   | Mythic unlock                 | Mythic?! Pip is speechless! Almost!    | A   | show     |
| `ann_rewards_crown_shard`     | Crown Shards earned           | Crown Shards! Collect them all!        | C   | show     |
| `ann_rewards_gumballs`        | big Gumball total             | Gumballs for days!                     | C   | show     |
| `ann_rewards_play_again`      | 3 s idle on rewards           | Play again? The show must go on!       | C   | show     |

#### Tutorial (coach Tumbler lines use the same voice at +4 st, label "COACH")

| Id             | Trigger        | Caption                             | Pri | Cooldown |
| -------------- | -------------- | ----------------------------------- | --- | -------- |
| `ann_tut_move` | tutorial start | Move with the stick or WASD!        | A   | —        |
| `ann_tut_jump` | jump step      | Jump over the gap!                  | A   | —        |
| `ann_tut_dive` | dive step      | Dive to go further. Belly first!    | A   | —        |
| `ann_tut_grab` | grab step      | Hold grab near a ledge to hang on!  | A   | —        |
| `ann_tut_done` | tutorial end   | You're ready! Let's race some bots! | A   | —        |

Total: **182 lines** (including alternates).

---

## 7. Implementation notes

### 7.1 Suggested module layout (`packages/audio/src/`)

| Folder       | Responsibility                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/`    | `AudioEngine` (single `AudioContext`, unlock, lifecycle), bus graph (§1.2), ducking controller, settings binding                       |
| `voices/`    | voice pool, priority/stealing (§1.5), per-id caps, retrigger guard, virtual loops                                                      |
| `spatial/`   | listener update, panner pool, air absorption, occlusion, culling, per-player throttling (§1.6–1.7)                                     |
| `synth/`     | recipe DSL (§0) → node graph builders; noise buffers; formant voice; IR generator                                                      |
| `bank/`      | SFX recipe table keyed by id; pre-render scheduler; fallback archetypes (§7.7)                                                         |
| `music/`     | sequencer, instruments (multisample render), drum kit, `tracks/<trackId>.ts` data, stem/layer controller, adaptive param mapper (§2.5) |
| `ambience/`  | weather/theme/crowd beds, Poisson detail scheduler, crowd excitement model                                                             |
| `announcer/` | line table (§6.5), queue/priorities/cooldowns, babble synth, caption events out to UI                                                  |
| `bridge/`    | `SimEvent` → sound router (§7.2), cue router (§7.3), state-diff watcher for character states                                           |
| `debug/`     | audio board for `tumbler.html` (play any id, voice meter, LUFS meter, bus faders)                                                      |

Sub-path imports per ARCHITECTURE.md (`@tumble/audio/engine`, …). The UI
receives captions via a small typed event (`onCaption({ id, text, speaker, durationMs, priority })`);
the audio package never imports React.

**Public API sketch**

```ts
audio.play(id, { pos?, player?, gain?, pitch?, priority? }): VoiceHandle | null;
audio.loop(id, emitterKey, params): LoopHandle;     // stable per obstacle instance / player
audio.setMusic(trackId, { phase, stage }): void;
audio.setAdaptive(state: AdaptiveMusicState): void; // §2.5 inputs, called at 10 Hz
audio.stinger(kind): void;                          // go | qualify | eliminate | last_player | overtime | round_over
audio.announce(lineId, vars?): void;
audio.setAmbience({ theme, weather }): void;
audio.handleSimEvents(events: readonly SimEvent[], ctx: ListenerContext): void;
```

### 7.2 Event-to-sound mapping (`SimEvent`, `packages/sim/src/events.ts`)

`ListenerContext` gives the router: local player id, positions of players
(interpolated), each player's ground `SurfaceKind`, round type/theme, distance
rank of each player (§1.7).

| `SimEvent.type` | Sound(s)                                                                                                                                                                                                           | Conditions / params                                       | Side effects                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `jump`          | `sfx_jump` (+ `sfx_jump_vocal` 1 in 4 local)                                                                                                                                                                       | throttle: local + nearest 12                              | —                                                                                                                             |
| `land`          | `impact < 0.35` → `sfx_land_soft`; else `sfx_land_hard` (+ `sfx_land_squash` ≥ 0.8); within 250 ms of own `dive` or onto a player → `sfx_land_double`; surface layer: `sfx_step_<surface>` at -4 dB                | gain +6·impact dB; ice + impact ≥ 0.5 → `sfx_ice_crackle` | pile-up clustering counter (§1.7); local impact ≥ 0.8 → crowd_ooh 15 % chance                                                 |
| `dive`          | `sfx_dive`                                                                                                                                                                                                         | —                                                         | arms `sfx_land_double` window (250 ms)                                                                                        |
| `getUp`         | `sfx_getup`                                                                                                                                                                                                        | —                                                         | stops `sfx_belly_slide_loop`                                                                                                  |
| `stun`          | `sfx_stun_boing` (length from `strength`), start `sfx_stun_stars_loop`                                                                                                                                             | throttle nearest 6; local → music LP duck (§2.5)          | pile-up counter; local stun streak → `ann_stun_streak`                                                                        |
| `bounce`        | `obstacle` resolves to type: `bouncePad` → `sfx_bounce_pad`; `bumperPillar` → `sfx_bumper_hit`; `bumperCar` → `sfx_bumper_car_hit`; `spinwheel` → `sfx_spinwheel_hit`; undefined → `sfx_land_squash`               | per-instance cap 2/150 ms                                 | local airtime tracking → `ann_bounce_big`                                                                                     |
| `grabStart`     | `targetKind`: `player` → `sfx_grab_start_player` (+ `sfx_grabbed_alert` if target is local); `ledge` → `sfx_grab_start_ledge` (on a `climbWall` collider → `sfx_climbwall_grip`); `prop` → `sfx_grab_start_prop`   | —                                                         | start `sfx_grab_hold_loop` for player grabs                                                                                   |
| `grabEnd`       | `release` → `sfx_grab_release`; `broken` / `stamina` → `sfx_grab_broken`                                                                                                                                           | —                                                         | stop hold loop                                                                                                                |
| `emote`         | `sfx_emote_pop` + cosmetic emote sfx                                                                                                                                                                               | throttle nearest 8                                        | —                                                                                                                             |
| `fellOut`       | void kind slime/goo/water → `sfx_fellout_splash`; else `sfx_fellout_poof`; stop any `sfx_fall_scream` with 300 ms fade                                                                                             | —                                                         | ≥ 6 in 2 s → `ann_huge_fall_03`; local long airtime → `ann_huge_fall_*`; crowd_laugh 30 % / crowd_gasp if near camera         |
| `respawn`       | `sfx_respawn_whoosh`; local → `sfx_ghost_shimmer_loop` 1 s                                                                                                                                                         | —                                                         | count same-checkpoint respawns → `ann_respawn_tip`                                                                            |
| `checkpoint`    | local only: `sfx_checkpoint`                                                                                                                                                                                       | remote: none                                              | —                                                                                                                             |
| `finish`        | `sfx_finish_line_cross` (local: + `sfx_finish_cross_self`); remote within 20 m: horn only                                                                                                                          | —                                                         | —                                                                                                                             |
| `qualified`     | local: `ui_stamp_qualified` → `qualify` stinger, `ui_confetti`, `crowd_cheer`; others: `ui_qualify_counter_tick` (batched)                                                                                         | —                                                         | crowd excitement +0.03; first of round → `ann_first_qualifier_*`; thresholds → half full / last spots lines + `ui_last_spots` |
| `eliminated`    | local: `ui_stamp_eliminated` → `eliminate` stinger, `crowd_aww`, then `mus_stinger_spectate`; others in survival: `ui_players_left_tick`                                                                           | —                                                         | `ann_elim_*`; alive milestones lines                                                                                          |
| `tileWarn`      | `sfx_tile_shake`                                                                                                                                                                                                   | P2 if under/adjacent to local, else P4; cap 6             | —                                                                                                                             |
| `tileFell`      | `sfx_tile_drop`                                                                                                                                                                                                    | falling whistle only within 12 m (max 2)                  | —                                                                                                                             |
| `obstacleCue`   | cue router (§7.3) by `cue` string; `pos` used as emitter position                                                                                                                                                  | —                                                         | some cues feed music (§2.10 conveyor tape-stop, §2.16 goo surge) and announcer (`_tip` lines)                                 |
| `teleport`      | `sfx_teleport_in` at `from`, `sfx_teleport_out` at `to` (+80 ms)                                                                                                                                                   | —                                                         | —                                                                                                                             |
| `score`         | by round: Egg Heist `delta>0` → `sfx_egg_score`, `delta<0` (own team) → `sfx_egg_steal`; Bounce Ball Blitz → `sfx_goal_horn` + `ann_team_goal_*`; Paint the Plaza → `sfx_paint_meter_tick` (splats come from cues) | own team non-spatial, others spatial at player            | team leader change → `ui_team_lead_change` + `ann_team_leading_<colour>` / `ann_team_tied`                                    |
| `propPickup`    | prop kind from replicated prop table: egg → `sfx_egg_pickup`; tail → `sfx_tail_grab`; key → `sfx_key_pickup`; crown → `sfx_crown_grab` + `sfx_crown_fanfare` + victory flow; ball → none                           | —                                                         | local tail → `ann_hunt_got_tail`, start `sfx_tail_hold_loop`                                                                  |
| `propDrop`      | egg → `sfx_egg_drop`; tail where player is local → `sfx_tail_stolen` (+ `ann_hunt_lost_tail`); key → `sfx_egg_drop` @ +5 st                                                                                        | —                                                         | stop `sfx_tail_hold_loop`                                                                                                     |

**Derived from replicated character state** (client-side diff each render
frame of `CharacterStateId` / flags; no new sim events needed):

| Transition / condition               | Sound                                         |
| ------------------------------------ | --------------------------------------------- |
| foot contact phase (render)          | `sfx_step_<surface>`                          |
| `Dive → DiveSlide`                   | `sfx_dive_land`, start `sfx_belly_slide_loop` |
| leave `DiveSlide`                    | stop belly slide (120 ms)                     |
| `→ LedgeHang`                        | start `sfx_ledge_hang_loop`                   |
| `→ LedgeClimb`                       | `sfx_climb`                                   |
| `→ Grabbed` (local)                  | enable `sfx_grabbed_struggle` on mash input   |
| `Stunned` + angular speed > 3        | `sfx_tumble_loop`                             |
| `Fall` + vel.y < -14 + y < killY + 8 | `sfx_fall_scream` + `sfx_fall_whistle`        |
| flag `InSlime` set / state `Slime`   | `sfx_slime_enter` / `sfx_slime_swim_loop`     |
| flag `OnIce` + lateral slip > 2 m/s  | `sfx_skid_ice_loop`                           |
| ground surface `slide` + speed > 1   | `sfx_slide_surface_loop`                      |
| flag `HasTail` (local)               | `sfx_tail_hold_loop`                          |
| `RoundPhase` changes                 | §7.4                                          |

_Optional additive contract extensions_ (would remove client-side guessing; to
be proposed to the sim owner, not required): `{ type: 'playerBump'; a; b; pos; speed }`,
`{ type: 'nearMiss'; player; obstacle; distance }`. Until they exist the client
derives both from render contacts and pose distance checks.

### 7.3 `obstacleCue` conventions

- **Format**: `cue = "<namespace>.<cueName>"`, lowerCamelCase both parts.
  For obstacles, `namespace` is the exact `ObstacleType` string; `event.obstacle`
  is the instance id (e.g. `"spin-2"`), `event.pos` the emitter position.
- Each `ObstacleModule.audioCues` lists its cue names **with** the namespace
  (e.g. `['punchWall.telegraph', 'punchWall.punch', 'punchWall.retract']`), so
  the audio bank can unit-test that every declared cue has a mapped sound.
- Cues are **discrete moments only**. Continuous sounds (whirr, hum, wind,
  creak) are **pose-driven loops** owned by the client audio runtime per
  instance, computing speed from `pose(t)` at `t` and `t - 1/60` (no network).
- Cues that are pure functions of time (pendulum apex, telegraphs of periodic
  obstacles) SHOULD be emitted client-side by the same deterministic runtime
  during prediction; server-originated cues (hits, bursts, replicated state
  changes) arrive over the reliable channel. The router de-duplicates by
  `(obstacle, cue, tick)` within 100 ms.
- Unknown cue → fallback archetype by suffix (`*.hit` → hit, `*.warn`/`*.telegraph`
  → alarm blip, `*.on`/`*.spawn` → whoosh up, `*.off` → whoosh down) and a dev warning.

**Cue list per obstacle type**

| ObstacleType       | Cues → sound                                                                                                                                                                                                         | Pose-driven loop                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `spinwheel`        | `spinwheel.hit` → `sfx_spinwheel_hit`                                                                                                                                                                                | `sfx_spinwheel_whirr_loop`                                |
| `pendulumHammer`   | `pendulumHammer.apex` → `sfx_pendulum_creak`; `pendulumHammer.swing` → `sfx_pendulum_whoosh`; `pendulumHammer.hit` → `sfx_pendulum_hit`                                                                              | —                                                         |
| `sweeperArm`       | `sweeperArm.accel` → `sfx_sweeper_accel`; `sweeperArm.hit` → `sfx_sweeper_hit`; `sweeperArm.nearMiss` → `crowd_ooh` (rate-limited)                                                                                   | `sfx_sweeper_hum_loop`                                    |
| `bumperPillar`     | `bumperPillar.hit` → `sfx_bumper_hit`; `bumperPillar.pulse` → `sfx_bumper_idle`                                                                                                                                      | —                                                         |
| `punchWall`        | `punchWall.telegraph`, `punchWall.punch`, `punchWall.retract`                                                                                                                                                        | —                                                         |
| `doorGauntlet`     | `doorGauntlet.burst` → `sfx_door_burst`; `doorGauntlet.thud` → `sfx_door_thud`                                                                                                                                       | —                                                         |
| `conveyorBelt`     | `conveyorBelt.reverseWarn` → `sfx_conveyor_reverse_alarm`; `conveyorBelt.reverse` → `sfx_conveyor_reverse`                                                                                                           | `sfx_conveyor_hum_loop`                                   |
| `tiltPlatform`     | `tiltPlatform.limit` → `sfx_tilt_hit_limit`                                                                                                                                                                          | `sfx_tilt_creak_loop` (from replicated angle)             |
| `seesaw`           | `seesaw.clunk` → `sfx_seesaw_clunk`                                                                                                                                                                                  | `sfx_seesaw_pivot_loop`                                   |
| `fanZone`          | `fanZone.warn`, `fanZone.on`, `fanZone.off`                                                                                                                                                                          | `sfx_fan_wind_loop` while on                              |
| `bouncePad`        | `bouncePad.launch` → `sfx_bounce_pad` (also via `bounce` event; dedupe)                                                                                                                                              | —                                                         |
| `fallingTiles`     | `fallingTiles.crack` → `sfx_tile_crack`; `fallingTiles.respawn` → `sfx_tile_respawn`; `fallingTiles.touch` → `sfx_hex_tile_touch`; `fallingTiles.layerWarn` → `sfx_layer_fall_warn` (+ `tileWarn`/`tileFell` events) | —                                                         |
| `risingSlime`      | `risingSlime.warn` → `sfx_slime_warn`; `risingSlime.surge` → `sfx_slime_surge`                                                                                                                                       | `sfx_slime_bubble_loop`                                   |
| `boulderLane`      | `boulderLane.spawn`, `boulderLane.hit` → `sfx_boulder_impact`, `boulderLane.despawn` → `sfx_boulder_exit`                                                                                                            | `sfx_boulder_roll_loop` per ball                          |
| `spinningDisc`     | `spinningDisc.reverse`                                                                                                                                                                                               | `sfx_spinning_disc_loop`                                  |
| `movingPlatform`   | `movingPlatform.arrive` → `sfx_moving_platform_stop`                                                                                                                                                                 | `sfx_moving_platform_loop`                                |
| `slideRamp`        | `slideRamp.enter` → `sfx_slide_ramp_enter`                                                                                                                                                                           | (surface loop via `slide` surface)                        |
| `iceFloor`         | `iceFloor.crackle` → `sfx_ice_crackle`                                                                                                                                                                               | —                                                         |
| `stickyGoo`        | `stickyGoo.enter`, `stickyGoo.exit` → `sfx_sticky_squelch`                                                                                                                                                           | —                                                         |
| `popupBlocks`      | `popupBlocks.warn`, `popupBlocks.up`, `popupBlocks.down`                                                                                                                                                             | —                                                         |
| `laserSweep`       | `laserSweep.charge`, `laserSweep.zap`                                                                                                                                                                                | `sfx_laser_hum_loop`                                      |
| `cannon`           | `cannon.telegraph`, `cannon.fire`, `cannon.bounce` → `sfx_cannon_ball_bounce`                                                                                                                                        | `sfx_cannon_ball_whistle` per near ball                   |
| `bumperCar`        | `bumperCar.hit`                                                                                                                                                                                                      | `sfx_bumper_car_loop`                                     |
| `rollingDrum`      | `rollingDrum.hit`                                                                                                                                                                                                    | `sfx_rolling_drum_loop`                                   |
| `collapsingBridge` | `collapsingBridge.creak`, `collapsingBridge.snap`                                                                                                                                                                    | —                                                         |
| `jumpRopeBeam`     | `jumpRopeBeam.speedUp`; `jumpRopeBeam.pass` (client-derived for local)                                                                                                                                               | `sfx_jumprope_whoosh_loop` per beam                       |
| `teleporterPair`   | (uses `teleport` event)                                                                                                                                                                                              | `sfx_teleporter_idle_loop`                                |
| `climbWall`        | `climbWall.grip`, `climbWall.pull`                                                                                                                                                                                   | —                                                         |
| `checkpointGate`   | (uses `checkpoint` event)                                                                                                                                                                                            | `sfx_checkpoint_gate_idle`                                |
| `finishLine`       | (uses `finish` event)                                                                                                                                                                                                | `sfx_finish_line_idle`                                    |
| `startGate`        | `startGate.open` → `sfx_start_gate_open`; `startGate.bump` → `sfx_start_gate_rattle`                                                                                                                                 | —                                                         |
| `voidTrigger`      | `voidTrigger.enter` (only for custom void audio; default uses `fellOut`)                                                                                                                                             | —                                                         |
| `propSpawner`      | `propSpawner.spawn` → `sfx_prop_spawn`                                                                                                                                                                               | `sfx_crown_hover_loop` when the spawned prop is the Crown |

**Round-rule namespaces** (emitted by round rules, not obstacles;
`event.obstacle` = the rule's id):

| Namespace      | Cues                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `patternPanic` | `revealStart`, `symbol`, `revealEnd`, `tick`, `timerEnd`, `drop`, `safe`, `speedUp`, `moreSymbols` |
| `paint`        | `splat`, `overpaint`                                                                               |
| `ball`         | `kick`, `bounce`, `post` (hits goal frame → `sfx_bumper_hit` +5 st)                                |
| `egg`          | `golden` (golden egg scored → `ann_team_egg_golden`)                                               |
| `round`        | `nearMiss`, `layerGone`, `crownClose` (used by announcer/music only)                               |

### 7.4 Round phase → audio actions

| `RoundPhase`   | Music                                                                              | Ambience                            | Announcer                               | Other                                    |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------- | ---------------------------------------- |
| `Loading`      | previous track (results) continues; pre-render this round's theme assets in chunks | fade to theme bed preview at -12 dB | —                                       | IR render for theme                      |
| `IntroFlyover` | round track **intro** stem (or `mus_stinger_final_reveal` first for finals)        | theme + weather beds in 1.5 s       | `ann_round_<name>`                      | `ui_flyover_title` + type chime          |
| `RulesCard`    | intro continues (loop intro bars if needed)                                        | —                                   | `ann_type_<type>_*`                     | `ui_rules_card`                          |
| `Countdown`    | intro last bar(s), tempo-aligned                                                   | crowd excitement 0.4                | `ann_countdown_ready`, `_3/_2/_1`       | `ui_countdown_3/2/1`                     |
| `Playing`      | `go` stinger on downbeat → loop A; adaptive (§2.5)                                 | full                                | `ann_countdown_go_*`, then event-driven | `sfx_start_gate_open`, `ui_countdown_go` |
| `Overtime`     | final30 forced + `overtime` stinger                                                | crowd 0.8 floor                     | `ann_overtime_*`                        | `ui_overtime`                            |
| `RoundEnd`     | slow-mo ramp + `round_over` stinger, then fade 1.2 s                               | duck -6 dB                          | `ann_round_over_*`                      | `ui_stamp_round_over`                    |
| `Results`      | `mus_results_wall` loop A                                                          | crowd applause                      | `ann_results_*`                         | `ui_results_card` ×n                     |
| `Transition`   | `mus_stinger_next_round`                                                           | fade out 1 s                        | `ann_results_next_round`                | —                                        |

`ShowPhase.PreShow` → lobby track + crowd; `Victory` → `sfx_crown_fanfare` →
`mus_victory_crowned`; `Ended` → Player Wall (`mus_results_wall` loop B) →
Rewards (lobby intro).

### 7.5 Loudness targets

Measured with ITU-R BS.1770 K-weighting (an offline meter in the audio debug
board renders 60 s of a scenario via `OfflineAudioContext` and reports LUFS).

| Item                                                | Target                                          | Tolerance                |
| --------------------------------------------------- | ----------------------------------------------- | ------------------------ |
| Full in-game mix (integrated, typical race)         | **-16 LUFS**                                    | ±1                       |
| True peak (master after limiter)                    | **≤ -1 dBTP**                                   | —                        |
| Music bus alone (all layers, intensity on)          | -20 LUFS                                        | ±1.5                     |
| Music base layer only                               | -23 LUFS                                        | ±2                       |
| Each stinger (short-term max)                       | -16 LUFS-S                                      | ±1                       |
| Announcer line (integrated per line)                | -18 LUFS                                        | ±1                       |
| Local player SFX short-term peaks (land hard, stun) | -14 LUFS-S                                      | ±2                       |
| Remote / world SFX short-term                       | -22 LUFS-S                                      | ±3                       |
| UI clicks/hover (momentary)                         | -26 LUFS-M                                      | ±2                       |
| Ambience beds (integrated)                          | -30 LUFS                                        | ±2                       |
| Rarity Mythic hit (short-term)                      | -13 LUFS-S                                      | — (deliberately loudest) |
| Menu mix (lobby music + UI)                         | -18 LUFS                                        | ±1                       |
| Mobile (Low tier)                                   | +1 dB makeup on master, limiter threshold -3 dB | —                        |

Every recipe is normalised at pre-render: peak to -1 dBFS then scaled to its
category target using an RMS approximation (fast, at load), so authored gains
in §5 are _relative within a recipe only_.

### 7.6 Memory & CPU budgets, pre-rendering

**Pre-render pipeline** (`bank/prerender.ts`):

1. At boot (after splash, before menu): render **core set** — UI (all §5.6),
   countdown/stamps, character (§5.1–5.2), drums (§2.2), lobby instruments,
   fallback archetypes. Budget **≤ 250 ms total main-thread time**, chunked in
   ≤ 8 ms slices via `OfflineAudioContext.startRendering()` promises (rendering
   is off-thread; slicing is for graph construction).
2. At round `Loading`: render **round set** — that round's obstacles (from
   `round.obstacles[].type` → their cue sounds), track instruments + stingers,
   theme IR, theme/weather detail one-shots. Budget **≤ 400 ms** wall time,
   must finish before `IntroFlyover`; anything late plays the archetype fallback.
3. Lazily on first use: everything else (rarity reveals render when the
   Rewards/Locker screen first opens).
4. Cache: `Map<id, AudioBuffer[]>` (variants). Evict round sets not used by the
   next 2 rounds' themes. Never re-render the core set.

**Memory budgets** (decoded Float32, mono unless noted):

| Pool                                                                       | Budget                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Core SFX + UI                                                              | ≤ 6 MB (~31 s mono at 48 kHz)                                                           |
| Round set (obstacles + stingers + details)                                 | ≤ 6 MB                                                                                  |
| Music instruments (multisamples ≤ 5 roots × 2 s × ~10 instruments) + drums | ≤ 8 MB per active track; previous track freed after crossfade                           |
| IR (stereo, ≤ 3 s)                                                         | ≤ 1.2 MB                                                                                |
| Noise buffers (wn/pn/bn, 2 s each)                                         | ≤ 1.2 MB                                                                                |
| Announcer TTS (phase 2, Opus decoded lazily per round)                     | ≤ 4 MB                                                                                  |
| **Total audio**                                                            | **≤ 28 MB** desktop, **≤ 16 MB** mobile (mobile: 3 variants → 2, multisample roots → 3) |

**CPU budgets** (audio render thread on mid laptop, Iris Xe / M1 class):

| Item                                                 | Budget                                                                                                                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total audio thread load                              | ≤ 15 % of one core (desktop), ≤ 20 % (mobile Low)                                                                                                                                                         |
| Live loop graphs                                     | ≤ 12 concurrent (Low: 6), each ≤ 6 nodes                                                                                                                                                                  |
| Music live nodes                                     | ≤ 24 (mono lead, bass, pads; everything else is buffers)                                                                                                                                                  |
| HRTF panners                                         | ≤ 8 (High), unlimited within the 32-voice cap (Ultra)                                                                                                                                                     |
| Convolver                                            | 1 instance (shared reverb bus)                                                                                                                                                                            |
| Main-thread audio update (listener, params, routing) | ≤ 0.4 ms/frame; param updates for loops at 30 Hz, air absorption/occlusion at 15/5 Hz                                                                                                                     |
| Allocation                                           | zero per frame: pooled `AudioBufferSourceNode` wrappers are recreated per play (unavoidable in Web Audio) but their wrapper objects, panner nodes, gain nodes and filter nodes are pooled and reconnected |

`AudioBufferSourceNode`s are one-shot by spec; the pool keeps per-voice
`GainNode → BiquadFilter (air) → PannerNode` chains alive and only swaps the
source node.

### 7.7 Placeholder-first plan ("never silent")

**Fallback resolution** — `play(id)` resolves in order:

1. Pre-rendered buffer for `id` → play.
2. Recipe exists but not rendered yet → render synchronously if ≤ 300 ms long
   (tiny), else go to 3 and queue the render.
3. **Archetype fallback** (jsfxr-style, always in core set): mapped by id prefix /
   suffix table below.
4. `ui_click` — the last resort. Dev builds log `[audio] missing id` once per id
   and show it in the debug overlay.

| Archetype          | Recipe                                | Used for (pattern)                                                         |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------- |
| `arch_blip`        | sqr 880 Hz AD 1/60                    | `ui_*`, unknown                                                            |
| `arch_jump`        | sqr f: 300→700 /120 AD 1/120          | `*jump*`, `*launch*`, `*_up`                                               |
| `arch_hit`         | wn LP 1.2k AD 1/100 + sin 150→60 /100 | `*hit*`, `*land*`, `*thud*`, `*impact*`, `*punch*`                         |
| `arch_boing`       | sin 200 vib 18 Hz decaying AD 2/400   | `*stun*`, `*bounce*`, `*bumper*`                                           |
| `arch_whoosh`      | pn BP 400→2k /250 AD 30/250           | `*whoosh*`, `*dive*`, `*swing*`, `*.on`, `*spawn*`, `*teleport*`           |
| `arch_alarm`       | sqr 1 kHz ×2 blips 80 ms              | `*warn*`, `*telegraph*`, `*alarm*`, `*charge*`                             |
| `arch_pickup`      | sqr 660→1320 two-step 1/32            | `*pickup*`, `*grab*`, `*score*`, `*coin*`, `*currency*`                    |
| `arch_explode`     | wn LP filt env 3k→200 /400 AD 1/450   | `*fire*`, `*burst*`, `*snap*`, `*firework*`                                |
| `arch_loop_hum`    | saw 80 Hz LP 300                      | any `*_loop`                                                               |
| `arch_jingle_good` | sqr C5-E5-G5-C6 1/32                  | `*qualif*`, `*finish*`, `*checkpoint*`, `*rarity*`, `*level*`, `*fanfare*` |
| `arch_jingle_bad`  | sqr G4-F♯4-F4 1/16 portamento         | `*elim*`, `*error*`, `*lost*`, `*stolen*`                                  |
| `arch_crowd`       | pn BP 900 env 100/1000                | `crowd_*`                                                                  |

Music fallback: if a track id has no data yet, play `mus_lobby_tumbletown`
patterns transposed to the theme's declared key with tempo from §2 tables,
so every theme has _some_ music from day one. Announcer fallback: babble voice
(§6.2) needs only the caption, so every line works as soon as it's in the table.

**Delivery milestones**

| Milestone         | Scope                                                                                                             | Exit criteria                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A0 — Never silent | engine, buses, unlock, archetypes, router for all `SimEvent` types, lobby track (single layer), countdown, stamps | every event audible; no console errors on iOS/Android/desktop; 32-voice cap enforced |
| A1 — Feel         | bespoke character SFX (§5.1–5.2), surfaces, UI (§5.6), stingers, crowd reactions                                  | "jump/dive/land feels great" playtest sign-off                                       |
| A2 — Obstacles    | all §5.3 cues + pose-driven loops, spatial tiers, throttling for 40                                               | 40-bot soak: no voice starvation of P0/P1, CPU ≤ budget                              |
| A3 — Music        | sequencer, kit, instruments, all 15 track ids with intro/loops; adaptive table §2.5                               | each round plays its track id with intensity + final-30 + stingers                   |
| A4 — Show         | ambience beds, announcer (babble + captions, all §6.5 lines), Player Wall sync, victory                           | full show recorded and reviewed; captions verified                                   |
| A5 — Mix          | loudness pass §7.5, ducking tune, mobile tier                                                                     | meter report within tolerance on 5 reference scenarios                               |
| A6 — Optional     | sampled/TTS replacements behind same ids                                                                          | A/B toggle in debug board                                                            |

### 7.8 Settings (Settings → Audio, Accessibility)

| Setting                                                  | Default                     | Effect                                                           |
| -------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| Master / Music / SFX / UI / Announcer / Ambience volume  | 80 / 70 / 80 / 70 / 80 / 70 | slider → squared gain × §1.3 defaults                            |
| Audio quality                                            | Auto                        | Low / Medium / High / Ultra (§1.5)                               |
| Spatial audio (HRTF / headphones mode)                   | Auto (on for High+)         | forces HRTF on/off                                               |
| Announcer                                                | On                          | On / Captions only / Off                                         |
| Announcer captions                                       | On                          | accessibility; independent of announcer voice                    |
| Sound captions ("[crowd cheers]", "[cannon fires left]") | Off                         | shows directional SFX captions for P0–P2 events                  |
| Mono audio                                               | Off                         | collapses master to mono (accessibility)                         |
| Dynamic range                                            | Normal                      | Normal / Night (limiter threshold -10 dB, ratio 4, makeup +4 dB) |
| Mute when unfocused                                      | Off                         | §3                                                               |
| Respect silent switch (iOS)                              | On                          | §1.8                                                             |
| Footstep pack                                            | (cosmetic)                  | §5.1                                                             |

### 7.9 Testing

- Unit (vitest, `packages/audio/test`): every id referenced in §5/§6 exists in
  the bank or has an archetype mapping; every `ObstacleModule.audioCues` entry
  resolves; every `SimEventType` has a router case (exhaustive `switch` with
  `never` check); every track id in round content resolves to a track definition;
  announcer captions ≤ 60 chars; voice pool never exceeds cap under a synthetic
  40-player event storm; stealing respects priority order.
- Offline render tests: render 2 s of each recipe in `OfflineAudioContext`
  (where available in test env, else skip) and assert non-silence and peak ≤ 0 dBFS.
- Manual: `tumbler.html` audio board — play any id, scrub adaptive state sliders
  (qualified %, timer, alive), toggle stems, LUFS meter, voice meter per class.

---

_End of AUDIO.md_
