/**
 * Server-renders the live private show lobby for the host and for members,
 * plus the party leader tools, and checks what each of them can see and do.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlayTab } from '../src/screens/menu/PlayTab.tsx';
import { lobbyStartState } from '../src/screens/overlays/PrivateLobby.tsx';
import { PrivateShowDialog } from '../src/screens/overlays/PrivateShow.tsx';
import { ShowHostTools } from '../src/screens/overlays/ShowHostTools.tsx';
import { FriendsSheet } from '../src/screens/overlays/SocialSheets.tsx';
import { social } from '../src/store/social.ts';
import { ui } from '../src/store/uiStore.ts';
import type { CustomLobbyMember, CustomLobbyState, PartyMember } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(social as unknown as { getInitialState: () => unknown }).getInitialState = social.getState;

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

const member = (id: string, over: Partial<CustomLobbyMember> = {}): CustomLobbyMember => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  colors,
  isHost: false,
  isSelf: false,
  ready: false,
  away: false,
  ...over,
});

function lobby(over: Partial<CustomLobbyState> = {}): CustomLobbyState {
  return {
    code: 'QWERTY',
    isHost: true,
    players: [
      member('me', { isHost: true, isSelf: true, ready: true }),
      member('ann', { ready: true }),
      member('bob', { away: true }),
    ],
    spectators: [member('sam')],
    options: {
      rounds: ['r'],
      bots: true,
      maxPlayers: 12,
      timerScale: 1,
      spectators: true,
      spectatorSlots: 2,
      countdownSec: 15,
      minPlayers: 2,
      isPrivate: true,
    },
    locked: false,
    banned: [{ id: 'eve', name: 'Eve' }],
    ...over,
  };
}

const render = (l: CustomLobbyState): string => {
  ui.setState({ customLobby: l });
  return renderToStaticMarkup(<PrivateShowDialog />);
};
const count = (html: string, needle: string): number => html.split(needle).length - 1;
const buttonsText = (html: string): string[] =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    (m[1] ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' '),
  );

beforeEach(() => {
  ui.getState().setRoundCatalog([{ id: 'r', name: 'Gumdrop Gauntlet', type: 'race' }]);
  ui.getState().setOnlineStatus({ state: 'online' });
});

describe('private lobby: host view', () => {
  it('shows host tools on every other member and the ban list', () => {
    const html = render(lobby());
    expect(count(html, 'data-testid="kick"')).toBe(3);
    expect(html).toContain('aria-label="Remove Ann"');
    expect(html).toContain('aria-label="Make Ann the host"');
    // Spectators cannot host, so only the two other players get the crown action.
    expect(count(html, 'the host"')).toBe(2);
    expect(html).not.toContain('aria-label="Remove Me"');
    expect(html).toContain('data-testid="lobby-lock"');
    expect(html).toContain('data-testid="lobby-new-code"');
    expect(html).toContain('data-testid="lobby-banned"');
    expect(html).toContain('aria-label="Let Eve rejoin"');
    expect(html).toContain('Reconnecting');
    expect(html).toContain('role="switch"');
    expect(html).not.toContain('data-testid="lobby-settings"');
    for (const t of buttonsText(html)) expect(t).not.toMatch(EMOJI);
  });

  it('disables Start with a reason until enough players are in', () => {
    const l = lobby({ options: { ...lobby().options, minPlayers: 6 } });
    const html = render(l);
    expect(html).toMatch(
      /data-testid="custom-start"[^>]*disabled=""|disabled=""[^>]*data-testid="custom-start"/,
    );
    expect(html).toContain('Waiting for players: 3/6');
  });

  it('shows the locked state', () => {
    const html = render(lobby({ locked: true }));
    expect(html).toContain('Locked · code joins refused');
    expect(html).toContain('Unlock');
  });
});

describe('private lobby: member view', () => {
  const asMember = (over: Partial<CustomLobbyState> = {}): CustomLobbyState =>
    lobby({
      isHost: false,
      players: [
        member('host', { isHost: true, ready: true }),
        member('me', { isSelf: true }),
        member('ann', { ready: true }),
      ],
      ...over,
    });

  it('shows read-only settings, the crown, and ready/spectate controls without host tools', () => {
    const html = render(asMember());
    expect(html).not.toContain('data-testid="kick"');
    expect(html).not.toContain('data-testid="lobby-lock"');
    expect(html).not.toContain('data-testid="lobby-banned"');
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('data-testid="lobby-settings"');
    expect(html).toContain('Pre-show countdown');
    expect(html).toContain('15s');
    expect(html).toContain('aria-label="Host"');
    expect(html).toContain('data-testid="custom-ready"');
    expect(html).toContain('Ready up');
    expect(html).toContain('data-testid="custom-role"');
    expect(html).not.toContain('data-testid="custom-start"');
    for (const t of buttonsText(html)) expect(t).not.toMatch(EMOJI);
  });

  it('lists spectators separately and offers to play again', () => {
    const html = render(
      asMember({
        players: [member('host', { isHost: true, ready: true })],
        spectators: [member('me', { isSelf: true })],
      }),
    );
    const spectators = html.slice(html.indexOf('data-testid="lobby-spectators"'));
    expect(spectators).toContain('Me');
    expect(html).toContain('Play instead');
    expect(html).not.toContain('data-testid="custom-ready"');
  });

  it('hides the spectate switch when spectating is off', () => {
    const html = render(
      asMember({ spectators: [], options: { ...lobby().options, spectators: false, spectatorSlots: 0 } }),
    );
    expect(html).not.toContain('data-testid="custom-role"');
    expect(html).not.toContain('data-testid="lobby-spectators"');
  });
});

describe('in-show host tools', () => {
  it('let only the host of a started show remove players', () => {
    ui.setState({ customLobby: lobby({ started: true }) });
    const host = renderToStaticMarkup(<ShowHostTools />);
    expect(count(host, 'data-testid="show-kick"')).toBe(3);
    expect(host).toContain('aria-label="Remove Sam"');
    // The lobby dialog no longer shows a started lobby.
    expect(renderToStaticMarkup(<PrivateShowDialog />)).not.toContain('data-testid="lobby-code"');
    ui.setState({ customLobby: lobby({ started: true, isHost: false }) });
    expect(renderToStaticMarkup(<ShowHostTools />)).toBe('');
    ui.setState({ customLobby: lobby() });
    expect(renderToStaticMarkup(<ShowHostTools />)).toBe('');
  });
});

describe('lobbyStartState', () => {
  it('mirrors the server blockers', () => {
    expect(lobbyStartState(lobby())).toEqual({ canStart: true, reason: null, waitingOn: ['Bob'] });
    expect(lobbyStartState(lobby({ options: { ...lobby().options, minPlayers: 4 } })).reason).toBe(
      'Waiting for players: 3/4',
    );
    const solo = lobby({
      players: [member('me', { isHost: true, isSelf: true, ready: true })],
      options: { ...lobby().options, bots: false, minPlayers: 1 },
    });
    expect(lobbyStartState(solo).canStart).toBe(false);
  });
});

describe('party leader tools', () => {
  // Parties only exist online; offline the sheet shows its empty state instead.
  beforeEach(() => social.getState().setAvailability('online'));

  const party = (selfLeads: boolean): PartyMember[] => [
    { id: 'me', name: 'Me', colors, ready: true, isLeader: selfLeads, isSelf: true },
    { id: 'ann', name: 'Ann', colors, ready: false, isLeader: !selfLeads, isSelf: false },
  ];

  it('gives the leader kick badges on the start card and promote/kick in the friends sheet', () => {
    ui.getState().setParty({ code: 'ABCDEF', maxSize: 4, members: party(true) });
    ui.setState({ menuTab: 'play' });
    expect(renderToStaticMarkup(<PlayTab />)).toContain('aria-label="Kick Ann"');
    const sheet = renderToStaticMarkup(<FriendsSheet />);
    expect(sheet).toContain('aria-label="Make Ann party leader"');
    expect(sheet).toContain('aria-label="Kick Ann"');
  });

  it('shows members no leader tools', () => {
    ui.getState().setParty({ code: 'ABCDEF', maxSize: 4, members: party(false) });
    expect(renderToStaticMarkup(<PlayTab />)).not.toContain('data-testid="party-kick"');
    expect(renderToStaticMarkup(<FriendsSheet />)).not.toContain('data-testid="party-promote"');
  });
});
