/**
 * Practice Island completion reward: a little XP and the Fresh Mint nameplate,
 * granted once. Signed-in accounts claim it from the API
 * (`POST /me/tutorial-complete`, idempotent per account); offline profiles
 * record it locally.
 */
import { getCosmetic } from '@tumble/content/cosmetics';
import { TUTORIAL_REWARD } from '@tumble/content/progression';
import type { TutorialReadyInfo } from '@tumble/ui/tutorial';
import type { ApiTutorialComplete } from '../api.ts';
import type { ProfileStore } from '../profile.ts';

/** XP for finishing the tutorial the first time. */
export const TUTORIAL_XP = TUTORIAL_REWARD.xp;
/** Cosmetic unlocked by finishing the tutorial. */
export const TUTORIAL_UNLOCK = TUTORIAL_REWARD.cosmeticId;

/** Where the reward goes: the signed-in account when there is one, else the local profile. */
export interface TutorialRewardTarget {
  profile: ProfileStore;
  account: { readonly active: boolean; completeTutorial(): Promise<ApiTutorialComplete | null> } | null;
}

type ReadyReward = Omit<TutorialReadyInfo, 'raceLine'>;

const NOTHING: ReadyReward = { xp: 0, unlock: null, repeat: true };

function unlockCard(cosmeticId: string | null): TutorialReadyInfo['unlock'] {
  const item = cosmeticId ? getCosmetic(cosmeticId) : undefined;
  return item ? { name: item.name, icon: 'nameplate', kind: 'nameplate' } : null;
}

/**
 * Grants the reward (first completion only).
 *
 * @param target - Local profile and the online account (if any).
 * @returns What the ready card shows (zero XP and no unlock on repeats, or
 *   when the API could not be reached: the account can finish the tutorial
 *   again later to claim it).
 */
export async function grantTutorialReward(target: TutorialRewardTarget): Promise<ReadyReward> {
  target.profile.answerTutorial();
  if (target.account?.active) {
    const r = await target.account.completeTutorial();
    if (!r?.granted) return NOTHING;
    return { xp: r.xp, unlock: unlockCard(r.unlock), repeat: false };
  }
  const r = target.profile.completeTutorial(TUTORIAL_XP, TUTORIAL_UNLOCK);
  if (!r.granted) return NOTHING;
  return { xp: TUTORIAL_XP, unlock: r.unlocked ? unlockCard(TUTORIAL_UNLOCK) : null, repeat: false };
}
