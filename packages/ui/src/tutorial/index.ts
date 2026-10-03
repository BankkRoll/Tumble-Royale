/**
 * `@tumble/ui/tutorial` — the Practice Island overlay: objective checklist,
 * prompt card with the player's real bindings, the coach's text speech bubble,
 * success bursts, skip flow and the "You're ready!" card.
 *
 * The tutorial runner drives it through {@link tutorialUi} (state) and
 * {@link setCoachAnchor} (per-frame bubble position), and listens on
 * {@link tutorialEvents} for skip / ready-card choices.
 */
export { mountTutorialOverlay, type TutorialOverlayHandle } from './mount.tsx';
export { TutorialOverlay, KeyChips, PromptText } from './TutorialOverlay.tsx';
export {
  TUTORIAL_UI_DEFAULTS,
  onCoachAnchor,
  setCoachAnchor,
  tutorialEvents,
  tutorialUi,
  useTutorialUI,
  type CoachAnchor,
  type CoachLine,
  type PromptPart,
  type TutorialDevice,
  type TutorialIntents,
  type TutorialPromptCard,
  type TutorialReadyInfo,
  type TutorialStep,
  type TutorialStepState,
  type TutorialUIState,
} from './store.ts';
/** Human label for a key/mouse binding code (shared with the settings rebinder). */
export { keyLabel } from '../screens/overlays/SettingsSheet.tsx';
export { TutorialIcon, type TutorialIconName } from './icons.tsx';
