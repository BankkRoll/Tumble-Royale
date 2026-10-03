/**
 * The one-time Practice Island completion reward. Shared by the API (online
 * accounts, `POST /me/tutorial-complete`) and the client (offline profiles) so
 * both grant exactly the same thing.
 */
export const TUTORIAL_REWARD = Object.freeze({
  /** Account XP (also counts as season pass XP online). */
  xp: 150,
  /** Cosmetic unlocked: the Fresh Mint nameplate. */
  cosmeticId: 'nameplate.mint',
} as const);
