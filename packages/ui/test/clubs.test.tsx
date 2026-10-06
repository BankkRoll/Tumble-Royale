/**
 * Club UI, server-rendered: loading, error, switched-off and empty states,
 * discovery and invites, the club page tabs by role, goals, Streamer Mode
 * hiding other players' tags, club tags in the chat widget, and no emoji on
 * any club button.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CLUB_EMBLEM } from '@tumble/shared';
import { ChatWidget } from '../src/hud/ChatWidget.tsx';
import { ClubPanel } from '../src/screens/overlays/ClubPanel.tsx';
import { FriendsSheet } from '../src/screens/overlays/SocialSheets.tsx';
import { INITIAL_CHAT, reduceChat } from '../src/store/chatChannels.ts';
import { clubs, type ClubCardView, type MyClubView } from '../src/store/clubs.ts';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { social } from '../src/store/social.ts';
import type { ProfileData } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(social as unknown as { getInitialState: () => unknown }).getInitialState = social.getState;
(clubs as unknown as { getInitialState: () => unknown }).getInitialState = clubs.getState;

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]|\u{FE0F}/u;
const ME = '99999999-9999-4999-8999-999999999999';
const PAL = '11111111-1111-4111-8111-111111111111';

const profile = (isGuest: boolean): ProfileData => ({
  id: ME,
  name: 'Sprinkles',
  tag: '1234',
  level: 3,
  xp: 0,
  xpToNext: 100,
  gumballs: 0,
  gems: 0,
  crowns: 0,
  colors: { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' },
  isGuest,
  stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0 },
});

const card = (over: Partial<ClubCardView> = {}): ClubCardView => ({
  id: 'c-1',
  name: 'Wobble Crew',
  tag: 'WOB',
  description: 'Daily shows at 8',
  emblem: DEFAULT_CLUB_EMBLEM,
  joinMode: 'open',
  memberCount: 2,
  maxMembers: 50,
  ...over,
});

const myClub = (): MyClubView => ({
  ...card(),
  members: [
    { userId: ME, name: 'Sprinkles', tag: '1234', level: 3, role: 'owner', presence: 'inMenu', isSelf: true },
    { userId: PAL, name: 'Zippy', tag: '0420', level: 5, role: 'member', presence: 'online', isSelf: false },
  ],
});

function settings(gameplay: Partial<typeof DEFAULT_SETTINGS.gameplay>): void {
  ui.getState().setSettings({ ...DEFAULT_SETTINGS, gameplay: { ...DEFAULT_SETTINGS.gameplay, ...gameplay } });
}

const html = () => renderToStaticMarkup(<ClubPanel />);
const buttons = (h: string): string[] =>
  [...h.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));

beforeEach(() => {
  clubs.getState().reset();
  clubs.getState().setSection('club');
  social.setState({ availability: 'online', chat: INITIAL_CHAT, muted: [], blocked: [] });
  settings({});
  ui.getState().setProfile(profile(false));
  ui.getState().setFriends([]);
});

describe('club panel states', () => {
  it('shows loading, error with Retry, and switched off', () => {
    expect(html()).toContain('Loading your club');
    clubs.getState().setStatus('error', 'The server could not be reached.');
    expect(html()).toContain('The server could not be reached.');
    expect(buttons(html())).toContain('Retry');
    clubs.getState().setStatus('disabled');
    expect(html()).toContain('switched off');
  });

  it('without a club: invites, pending requests, discovery and the found button', () => {
    clubs.getState().setLoaded({
      club: null,
      role: null,
      joinRequests: [],
      invites: [{ club: card({ id: 'c-2', name: 'Invite Club', joinMode: 'invite' }), from: null }],
      pending: [card({ id: 'c-3', name: 'Asked Club', joinMode: 'request' })],
    });
    clubs.getState().setDiscovery({ recommended: [card({ id: 'c-4', name: 'Open Club' })] });
    const h = html();
    expect(h).toContain('Invite Club');
    expect(h).toContain('Asked Club');
    expect(h).toContain('Open Club');
    expect(buttons(h)).toEqual(expect.arrayContaining(['Join', 'Decline', 'Cancel request', 'Found a club']));
    expect(h).not.toContain('club-guest-note');
  });

  it('tells guests to link a sign-in and disables founding', () => {
    ui.getState().setProfile(profile(true));
    clubs.getState().setLoaded({ club: null, role: null, joinRequests: [], invites: [], pending: [] });
    const h = html();
    expect(h).toContain('club-guest-note');
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Found a club<\/button>/);
  });
});

describe('club page', () => {
  it('shows officers and owners the Requests tab with its count, members only the rest', () => {
    clubs.getState().setLoaded({
      club: myClub(),
      role: 'owner',
      joinRequests: [{ userId: 'u-r', name: 'Asker', tag: '7777', level: 2, at: 0 }],
      invites: [],
      pending: [],
    });
    let h = html();
    expect(buttons(h)).toEqual(
      expect.arrayContaining(['Roster', 'Chat', 'Goals', 'Requests · 1', 'Settings']),
    );
    expect(buttons(h)).toEqual(expect.arrayContaining(['Party up', 'Manage']));
    expect(h).toContain('[WOB]');

    clubs
      .getState()
      .setLoaded({ club: myClub(), role: 'member', joinRequests: [], invites: [], pending: [] });
    h = html();
    expect(buttons(h).some((b) => b.startsWith('Requests'))).toBe(false);
    expect(buttons(h)).not.toContain('Manage');
  });

  it('Streamer Mode hides other players tags but keeps the own club tag', () => {
    settings({ streamerMode: true });
    clubs.getState().setLoaded({ club: myClub(), role: 'owner', joinRequests: [], invites: [], pending: [] });
    const h = html();
    expect(h).toContain('#••••');
    expect(h).not.toContain('#0420');
    expect(h).toContain('[WOB]');
    clubs.getState().setLoaded({ club: null, role: null, joinRequests: [], invites: [], pending: [] });
    clubs.getState().setDiscovery({ recommended: [card({ id: 'c-9', tag: 'OTHR' })] });
    expect(html()).not.toContain('[OTHR]');
  });

  it('renders goals with progress and Collect only for finished, unclaimed goals the player earned', () => {
    clubs
      .getState()
      .setLoaded({ club: myClub(), role: 'member', joinRequests: [], invites: [], pending: [] });
    clubs.getState().setTab('goals');
    clubs.getState().setGoals({
      status: 'ready',
      data: {
        week: '2026-W40',
        refreshesAt: Date.now() + 2 * 86_400_000,
        eligible: true,
        goals: [
          {
            goalId: 'shows',
            title: 'Play 10 shows',
            progress: 10,
            target: 10,
            completed: true,
            claimed: false,
            reward: { xp: 2000, gumballs: 100 },
          },
          {
            goalId: 'crowns',
            title: 'Win 2 Crowns',
            progress: 1,
            target: 2,
            completed: false,
            claimed: false,
            reward: { xp: 3000, gumballs: 150 },
          },
          {
            goalId: 'qualify',
            title: 'Qualify from 16 rounds',
            progress: 16,
            target: 16,
            completed: true,
            claimed: true,
            reward: { xp: 2500, gumballs: 100 },
          },
        ],
        contributions: [{ userId: PAL, name: 'Zippy', tag: '0420', shows: 4, rounds: 9, crowns: 1 }],
      },
    });
    const h = html();
    expect(buttons(h).filter((b) => b === 'Collect')).toHaveLength(1);
    expect(h).toContain('role="progressbar"');
    expect(h).toContain('Collected');
    expect(h).toContain('4 shows');
  });

  it('puts no emoji on any club button', () => {
    clubs.getState().setLoaded({ club: myClub(), role: 'owner', joinRequests: [], invites: [], pending: [] });
    for (const tab of ['roster', 'chat', 'goals', 'requests', 'settings'] as const) {
      clubs.getState().setTab(tab);
      for (const b of buttons(html())) expect(b).not.toMatch(EMOJI);
    }
  });
});

describe('social sheet and chat', () => {
  it('switches the sheet between friends and the club', () => {
    clubs.getState().setLoaded({ club: myClub(), role: 'owner', joinRequests: [], invites: [], pending: [] });
    expect(renderToStaticMarkup(<FriendsSheet />)).toContain('data-testid="club-page"');
    clubs.getState().setSection('friends');
    expect(renderToStaticMarkup(<FriendsSheet />)).not.toContain('data-testid="club-page"');
  });

  it('shows club tags beside names in chat, hidden for others in Streamer Mode', () => {
    let chat = reduceChat(INITIAL_CHAT, { type: 'room', room: 'global', access: 'write' });
    chat = reduceChat(chat, { type: 'club', on: true });
    chat = reduceChat(chat, {
      type: 'receive',
      line: {
        id: 'c:1',
        channel: 'club',
        from: { userId: PAL, name: 'Zippy', key: PAL, club: 'WOB' },
        text: 'hey',
        at: Date.now(),
      },
    });
    chat = reduceChat(chat, { type: 'open', channel: 'club' });
    social.setState({ chat });
    expect(renderToStaticMarkup(<ChatWidget />)).toContain('[WOB]');
    settings({ streamerMode: true });
    expect(renderToStaticMarkup(<ChatWidget />)).not.toContain('[WOB]');
  });
});
