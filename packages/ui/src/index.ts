/**
 * @tumble/ui — React overlay: every menu, HUD and transition screen, plus the
 * game ↔ UI store.
 *
 * Responsibilities:
 * - `mountUI(el)` renders the overlay over the game canvas;
 * - `ui` (Zustand store) is the game → UI contract (plain actions);
 * - `uiEvents` / `bindUI` is the UI → game intent bus;
 * - `setAudioHooks` plugs the audio engine into UI cues/music;
 * - `playerWallTimeline` is the shared schedule for the end-of-show wall.
 *
 * See packages/ui/README.md and docs/design/SCREENS.md.
 */
export { mountUI, type MountOptions, type UIHandle } from './mount.tsx';
export { App } from './App.tsx';
export { openNewsPost } from './screens/menu/NewsTab.tsx';
export { openAccountSettings } from './screens/overlays/SettingsSheet.tsx';
export { grantText } from './components/GrantChip.tsx';
export * from './store/index.ts';
export {
  setAudioHooks,
  playCue,
  playMusic,
  cueFallbacks,
  UI_CUES,
  UI_MUSIC,
  type AudioHooks,
  type UICueName,
} from './audio-cues.ts';
export { fireConfetti, fireFireworks, CONSOLATION_LINES, type ConfettiOptions } from './transitions/index.ts';
export {
  MASKED_TAG,
  maskedName,
  randomTumblerName,
  seatName,
  validateDisplayName,
  streamerSafeAccount,
  streamerSafeAccountLabel,
  streamerSafeKeyedName,
  streamerSafeName,
  type AccountName,
  type KeyedPlayer,
  type NamedPlayer,
} from './names.ts';
export {
  palette,
  rarityColors,
  roundTypeStyle,
  tumblerSwatches,
  confettiSets,
  semanticColors,
  fonts,
  FONT_STYLESHEET_URL,
} from './theme/tokens.ts';
