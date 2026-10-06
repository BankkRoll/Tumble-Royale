/**
 * Streamer Mode leak regressions in the menus: the friends sheet, the player
 * card opened from a masked name, the profile card it leads to, club join
 * requests, the leaderboard podium and the highlight titles.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { maskedName, MASKED_TAG, streamerSafeAccount, streamerSafeAccountLabel } from '../src/names.ts';
import { LeaderboardsTab } from '../src/screens/menu/LeaderboardsTab.tsx';
import { ProfileOverlay } from '../src/screens/menu/ProfileTab.tsx';
import { ClubPanel } from '../src/screens/overlays/ClubPanel.tsx';
import { PlayerMenu } from '../src/screens/overlays/PlayerActions.tsx';
import { FriendsSheet } from '../src/screens/overlays/SocialSheets.tsx';
import { INITIAL_CHAT } from '../src/store/chatChannels.ts';
import { clubs } from '../src/store/clubs.ts';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { highlightTitle } from '../src/store/highlights.ts';
import { social } from '../src/store/social.ts';
import type { HighlightEntry, LeaderboardRow, ProfileData } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(social as unknown as { getInitialState: () => unknown }).getInitialState = social.getState;
(clubs as unknown as { getInitialState: () => unknown }).getInitialState = clubs.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'plain' as const };
const PAL = '11111111-1111-4111-8111-111111111111';

function streamer(on: boolean): void {
  ui.getState().setSettings({
    ...DEFAULT_SETTINGS,
    gameplay: { ...DEFAULT_SETTINGS.gameplay, streamerMode: on },
  });
}

beforeEach(() => {
  streamer(false);
  ui.setState({ friends: [], party: null, inspectedProfile: null });
  social.setState({
    availability: 'online',
    chat: INITIAL_CHAT,
    incoming: [],
    outgoing: [],
    blocked: [],
    playerMenu: null,
  });
  clubs.getState().reset();
  clubs.getState().setSection('friends');
});

describe('streamerSafeAccount', () => {
  it('masks name and tag while streaming and leaves them alone otherwise', () => {
    const p = { userId: 'u-1', name: 'RealName', tag: '4242' };
    expect(streamerSafeAccount(p, false)).toEqual({ name: 'RealName', tag: '4242', masked: false });
    expect(streamerSafeAccount(p, true)).toEqual({ name: maskedName('u-1'), tag: MASKED_TAG, masked: true });
    expect(streamerSafeAccountLabel(p, false, true)).toBe('RealName#4242');
    expect(streamerSafeAccountLabel(p, true, true)).toBe(`${maskedName('u-1')}#••••`);
  });
});

describe('friends sheet', () => {
  it('masks friends, recent players, requests and the blocked list', () => {
    ui.setState({
      friends: [
        { id: 'u-f', name: 'FriendName', tag: '1111', presence: 'online', colors },
        { id: 'u-r', name: 'RecentName', tag: '2222', presence: 'offline', colors, recent: true },
      ],
    });
    social.setState({
      incoming: [{ userId: 'u-in', name: 'IncomingName', tag: '3333', at: 0, colors }],
      outgoing: [{ userId: 'u-out', name: 'OutgoingName', tag: '4444', at: 0, colors }],
      blocked: [{ userId: 'u-b', name: 'BlockedName', tag: '5555' }],
    });
    const plain = renderToStaticMarkup(<FriendsSheet />);
    expect(plain).toContain('FriendName');
    expect(plain).toContain('IncomingName');

    streamer(true);
    const html = renderToStaticMarkup(<FriendsSheet />);
    for (const leak of [
      'FriendName',
      'RecentName',
      'IncomingName',
      'OutgoingName',
      '1111',
      '2222',
      '3333',
      '4444',
    ])
      expect(html).not.toContain(leak);
    expect(html).toContain(maskedName('u-f'));
    expect(html).toContain(maskedName('u-in'));
    expect(html).toContain('#••••');
  });
});

describe('player card from a masked name', () => {
  it('does not pull the real tag back in from the friends list', () => {
    streamer(true);
    ui.setState({ friends: [{ id: PAL, name: 'FriendName', tag: '1111', presence: 'online', colors }] });
    social.setState({ playerMenu: { userId: PAL, name: maskedName(PAL), key: PAL, masked: true } });
    const html = renderToStaticMarkup(<PlayerMenu />);
    expect(html).not.toContain('1111');
    expect(html).not.toContain('FriendName');
    expect(html).toContain(maskedName(PAL));
  });

  it('a masked profile card shows the mask and a hidden tag', () => {
    const card: ProfileData = {
      id: PAL,
      name: maskedName(PAL),
      tag: MASKED_TAG,
      masked: true,
      level: 4,
      xp: 0,
      xpToNext: 100,
      gumballs: 0,
      gems: 0,
      crowns: 0,
      colors,
      isGuest: false,
      stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0 },
    };
    ui.setState({ inspectedProfile: card });
    const html = renderToStaticMarkup(<ProfileOverlay />);
    expect(html).toContain(maskedName(PAL));
    expect(html).toContain('#••••');
  });
});

describe('club join requests', () => {
  it('masks the asker in Streamer Mode', () => {
    clubs.getState().setSection('club');
    clubs.getState().setLoaded({
      club: {
        id: 'c-1',
        name: 'Wobble Crew',
        tag: 'WOB',
        description: '',
        emblem: { shape: 'circle', color: '#ff4f9a', icon: 'star' } as never,
        joinMode: 'request',
        memberCount: 1,
        maxMembers: 50,
        members: [],
      },
      role: 'owner',
      joinRequests: [{ userId: 'u-ask', name: 'AskerName', tag: '7777', level: 2, at: 0 }],
      invites: [],
      pending: [],
    });
    clubs.getState().setTab('requests');
    expect(renderToStaticMarkup(<ClubPanel />)).toContain('AskerName');
    streamer(true);
    const html = renderToStaticMarkup(<ClubPanel />);
    expect(html).not.toContain('AskerName');
    expect(html).not.toContain('7777');
    expect(html).toContain(maskedName('u-ask'));
  });
});

describe('leaderboard podium', () => {
  it('masks the top three like the rows below them', () => {
    const row = (rank: number, name: string): LeaderboardRow => ({
      rank,
      playerId: `p-${rank}`,
      name,
      value: 10 - rank,
      colors,
    });
    ui.setState({
      leaderboards: {
        ...ui.getState().leaderboards,
        crowns: [row(1, 'GoldName'), row(2, 'SilverName'), row(3, 'BronzeName')],
      },
    });
    expect(renderToStaticMarkup(<LeaderboardsTab />)).toContain('GoldName');
    streamer(true);
    const html = renderToStaticMarkup(<LeaderboardsTab />);
    for (const leak of ['GoldName', 'SilverName', 'BronzeName']) expect(html).not.toContain(leak);
  });
});

describe('highlight titles', () => {
  it('keep a party mate named in Streamer Mode and mask strangers', () => {
    const h = (isParty: boolean): HighlightEntry => ({
      id: 'h',
      key: 'k',
      roundIndex: 0,
      roundName: 'Crown Climb',
      isFinal: true,
      kind: 'finalWin',
      start: 0,
      length: 5,
      player: { id: 3, name: 'PalName', isBot: false, isLocal: false, ...(isParty ? { isParty: true } : {}) },
      other: null,
      value: 0,
    });
    expect(highlightTitle(h(true), true)).toBe('PalName won the Crown');
    expect(highlightTitle(h(false), true)).toBe('Tumbler 4 won the Crown');
  });
});
