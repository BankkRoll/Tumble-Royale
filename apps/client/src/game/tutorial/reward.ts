/**
 * Practice Island completion reward: a little XP and the Fresh Mint nameplate,
 * granted once per profile and remembered with a `tutorialCompleted` flag.
 */
import { getCosmetic } from '@tumble/content/cosmetics';
import type { TutorialReadyInfo } from '@tumble/ui/tutorial';
import type { ProfileStore } from '../profile.ts';

/** XP for finishing the tutorial the first time. */
export const TUTORIAL_XP = 150;
/** Cosmetic unlocked by finishing the tutorial. */
export const TUTORIAL_UNLOCK = 'nameplate.mint';

/** The saved-profile fields this reward touches (a subset of `ProfileStore`'s private data). */
interface RewardableProfile {
  totalXp: number;
  seasonXp: number;
  owned: string[];
  tutorialCompleted?: boolean;
}

/**
 * Grants the reward (first completion only) and saves the profile.
 *
 * @param profile - The local profile.
 * @returns What the ready card shows (zero XP and no unlock on repeats).
 */
export function grantTutorialReward(profile: ProfileStore): Omit<TutorialReadyInfo, 'raceLine'> {
  // HACK: ProfileStore has no generic grant API yet and profile.ts belongs to
  // the meta/profile owner. The saved shape is additive-only by contract
  // (see SavedProfile), so writing XP/owned plus one new flag is safe; the
  // public `answerTutorial()` call below persists it.
  // TODO: replace with `profile.grantTutorialReward()` once ProfileStore exposes one.
  const data = (profile as unknown as { data: RewardableProfile | null }).data;
  if (!data || typeof data.totalXp !== 'number' || !Array.isArray(data.owned)) return { xp: 0, unlock: null, repeat: true };
  if (data.tutorialCompleted) return { xp: 0, unlock: null, repeat: true };
  data.tutorialCompleted = true;
  data.totalXp += TUTORIAL_XP;
  data.seasonXp = (data.seasonXp ?? 0) + TUTORIAL_XP;
  const item = getCosmetic(TUTORIAL_UNLOCK);
  let unlock: TutorialReadyInfo['unlock'] = null;
  if (item && !data.owned.includes(item.id)) {
    data.owned.push(item.id);
    unlock = { name: item.name, icon: 'nameplate', kind: 'nameplate' };
  }
  profile.answerTutorial();
  return { xp: TUTORIAL_XP, unlock, repeat: false };
}
