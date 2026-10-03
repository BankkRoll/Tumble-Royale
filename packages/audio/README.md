# @tumble/audio

Everything Tumble Royale sounds like, synthesized at runtime with the Web Audio
API. There are no audio files and no audio libraries. The package ships a few
KB of code and the game is never silent.

- **AudioEngine**: one lazy `AudioContext`, unlock on the first gesture, buses
  `music / sfx / voice / ui → master → limiter → destination`, ducking, mono
  downmix, mute-when-hidden (fades out and suspends), 32-voice SFX pool with
  priority- and distance-aware stealing, HRTF on desktop and equal-power on
  mobile, and looping spatial emitters that go virtual when far away.
- **SFX bank**: 104 procedural sounds, rendered once into `AudioBuffer`s through
  `OfflineAudioContext` (lazy or prewarmed in idle time, peak/RMS-normalised,
  loops baked seamless) and played with per-play pitch and volume variance.
- **Adaptive music**: a lookahead step sequencer on the audio clock. It plays
  16 original tracks authored as data, split into 6 stems that fade with
  intensity and final-30. Track changes crossfade on the bar line, and 15
  stingers land on the next beat in the playing key.
- **Announcer**: Web Speech with a cheerful voice and music ducking. Falls back
  to a formant "babble" voice when speech isn't available. Captions always fire.
- **Bindings**: `createGameAudio(engine)` maps `SimEvent`s, cue names, round
  and show phases, and footsteps to sound.

Design source: `docs/design/AUDIO.md` (tempos, keys, the leitmotif, stingers,
cue conventions) and `docs/design/SCREENS.md` (UI cue names).

Lab: run `pnpm --filter @tumble/client dev` and open
**http://localhost:5173/audio.html**.

## Quick start

```ts
import { AudioEngine, createGameAudio } from '@tumble/audio';
import { RoundPhase } from '@tumble/shared';

const engine = new AudioEngine();          // nothing is created until needed
engine.installUnlockHandlers();             // first pointer/key/touch resumes audio
void engine.sfx.prewarm();                  // renders in idle time; works before unlock
const audio = createGameAudio(engine);

audio.setLocalPlayer(myId);
audio.setPlayerPositionResolver((id) => players[id]?.renderPos);
audio.setObstacleResolver((id, tile) => ({ type: obstacles[id]?.type, pos: tilePos(id, tile) }));
audio.announcer.onCaption((text, ms) => hud.caption(text, ms));

// every frame
engine.setListener(listenerPos, camForward, camUp);
audio.handleSimEvents(sink.drain(), listenerPos);
audio.stepFootstep(id, speed, grounded, surface, pos, dt);
audio.update();

// lifecycle
audio.onRoundPhase(RoundPhase.IntroFlyover, 'race', { roundNumber: 1, roundName: 'Gumdrop Gauntlet', theme: 'candy' });
audio.updateRoundStatus({ roundType: 'race', qualified: 12, qualifyTarget: 26, timeLeft: 95 }); // ~10 Hz
audio.playCue('ui.stamp.qualified');
```

## API

### `AudioEngine`

| Member | Description |
|---|---|
| `new AudioEngine({ maxVoices?, panningModel?, settings?, createContext? })` | `panningModel: 'auto'` picks HRTF on desktop and equal-power on mobile |
| `ensureContext()`, `unlock()`, `installUnlockHandlers(target?)`, `onUnlock(cb)`, `isUnlocked` | lifecycle |
| `play(name, { pos?, volume?, pitch?, priority?, delay?, noVariance?, pan? }) → VoiceHandle \| null` | one-shot; with `pos` it's spatial, without it plays 2D |
| `createEmitter(name, { pos?, volume?, rate?, maxDistance? }) → LoopEmitter` | `start()`, `stop(fade)`, `setPosition(x,y,z)`, `setVolume()`, `setRate()`, `dispose()` |
| `setListener(pos, forward, up)` | call every frame from the camera |
| `getSettings()`, `applySettings(patch)`, `setVolume(bus, v)`, `setMuted()`, `setMonoAudio()` | settings are 0–1 per bus with a squared taper |
| `duckMusic(active)` | ref-counted; the announcer uses it |
| `update()` | per frame: realises or virtualises emitters by distance |
| `activeVoices`, `maxVoices`, `audibleEmitters`, `sfx: SfxBank`, `listenerPos` | introspection |

### `MusicSystem` (`audio.music`)

`play(track, { fade?, quantize?: 'bar' | 'beat' | 'now' })`, `stop(fade)`,
`setIntensity(0..1)`, `setFinal30(bool)`, `stinger(id)`, `position()`.
Layer changes are bar-quantised. Calling `play` before unlock queues the track.

Stem levels from `stemLevels()`:

| Stem | Level |
|---|---|
| drums, bass, chords | always on |
| lead | fades in over intensity 0.12–0.35 |
| intensity | fades in over intensity 0.5–0.8 |
| final | follows the final-30 flag |

### `Announcer` (`audio.announcer`)

`say(lineId, vars?, { priority?, interrupt?, silent? })`, `sayText(text, opts)`,
`onCaption(cb)`, `setEnabled()`, `setSpeechEnabled()`, `cancel()`.
A higher priority interrupts a lower one. Countdown lines use priority 3.

### `GameAudio` (`createGameAudio(engine, opts)`)

`handleSimEvent(e, listenerPos?)`, `handleSimEvents(events, listenerPos?)`,
`playCue(name, opts?)`, `onRoundPhase(phase, roundType, info?)`,
`onShowPhase(phase, info?)`, `updateRoundStatus(status)`,
`stepFootstep(player, speed, grounded, surface, pos, dt)`,
`setSliding(player, on, pos?)`, `createObstacleLoop(type, pos)`,
`setLocalPlayer`, `setPlayerPositionResolver`, `setObstacleResolver`, `update()`,
`dispose()`.

The local player's sounds are 2D and get a priority bonus. Remote one-shots
beyond 60 m are skipped. `handleSimEvent` never throws.

`AudioSimEvent` mirrors `SimEvent` structurally, because `@tumble/audio` does
not depend on `@tumble/sim`. Pass the real events directly. If the sim adds a
new event kind, add it to `AudioSimEvent` and the router `switch`.

## Cue names

`playCue` resolves names in this order:

1. alias
2. exact name (sound, `music.*`, `stinger.*`, `announcer.*`)
3. AUDIO.md snake_case id (`sfx_land_soft` → `land.soft`)
4. parent (`ui.stamp.timeUp` → `ui.stamp`)
5. keyword archetype (`*warn*` → `alarm.blip`, …)

Unknown names warn once and still play something.

**UI** (SCREENS.md):
- Basics: `ui.click`, `ui.hover`, `ui.confirm`, `ui.back`, `ui.whoosh`,
  `ui.error`, `ui.tab`, `ui.toggle`, `ui.slider`, `ui.toast`
- Stamps: `ui.stamp`, `ui.stamp.qualified`, `ui.stamp.eliminated`,
  `ui.stamp.roundOver`, `ui.stamp.go`, `ui.stamp.timeUp`, `ui.stamp.final`,
  `ui.stamp.victory`
- Rewards: `ui.reward`, `ui.levelUp`, `ui.claim`, `ui.purchase`, `ui.coin`,
  `ui.notify`
- Rarity reveals: `ui.rarity.common`, `ui.rarity.uncommon`, `ui.rarity.rare`,
  `ui.rarity.epic`, `ui.rarity.legendary`, `ui.rarity.mythic`
- Countdown and matchmaking: `ui.countdown.tick`, `ui.countdown.go`,
  `ui.matchFound`, `ui.joinTick`, `ui.typeOn`
- Celebration: `ui.confetti`, `ui.fireworks`
- Player Wall: `ui.wall.flash`, `ui.wall.trapdoor`, `ui.wall.fall`,
  `ui.wall.aww`, `ui.wall.counter`, `ui.wall.shake`, `ui.wall.crown`

**Music:**
- `music.menu`, `music.matchmaking`, `music.preshow` and `music.rewards` all
  play the lobby track; each context sets its own intensity.
- `music.intro`, `music.results` / `music.wall`, `music.final`,
  `music.victory`
- `music.none` stops the music. `music.sting` plays the logo stinger.
- `music.<trackId>` plays that track. `music.mus_*` design ids also work.

**Stingers:** `stinger.<id>` with id one of `roundStart`, `qualified`,
`eliminated`, `roundOver`, `victory`, `levelUp`, `finalRound`,
`thirtySeconds`, `lastSpots`, `overtime`, `logo`, `matchFound`, `showStart`,
`nextRound`, `spectate`. AUDIO.md names also work (`go`, `qualify`,
`eliminate`, `last_player`, `round_over`, `show_start`, …).

**Announcer:** `announcer.<lineId>`. The full list is in `announcer/lines.ts`.

**Obstacle cues:** `obstacleCue.cue` uses the `<ObstacleType>.<cue>` form from
AUDIO.md §7.3 (`cannon.fire`, `punchWall.telegraph`, `fallingTiles.crack`,
`patternPanic.tick`, …). The table is `OBSTACLE_CUES`. A bare bank name such as
`splash` also works. Pose-driven loops per obstacle type are in
`OBSTACLE_LOOPS`.

**Sounds:** every `SFX_NAMES` entry is a valid cue. The lab lists them all, with
a description of each on hover.

## Music tracks

| id | Title | Tempo / key | Use |
|---|---|---|---|
| `candy` | Sugar Rush | 150 · C major | candy theme |
| `factory` | Clockwork | 128 · D dorian | factory |
| `frosty` | Snowglobe | 138 · E minor | frosty |
| `jungle` | Bongo Bounce | 124 · D mixolydian (3:4 bongos) | jungle |
| `sunset` | Boardwalk | 104 swung · B♭ major | sunset |
| `space` | Orbit Party | 120 · A lydian | space |
| `beach` | Tiki Tumble | 116 · G major (3+3+2 bass) | beach |
| `neon` | Arcade Heart | 140 · F♯ minor | neon |
| `castle` | Jester Court | 6/8 (♩.=100) · G mixolydian | castle |
| `goo` | Gloop Groove | 100 swung · E dorian | goo |
| `logic` | Tick Tock | 96 · A minor | logic rounds |
| `final` | Crown Fever | 160 · C minor (leitmotif in minor) | every final |
| `lobby` | Tumbletown | 112 swung · F major (leitmotif) | menus, matchmaking, pre-show |
| `results` | The Tumble Wall | 92 · E♭ major | results, Player Wall |
| `victory` | Crowned | 120 · C major | victory |
| `showIntro` | Showtime Spin | 140 · B♭ major | show intro |

## Adding a sound

1. Pick the right file in `src/sfx/library/` (`movement`, `obstacles`, `show`,
   or `ui`) and add an entry:
   ```ts
   'thing.boop': {
     desc: 'What it is, for the lab',
     duration: 0.3,                  // seconds rendered (loop period for loops)
     priority: VoicePriority.Normal, // voice stealing
     pitchVar: 1.5, volVar: 0.15,    // per-play variance
     cooldownMs: 40,                 // per-emitter retrigger guard
     render: (s) => {
       tone(s, { freq: 300, freqEnd: 600, t: 0, dur: 0.2, gain: 0.5 });
       noise(s, { t: 0, dur: 0.05, gain: 0.3, filter: { type: 'bandpass', freq: 2000 } });
     },
   },
   ```
   - Levels inside `render` are relative, because each sound is normalised.
     Use `gain` on the definition to mix it.
   - Building blocks are in `src/synth/toolkit.ts`: `tone`, `noise`, `fm`,
     `vocal`, `sparkle`, `reverb`, `softClip`, `bitcrusher`, `bedTone`,
     `bedNoise`.
   - Instruments are in `src/synth/instruments.ts`.
   - For a loop, set `loop: true` and use `bedTone`/`bedNoise` over the full
     `len`. Choose LFO rates that complete whole cycles per period.
2. If the UI calls it by another name, add an entry to `CUE_ALIASES`. For an
   obstacle cue, add it to `OBSTACLE_CUES`.
3. `test/cues.test.ts` checks the bank's shape and that every alias resolves.

## Adding a track

Add a `TrackDef` to `src/music/tracks.ts` and its id to `MusicTrackId`. A track
needs `bpm`, `beatsPerBar`, `key`, `scale`, a `progression` with one chord token
per bar, and `parts`.

Chord tokens: `1`, `6`, `5^7`, `4sus2`, `5M` (forced major), `2m^7`.

Each part sets a `stem` and an `instrument`, plus a `mode`:

| Mode | What the pattern means |
|---|---|
| `drum` | 16-character lanes (`x` hit, `X` accent, `o` ghost) |
| `scale` | melody degrees |
| `chord` | chord-tone indexes, for bass and arpeggios |
| `stack` | the whole chord |

Pattern tokens (8th-note grid with `res: 2`):

| Token | Meaning |
|---|---|
| `.` | rest |
| `_` | hold |
| `5` | a degree |
| `10` | a degree above the octave |
| `-2` | a degree below the root |
| `3b`, `7#` | accidentals |
| `>5` | accent |
| `~5` | ghost note |

`variations: n` appends seeded, generated melody bars as a B-section. Every
stem should have at least one part; the tests check this.

## Testing

```sh
pnpm --filter @tumble/audio typecheck
pnpm --filter @tumble/audio test
```

The tests cover:
- scheduler timing math (bar and beat quantisation, swing)
- scale, chord and pattern parsing, and melody generation
- that every track compiles in range, and the leitmotif
- stem levels
- voice stealing, including a synthetic 40-player storm
- loop baking
- footstep cadence
- that the cue registry covers every UI and music cue and every obstacle cue
- that captions are 60 characters or fewer
