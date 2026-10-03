/**
 * Game ↔ UI contract: the Zustand store, the intent bus and all data types.
 */
export * from './types.ts';
export * from './defaults.ts';
export { ui, useUI, setNavigator, type UIState, type WipeState } from './uiStore.ts';
export {
  uiEvents,
  bindUI,
  UIEventEmitter,
  type UIIntents,
  type UIIntentName,
  type UIIntentListener,
  type UIHandlers,
} from './events.ts';
export {
  playerWallTimeline,
  type PlayerWallTimeline,
  type PlayerWallTimingOptions,
} from './playerWallTimeline.ts';
