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
| `setLocalReady` / `setCustomLobby` / `setRoundCatalog`            |                                                                                      |                                                                                                                                                                    |
| `setQueue`                                                        | `(q: Partial<QueueState>)`                                                           | Matchmaking card.                                                                                                                                                  |
| `setPreShow` / `setShowIntro` / `setRoundIntro`                   | info objects                                                                         | Round intro feeds loading, flyover and rules cards.                                                                                                                |
| `setHud`                                                          | `(patch: Partial<HudState>)`                                                         | **Throttle to 10–15 Hz.** No-op if nothing changed; widgets select single fields.                                                                                  |
| `resetHud`                                                        | `(patch?)`                                                                           | Start of each round.                                                                                                                                               |
| `setCountdown`                                                    | `(3\|2\|1\|null)`                                                                    | Numerals; follow with `showStamp('go')`.                                                                                                                           |
| `showStamp`                                                       | `(kind: StampKind, { text?, sub? }) => id`                                           | `qualified, eliminated, roundOver, timeUp, go, overtime, final, victory, teamWin, teamLose`. Queued.                                                               |
| `setEliminatedSheet`                                              | `(open)`                                                                             | Spectate / Back to lobby / Play again.                                                                                                                             |
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

| Intent                                    | Payload                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `start`                                   | — (splash pressed; unlock audio)                                                                                  |
| `welcomeDone`                             | `{ name, colors }`                                                                                                |
| `previewColors`                           | `{ colors, pattern }`                                                                                             |
| `tutorialChoice`                          | `{ accept, dontAskAgain }`                                                                                        |
| `menuTab` / `overlay`                     | `{ tab }` / `{ overlay }`                                                                                         |
| `selectPlaylist` / `play`                 | `{ playlistId }`                                                                                                  |
| `cancelQueue`                             | —                                                                                                                 |
| `ready`                                   | `{ ready }`                                                                                                       |
| `tryOn`                                   | `{ slot, itemId \| null }`                                                                                        |
| `equip`                                   | `{ slot, itemId }`                                                                                                |
| `selectLoadout`                           | `{ index }`                                                                                                       |
| `customizeColors`                         | `{ colors }`                                                                                                      |
| `randomizeOutfit`                         | —                                                                                                                 |
| `purchase`                                | `{ offerId }` (after the UI's own confirm dialog)                                                                 |
| `claimPassTier`                           | `{ tier, track: 'free' \| 'premium' }`                                                                            |
| `buyPremiumPass`                          | —                                                                                                                 |
| `rerollChallenge` / `claimChallenge`      | `{ id }`                                                                                                          |
| `leaderboardQuery`                        | `{ board }`                                                                                                       |
| `requestMatchHistory`                     | —                                                                                                                 |
| `settingsChange`                          | `{ settings, section }`                                                                                           |
| `accountAction`                           | `{ action: 'link-discord' \| 'link-google' \| 'link-email' \| 'signOut' \| 'deleteAccount' \| 'rename', value? }` |
| `spectate`                                | —                                                                                                                 |
| `spectateNext`                            | `{ dir: 1 \| -1 }`                                                                                                |
| `playAgain` / `backToLobby` / `leaveShow` | —                                                                                                                 |
| `emote`                                   | `{ slot, id }`                                                                                                    |
| `quickPing`                               | `{ kind }`                                                                                                        |
| `photoMode`                               | —                                                                                                                 |
| `createCustom`                            | `{ options: CustomLobbyOptions }`                                                                                 |
| `joinCode`                                | `{ code }`                                                                                                        |
| `startCustom` / `leaveCustom`             | —                                                                                                                 |
| `inviteFriend`                            | `{ friendId }`                                                                                                    |
| `addFriend`                               | `{ nameTag }`                                                                                                     |
| `copyInvite`                              | `{ code }`                                                                                                        |
| `kickPartyMember`                         | `{ memberId }`                                                                                                    |
| `leaveParty`                              | —                                                                                                                 |
| `continue`                                | `{ from: ScreenId }` (victory, winnerCam, playerWall)                                                             |
| `skipPlayerWall`                          | —                                                                                                                 |
| `playerWallEvent`                         | `PlayerWallEvent` (every wall beat; see below)                                                                    |
| `transitionCovered`                       | `{ to: ScreenId }` (swap 3D scenes now)                                                                           |
| `screenShown`                             | `{ screen }`                                                                                                      |
| `dialogResult`                            | `{ dialogId, buttonId }`                                                                                          |
| `toastAction`                             | `{ toastId, actionId }`                                                                                           |
| `retryConnection`                         | —                                                                                                                 |
| `touchInput`                              | `{ move: {x,y}, jump, dive, grab }` (rAF-coalesced)                                                               |
| `navUnhandled`                            | `{ dir }` (e.g. Back on a root screen → open pause)                                                               |

The UI never navigates on its own for game-owned transitions (e.g. after
`continue` the game decides between rewards / menu). Pure-UI navigation (menu
tabs, custom lobby, match history, overlays) is handled internally.

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
  theme/            tokens, motion (spring → CSS linear()), CSS (base, screens, hud, wall)
  transitions/      TumbleWipe, StampLayer, Confetti (canvas)
  components/       Button/Toggle/Slider…, TumblerAvatar (SVG), panels, toasts, dialogs
  hud/              HUD widgets, emote wheel, touch controls
  screens/          every screen + menu tabs + overlay sheets
  nav/              spatial keyboard/gamepad navigation
```
