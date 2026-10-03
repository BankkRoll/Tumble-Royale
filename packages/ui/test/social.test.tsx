/**
 * Social UI: chat visibility rules, the chat feed, the friends sheet (online
 * and offline), notification actions, profile actions and the report dialog,
 * server-rendered.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatLayer } from '../src/hud/ChatFeed.tsx';
import { ProfileOverlay } from '../src/screens/menu/ProfileTab.tsx';
import { PlayerMenu, ReportDialog } from '../src/screens/overlays/PlayerActions.tsx';
import { FriendsSheet, NotificationsPanel } from '../src/screens/overlays/SocialSheets.tsx';
import { DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { social, visibleChat, type ChatLine } from '../src/store/social.ts';
import type { ProfileData } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(social as unknown as { getInitialState: () => unknown }).getInitialState = social.getState;

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]|\u{FE0F}/u;
const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };
const PAL = '11111111-1111-4111-8111-111111111111';
const RIVAL = '22222222-2222-4222-8222-222222222222';

function line(over: Partial<ChatLine> & { text: string }): ChatLine {
  return {
    id: Math.random().toString(36).slice(2),
    from: { userId: RIVAL, name: 'Rival', key: RIVAL },
    at: Date.now(),
    ...over,
  };
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));
}

function settings(gameplay: Partial<typeof DEFAULT_SETTINGS.gameplay>): void {
  ui.getState().setSettings({
    ...DEFAULT_SETTINGS,
    gameplay: { ...DEFAULT_SETTINGS.gameplay, ...gameplay },
  });
}

const me: ProfileData = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Sprinkles',
  tag: '1234',
  level: 3,
  xp: 0,
  xpToNext: 100,
  gumballs: 0,
  gems: 0,
  crowns: 0,
  colors,
  isGuest: true,
  stats: { shows: 0, finals: 0, roundsQualified: 0, bestStreak: 0 },
};

beforeEach(() => {
  social.setState({
    availability: 'online',
    incoming: [],
    outgoing: [],
    blocked: [],
    muted: [],
    showChat: [],
    partyChat: [],
    chatEnabled: false,
    chatOpen: false,
    playerMenu: null,
    reportTarget: null,
    search: { query: '', results: [], loading: false },
  });
  settings({});
  ui.getState().setProfile(me);
  ui.getState().setFriends([]);
  ui.getState().setNotifications([]);
  ui.getState().setParty({
    code: 'ABC234',
    maxSize: 4,
    members: [{ id: me.id, name: me.name, colors, ready: true, isLeader: true, isSelf: true }],
  });
});

describe('visibleChat', () => {
  const lines = [
    line({ text: 'oh shit', masked: 'oh ****' }),
    line({ text: 'hi', from: { name: 'Bot Bob', key: 'name:Bot Bob', isBot: true } }),
    line({ text: 'me', self: true, from: { name: 'Sprinkles', key: me.id } }),
  ];
  it('uses the masked text only with the filter on', () => {
    const on = visibleChat(lines, { showChat: true, filter: true, muted: [], blocked: [] });
    const off = visibleChat(lines, { showChat: true, filter: false, muted: [], blocked: [] });
    expect(on[0]!.display).toBe('oh ****');
    expect(off[0]!.display).toBe('oh shit');
  });
  it('"Show chat" off hides everyone but you', () => {
    const v = visibleChat(lines, { showChat: false, filter: true, muted: [], blocked: [] });
    expect(v.map((l) => l.text)).toEqual(['me']);
  });
  it('hides muted keys and blocked accounts', () => {
    const v = visibleChat(lines, { showChat: true, filter: true, muted: ['name:Bot Bob'], blocked: [RIVAL] });
    expect(v.map((l) => l.text)).toEqual(['me']);
  });
});

describe('ChatLayer', () => {
  it('renders masked lines with the filter on and raw ones with it off', () => {
    social.getState().pushShowChat(line({ text: 'what the fuck', masked: 'what the ****' }));
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('what the ****');
    settings({ chatFilter: false });
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('what the fuck');
  });

  it('shows pings, hides other players when chat is off, and offers Enter only when enabled', () => {
    social.getState().pushShowChat(line({ text: 'Go here!', quick: 'ping:go' }));
    let html = renderToStaticMarkup(<ChatLayer />);
    expect(html).toContain('is-ping');
    expect(html).not.toContain('Enter');
    social.getState().setChatEnabled(true);
    ui.getState().setHud({ device: 'keyboard' });
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('Enter');
    settings({ showChat: false });
    html = renderToStaticMarkup(<ChatLayer />);
    expect(html).not.toContain('Go here!');
  });

  it('opens an input when chat is open', () => {
    social.setState({ chatEnabled: true, chatOpen: true });
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('aria-label="Chat message"');
  });
});

describe('FriendsSheet', () => {
  it('offline: explains, offers Retry, and has no dead buttons', () => {
    social.getState().setAvailability('offline');
    const html = renderToStaticMarkup(<FriendsSheet />);
    expect(html).toContain('Friends need the online servers');
    const labels = buttons(html);
    expect(labels).toContain('Retry');
    expect(labels.some((b) => /Invite|Add|Search|Copy|Join/.test(b))).toBe(false);
  });

  it('online: requests, friends by presence, recent players and blocked', () => {
    social
      .getState()
      .setRequests(
        [{ userId: PAL, name: 'Pal', tag: '0001', at: 1, colors }],
        [{ userId: RIVAL, name: 'Rival', tag: '0002', at: 2, colors }],
      );
    social.getState().setBlocked([{ userId: 'b', name: 'Meanie', tag: '6666' }]);
    ui.getState().setFriends([
      { id: 'f1', name: 'Wobble', tag: '0420', presence: 'inShow', playlist: 'Main Show', colors },
      { id: 'f2', name: 'Bean', tag: '0007', presence: 'inMenu', joinable: true, colors },
      {
        id: 'r1',
        name: 'Stranger',
        tag: '1111',
        presence: 'offline',
        colors,
        recent: true,
        relation: 'none',
      },
      { id: 'f2', name: 'Bean', tag: '0007', presence: 'inMenu', colors, recent: true, relation: 'friend' },
    ]);
    const html = renderToStaticMarkup(<FriendsSheet />);
    const labels = buttons(html);
    expect(html).toContain('Requests · 2');
    expect(labels).toEqual(expect.arrayContaining(['Accept', 'Decline', 'Cancel', 'Join', 'Invite']));
    expect(html).toContain('In a show: Main Show');
    expect(html).toContain('Recent players · 2');
    expect(labels).toContain('Add friend');
    expect(labels.filter((b) => b === 'Profile')).toHaveLength(2);
    expect(html).toContain('Blocked · 1');
    for (const b of labels) expect(b).not.toMatch(EMOJI);
  });

  it('shows party chat once someone joined', () => {
    ui.getState().setParty({
      code: 'ABC234',
      maxSize: 4,
      members: [
        { id: me.id, name: me.name, colors, ready: true, isLeader: true, isSelf: true },
        { id: PAL, name: 'Pal', colors, ready: false, isLeader: false, isSelf: false },
      ],
    });
    social.getState().pushPartyChat(line({ text: 'ready?', from: { userId: PAL, name: 'Pal', key: PAL } }));
    const html = renderToStaticMarkup(<FriendsSheet />);
    expect(html).toContain('data-testid="party-chat"');
    expect(html).toContain('ready?');
  });
});

describe('NotificationsPanel', () => {
  it('offers inline actions until resolved', () => {
    ui.getState().setNotifications([
      {
        id: 'n1',
        kind: 'friendRequest',
        title: 'Pal#0001 wants to be friends',
        time: 1,
        action: { kind: 'friendRequest', userId: PAL },
      },
      {
        id: 'n2',
        kind: 'invite',
        title: 'Pal invited you',
        time: 2,
        action: { kind: 'partyInvite', userId: PAL, code: 'ABC234' },
      },
      {
        id: 'n3',
        kind: 'invite',
        title: 'Old invite',
        time: 0,
        action: { kind: 'partyInvite', userId: PAL, code: 'ZZZ234' },
        resolved: 'Declined',
      },
    ]);
    const html = renderToStaticMarkup(<NotificationsPanel />);
    const labels = buttons(html);
    expect(labels.filter((b) => b === 'Accept')).toHaveLength(1);
    expect(labels.filter((b) => b === 'Join')).toHaveLength(1);
    expect(labels.filter((b) => b === 'Decline')).toHaveLength(2);
    expect(html).toContain('Declined');
  });
});

describe('player actions', () => {
  it('profile overlay: friend, mute, block and report for accounts; only mute offline', () => {
    ui.getState().setInspectedProfile({ ...me, id: RIVAL, name: 'Rival', tag: '0002' });
    let labels = buttons(renderToStaticMarkup(<ProfileOverlay />));
    expect(labels).toEqual(expect.arrayContaining(['Add friend', 'Mute', 'Block', 'Report']));
    social.getState().setAvailability('offline');
    labels = buttons(renderToStaticMarkup(<ProfileOverlay />));
    expect(labels).toContain('Mute');
    expect(labels).not.toContain('Report');
    ui.getState().setInspectedProfile(me);
    expect(buttons(renderToStaticMarkup(<ProfileOverlay />))).not.toContain('Mute');
  });

  it('player menu reflects mute/block state', () => {
    social.getState().setMuted([RIVAL]);
    social.getState().setBlocked([{ userId: RIVAL, name: 'Rival', tag: '0002' }]);
    social.getState().openPlayerMenu({ userId: RIVAL, name: 'Rival', tag: '0002', key: RIVAL });
    const labels = buttons(renderToStaticMarkup(<PlayerMenu />));
    expect(labels).toEqual(expect.arrayContaining(['View profile', 'Unmute', 'Unblock', 'Report']));
    expect(labels).not.toContain('Add friend');
  });

  it('report dialog lists every reason and starts disabled', () => {
    social.getState().openReport({ userId: RIVAL, name: 'Rival', key: RIVAL });
    const html = renderToStaticMarkup(<ReportDialog />);
    for (const r of ['Harassment', 'Offensive name', 'Cheating', 'Griefing', 'Spam', 'Something else'])
      expect(html).toContain(r);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send report<\/button>/);
  });
});
