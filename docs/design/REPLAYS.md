# Round replays

Every round the local client watches (offline and online, playing or
spectating) is recorded from what is rendered and can be rewatched from the
round results, the rewards screen and, once knocked out, the in-game menu.
Recordings can be saved as files and opened again from Profile or Match
history.

Code: `apps/client/src/game/replay/` (pure: `codec`, `format`, `recorder`,
`timeline`, `clock`, `library`, `controls`; engine glue: `source`, `view`,
`live`, `controller`), UI: `packages/ui/src/screens/Replay.tsx`.

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
