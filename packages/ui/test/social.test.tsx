/**
 * Social UI: chat visibility rules, the chat feed, the friends sheet (online
 * and offline), notification actions, profile actions and the report dialog,
 * server-rendered.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatWidget } from '../src/hud/ChatWidget.tsx';
import { INITIAL_CHAT } from '../src/store/chatChannels.ts';
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
    chat: INITIAL_CHAT,
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

describe('ChatWidget', () => {
  const ChatLayer = ChatWidget;
  const tabsOf = (html: string) =>
    [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));
  const online = () => social.getState().dispatchChat({ type: 'room', room: 'global', access: 'write' });

  it('restores a half-typed draft when the input mounts again', () => {
    online();
    social.setState({ chatDraft: 'half a thou' });
    social.getState().dispatchChat({ type: 'open' });
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('value="half a thou"');
    social.setState({ chatDraft: '' });
  });

  it('renders masked lines with the filter on and raw ones with it off', () => {
    social.getState().pushChat(line({ text: 'what the fuck', masked: 'what the ****' }));
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('what the ****');
    settings({ chatFilter: false });
    expect(renderToStaticMarkup(<ChatLayer />)).toContain('what the fuck');
  });

  it('shows pings in the collapsed feed and hides other players when chat is off', () => {
    social.getState().pushChat(line({ text: 'Go here!', quick: 'ping:go' }));
    ui.getState().setHud({ device: 'keyboard' });
    let html = renderToStaticMarkup(<ChatLayer />);
    expect(html).toContain('is-ping');
    expect(html).toContain('Enter');
    settings({ showChat: false });
    html = renderToStaticMarkup(<ChatLayer />);
    expect(html).not.toContain('Go here!');
  });

  it('opens on All with "Message everyone" and shows Name#tag lines', () => {
    online();
    social
      .getState()
      .pushChat(
        line({ text: 'hello world', from: { userId: RIVAL, name: 'Rival', tag: '0002', key: RIVAL } }),
      );
    social.getState().dispatchChat({ type: 'open' });
    const html = renderToStaticMarkup(<ChatLayer />);
    expect(tabsOf(html)).toEqual(['All']);
    expect(html).toContain('placeholder="Message everyone"');
    expect(html).toContain('Rival#0002');
    expect(html).toContain('hello world');
    expect(html).toContain('aria-label="Actions for Rival"');
  });

  it('offline: one line explaining chat needs the online servers, no errors', () => {
    social.getState().dispatchChat({ type: 'open' });
    const html = renderToStaticMarkup(<ChatLayer />);
    expect(html).toContain('placeholder="Chat needs the online servers"');
    expect(html).not.toMatch(/System|not allowed|read-only/);
    expect(html).not.toContain('No messages yet');
  });

  it('tabs: Party in a party with an unread dot, Whispers once there is a conversation, no System', () => {
    online();
    const s = social.getState();
    s.dispatchChat({ type: 'party', on: true });
    s.dispatchChat({ type: 'whispers', on: true });
    s.pushChat(line({ text: 'ready?', channel: 'party', from: { userId: PAL, name: 'Pal', key: PAL } }));
    s.dispatchChat({ type: 'open' });
    let html = renderToStaticMarkup(<ChatLayer />);
    expect(tabsOf(html)).toEqual(['All', 'Party']);
    expect(html).toContain('aria-label="1 unread"');
    expect(html).not.toContain('ready?');
    s.pushChat(line({ text: 'psst', channel: 'whisper', from: { userId: PAL, name: 'Pal', key: PAL } }));
    html = renderToStaticMarkup(<ChatLayer />);
    expect(tabsOf(html)).toEqual(['All', 'Party', 'Whispers']);
    for (const t of tabsOf(html)) expect(t).not.toMatch(EMOJI);
  });

  it('System notices show inline in every tab and are never clickable', () => {
    online();
    const s = social.getState();
    s.dispatchChat({ type: 'party', on: true });
    s.pushChat(
      line({ text: 'Pal joined the party', channel: 'system', from: { name: 'System', key: 'system' } }),
    );
    for (const tab of ['all', 'party'] as const) {
      s.dispatchChat({ type: 'open', channel: tab });
      const html = renderToStaticMarkup(<ChatLayer />);
      expect(html).toMatch(/class="tr-chat-line is-system"[^>]*>.*Pal joined the party/);
      expect(html).not.toContain('Actions for System');
    }
  });

  it('colours party mates, marks friends and hides blocked players', () => {
    online();
    ui.getState().setFriends([{ id: PAL, name: 'Pal', tag: '0001', presence: 'inMenu', colors }]);
    ui.getState().setParty({
      code: 'ABC234',
      maxSize: 4,
      members: [
        { id: me.id, name: me.name, colors, ready: true, isLeader: true, isSelf: true },
        { id: PAL, name: 'Pal', tag: '0001', colors, ready: false, isLeader: false, isSelf: false },
      ],
    });
    social.getState().setBlocked([{ userId: RIVAL, name: 'Rival', tag: '0002' }]);
    social
      .getState()
      .pushChat(line({ text: 'from pal', from: { userId: PAL, name: 'Pal', tag: '0001', key: PAL } }));
    social.getState().pushChat(line({ text: 'from rival' }));
    social.getState().dispatchChat({ type: 'open' });
    const html = renderToStaticMarkup(<ChatLayer />);
    expect(html).toContain('is-party-mate');
    expect(html).toContain('tr-chat-friend');
    expect(html).toContain('Actions for Pal (friend)');
    expect(html).toContain('from pal');
    expect(html).not.toContain('from rival');
  });

  it('shows a refusal once as a short hint', () => {
    social.getState().dispatchChat({ type: 'hint', text: 'Slow down a little', at: Date.now() });
    const html = renderToStaticMarkup(<ChatLayer />);
    expect(html.match(/Slow down a little/g)).toHaveLength(1);
    expect(html).toContain('data-testid="chat-hint"');
  });

  it('gamepad quick chat shows preset buttons instead of a text field', () => {
    social.getState().dispatchChat({ type: 'room', room: 'show', access: 'read' });
    social.getState().dispatchChat({ type: 'open', mode: 'quick' });
    const html = renderToStaticMarkup(<ChatLayer />);
    expect(buttons(html)).toEqual(expect.arrayContaining(['Go here!', 'Watch out!', 'GG!', 'Wow!', 'Close']));
    expect(html).not.toContain('aria-label="Chat message"');
  });

  it('labels outgoing whispers', () => {
    social.getState().pushChat(
      line({
        text: 'see you there',
        channel: 'whisper',
        self: true,
        from: { name: 'Sprinkles', key: me.id },
        to: { userId: PAL, name: 'Pal', tag: '0001', key: PAL },
      }),
    );
    settings({ showChat: false });
    const html = renderToStaticMarkup(<ChatLayer />);
    expect(html).toContain('To Pal#0001');
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

  it('moves party chat to the widget and makes members clickable', () => {
    ui.getState().setParty({
      code: 'ABC234',
      maxSize: 4,
      members: [
        { id: me.id, name: me.name, colors, ready: true, isLeader: true, isSelf: true },
        { id: PAL, name: 'Pal', tag: '0001', colors, ready: false, isLeader: false, isSelf: false },
      ],
    });
    const html = renderToStaticMarkup(<FriendsSheet />);
    expect(html).not.toContain('data-testid="party-chat"');
    expect(html).toContain('data-testid="party-chat-open"');
    expect(html).toContain('aria-label="Player card for Pal"');
    expect(html).not.toContain('aria-label="Player card for Sprinkles"');
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

  it('player card for a friend in your party, as leader: whisper, promote, kick', () => {
    ui.getState().setFriends([{ id: PAL, name: 'Pal', tag: '0001', presence: 'inMenu', colors }]);
    ui.getState().setParty({
      code: 'ABC234',
      maxSize: 4,
      members: [
        { id: me.id, name: me.name, colors, ready: true, isLeader: true, isSelf: true },
        { id: PAL, name: 'Pal', tag: '0001', colors, ready: false, isLeader: false, isSelf: false },
      ],
    });
    social.getState().openPlayerMenu({ userId: PAL, name: 'Pal', key: PAL });
    const html = renderToStaticMarkup(<PlayerMenu />);
    const labels = buttons(html);
    expect(html).toContain('#0001');
    expect(html).toContain('In the menu');
    expect(labels).toEqual(
      expect.arrayContaining([
        'View profile',
        'Whisper',
        'Make leader',
        'Kick from party',
        'Mute',
        'Block',
        'Report',
      ]),
    );
    expect(labels).not.toContain('Add friend');
    expect(labels).not.toContain('Invite to party');
    for (const b of labels) expect(b).not.toMatch(EMOJI);
  });

  it('player card for a joinable friend offers Join and Invite; strangers get Add friend', () => {
    ui.getState().setFriends([
      { id: PAL, name: 'Pal', tag: '0001', presence: 'inMenu', joinable: true, colors },
    ]);
    social.getState().openPlayerMenu({ userId: PAL, name: 'Pal', key: PAL });
    expect(buttons(renderToStaticMarkup(<PlayerMenu />))).toEqual(
      expect.arrayContaining(['Join party', 'Invite to party', 'Whisper']),
    );
    social.getState().openPlayerMenu({ userId: RIVAL, name: 'Rival', key: RIVAL });
    let labels = buttons(renderToStaticMarkup(<PlayerMenu />));
    expect(labels).toContain('Add friend');
    expect(labels).not.toContain('Whisper');
    social.getState().setRequests([{ userId: RIVAL, name: 'Rival', tag: '0002', at: 1, colors }], []);
    labels = buttons(renderToStaticMarkup(<PlayerMenu />));
    expect(labels).toContain('Accept friend');
  });

  it('report dialog lists every reason and starts disabled', () => {
    social.getState().openReport({ userId: RIVAL, name: 'Rival', key: RIVAL });
    const html = renderToStaticMarkup(<ReportDialog />);
    for (const r of ['Harassment', 'Offensive name', 'Cheating', 'Griefing', 'Spam', 'Something else'])
      expect(html).toContain(r);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send report<\/button>/);
  });
});
