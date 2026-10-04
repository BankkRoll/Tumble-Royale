/**
 * One "Join with a code" for both code kinds: a private show's lobby code
 * first, else a party invite code, with a clear answer for every refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiParty, type ApiPartyPreview } from '../src/game/api.ts';
import { NO_CODE_MATCH, joinWithCode, type JoinCodeDeps } from '../src/game/online/joinCode.ts';
import type { Lobby } from '../src/game/online/matchmaker.ts';

const lobby = { code: 'ABC234' } as Lobby;
const preview: ApiPartyPreview = {
  code: 'PARTY2',
  leader: 'Ann#0001',
  size: 2,
  maxSize: 4,
  playlistId: 'main',
};
const party = (code: string, members = 1): ApiParty => ({
  id: `p-${code}`,
  code,
  leaderId: 'u0',
  members: Array.from({ length: members }, (_, i) => ({
    userId: `u${i}`,
    displayName: `U${i}`,
    tag: '0001',
    ready: true,
    joinedAt: i,
  })),
  playlistId: 'main',
  inviteUrl: '',
  maxSize: 4,
});

const lobbyMissing = () => Promise.reject(new ApiError(404, 'lobby_not_found', 'No lobby with that code'));
const partyMissing = () => Promise.reject(new ApiError(404, 'not_found', 'Party not found'));

function deps(over: Partial<JoinCodeDeps> = {}): JoinCodeDeps {
  return {
    joinLobby: vi.fn(lobbyMissing),
    partyByCode: vi.fn(() => Promise.resolve(preview)),
    joinParty: vi.fn((code: string) => Promise.resolve({ party: party(code, 3) })),
    currentParty: () => null,
    ...over,
  };
}

describe('join with a code', () => {
  it('joins a private show when a lobby owns the code (and never looks for a party)', async () => {
    const d = deps({ joinLobby: vi.fn(() => Promise.resolve({ lobby })) });
    expect(await joinWithCode(' abc234 ', d)).toEqual({ kind: 'lobby', lobby });
    expect(d.joinLobby).toHaveBeenCalledWith('ABC234');
    expect(d.partyByCode).not.toHaveBeenCalled();
  });

  it('falls back to the party behind the code', async () => {
    const d = deps();
    const r = await joinWithCode('PARTY2', d);
    expect(r).toMatchObject({ kind: 'party', party: { code: 'PARTY2' } });
    expect(d.joinParty).toHaveBeenCalledWith('PARTY2');
  });

  it('works for party codes while private shows are offline', async () => {
    const r = await joinWithCode('PARTY2', deps({ joinLobby: null }));
    expect(r.kind).toBe('party');
  });

  it('says plainly when neither a party nor a show uses the code', async () => {
    expect(await joinWithCode('ZZZZ22', deps({ partyByCode: partyMissing }))).toEqual(NO_CODE_MATCH);
  });

  it('rejects codes no party or show could have without asking anyone', async () => {
    const d = deps();
    for (const bad of ['', 'ABC', 'ABCDEFG', 'ABC10O', 'AB-234'])
      expect(await joinWithCode(bad, d)).toEqual(NO_CODE_MATCH);
    expect(d.joinLobby).not.toHaveBeenCalled();
  });

  it('reports a full party before trying to join it', async () => {
    const d = deps({ partyByCode: () => Promise.resolve({ ...preview, size: 4 }) });
    expect(await joinWithCode('PARTY2', d)).toMatchObject({ kind: 'error', title: 'That party is full' });
    expect(d.joinParty).not.toHaveBeenCalled();
  });

  it('reports a party that filled up in the meantime', async () => {
    const d = deps({ joinParty: () => Promise.reject(new ApiError(409, 'party_full', 'Party is full')) });
    expect(await joinWithCode('PARTY2', d)).toMatchObject({ kind: 'error', title: 'That party is full' });
  });

  it('asks before leaving a party with other people, then joins once confirmed', async () => {
    const d = deps({ currentParty: () => party('MYPT22', 3) });
    const first = await joinWithCode('PARTY2', d);
    expect(first).toEqual({ kind: 'confirmLeaveParty', preview, currentSize: 3 });
    expect(d.joinParty).not.toHaveBeenCalled();
    expect((await joinWithCode('PARTY2', d, { leaveParty: true })).kind).toBe('party');
  });

  it('switches silently out of a party of one', async () => {
    const r = await joinWithCode('PARTY2', deps({ currentParty: () => party('MYPT22', 1) }));
    expect(r.kind).toBe('party');
  });

  it('recognises the playerâ€™s own party code', async () => {
    const d = deps({ currentParty: () => party('MYPT22', 2) });
    expect(await joinWithCode('mypt22', d)).toEqual({ kind: 'alreadyInParty' });
    expect(d.joinLobby).not.toHaveBeenCalled();
  });

  it('names a lobby refusal instead of trying the party', async () => {
    const d = deps({
      joinLobby: () => Promise.reject(new ApiError(409, 'lobby_started', 'The show already started')),
    });
    expect(await joinWithCode('ABC234', d)).toMatchObject({
      kind: 'error',
      title: 'That show already started',
    });
    expect(d.partyByCode).not.toHaveBeenCalled();
  });

  it('explains a kick from that party', async () => {
    const d = deps({
      joinParty: () => Promise.reject(new ApiError(403, 'kicked', 'You were removed from this party')),
    });
    expect(await joinWithCode('PARTY2', d)).toMatchObject({ title: 'You were removed from that party' });
  });

  it('does not blame the code when the servers are unreachable', async () => {
    const down = () => Promise.reject(new ApiError(0, 'network', 'Network error'));
    expect(await joinWithCode('PARTY2', deps({ partyByCode: down }))).toMatchObject({
      kind: 'error',
      title: "Couldn't check that code",
    });
    // The lobby side was down and no party matched: it might still be a show code.
    expect(await joinWithCode('ABC234', deps({ joinLobby: down, partyByCode: partyMissing }))).toMatchObject({
      title: "Couldn't check that code",
    });
  });
});
