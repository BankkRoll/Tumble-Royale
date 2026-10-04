/**
 * When to offer Practice Island. The prompt comes back on later launches
 * until the player ticks "Don't ask again" or finishes the island once;
 * saying "I'll wing it" only skips it for this launch. The island itself is
 * always reachable from the Play tab and Settings → Gameplay.
 */

/** What the profile and this launch know about the tutorial. */
export interface TutorialPromptState {
  /** "Don't ask again" was ticked (stored on the profile as `tutorialAnswered`). */
  dontAsk: boolean;
  /** Practice Island was finished once. */
  completed: boolean;
  /** The prompt already showed in this launch. */
  askedThisLaunch: boolean;
}

/**
 * Whether to show the prompt now.
 *
 * @example shouldOfferTutorial({ dontAsk: false, completed: false, askedThisLaunch: false }) // true
 */
export function shouldOfferTutorial(s: TutorialPromptState): boolean {
  return !s.dontAsk && !s.completed && !s.askedThisLaunch;
}

/**
 * What answering the prompt changes.
 *
 * @returns Whether to start the island now, and whether to stop asking for good.
 */
export function tutorialAnswer(choice: { accept: boolean; dontAskAgain: boolean }): {
  start: boolean;
  stopAsking: boolean;
} {
  return { start: choice.accept, stopAsking: choice.dontAskAgain };
}
