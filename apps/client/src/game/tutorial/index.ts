/**
 * Practice Island (the optional first-launch tutorial). `runTutorial(ctx)`
 * starts it as a session the app's frame loop drives like any show.
 */
import type { GameContext } from '../show/context.ts';
import { TutorialSession } from './session.ts';

export { TutorialSession, type TutorialHooks } from './session.ts';
export { promptKeys, type PromptAction } from './bindings.ts';
export { grantTutorialReward, TUTORIAL_UNLOCK, TUTORIAL_XP } from './reward.ts';

/**
 * Starts Practice Island. The session ends through `ctx.onEnd`: `'playAgain'`
 * when the player picks "Play a show!" on the ready card (the app starts the
 * first bot-heavy show), `'backToLobby'` on skip or "Main menu".
 *
 * @param ctx - App services (the same context shows get).
 * @returns The running session; assign it as the app's current session so
 *   the frame loop drives it.
 * @example
 * this.session = runTutorial(this.ctx);
 */
export function runTutorial(ctx: GameContext): TutorialSession {
  const session = new TutorialSession(ctx);
  session.start();
  return session;
}
