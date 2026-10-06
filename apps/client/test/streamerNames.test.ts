/**
 * Streamer Mode in what the game writes itself: toasts and notifications for
 * friend requests, party and club invites, club join requests, friend
 * actions, the leave-party question, masked profile cards and `/mute` by the
 * masked label.
 */
import { DEFAULT_SETTINGS, INITIAL_CHAT, maskedName, social, ui, type ProfileData } from '@tumble/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/game/api.ts';
import type { TypedMessage } from '../src/game/online/jsonSocket.ts';
import { partyOwnerLabel } from '../src/game/online/joinCode.ts';
import { findMuteKey } from '../src/game/social/chatRouter.ts';
import { ClubController } from '../src/game/social/clubController.ts';
import { SocialController } from '../src/game/social/socialController.ts';
import { maskedProfile, otherPlayerName } from '../src/game/social/streamerNames.ts';

function streamer(on: boolean): void {
  ui.getState().setSettings({
    ...DEFAULT_SETTINGS,
    gameplay: { ...DEFAULT_SETTINGS.gameplay, streamerMode: on },
  });
}

function fakeRealtime() {
  const handlers = new Map<string, ((m: TypedMessage) => void)[]>();
  return {
    connected: true,
    on(type: string, fn: (m: TypedMessage) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
      return () => undefined;
    },
    send() {},
    emit(type: string, m: Record<string, unknown>) {
      for (const fn of handlers.get(type) ?? []) fn({ type, ...m });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const toastTitles = (): string[] => ui.getState().toasts.map((t) => t.title);

beforeEach(() => {
  streamer(true);
  ui.setState({ toasts: [], friends: [], customLobby: null });
  social.setState({ chat: INITIAL_CHAT });
});

afterEach(() => streamer(false));

describe('otherPlayerName', () => {
  const from = { userId: 'u-x', name: 'RealName', tag: '4242' };

  it('masks by account id while streaming, tag included', () => {
    expect(otherPlayerName(from, 'Someone', true, false)).toBe('RealName#4242');
    expect(otherPlayerName(from, 'Someone', true, true)).toBe(`${maskedName('u-x')}#••••`);
    expect(otherPlayerName(from, 'Someone', false, true)).toBe(maskedName('u-x'));
  });

  it('falls back instead of leaking a name it cannot mask', () => {
    expect(otherPlayerName({ name: 'RealName' }, 'Someone', false, true)).toBe('Someone');
    expect(otherPlayerName({ name: 'RealName' }, 'Someone', false, false)).toBe('RealName');
    expect(otherPlayerName(undefined, 'Someone')).toBe('Someone');
  });
});

describe('maskedProfile', () => {
  it('keeps the clicked mask and hides the tag', () => {
    const card = { id: 'u-x', name: 'RealName', tag: '4242' } as ProfileData;
    expect(maskedProfile(card, 'Tumbler 5')).toMatchObject({ name: 'Tumbler 5', tag: '••••', masked: true });
    expect(maskedProfile(card).name).toBe(maskedName('u-x'));
  });
});

describe('partyOwnerLabel', () => {
  it("names the other party's leader only outside Streamer Mode", () => {
    expect(partyOwnerLabel('Leader#1234', false)).toBe("Leader's party");
    expect(partyOwnerLabel('Leader#1234', true)).toBe('that party');
    expect(partyOwnerLabel(null, false)).toBe('that party');
  });
});

describe('toasts', () => {
  it('masks the asker of a club join request', async () => {
    const rt = fakeRealtime();
    const api = { myClub: async () => ({ club: null, role: null, invites: [], requests: [] }) };
    const c = new ClubController(api as unknown as ApiClient, rt, {
      userId: () => 'u-me',
      applyParty: () => undefined,
      notify: () => undefined,
    });
    c.bind();
    rt.emit('club_request', { clubId: 'c-1', from: { userId: 'u-ask', name: 'AskerName', tag: '0003' } });
    await flush();
    expect(toastTitles()).toContain(`${maskedName('u-ask')} wants to join your club`);
    expect(toastTitles().join()).not.toContain('AskerName');
  });

  it('masks "Request sent to" and party-invite declines', async () => {
    const rt = fakeRealtime();
    const api = {
      friendRequest: async () => ({
        status: 'pending',
        user: { userId: 'u-new', displayName: 'NewName', tag: '0004' },
      }),
    };
    const s = new SocialController(api as unknown as ApiClient, rt, {
      userId: () => 'u-me',
      colorsOf: () => ({ primary: '#fff', secondary: '#000', pattern: 'plain' }),
      applyParty: () => undefined,
      partyId: () => null,
    });
    s.bind();
    await s.request({ userId: 'u-new' });
    rt.emit('party_invite_declined', { by: { userId: 'u-dec', name: 'DeclinerName', tag: '0005' } });
    expect(toastTitles()).toContain(`Request sent to ${maskedName('u-new')}`);
    expect(toastTitles()).toContain(`${maskedName('u-dec')} can't join right now`);
    expect(toastTitles().join()).not.toMatch(/NewName|DeclinerName/);
  });
});

describe('/mute by the masked label', () => {
  it('finds a stranger by the name Streamer Mode shows and confirms with it', () => {
    social.getState().pushChat({
      id: 'g1',
      from: { userId: 'u-x', name: 'RealName', tag: '4242', key: 'u-x' },
      text: 'hi',
      at: 1,
    });
    social.getState().pushChat({
      id: 's1',
      room: 'show',
      from: { userId: 'u-y', name: 'SeatName', key: 'u-y' },
      text: 'gg',
      at: 2,
      seat: 6,
    });
    expect(findMuteKey(maskedName('u-x').toLowerCase())).toEqual({ key: 'u-x', name: maskedName('u-x') });
    expect(findMuteKey('Tumbler 7')).toEqual({ key: 'u-y', name: 'Tumbler 7' });
    expect(findMuteKey('RealName')).toEqual({ key: 'u-x', name: 'RealName' });
    streamer(false);
    expect(findMuteKey(maskedName('u-x'))).toBeNull();
  });
});
