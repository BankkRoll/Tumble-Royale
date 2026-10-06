/**
 * Client side of custom rounds: the session registry (validated before use,
 * merged into the offline catalogue), local drafts, the Test play handoff
 * and Play again after a Test play.
 */
import { PLAYTEST_ROUND_ID, starterRound } from '@tumble/content/custom';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAYTEST_DRAFT_ID, memoryDrafts, type RoundDraft } from '../src/customRounds/drafts.ts';
import { PLAYTEST_PLAYERS, loadPlaytest } from '../src/customRounds/playtest.ts';
import {
  catalogWithCustomRounds,
  clearCustomRounds,
  lookupRound,
  registerCustomRound,
} from '../src/customRounds/registry.ts';
import { playAgainAction } from '../src/game/lastShow.ts';

afterEach(() => clearCustomRounds());

const draft = (over: Partial<RoundDraft> = {}): RoundDraft => ({
  id: 'd1',
  name: 'My Race',
  type: 'race',
  description: '',
  round: starterRound(),
  sharedCode: null,
  updatedAt: 1,
  ...over,
});

describe('custom round registry', () => {
  it('registers valid rounds and refuses invalid ones', () => {
    expect(lookupRound('custom:K7MQ2X9A')).toBeUndefined();
    const ok = registerCustomRound(starterRound(), 'custom:K7MQ2X9A');
    expect(ok.ok).toBe(true);
    expect(lookupRound('custom:K7MQ2X9A')?.name).toBe('My Race');
    expect(catalogWithCustomRounds().has('custom:K7MQ2X9A')).toBe(true);
    expect(catalogWithCustomRounds().has('gumdrop-gauntlet')).toBe(true);
    const bad = registerCustomRound({ ...starterRound(), killY: 50 }, 'custom:BBBBBBBB');
    expect(bad.ok).toBe(false);
    expect(lookupRound('custom:BBBBBBBB')).toBeUndefined();
    expect(lookupRound('gumdrop-gauntlet')?.id).toBe('gumdrop-gauntlet');
  });
});

describe('local drafts', () => {
  it('saves, lists newest first, hides the playtest slot and deletes', async () => {
    const store = memoryDrafts();
    await store.put(draft({ id: 'a', updatedAt: 1 }));
    await store.put(draft({ id: 'b', updatedAt: 5 }));
    await store.put(draft({ id: PLAYTEST_DRAFT_ID, updatedAt: 9 }));
    expect((await store.list()).map((d) => d.id)).toEqual(['b', 'a']);
    const got = await store.get('a');
    got!.name = 'changed';
    expect((await store.get('a'))!.name).toBe('My Race');
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
  });
});

describe('test play', () => {
  it('turns the playtest draft into a one-round show', async () => {
    const store = memoryDrafts();
    expect(await loadPlaytest(store)).toEqual({
      ok: false,
      message: 'Open the round editor and press Test play',
    });
    await store.put(draft({ id: PLAYTEST_DRAFT_ID }));
    const r = await loadPlaytest(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playlist.pool).toEqual([{ roundId: PLAYTEST_ROUND_ID, weight: 1 }]);
    expect(r.playlist.maxRounds).toBe(1);
    expect(r.playlist.maxPlayers).toBe(PLAYTEST_PLAYERS);
    expect(lookupRound(PLAYTEST_ROUND_ID)?.botNav.length).toBeGreaterThan(0);
  });

  it('reports a draft with errors', async () => {
    const store = memoryDrafts();
    const round = starterRound();
    round.triggers = [];
    await store.put(draft({ id: PLAYTEST_DRAFT_ID, round }));
    const r = await loadPlaytest(store);
    expect(r).toEqual({ ok: false, message: 'The round has errors: Races need a finish' });
  });

  it('Play again runs Test play again', () => {
    expect(playAgainAction({ kind: 'playtest' })).toEqual({ action: 'playtest' });
  });
});
