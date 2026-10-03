import { describe, expect, it } from 'vitest';
import type { ApiFriends } from '../src/game/api.ts';
import {
  EMPTY_FRIENDS,
  friendsFromApi,
  friendsToUi,
  reduceFriends,
  uiPresence,
  type FriendsModel,
} from '../src/game/social/friendsState.ts';

const colors = { primary: '#fff', secondary: '#000', pattern: 'plain' as const };
const ref = (userId: string, name = userId) => ({ userId, name, tag: '0001' });
const card = (userId: string, name = userId) => ({ userId, displayName: name, tag: '0001', level: 2 });

function base(): FriendsModel {
  const api: ApiFriends = {
    friends: [
      { ...card('z', 'Zed'), presence: 'offline' },
      { ...card('a', 'Amy'), presence: 'in_match', playlistId: 'main-show' },
      { ...card('b', 'Bob'), presence: 'in_menu', joinable: true },
    ],
    incoming: [{ ...card('i'), at: '2026-10-01T00:00:00.000Z' }],
    outgoing: [{ ...card('o') }],
    blocked: [],
  };
  return friendsFromApi(api, [
    { ...card('r', 'Rita'), relation: 'none' },
    { ...card('b', 'Bob'), relation: 'friend', presence: 'in_menu' },
    { ...card('o'), relation: 'outgoing' },
  ]);
}

describe('friends reducer', () => {
  it('sorts friends by availability then name', () => {
    expect(base().friends.map((f) => f.userId)).toEqual(['b', 'a', 'z']);
  });

  it('applies presence (with playlist) and re-sorts; ignores strangers', () => {
    let m = reduceFriends(base(), { type: 'presence', userId: 'z', status: 'online', joinable: true });
    expect(m.friends[0]).toMatchObject({ userId: 'b' });
    expect(m.friends.find((f) => f.userId === 'z')).toMatchObject({ presence: 'online', joinable: true });
    m = reduceFriends(m, { type: 'presence', userId: 'b', status: 'in_queue', playlistId: 'duos' });
    expect(m.friends.find((f) => f.userId === 'b')).toMatchObject({
      presence: 'in_queue',
      playlistId: 'duos',
    });
    expect(m.friends.find((f) => f.userId === 'b')!.joinable).toBeUndefined();
    const same = reduceFriends(m, { type: 'presence', userId: 'nobody', status: 'online' });
    expect(same).toBe(m);
  });

  it('applies a presence snapshot to everyone at once', () => {
    const m = reduceFriends(base(), {
      type: 'presence_snapshot',
      friends: [
        { userId: 'a', status: 'offline' },
        { userId: 'z', status: 'in_menu' },
      ],
    });
    expect(m.friends.map((f) => [f.userId, f.presence])).toEqual([
      ['b', 'in_menu'],
      ['z', 'in_menu'],
      ['a', 'offline'],
    ]);
  });

  it('tracks the request lifecycle', () => {
    let m = reduceFriends(EMPTY_FRIENDS, { type: 'friend_request', from: ref('x', 'Xena'), at: 5 });
    expect(m.incoming.map((r) => r.userId)).toEqual(['x']);
    expect(reduceFriends(m, { type: 'friend_request', from: ref('x') })).toBe(m);
    m = reduceFriends(m, { type: 'accepted', userId: 'x' });
    expect(m.incoming).toEqual([]);
    expect(m.friends).toEqual([expect.objectContaining({ userId: 'x', presence: 'offline' })]);

    m = reduceFriends(m, { type: 'request_sent', user: ref('y'), status: 'pending' });
    expect(m.outgoing.map((r) => r.userId)).toEqual(['y']);
    m = reduceFriends(m, { type: 'friend_accepted', by: ref('y') });
    expect(m.outgoing).toEqual([]);
    expect(m.friends.map((f) => f.userId).sort()).toEqual(['x', 'y']);

    m = reduceFriends(m, { type: 'request_sent', user: ref('w'), status: 'accepted' });
    expect(m.friends.some((f) => f.userId === 'w')).toBe(true);
  });

  it('drops requests when the other side declines or cancels', () => {
    let m = reduceFriends(base(), { type: 'friend_request_removed', userId: 'o' });
    expect(m.outgoing).toEqual([]);
    m = reduceFriends(m, { type: 'friend_request_removed', userId: 'i' });
    expect(m.incoming).toEqual([]);
    expect(reduceFriends(m, { type: 'friend_request_removed', userId: 'i' })).toBe(m);
  });

  it('removes friends on friend_removed', () => {
    const m = reduceFriends(base(), { type: 'friend_removed', userId: 'a' });
    expect(m.friends.map((f) => f.userId)).toEqual(['b', 'z']);
  });

  it('blocking removes every trace and unblocking restores only the block list', () => {
    let m = reduceFriends(base(), { type: 'blocked', user: ref('b', 'Bob') });
    expect(m.friends.some((f) => f.userId === 'b')).toBe(false);
    expect(m.recent.some((r) => r.userId === 'b')).toBe(false);
    expect(m.blocked.map((x) => x.userId)).toEqual(['b']);
    m = reduceFriends(m, { type: 'unblocked', userId: 'b' });
    expect(m.blocked).toEqual([]);
    expect(m.friends.some((f) => f.userId === 'b')).toBe(false);
  });
});

describe('friendsToUi', () => {
  it('projects presence, playlist names, recent relations and requests', () => {
    const ui = friendsToUi(
      base(),
      () => colors,
      (id) => (id === 'main-show' ? 'Main Show' : id),
    );
    const amy = ui.friends.find((f) => f.id === 'a' && !f.recent)!;
    expect(amy).toMatchObject({ presence: 'inShow', playlist: 'Main Show', relation: 'friend' });
    const bob = ui.friends.find((f) => f.id === 'b' && !f.recent)!;
    expect(bob).toMatchObject({ presence: 'inMenu', joinable: true });
    const recent = ui.friends.filter((f) => f.recent);
    expect(recent.map((f) => [f.id, f.relation, f.presence])).toEqual([
      ['r', 'none', 'offline'],
      ['b', 'friend', 'inMenu'],
      ['o', 'outgoing', 'offline'],
    ]);
    expect(ui.incoming).toEqual([
      expect.objectContaining({ userId: 'i', at: Date.parse('2026-10-01T00:00:00.000Z') }),
    ]);
    expect(ui.outgoing.map((r) => r.userId)).toEqual(['o']);
  });

  it('a removed friend in recent players reads as a stranger again', () => {
    const m = reduceFriends(base(), { type: 'friend_removed', userId: 'b' });
    const recentBob = friendsToUi(m, () => colors).friends.find((f) => f.id === 'b')!;
    expect(recentBob).toMatchObject({ recent: true, relation: 'none', presence: 'offline' });
  });

  it('maps API presence to UI presence', () => {
    expect(['online', 'in_menu', 'in_queue', 'in_match', 'offline', 'weird'].map(uiPresence)).toEqual([
      'online',
      'inMenu',
      'inQueue',
      'inShow',
      'offline',
      'offline',
    ]);
  });
});
