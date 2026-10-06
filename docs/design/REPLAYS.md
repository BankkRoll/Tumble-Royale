# Round replays

Every round the local client watches (offline and online, playing or
spectating) is recorded from what is rendered and can be rewatched from the
round results, the rewards screen and, once knocked out, the in-game menu.
Recordings can be saved as files and opened again from Profile or Match
history.

Code: `apps/client/src/game/replay/` (pure: `codec`, `format`, `recorder`,
`timeline`, `clock`, `library`, `controls`, `tape`, `elimCause`,
`elimination`, `highlights`; engine glue: `source`, `view`, `live`,
`controller`, `elimPlayer`), `apps/client/src/game/show/elimination.ts`
(session side), UI: `packages/ui/src/screens/Replay.tsx`, `ElimReplay.tsx`,
`Highlights.tsx`.

## Recording

`LiveRecording` is handed to show sessions as `GameContext.replays`. The
session starts it at the countdown, calls `frame()` once per rendered frame
and `event()` for every sim event, and closes it when results arrive (or
`null` when the player leaves). Finished rounds go into `ReplayLibrary`, a
ring buffer cleared when the next show starts (8 rounds / 48 MB cap).

Frames are taken when round time crosses the next 20 Hz grid point and are
stamped with the actual sample time (ms), so late or irregular frames never
shift state in time. What is recorded per frame:

- per player: position (cm), yaw (1/4096 turn), character state + time in
  state (cs, only on change), `CharacterFlag` byte, grounded + emote slot,
  presence. Each field is a delta against the last written value, behind a
  one-byte change mask, so idle or eliminated players cost one byte.
  Velocity is not recorded: playback derives it from neighbouring positions
  (zero across teleports).
- the live camera: mode (follow / spectate / celebrate / flyover), target,
  yaw, pitch — the "Your view" replay camera.
- obstacles: time-driven obstacles need nothing (they are `pose(t)`); only
  replicated net states (`getNetState`: props, falling tiles, doors, tilt,
  seesaws, goal zones, paint grid, pattern board, teleporters) are written,
  and only when they change. Values are integers, or hundredths for float
  states (props), predicted as "last value + last change" with the
  residuals' zero runs collapsed, so ticking counters and props at rest are
  nearly free.

Events (all `SimEvent` kinds) are a separate stream: centisecond time delta,
type code, then fields per a fixed schema (`EVENT_SCHEMA` in `format.ts`;
positions in cm, scalars in hundredths, obstacle ids and cue names through a
string table).

Measured (tests in `apps/client/test/replay-*.test.ts`): a synthetic
5-minute 40-player round with everyone always moving is 1.1 MB; real 40-bot
rounds extrapolate to 1.3 MB (race), 2.1 MB (falling tiles) and 2.4 MB
(props) per 5 minutes. The budget is 5 MB.

## File format (version 1)

Little-endian:

| Field          | Type       | Notes                          |
| -------------- | ---------- | ------------------------------ |
| magic          | u32        | `TRPL` (0x4c505254)            |
| format version | u16        | 1; other versions are rejected |
| header length  | u32        |                                |
| header         | UTF-8 JSON | `ReplayHeader`                 |
| frames length  | u32        |                                |
| frames         | bytes      | frame stream                   |
| events length  | u32        |                                |
| events         | bytes      | event stream                   |
| checksum       | u32        | FNV-1a of everything before it |

The header carries `gameVersion`, `protocolVersion`, `recordedAt`, show and
round (`roundId`, name, type, index, final), everything needed to rebuild
the level identically (`seed`, `stage`, `variationId`), `localId`, `rate`,
`startTime` (round time of the first frame), the players (id, name, bot,
team, cosmetic loadout), the obstacle-id table, the string table, counts,
duration and the outcome. Files are named `<round>-<time>.tumblereplay`.

Loading validates magic, format version, checksum and every header field;
the round must exist in this build. A different game major.minor still plays
with a warning that courses may have changed.

## Playback

`ReplayView` builds a normal `RoundView` (level, environment, obstacle
visuals, Tumblers, VFX) from the recording with its own `TumblerPool`, no
audio and no ragdolls (both are shared with the live round). Its
`ReplayRoundSource` owns a private, never-stepped match sim (own Rapier
world, no players) created from the recorded round, seed, stage and
variation: the playhead poses its kinematic obstacles with `setTime` and
restores the recorded net states on top, which also keeps camera collision
and VFX ground probes correct. The live sim is never touched.

`ReplayTimeline` decodes a recording once into flat typed arrays; locating a
time is a binary search and sampling interpolates positions/yaw between the
two surrounding frames (teleports snap). The per-frame path allocates
nothing. Recorded events are replayed into VFX while playing forward and
skipped across seeks; a seek cuts the camera. Paused playback freezes the
world but keeps the camera live.

Cameras: Follow (any player, prev/next), Free (orbit a point panned with
WASD/R/F or the left stick, zoom with wheel/pinch/Y + right stick), Your view
(the recorded live camera).

Controls: Space/K/Enter play-pause, Left/Right (Shift: 1 s) seek 5 s,
`,`/`.` step, Home/End, Up/Down speed (0.25×–2×), C/V or 1/2/3 camera,
Q/E/Tab player, Esc exit; pad A play, B exit, X camera, LB/RB player,
LT/RT seek, d-pad seek/speed, sticks move/look; drag to look and pinch to
zoom on touch; every control is also a large on-screen button.

## Entry and exit

The viewer opens as a `SceneDirector` overlay and a UI layer over the
current screen; the screen underneath (results wall, rewards, the spectated
round, the menu) stays mounted but hidden and is not updated. Exit disposes
the replay view, its pool and its sim (logged in
`window.__tumble.memoryLog` as `replay:<round>:open` / `:closed`) and
restores the previous overlay. Offline the show waits while a replay is
open; online it keeps running, and if it changes screen the replay closes.

## Clips

The rewards screen's Share sheet turns any recorded round of the show into a
5–15 s video (code: `apps/client/src/game/share/`). The default is the round
the player won, else the latest one they qualified from, ending 1.5 s after
the moment they qualified (`clipWindow.ts` reads it straight from the event
stream, no timeline decode).

Rendering builds a private `ReplayView` (same as the viewer: own pool, own
replay sim, no audio, screen effects replaced by no-ops), seeks to the window
start and steps the clock by exactly 1/30 s per frame, so a clip is the same
whatever the display rate. The camera is the viewer's default: "Your view"
when the recording has a camera track, else following the local player.
Each frame renders into a multisampled HDR target, a full-screen pass applies
exposure, the preset's tone mapping and the round's saturation/contrast into
an 8-bit target, and the pixels are read back onto a 2D canvas that gets the
round-name pill and the wordmark. 720p30 by default, 1080p30 on High/Ultra.

Encoding, best first: WebCodecs H.264 in MP4, VP9 then VP8 in WebM (muxed by
`mp4Muxer.ts` / `webmMuxer.ts`, no dependencies), then MediaRecorder on
`canvas.captureStream()`. The loop renders one clip frame per animation frame
and waits on the encoder queue, so the menu keeps its frame rate; it checks
for cancel every frame and disposes the view, both targets and the canvas
whatever happens. The finished file lives in one object URL, revoked when it
is replaced, when the sheet closes and when the rewards screen goes away.
Nothing is uploaded.

| Browser                          | Clip path                                                   |
| -------------------------------- | ----------------------------------------------------------- |
| Chrome / Edge (desktop, Android) | WebCodecs H.264 → MP4                                       |
| Chromium builds without H.264    | WebCodecs VP9 → WebM                                        |
| Safari 16.4+ / iOS 16.4+         | WebCodecs H.264 → MP4                                       |
| Firefox 130+                     | WebCodecs H.264 → MP4 where the OS has an encoder, else VP9 |
| Older engines with MediaRecorder | MediaRecorder WebM (or MP4 on Safari), paced in real time   |
| Neither                          | Clips explained as unavailable; cards still work            |

## Elimination replay

When the local player is knocked out, "How you went out" replays the last
~7.5 s of the round up to 1 s after the knock-out, with one line on the
cause (UI: `docs/design/SCREENS.md` §9.8a).

**Source.** Offline it is cut from the round's own recording (the live
recorder's snapshot, or the stored round once results are in). Online the
client keeps `ReplayTape`, a ring buffer of the last 10 s of what it
rendered (its interpolated snapshots and its own prediction): every player's
position, yaw, state, flags and emote, the live camera and the replicated
obstacle states, sampled on the same 20 Hz grid as the recorder, plus the
last 4096 sim events by reference. It is sized once per round (typed arrays,
about 24 bytes per player per frame; under 1 MB for 100 players, tested) and
writing a frame allocates nothing after the first frames. On the knock-out
the tape is turned into a normal short recording, so both paths play through
the same `ReplayView` and nothing changes on the wire.

**Cause.** `attributeElimination` reads the event stream:

| Cause     | When                                                                                                                                       | Text                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| obstacle  | a `stun` inside the reach of a placed hazard (sweeper, mallet, pow wall, …) or a `bounce` off a named obstacle, within 4 s before the fall | Knocked off by a sweeper / Launched off by a boing pad |
| grabbed   | another player's grab on you ended (or was still on) within 2.5 s of the fall                                                              | Grabbed by <name>                                      |
| bumped    | a stun away from any hazard right after another player dived into you                                                                      | Bumped off by <name>                                   |
| floor     | crumbling tiles near where you fell dropped within 2 s                                                                                     | The floor dropped away                                 |
| wrongTile | a fall with nothing else to blame in a logic round                                                                                         | Picked the wrong tile                                  |
| fell      | a fall with nothing to blame, or two different causes within 0.3 s of each other (a toss-up)                                               | Fell off the course                                    |
| missedCut | out at the end of a race; the gap is the distance to the finish at running speed                                                           | Missed the cut by 0.4 s / Didn't make the cut          |
| teamLost  | out at the end of a team round, from the final team scores                                                                                 | Your team lost 12–15                                   |
| timeUp    | out at the end of any other timed round                                                                                                    | Time ran out                                           |
| unknown   | a tied team result, a forfeit mid-round                                                                                                    | Knocked out                                            |

Events carry no "hit by", so obstacles are found by proximity: each placed
obstacle's reach is its longest sweeping parameter (arm length, radius,
range, …) plus 2 m. The cause also picks the decisive moment, which the
replay slows down around, and the camera: the grabber or bumper when another
player did it ("killer's eye"), else the local player, locked so it never
switches away. Names go through Streamer Mode before they reach the screen.

**Playback.** The view is built in time-sliced steps (`ReplayView.load`)
while the ELIMINATED stamp plays and shown as a director overlay at the time
the watch choice would appear. The decisive moment plays at 0.45× from 0.5 s
before to 0.9 s after; the rest plays at whatever rate (1–3×) brings the
whole replay to about 5.5 s. Under Reduce Motion it is one still frame of the
decisive moment for 4 s. Any key, click, tap or pad button skips (input
still held from playing doesn't); a screen change (results, next round),
opening the replay viewer or a build that takes over 3 s ends it. It never
holds the show: the watch choice is offered on schedule and its countdown
runs, the UI only hides it until the replay ends, and offline the sim keeps
stepping underneath. Knock-outs that end the round for the player (the cut,
a team loss, time up) play over the results wall.

**Gating.** On when `replays.enabled` is on and Settings → Gameplay →
Elimination replay is on (default). Off means no tape, no per-frame work and
no replay. Analytics: `replay.elimination` with `outcome` (watched, skipped,
interrupted, unavailable), `cause`, `still`, `online` and the planned
`seconds`.

## Highlights

Every round that goes into the library is scanned for highlight moments
(`highlights.ts`, events only, no frame decode):

| Kind              | Moment                                                                    | Base |
| ----------------- | ------------------------------------------------------------------------- | ---- |
| finalWin          | the final's winner                                                        | 100  |
| closeFinish       | two qualifications within 0.35 s (×1 to ×2.5, closer scores more)         | 40   |
| lastSecondQualify | qualifying in the last 5 s of the time limit, or taking the last spot     | 45   |
| decisiveScore     | the last lead change of a team round (×1.5 in the last 10 s)              | 38   |
| clutchSurvival    | a ledge grab with no fall after it, or surviving with three or fewer left | 32   |
| comeback          | qualifying after two or more falls, stuns or grabs in the last 25 s       | 30   |
| chainGrab         | a grab that makes a line of three or more Tumblers (+50% per extra)       | 30   |
| bigFall           | a landing at 16 m/s or harder                                             | 14   |

Scores are ×1.5 when the local player is the main or second player and ×1.2
in the final. Each highlight is cut to a 3–5 s segment inside its recording.
The show keeps its best six (`HighlightReel`): sorted by score, then earlier
round, earlier moment, kind and player id, so the order is the same whatever
order rounds arrive in; at most two of a kind while other kinds can fill the
reel, and never two overlapping segments of one round. A re-recorded round
replaces its highlights, rounds the library evicts take theirs along, and a
new show starts empty.

The rewards screen lists them (`docs/design/SCREENS.md` §11). Watch and Play
all open the replay viewer on each segment in turn, following the
highlight's player; Share opens the share sheet's clip tab on the
highlight's round and window, so export goes through the clip pipeline
above. Hidden while `replays.enabled` is off. Analytics: `highlight.view`
(`kind`, `count`, `mode`, `local`) and `highlight.share` (`kind`, `local`,
`final`).
