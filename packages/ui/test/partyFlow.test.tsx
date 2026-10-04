/**
 * Party and show-flow UI, server-rendered: what a party member's PLAY does
 * in each mode, who is away playing solo, the Practice Island entries, the
 * one Join dialog for show and party codes, the honest pending rewards
 * screen, and host settings edits that survive pushed lobby updates.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { RewardsScreen } from '../src/screens/Rewards.tsx';
import { PlayTab, partyStatusText } from '../src/screens/menu/PlayTab.tsx';
import { SETTINGS_CONFIRM_MS, reconcileSettingsDraft } from '../src/screens/overlays/PrivateLobby.tsx';
import { JoinCodeDialog } from '../src/screens/overlays/PrivateShow.tsx';
import { Section } from '../src/screens/overlays/SettingsSheet.tsx';
import { FriendsSheet } from '../src/screens/overlays/SocialSheets.tsx';
import { social } from '../src/store/social.ts';
import { ui } from '../src/store/uiStore.ts';
import type { CustomLobbyOptions, PartyMember } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(social as unknown as { getInitialState: () => unknown }).getInitialState = social.getState;

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;
const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };

const mate = (id: string, over: Partial<PartyMember> = {}): PartyMember => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  colors,
  ready: false,
  isLeader: false,
  isSelf: false,
  ...over,
});

function setParty(members: PartyMember[]): void {
  ui.getState().setParty({ code: 'ABCDEF', maxSize: 4, members });
}

const playButton = (html: string): string =>
  /<button[^>]*data-testid="play"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1]?.replace(/<[^>]+>/g, ' ') ?? '';

beforeEach(() => {
  ui.setState({ rewards: null, rewardsPending: null, localReady: false });
  ui.getState().setOnlineStatus({ state: 'online' });
  ui.getState().setPlayMode('online');
  setParty([mate('lead', { isLeader: true, ready: true }), mate('me', { isSelf: true })]);
});

describe('a party member on the Play tab', () => {
  it('readies up for the leader’s online show', () => {
    const btn = playButton(renderToStaticMarkup(<PlayTab />));
    expect(btn).toContain('Ready up');
    expect(btn).toContain('The leader starts the show');
  });

  it('can still play solo vs bots, told they stay in the party', () => {
    ui.getState().setPlayMode('offline');
    const btn = playButton(renderToStaticMarkup(<PlayTab />));
    expect(btn).toContain('Play');
    expect(btn).not.toContain('Ready');
    expect(btn).toContain('Solo vs bots · you stay in the party');
  });

  it('plays solo vs bots when the servers are down, since online is not on offer', () => {
    ui.getState().setOnlineStatus({ state: 'offline', message: 'down' });
    expect(playButton(renderToStaticMarkup(<PlayTab />))).toContain('Solo vs bots');
  });

  it('a leader alone in their party gets the normal Play', () => {
    setParty([mate('me', { isSelf: true, isLeader: true, ready: true })]);
    expect(playButton(renderToStaticMarkup(<PlayTab />))).toContain('Online ·');
  });
});

describe('who is away', () => {
  it('says when the leader is playing solo', () => {
    setParty([
      mate('lead', { isLeader: true, ready: true, playingSolo: true }),
      mate('me', { isSelf: true }),
    ]);
    const html = renderToStaticMarkup(<PlayTab />);
    expect(html).toMatch(/data-testid="party-status"[^>]*>Leader is playing solo</);
  });

  it('names a member playing solo, and never the player themselves', () => {
    const lead = mate('lead', { isLeader: true, isSelf: true, ready: true });
    expect(partyStatusText([lead, mate('bob', { playingSolo: true })])).toBe('Bob is playing solo');
    expect(
      partyStatusText([lead, mate('bob', { playingSolo: true }), mate('cat', { playingSolo: true })]),
    ).toBe('2 members are playing solo');
    expect(partyStatusText([{ ...lead, playingSolo: true }])).toBeNull();
    expect(partyStatusText([lead, mate('bob')])).toBeNull();
  });
});

describe('Practice Island entries', () => {
  it('sits on the start card next to Join with code', () => {
    const html = renderToStaticMarkup(<PlayTab />);
    expect(html).toContain('data-testid="practice-island"');
    expect(html).toContain('Practice Island');
  });

  it('is in Settings → Gameplay', () => {
    const html = renderToStaticMarkup(<Section id="gameplay" />);
    expect(html).toContain('data-testid="settings-practice"');
    expect(html).toContain('Practice Island');
  });
});

describe('one Join dialog for show and party codes', () => {
  it('asks for either kind of code', () => {
    const html = renderToStaticMarkup(<JoinCodeDialog />);
    expect(html).toContain('private show or a party');
    expect(html).toContain('>Join<');
    expect(html).not.toContain('Join show');
  });

  it('stays usable for party codes when only matchmaking is down', () => {
    ui.getState().setOnlineStatus({ state: 'offline', message: 'down' });
    social.getState().setAvailability('online');
    expect(renderToStaticMarkup(<JoinCodeDialog />)).toContain('data-testid="join-code-input"');
    social.getState().setAvailability('offline');
    expect(renderToStaticMarkup(<JoinCodeDialog />)).not.toContain('data-testid="join-code-input"');
  });

  it('the Friends sheet entry says it takes party codes too', () => {
    social.getState().setAvailability('online');
    const html = renderToStaticMarkup(<FriendsSheet />);
    expect(html).toContain('Join a party or show with a code');
  });
});

describe('pending rewards', () => {
  it('says rewards are arriving instead of showing local numbers', () => {
    ui.getState().setRewardsPending('arriving');
    const html = renderToStaticMarkup(<RewardsScreen />);
    expect(html).toContain('data-testid="rewards-arriving"');
    expect(html).toContain('Rewards arriving');
    expect(html).toContain('Back to lobby');
    expect(html).toContain('Play again');
  });

  it('ends with the profile promise when the reward never came', () => {
    ui.getState().setRewardsPending('deferred');
    expect(renderToStaticMarkup(<RewardsScreen />)).toContain('Rewards will appear in your profile');
  });

  it('the real reward replaces the waiting state', () => {
    ui.getState().setRewardsPending('arriving');
    ui.getState().setRewards({
      xpLines: [{ label: 'Show played', xp: 100 }],
      levelFrom: { level: 1, xp: 0, xpToNext: 500 },
      levelTo: { level: 1, xp: 100, xpToNext: 500 },
      gumballs: 20,
      crowns: 0,
      unlocks: [],
    });
    expect(ui.getState().rewardsPending).toBeNull();
    expect(renderToStaticMarkup(<RewardsScreen />)).not.toContain('rewards-arriving');
  });

  it('uses no emoji on its buttons', () => {
    ui.getState().setRewardsPending('deferred');
    const html = renderToStaticMarkup(<RewardsScreen />);
    for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g))
      expect((m[1] ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '')).not.toMatch(EMOJI);
  });
});

describe('host settings draft', () => {
  const pushed: CustomLobbyOptions = {
    rounds: ['a', 'b'],
    bots: true,
    maxPlayers: 20,
    timerScale: 1,
    spectators: true,
    isPrivate: true,
  };
  const T = 1_000_000;

  it('keeps an unsent edit when someone else’s change pushes the lobby', () => {
    const r = reconcileSettingsDraft({ maxPlayers: 30 }, { maxPlayers: null }, pushed, T);
    expect(r.draft).toEqual({ maxPlayers: 30 });
  });

  it('keeps a sent edit while its patch is in flight', () => {
    const r = reconcileSettingsDraft({ maxPlayers: 30 }, { maxPlayers: T }, pushed, T + 200);
    expect(r).toEqual({ draft: { maxPlayers: 30 }, sentAt: { maxPlayers: T } });
  });

  it('drops an edit once the push shows it landed (arrays compared by value)', () => {
    const r = reconcileSettingsDraft(
      { maxPlayers: 20, rounds: ['a', 'b'] },
      { maxPlayers: T, rounds: T },
      pushed,
      T + 100,
    );
    expect(r.draft).toEqual({});
  });

  it('drops a sent edit no push confirmed in time (refused or overridden)', () => {
    const r = reconcileSettingsDraft({ bots: false }, { bots: T }, pushed, T + SETTINGS_CONFIRM_MS);
    expect(r.draft).toEqual({});
  });

  it('settles each key on its own', () => {
    const r = reconcileSettingsDraft(
      { maxPlayers: 20, bots: false, timerScale: 1.5 },
      { maxPlayers: T, bots: null, timerScale: T - SETTINGS_CONFIRM_MS },
      pushed,
      T + 10,
    );
    expect(r.draft).toEqual({ bots: false });
    expect(r.sentAt).toEqual({ bots: null });
  });
});
