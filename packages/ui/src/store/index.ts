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
export {
  CHANNEL_LABEL,
  CHANNEL_ORDER,
  CHAT_HELP,
  CHAT_KEEP,
  CHAT_OFFLINE,
  INITIAL_CHAT,
  ROOM_PRIORITY,
  channelOf,
  chatPlaceholder,
  chatTabs,
  feedLines,
  linesOf,
  nameTag,
  parseChatInput,
  publicRoom,
  reduceChat,
  roomOf,
  type ChatAction,
  type ChatChannel,
  type ChatCommand,
  type ChatHint,
  type ChatLineChannel,
  type ChatState,
  type CommandContext,
  type PublicRoom,
  type RoomAccess,
  type WhisperTarget,
} from './chatChannels.ts';
export {
  SHOW_MENU_SCREENS,
  isTypingTarget,
  keyboardBusy,
  menuOwnsInput,
  watchChoiceVisible,
} from './inputOwnership.ts';
