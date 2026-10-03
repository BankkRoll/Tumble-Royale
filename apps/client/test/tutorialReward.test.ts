import { describe, expect, it, vi } from 'vitest';
import type { ApiTutorialComplete } from '../src/game/api.ts';
import type { ProfileStore } from '../src/game/profile.ts';
import { TUTORIAL_UNLOCK, TUTORIAL_XP, grantTutorialReward } from '../src/game/tutorial/reward.ts';

function fakeProfile() {
  let done = false;
  const p = {
    answerTutorial: vi.fn(),
    completeTutorial: vi.fn((xp: number, id: string) => {
      if (done) return { granted: false, unlocked: false };
      done = true;
      expect(xp).toBe(TUTORIAL_XP);
      expect(id).toBe(TUTORIAL_UNLOCK);
      return { granted: true, unlocked: true };
    }),
  };
  return p as typeof p & ProfileStore;
}

describe('tutorial reward', () => {
  it('offline: grants on the local profile once', async () => {
    const profile = fakeProfile();
    const first = await grantTutorialReward({ profile, account: null });
    expect(first).toMatchObject({ xp: TUTORIAL_XP, repeat: false });
    expect(first.unlock?.kind).toBe('nameplate');
    expect(await grantTutorialReward({ profile, account: null })).toEqual({
      xp: 0,
      unlock: null,
      repeat: true,
    });
    expect(profile.answerTutorial).toHaveBeenCalled();
  });

  it('online: claims from the account and never touches the local reward', async () => {
    const profile = fakeProfile();
    const answers: (ApiTutorialComplete | null)[] = [
      { granted: true, xp: TUTORIAL_XP, unlock: TUTORIAL_UNLOCK, level: 2, totalXp: 150 },
      { granted: false, xp: 0, unlock: null, level: 2, totalXp: 150 },
      null,
    ];
    const account = { active: true, completeTutorial: vi.fn(async () => answers.shift() ?? null) };
    expect(await grantTutorialReward({ profile, account })).toMatchObject({ xp: TUTORIAL_XP, repeat: false });
    expect(await grantTutorialReward({ profile, account })).toMatchObject({ xp: 0, repeat: true });
    // Unreachable API: nothing is shown as granted, and nothing is granted locally either.
    expect(await grantTutorialReward({ profile, account })).toMatchObject({ xp: 0, repeat: true });
    expect(account.completeTutorial).toHaveBeenCalledTimes(3);
    expect(profile.completeTutorial).not.toHaveBeenCalled();
  });

  it('an inactive account falls back to the local profile', async () => {
    const profile = fakeProfile();
    const account = { active: false, completeTutorial: vi.fn(async () => null) };
    expect((await grantTutorialReward({ profile, account })).xp).toBe(TUTORIAL_XP);
    expect(account.completeTutorial).not.toHaveBeenCalled();
  });
});
