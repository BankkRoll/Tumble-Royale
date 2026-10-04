/**
 * Streamer Mode: other real players' names never reach the screen; you, your
 * party and bots keep theirs.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatWidget } from '../src/hud/ChatWidget.tsx';
import { RaceProgress, SpectateBanner } from '../src/hud/widgets.tsx';
import { maskedName, seatName, streamerSafeKeyedName, streamerSafeName } from '../src/names.ts';
import { ShowHostTools } from '../src/screens/overlays/ShowHostTools.tsx';
import { VictoryScreen, WinnerCamScreen } from '../src/screens/Results.tsx';
import { INITIAL_CHAT } from '../src/store/chatChannels.ts';
import { DEFAULT_HUD, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { social } from '../src/store/social.ts';
import { ui } from '../src/store/uiStore.ts';
import type { CustomLobbyMember, CustomLobbyState, ShowPlayer } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(social as unknown as { getInitialState: () => unknown }).getInitialState = social.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'plain' as const };
const human: ShowPlayer = { id: 6, name: 'RealPerson99', colors, isBot: false };

function streamer(on: boolean): void {
  const s = ui.getState().settings;
  ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, streamerMode: on } } });
}

describe('streamerSafeName', () => {
  it('masks other real players only', () => {
    expect(streamerSafeName({ id: 4, name: 'Real' }, true)).toBe('Tumbler 5');
    expect(streamerSafeName({ id: 4, name: 'Real' }, false)).toBe('Real');
    expect(streamerSafeName({ id: 4, name: 'Me', isLocal: true }, true)).toBe('Me');
    expect(streamerSafeName({ id: 4, name: 'Pal', isParty: true }, true)).toBe('Pal');
    expect(streamerSafeName({ id: 4, name: 'Sir Wobble', isBot: true }, true)).toBe('Sir Wobble');
  });

  it('uses one seat name for masks and unknown seats, counting from 1', () => {
    expect(seatName(0)).toBe('Tumbler 1');
    expect(seatName(41)).toBe('Tumbler 42');
    expect(streamerSafeName({ id: 41, name: 'Real' }, true)).toBe(seatName(41));
    expect(streamerSafeKeyedName({ key: 'u', name: 'Real', seat: 41 }, true)).toBe(seatName(41));
  });
});

describe('streamer mode on screen', () => {
  afterEach(() =>
    ui.setState({ settings: DEFAULT_SETTINGS, hud: DEFAULT_HUD, victory: null, spectate: null }),
  );

  it('race leader tooltips hide real players but keep bots', () => {
    streamer(true);
    ui.setState({
      hud: {
        ...DEFAULT_HUD,
        roundType: 'race',
        leaders: [
          { id: 2, name: 'RealPerson99', color: '#fff', progress: 0.8 },
          { id: 3, name: 'Sir Wobble', color: '#fff', progress: 0.7, isBot: true },
        ],
      },
    });
    const html = renderToStaticMarkup(<RaceProgress />);
    expect(html).not.toContain('RealPerson99');
    expect(html).toContain('title="Tumbler 3"');
    expect(html).toContain('title="Sir Wobble"');
  });

  it('the winner banners hide a real winner', () => {
    streamer(true);
    ui.setState({
      victory: { winner: human, isLocalWinner: false, crownsBefore: 0, crownsAfter: 0, showName: 'Show' },
    });
    expect(renderToStaticMarkup(<WinnerCamScreen />)).not.toContain('RealPerson99');
    expect(renderToStaticMarkup(<VictoryScreen />)).not.toContain('RealPerson99');
  });

  it('the spectate banner hides the watched player', () => {
    streamer(true);
    ui.setState({ spectate: { player: human, detail: 'In the lead', qualified: false, index: 0, count: 3 } });
    const html = renderToStaticMarkup(<SpectateBanner />);
    expect(html).not.toContain('RealPerson99');
    expect(html).toContain('Tumbler 7');
  });
});

describe('streamer mode for players known by account', () => {
  const member = (id: string, name: string, over: Partial<CustomLobbyMember> = {}): CustomLobbyMember => ({
    id,
    name,
    colors,
    isHost: false,
    isSelf: false,
    ready: true,
    away: false,
    ...over,
  });
  const started = (): CustomLobbyState => ({
    code: 'QWERTY',
    isHost: true,
    started: true,
    players: [member('u-me', 'MyOwnName', { isHost: true, isSelf: true }), member('u-x', 'RealPerson99')],
    spectators: [member('u-pal', 'MyFriend')],
    options: {
      rounds: ['r'],
      bots: true,
      maxPlayers: 12,
      timerScale: 1,
      spectators: true,
      spectatorSlots: 2,
      countdownSec: 15,
      minPlayers: 1,
      isPrivate: true,
    },
    locked: false,
    banned: [],
  });

  afterEach(() => {
    ui.setState({ settings: DEFAULT_SETTINGS, customLobby: null, friends: [] });
    social.setState({ chat: INITIAL_CHAT });
  });

  it('masks a stranger with a stable number per account', () => {
    expect(maskedName('u-x')).toBe(maskedName('u-x'));
    expect(maskedName('u-x')).toMatch(/^Tumbler [1-9]\d\d$/);
    expect(maskedName('u-x')).not.toBe(maskedName('u-y'));
    const p = { key: 'u-x', name: 'RealPerson99' };
    expect(streamerSafeKeyedName(p, false)).toBe('RealPerson99');
    expect(streamerSafeKeyedName(p, true)).toBe(maskedName('u-x'));
    expect(streamerSafeKeyedName({ ...p, seat: 4 }, true)).toBe('Tumbler 5');
    expect(streamerSafeKeyedName({ ...p, known: true }, true)).toBe('RealPerson99');
    expect(streamerSafeKeyedName({ ...p, isBot: true }, true)).toBe('RealPerson99');
  });

  it('host tools hide strangers but keep friends', () => {
    streamer(true);
    ui.setState({
      customLobby: started(),
      friends: [{ id: 'u-pal', name: 'MyFriend', tag: '0001', presence: 'inShow', colors }],
    });
    const html = renderToStaticMarkup(<ShowHostTools />);
    expect(html).not.toContain('RealPerson99');
    expect(html).toContain(maskedName('u-x'));
    expect(html).toContain('MyFriend');
  });

  it('show chat masks the sender as their seat, and keeps self and bots', () => {
    streamer(true);
    social.getState().dispatchChat({ type: 'room', room: 'show', access: 'write' });
    const at = Date.now();
    social.getState().pushChat({
      id: 'a',
      room: 'show',
      from: { userId: 'u-x', name: 'RealPerson99', key: 'u-x' },
      text: 'hi',
      at,
      seat: 6,
    });
    social.getState().pushChat({
      id: 'b',
      room: 'show',
      from: { name: 'Sir Wobble', key: 'name:Sir Wobble', isBot: true },
      text: 'gg',
      at,
      seat: 2,
    });
    social.getState().pushChat({
      id: 'c',
      room: 'show',
      from: { userId: 'u-me', name: 'MyOwnName', key: 'u-me' },
      text: 'yo',
      at,
      self: true,
      seat: 0,
    });
    social.getState().dispatchChat({ type: 'open' });
    const html = renderToStaticMarkup(<ChatWidget />);
    expect(html).not.toContain('RealPerson99');
    expect(html).toContain('Tumbler 7');
    expect(html).toContain('Sir Wobble');
    expect(html).toContain('MyOwnName');
  });

  it('menu chat masks strangers by account, tag included', () => {
    social.getState().dispatchChat({ type: 'room', room: 'global', access: 'write' });
    social.getState().pushChat({
      id: 'g',
      from: { userId: 'u-x', name: 'RealPerson99', tag: '1234', key: 'u-x' },
      text: 'hello',
      at: Date.now(),
    });
    social.getState().dispatchChat({ type: 'open' });
    expect(renderToStaticMarkup(<ChatWidget />)).toContain('RealPerson99');
    streamer(true);
    const html = renderToStaticMarkup(<ChatWidget />);
    expect(html).not.toContain('RealPerson99');
    expect(html).not.toContain('#1234');
    expect(html).toContain(maskedName('u-x'));
  });
});
