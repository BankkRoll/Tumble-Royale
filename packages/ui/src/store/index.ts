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
export * from './account.ts';
export {
  playerWallTimeline,
  type PlayerWallTimeline,
  type PlayerWallTimingOptions,
} from './playerWallTimeline.ts';
export {
  social,
  useSocial,
  visibleChat,
  CHAT_HISTORY,
  PRESENCE_LABEL,
  type SocialState,
  type SocialAvailability,
  type PlayerRef,
  type FriendRequest,
  type BlockedPlayer,
  type PlayerSearchResult,
  type ChatLine,
  type ChatVisibility,
  type VisibleChatLine,
} from './social.ts';
