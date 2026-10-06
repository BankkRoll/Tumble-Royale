# @tumble/ui

React 19 + Zustand overlay for Tumble Royale: every menu, HUD and transition
screen, plus the **game ↔ UI contract**. The game loop never renders React; it
calls plain store actions and listens to typed intents.

Design bible: [`docs/design/SCREENS.md`](../../docs/design/SCREENS.md).
Preview every state: `pnpm --filter @tumble/client dev` → <http://localhost:5173/ui.html?screen=menu>.

## Mounting

```ts
import { mountUI, setAudioHooks, ui } from '@tumble/ui';

const handle = mountUI(document.getElementById('ui')!); // loads fonts + CSS, wires keyboard nav
setAudioHooks({ cue: (n) => audio.playUi(n), music: (t) => audio.music(t) });
ui.getState().setScreen('splash');
```

`#ui` gets `pointer-events: none`; only panels/buttons (`.tr-interactive`) take
input, so the canvas keeps mouse/touch where the UI is transparent.

Sub-path imports: `@tumble/ui/store`, `@tumble/ui/components`, `@tumble/ui/hud`,
`@tumble/ui/screens`, `@tumble/ui/transitions`, `@tumble/ui/theme`, `@tumble/ui/nav`.

## Game → UI: store actions (`ui.getState().…`)

| Action                                                            | Signature                                                                            | Notes                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setScreen`                                                       | `(screen: ScreenId, opts?: { transition?: 'none'\|'fade'\|'wipe'; hold?: boolean })` | Default transition per screen (`DEFAULT_TRANSITIONS`). `wipe` covers → swaps → emits `transitionCovered` → reveals. `hold` keeps it covered until `releaseWipe()`. |
| `releaseWipe`                                                     | `()`                                                                                 | Reveal a held wipe.                                                                                                                                                |
| `setMenuTab` / `setOverlay`                                       | `(tab: MenuTab)` / `(o: OverlayId)`                                                  | Also emit `menuTab` / `overlay`.                                                                                                                                   |
| `navigate`                                                        | `(dir: NavDirection)`                                                                | Gamepad: `up/down/left/right/accept/back/tabPrev/tabNext`.                                                                                                         |
| `setTouch`                                                        | `(isTouch: boolean)`                                                                 | Auto-detected on mount.                                                                                                                                            |
| `setBoot`                                                         | `(p: Partial<BootState>)`                                                            | Real byte progress `0..1`, label, error.                                                                                                                           |
| `setConnection`                                                   | `(c: ConnectionState)`                                                               | `reconnecting`/`connecting` shows the curtain.                                                                                                                     |
| `showDialog` / `closeDialog`                                      | `(d: DialogSpec)`                                                                    | Result arrives as `dialogResult`.                                                                                                                                  |
| `pushToast` / `dismissToast`                                      | `(t: ToastInput) => id`                                                              | In-round toasts default to the left feed.                                                                                                                          |
| `setNotifications`                                                | `(items: NotificationItem[])`                                                        |                                                                                                                                                                    |
| `setSettings`                                                     | `(s: Settings)`                                                                      | Silent (e.g. loaded from storage).                                                                                                                                 |
| `updateSettings`                                                  | `(section, patch)`                                                                   | Emits `settingsChange`.                                                                                                                                            |
| `setCaption`                                                      | `(text \| null)`                                                                     | Announcer caption (shown if Captions on).                                                                                                                          |
| `setProfile` / `setWallet`                                        | `(ProfileData)` / `({ gumballs?, gems? })`                                           |                                                                                                                                                                    |
| `setInventory` / `setStoreData` / `setPass` / `setChallenges`     | data objects                                                                         |                                                                                                                                                                    |
| `setLeaderboard`                                                  | `(board: LeaderboardId, rows: LeaderboardRow[])`                                     | Answer to `leaderboardQuery`.                                                                                                                                      |
| `setMatchHistory` / `setNews` / `setFriends` / `setParty`         | arrays / `PartyState`                                                                |                                                                                                                                                                    |
| `setPlaylists`                                                    | `(list: Playlist[], selected?: string)`                                              |                                                                                                                                                                    |
| `setLocalReady` / `setCustomLobby` / `setRoundCatalog`            | `(boolean)` / `(CustomLobbyState \| null)` / `(RoundCatalogEntry[])`                 | Party ready flag; the private-show lobby (`privateShow` dialog); rounds offered by the round picker.                                                               |
| `setQueue`                                                        | `(q: Partial<QueueState>)`                                                           | Matchmaking card.                                                                                                                                                  |
| `setPreShow` / `setShowIntro` / `setRoundIntro`                   | info objects                                                                         | Round intro feeds loading, flyover and rules cards.                                                                                                                |
| `setHud`                                                          | `(patch: Partial<HudState>)`                                                         | **Throttle to 10–15 Hz.** No-op if nothing changed; widgets select single fields.                                                                                  |
| `resetHud`                                                        | `(patch?)`                                                                           | Start of each round.                                                                                                                                               |
| `setCountdown`                                                    | `(3\|2\|1\|null)`                                                                    | Numerals; follow with `showStamp('go')`.                                                                                                                           |
| `showStamp`                                                       | `(kind: StampKind, { text?, sub? }) => id`                                           | `qualified, eliminated, roundOver, timeUp, go, overtime, final, victory, teamWin, teamLose`. Queued.                                                               |
| `setEliminatedSheet`                                              | `(open)`                                                                             | Keep watching / Leave show choice after elimination.                                                                                                               |
| `setSpectate`                                                     | `(SpectateInfo \| null)`                                                             | Spectating banner.                                                                                                                                                 |
| `setEmoteWheel`                                                   | `(open)`                                                                             | Hold-to-open; emits the highlighted slot on close.                                                                                                                 |
| `setResults` / `setBetweenRounds` / `setFinalHype` / `setVictory` | info objects                                                                         |                                                                                                                                                                    |
| `setPlayerWall`                                                   | `(summary: ShowSummary, opts?: { render3D?, autoContinueMs? })`                      | Call before `setScreen('playerWall')`.                                                                                                                             |
| `setRewards`                                                      | `(RewardsSummary)`                                                                   |                                                                                                                                                                    |

Read state outside React with `ui.getState()`; subscribe with `ui.subscribe(fn)`.
Inside React use `useUI(selector)` (pick the smallest slice).

## UI → Game: intents

```ts
import { bindUI, uiEvents } from '@tumble/ui';

const off = bindUI({
  onPlay: ({ playlistId }) => matchmaker.queue(playlistId),
  onCancelQueue: () => matchmaker.cancel(),
  onTransitionCovered: ({ to }) => scenes.swapFor(to),
  onPlayerWallEvent: (e) => wall3d.handle(e),
});
uiEvents.on('equip', ({ slot, itemId }) => api.equip(slot, itemId));
```

The full typed list is `UIIntents` in `src/store/events.ts`.

| Intent                                                          | Payload                                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Start & menus**                                               |                                                                                                                                     |
| `start`                                                         | — (splash pressed; unlock audio)                                                                                                    |
| `welcomeDone`                                                   | `{ name, colors }`                                                                                                                  |
| `previewColors`                                                 | `{ colors, pattern }`                                                                                                               |
| `tutorialChoice`                                                | `{ accept, dontAskAgain }`                                                                                                          |
| `menuTab` / `overlay`                                           | `{ tab }` / `{ overlay }`                                                                                                           |
| `navUnhandled`                                                  | `{ dir }` (e.g. Back on the root menu)                                                                                              |
| `screenShown` / `transitionCovered`                             | `{ screen }` / `{ to }` (swap 3D scenes now)                                                                                        |
| `dialogResult`                                                  | `{ dialogId, buttonId }`                                                                                                            |
| `toastAction`                                                   | `{ toastId, actionId }`                                                                                                             |
| `retryConnection`                                               | —                                                                                                                                   |
| **Play & matchmaking**                                          |                                                                                                                                     |
| `selectPlaylist`                                                | `{ playlistId }`                                                                                                                    |
| `playMode`                                                      | `{ mode: PlayMode }`                                                                                                                |
| `play`                                                          | `{ playlistId, mode? }`                                                                                                             |
| `retryOnline`                                                   | — (re-probe the servers)                                                                                                            |
| `probeRegions`                                                  | — (Settings → Region is open; measure pings)                                                                                        |
| `cancelQueue`                                                   | —                                                                                                                                   |
| `ready`                                                         | `{ ready }` (party member)                                                                                                          |
| **Private shows**                                               |                                                                                                                                     |
| `createCustom`                                                  | `{ options: CustomLobbyOptions }`                                                                                                   |
| `playCustomOffline`                                             | `{ options: CustomLobbyOptions }` (private show vs bots)                                                                            |
| `joinCode`                                                      | `{ code }`                                                                                                                          |
| `updateCustom`                                                  | `{ options: Partial<CustomLobbyOptions> }` (host, live)                                                                             |
| `startCustom`                                                   | `{ force? }` (force = start with unready players)                                                                                   |
| `leaveCustom` / `newCustomCode`                                 | —                                                                                                                                   |
| `lockCustom`                                                    | `{ locked }`                                                                                                                        |
| `kickCustomMember` / `unbanCustomMember` / `transferCustomHost` | `{ userId }`                                                                                                                        |
| `readyCustom`                                                   | `{ ready }`                                                                                                                         |
| `spectateCustom`                                                | `{ spectator }`                                                                                                                     |
| **Locker, store, pass**                                         |                                                                                                                                     |
| `tryOn`                                                         | `{ slot, itemId \| null }`                                                                                                          |
| `tryOnBundle`                                                   | `{ items: { slot, itemId }[] }`                                                                                                     |
| `equip`                                                         | `{ slot, itemId }`                                                                                                                  |
| `selectLoadout`                                                 | `{ index }`                                                                                                                         |
| `customizeColors`                                               | `{ colors }`                                                                                                                        |
| `randomizeOutfit`                                               | —                                                                                                                                   |
| `dressingRoom`                                                  | `{ active }` (move the 3D Tumbler into the dressing-room framing)                                                                   |
| `turntable`                                                     | `{ rotate, zoom }`                                                                                                                  |
| `needThumbnails`                                                | `{ ids }` (render cosmetic thumbnails)                                                                                              |
| `purchase`                                                      | `{ offerId }` (after the UI's own confirm dialog)                                                                                   |
| `buyGems`                                                       | `{ packId }`                                                                                                                        |
| `claimPassTier`                                                 | `{ tier, track: 'free' \| 'premium' }`                                                                                              |
| `buyPremiumPass`                                                | —                                                                                                                                   |
| `rerollChallenge` / `claimChallenge`                            | `{ id }`                                                                                                                            |
| **Profile, ranks, news, settings**                              |                                                                                                                                     |
| `leaderboardQuery`                                              | `{ board, scope? }`                                                                                                                 |
| `inspectPlayer`                                                 | `{ playerId, name? }`                                                                                                               |
| `requestMatchHistory`                                           | —                                                                                                                                   |
| `newsRead`                                                      | `{ ids }`                                                                                                                           |
| `settingsChange`                                                | `{ settings, section }`                                                                                                             |
| `accountAction`                                                 | `{ action, value? }`; action is `link-<provider>`, `signIn-<provider>`, `unlink-<provider>`, `signOut`, `deleteAccount` or `rename` |
| **Party & social**                                              |                                                                                                                                     |
| `inviteFriend`                                                  | `{ friendId }`                                                                                                                      |
| `copyInvite`                                                    | `{ kind, what }` (analytics only; the UI copies and confirms)                                                                       |
| `kickPartyMember` / `promotePartyMember`                        | `{ memberId }`                                                                                                                      |
| `leaveParty`                                                    | —                                                                                                                                   |
| `addFriend`                                                     | `{ nameTag }`                                                                                                                       |
| `searchPlayers`                                                 | `{ query }`                                                                                                                         |
| `requestFriend`                                                 | `{ userId, name? }`                                                                                                                 |
| `friendRequestAction`                                           | `{ userId, action: 'accept' \| 'decline' \| 'cancel' }`                                                                             |
| `removeFriend` / `unblockPlayer` / `joinFriend`                 | `{ userId }`                                                                                                                        |
| `blockPlayer`                                                   | `{ userId, name }`                                                                                                                  |
| `mutePlayer`                                                    | `{ key, name, muted }` (local only)                                                                                                 |
| `reportPlayer`                                                  | `{ userId, reason, details? }`                                                                                                      |
| `partyInviteAction`                                             | `{ userId, code, action: 'join' \| 'decline' }`                                                                                     |
| `sendChat` / `sendPartyChat`                                    | `{ text }`                                                                                                                          |
| `chatInput`                                                     | `{ open }` (the game frees the mouse and held keys)                                                                                 |
| **In the show**                                                 |                                                                                                                                     |
| `emote`                                                         | `{ slot, id }`                                                                                                                      |
| `quickPing`                                                     | `{ kind }`                                                                                                                          |
| `spectate`                                                      | — (keep watching)                                                                                                                   |
| `spectateNext`                                                  | `{ dir: 1 \| -1 }`                                                                                                                  |
| `leaveShow` / `playAgain` / `backToLobby`                       | —                                                                                                                                   |
| `touchInput`                                                    | `{ move: {x,y}, jump, dive, grab }` (rAF-coalesced)                                                                                 |
| `touchLook`                                                     | `{ dx, dy }`                                                                                                                        |
| `photoMode` / `photoCapture` / `photoExit`                      | —                                                                                                                                   |
| `replayOpen`                                                    | `{ key }` (a recorded round)                                                                                                        |
| `replayOpenLive`                                                | — (replay of the round in progress)                                                                                                 |
| `replayOpenFile`                                                | `{ name, bytes: ArrayBuffer }`                                                                                                      |
| `replayCommand`                                                 | `ReplayCommand` (play/pause, seek, speed, camera, save…)                                                                            |
| `continue`                                                      | `{ from: ScreenId }` (victory, winnerCam, playerWall)                                                                               |
| `skipPlayerWall`                                                | —                                                                                                                                   |
| `playerWallEvent`                                               | `PlayerWallEvent` (every wall beat; see below)                                                                                      |

The UI never navigates on its own for game-owned transitions (e.g. after
`continue` the game decides between rewards / menu). Pure-UI navigation (menu
tabs, private-show dialog, match history, overlays) is handled internally.

## Player wall sync

`playerWallTimeline(summary, { timeScale?, reduceMotion? })` is a **pure**
schedule: `{ events, duration, counts }`. The DOM wall runs it and emits every
beat as `playerWallEvent`:

`wallStart · cellsIn · roundBanner{roundIndex} · cellFlash{playerIds} ·
trapdoorOpen{playerIds} · cellDrop{playerId, spin, drift, hang} · counter{from,to} ·
roundEnd · winnerFocus{playerId} · crownDrop{playerId} · winnerReveal{playerId} ·
wallEnd · skip`

With `setPlayerWall(summary, { render3D: true })` the DOM hides its cells and
keeps the banners, counter and skip button; the three.js wall
(`render/scenes/playerWall`) animates the cells from the same events.
`wallGrid(n, w, h)` exposes the layout solver if the 3D wall wants the same grid.

## Audio cues

`playCue(name)` / `playMusic(track)` call the hooks installed with
`setAudioHooks`. Names are hierarchical — `cueFallbacks('ui.stamp.qualified')`
returns `['ui.stamp.qualified', 'ui.stamp']`. Full list: `UI_CUES`, `UI_MUSIC`.

## Accessibility & settings

`Settings.accessibility` drives root attributes: `data-reduce-motion`,
`data-reduce-flashing`, `data-reduce-shake`, `data-cb` (colour-blind palette),
`--ui-scale` (all sizes are `em`). `gameplay.streamerMode` masks other humans'
names and lobby/party codes. Keyboard nav (arrows / Enter / Esc / Q·E) is only
active on menu screens so gameplay keys never get swallowed.

## Layout

```
src/
  index.ts          public API
  mount.tsx         mountUI()
  App.tsx           layer stack
  audio-cues.ts     pluggable cue/music hooks
  names.ts          original name generator + validation
  store/            types, defaults, Zustand store, intent bus, wall timeline
  theme/            tokens, motion (spring → CSS linear()), its own CSS (base, screens, menu, hud, lobby, social, account, replay, wall)
  transitions/      TumbleWipe, StampLayer, Confetti (canvas)
  components/       Button/Toggle/Slider…, TumblerAvatar (SVG), panels, toasts, dialogs
  hud/              HUD widgets, emote wheel, touch controls
  screens/          every screen + menu tabs + overlay sheets
  nav/              spatial keyboard/gamepad navigation
```
