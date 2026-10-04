/**
 * The Practice Island prompt comes back on later launches until "Don't ask
 * again" is ticked or the island is finished, and only once per launch.
 */
import { describe, expect, it } from 'vitest';
import { shouldOfferTutorial, tutorialAnswer } from '../src/game/tutorial/prompt.ts';

const fresh = { dontAsk: false, completed: false, askedThisLaunch: false };

describe('Practice Island prompt', () => {
  it('asks a player who has not answered for good', () => {
    expect(shouldOfferTutorial(fresh)).toBe(true);
  });

  it('asks only once per launch', () => {
    expect(shouldOfferTutorial({ ...fresh, askedThisLaunch: true })).toBe(false);
  });

  it('stops for good after "Don\'t ask again" or finishing the island', () => {
    expect(shouldOfferTutorial({ ...fresh, dontAsk: true })).toBe(false);
    expect(shouldOfferTutorial({ ...fresh, completed: true })).toBe(false);
  });

  it('honours the tick on either answer, and only the tick', () => {
    expect(tutorialAnswer({ accept: true, dontAskAgain: false })).toEqual({ start: true, stopAsking: false });
    expect(tutorialAnswer({ accept: false, dontAskAgain: false })).toEqual({
      start: false,
      stopAsking: false,
    });
    expect(tutorialAnswer({ accept: false, dontAskAgain: true })).toEqual({ start: false, stopAsking: true });
    expect(tutorialAnswer({ accept: true, dontAskAgain: true })).toEqual({ start: true, stopAsking: true });
  });
});
