/**
 * Every previewable screen/state, deep-linkable as `ui.html?screen=<id>`.
 */
import { openNewsPost, ui, type MenuTab } from '@tumble/ui';
import { hudForRound, stopAutoplay } from './autoplay.ts';
import {
  SHOW_NAME,
  SHOW_ROUNDS,
  aliveAt,
  makeBetween,
  makeResults,
  makeRewards,
  roundIntro,
} from './mocks.ts';
import { resetTransient, world } from './world.ts';

/** A preview preset. */
export interface Preset {
  id: string;
  label: string;
  group: 'First launch' | 'Menu' | 'Show flow' | 'In round' | 'End of show' | 'Overlays & system';
  apply: () => void;
}

const s = () => ui.getState();

function menu(tab: MenuTab): () => void {
  return () => {
    s().setCurrencyPanel('none');
    s().setInspectedProfile(null);
    s().setScreen('menu', { transition: 'none' });
    s().setMenuTab(tab);
  };
}

function round(kind: 'race' | 'survival' | 'team' | 'hunt' | 'final'): void {
  const players = world.players;
  const local = players.find((p) => p.isLocal);
  const base = { race: 0, survival: 2, team: 0, hunt: 0, final: 3 }[kind];
  const intro = roundIntro(base);
  s().setRoundIntro(intro);
  s().resetHud(
    hudForRound(
      kind,
      kind === 'final' ? 7 : 40,
      kind === 'final' ? 1 : 26,
      120,
      local,
      kind === 'team'
        ? 'Hoard the most eggs!'
        : kind === 'hunt'
          ? 'Hold a tail when time runs out!'
          : intro.objective,
    ),
  );
  const leaders = players
    .filter((p) => !p.isLocal)
    .slice(0, 3)
    .map((p, i) => ({ id: p.id, name: p.name, color: p.colors.primary, progress: 0.82 - i * 0.07 }));
  s().setHud({
    timeLeft: 74,
    qualified: 12,
    alive: 23,
    progress: 0.58,
    leaders,
    controlsHint: true,
    objective: s().hud.objective,
  });
  if (kind === 'team') {
    s().setHud({
      roundType: 'team',
      teams: [
        { name: 'Pink', color: '#ff4f8b', score: 14, isMine: true },
        { name: 'Blue', color: '#3fa9ff', score: 17, isMine: false },
        { name: 'Yellow', color: '#ffd23f', score: 9, isMine: false },
      ],
    });
  }
  if (kind === 'hunt') {
    s().setHud({
      roundType: 'hunt',
      timeLeft: 8,
      teams: [
        { name: 'Tails held', color: '#ff4f9a', score: 11, isMine: true },
        { name: 'Tail-less', color: '#8a5cff', score: 18, isMine: false },
      ],
    });
  }
  if (kind === 'final') s().setHud({ qualified: 0, timeLeft: 25 });
  s().setScreen('round', { transition: 'none' });
}

function feedToasts(): void {
  for (const p of world.players.slice(3, 6))
    s().pushToast({
      title: `${p.name} qualified!`,
      icon: '🏁',
      variant: 'feed',
      color: p.colors.primary,
      durationMs: 60000,
    });
}

/** All presets in dev-menu order. */
export const PRESETS: Preset[] = [
  {
    id: 'boot',
    label: 'Boot loader',
    group: 'First launch',
    apply: () => (
      s().setBoot({ progress: 0.62, label: '', error: undefined }),
      s().setScreen('boot', { transition: 'none' })
    ),
  },
  {
    id: 'bootError',
    label: 'Boot error',
    group: 'First launch',
    apply: () => (
      s().setBoot({ progress: 0.4, error: 'WebGL2 is switched off in this browser.' }),
      s().setScreen('boot', { transition: 'none' })
    ),
  },
  {
    id: 'splash',
    label: 'Click-to-start splash',
    group: 'First launch',
    apply: () => s().setScreen('splash', { transition: 'none' }),
  },
  {
    id: 'welcome',
    label: 'Welcome (name + colour)',
    group: 'First launch',
    apply: () => s().setScreen('welcome', { transition: 'none' }),
  },
  {
    id: 'tutorialPrompt',
    label: 'Tutorial prompt',
    group: 'First launch',
    apply: () => s().setScreen('tutorialPrompt', { transition: 'none' }),
  },

  { id: 'menu', label: 'Main menu · Play', group: 'Menu', apply: menu('play') },
  { id: 'locker', label: 'Locker', group: 'Menu', apply: menu('locker') },
  { id: 'store', label: 'Store', group: 'Menu', apply: menu('store') },
  { id: 'pass', label: 'Season Pass', group: 'Menu', apply: menu('pass') },
  { id: 'challenges', label: 'Challenges', group: 'Menu', apply: menu('challenges') },
  { id: 'profile', label: 'Profile', group: 'Menu', apply: menu('profile') },
  { id: 'leaderboards', label: 'Leaderboards', group: 'Menu', apply: menu('leaderboards') },
  { id: 'news', label: 'News', group: 'Menu', apply: menu('news') },
  {
    id: 'newsReader',
    label: 'News · post reader',
    group: 'Menu',
    apply: () => {
      const first = s().news[0];
      if (first) openNewsPost(first.id);
      s().setScreen('menu', { transition: 'none' });
      ui.setState({ menuTab: 'news' });
    },
  },
  {
    id: 'modeOffline',
    label: 'Play · servers offline',
    group: 'Menu',
    apply: () => {
      s().setOnlineStatus({ state: 'offline', message: 'The game servers are offline right now.' });
      ui.setState({ playMode: 'offline' });
      menu('play')();
    },
  },
  {
    id: 'gumballs',
    label: 'Wallet · Earn Gumballs',
    group: 'Menu',
    apply: () => (menu('play')(), s().setCurrencyPanel('gumballs')),
  },
  {
    id: 'gems',
    label: 'Wallet · Gems (coming soon)',
    group: 'Menu',
    apply: () => (menu('play')(), s().setCurrencyPanel('gems')),
  },
  {
    id: 'inspectProfile',
    label: 'Ranks · another player card',
    group: 'Menu',
    apply: () => {
      menu('leaderboards')();
      const row = s().leaderboards.crowns?.[0];
      const me = s().profile;
      if (row && me)
        s().setInspectedProfile({
          ...me,
          id: row.playerId,
          name: row.name,
          colors: row.colors,
          crowns: row.value,
          isGuest: false,
          showcase: [],
        });
    },
  },
  {
    id: 'matchHistory',
    label: 'Match history',
    group: 'Menu',
    apply: () => s().setScreen('matchHistory', { transition: 'none' }),
  },
  {
    id: 'partyMember',
    label: 'Menu as party member (Ready)',
    group: 'Menu',
    apply: () => {
      const party = s().party;
      if (party)
        s().setParty({
          ...party,
          members: party.members.map((m, i) => ({ ...m, isLeader: i === 1, ready: false })),
        });
      menu('play')();
    },
  },
  {
    id: 'customLobby',
    label: 'Private show (setup)',
    group: 'Menu',
    apply: () => {
      s().setCustomLobby(null);
      menu('play')();
      s().setOverlay('privateShow');
    },
  },
  {
    id: 'customLobbyHost',
    label: 'Private show (hosting)',
    group: 'Menu',
    apply: () => {
      s().setCustomLobby({
        code: 'GOO42X',
        isHost: true,
        players: world.players
          .slice(0, 11)
          .map((p) => ({ id: String(p.id), name: p.name, colors: p.colors })),
        options: {
          rounds: [...SHOW_ROUNDS],
          bots: true,
          maxPlayers: 40,
          timerScale: 1,
          spectators: true,
          isPrivate: true,
        },
      });
      menu('play')();
      s().setOverlay('privateShow');
    },
  },

  {
    id: 'matchmaking',
    label: 'Matchmaking',
    group: 'Show flow',
    apply: () => {
      s().setMenuTab('play');
      s().setQueue({
        status: 'searching',
        startedAt: Date.now() - 14000,
        playersFound: 27,
        playersNeeded: 40,
        etaSec: 12,
        region: 'EU West',
      });
      s().setScreen('matchmaking', { transition: 'none' });
    },
  },
  {
    id: 'matchFound',
    label: 'Match found burst',
    group: 'Show flow',
    apply: () => s().setScreen('matchFound', { transition: 'none' }),
  },
  {
    id: 'preShow',
    label: 'Pre-show lobby',
    group: 'Show flow',
    apply: () => {
      s().setPreShow({
        showName: SHOW_NAME,
        roundCount: SHOW_ROUNDS.length,
        playersJoined: 32,
        maxPlayers: 40,
        startsAt: Date.now() + 18000,
        joinFeed: world.players.slice(0, 32).map((p) => p.name),
      });
      s().setScreen('preShow', { transition: 'none' });
    },
  },
  {
    id: 'showIntro',
    label: 'Show intro card',
    group: 'Show flow',
    apply: () => (
      s().setShowIntro({ showName: SHOW_NAME, roundIndex: 0, roundCount: SHOW_ROUNDS.length }),
      s().setScreen('showIntro', { transition: 'none' })
    ),
  },
  {
    id: 'roundLoading',
    label: 'Round loading',
    group: 'Show flow',
    apply: () => (
      s().setRoundIntro(roundIntro(1)),
      s().setRoundLoading(null),
      s().setRoundLoading({ progress: 0.42 }),
      s().setScreen('roundLoading', { transition: 'none' })
    ),
  },
  {
    id: 'roundLoadingWaiting',
    label: 'Round loading: waiting for players',
    group: 'Show flow',
    apply: () => (
      s().setRoundIntro(roundIntro(1)),
      s().setRoundLoading({
        progress: 1,
        ready: true,
        loaded: 23,
        total: 26,
        waiting: world.players.filter((p) => !p.isLocal).slice(0, 3),
        everyoneIn: false,
      }),
      s().setScreen('roundLoading', { transition: 'none' })
    ),
  },
  {
    id: 'roundIntro',
    label: 'Flyover title card',
    group: 'Show flow',
    apply: () => (s().setRoundIntro(roundIntro(0)), s().setScreen('roundIntro', { transition: 'none' })),
  },
  {
    id: 'roundIntroFinal',
    label: 'Flyover title card (final)',
    group: 'Show flow',
    apply: () => (s().setRoundIntro(roundIntro(3)), s().setScreen('roundIntro', { transition: 'none' })),
  },
  {
    id: 'rules',
    label: 'Rules card',
    group: 'Show flow',
    apply: () => (s().setRoundIntro(roundIntro(0)), s().setScreen('rules', { transition: 'none' })),
  },
  {
    id: 'finalHype',
    label: 'FINAL ROUND hype',
    group: 'Show flow',
    apply: () => (
      s().setFinalHype({ roundName: 'Crown Climb', finalists: aliveAt(world.winSummary, 3) }),
      s().setScreen('finalHype', { transition: 'none' })
    ),
  },

  {
    id: 'countdown',
    label: '3-2-1-GO',
    group: 'In round',
    apply: () => {
      round('race');
      s().setHud({ timeLeft: 120, qualified: 0, progress: 0, leaders: [] });
      let n = 3;
      s().setCountdown(n);
      const id = window.setInterval(() => {
        n--;
        if (n > 0) s().setCountdown(n);
        else {
          s().setCountdown(null);
          s().showStamp('go');
          window.clearInterval(id);
        }
      }, 1000);
    },
  },
  { id: 'round', label: 'HUD · race', group: 'In round', apply: () => (round('race'), feedToasts()) },
  { id: 'hudSurvival', label: 'HUD · survival', group: 'In round', apply: () => round('survival') },
  { id: 'hudTeam', label: 'HUD · team scores', group: 'In round', apply: () => round('team') },
  { id: 'hudHunt', label: 'HUD · hunt (10 s left)', group: 'In round', apply: () => round('hunt') },
  { id: 'hudFinal', label: 'HUD · final', group: 'In round', apply: () => round('final') },
  {
    id: 'hudOvertime',
    label: 'HUD · overtime',
    group: 'In round',
    apply: () => (round('race'), s().setHud({ timeLeft: 0, overtime: true })),
  },
  {
    id: 'emoteWheel',
    label: 'Emote wheel',
    group: 'In round',
    apply: () => (round('race'), s().setEmoteWheel(true)),
  },
  {
    id: 'touch',
    label: 'Mobile touch layout',
    group: 'In round',
    apply: () => (s().setTouch(true), round('race'), s().setHud({ device: 'touch' })),
  },
  {
    id: 'qualified',
    label: 'QUALIFIED! stamp',
    group: 'In round',
    apply: () => (round('race'), s().setHud({ localStatus: 'qualified' }), s().showStamp('qualified')),
  },
  {
    id: 'eliminated',
    label: 'ELIMINATED + choice sheet',
    group: 'In round',
    apply: () => {
      round('race');
      s().setHud({ localStatus: 'eliminated' });
      s().showStamp('eliminated');
      window.setTimeout(() => s().setEliminatedSheet(true), 2300);
    },
  },
  {
    id: 'spectating',
    label: 'Spectating banner',
    group: 'In round',
    apply: () => {
      round('race');
      const p = world.players[5];
      s().setHud({ localStatus: 'spectating', controlsHint: false });
      if (p) s().setSpectate({ player: p, detail: '2nd place', qualified: true, index: 1, count: 24 });
    },
  },
  {
    id: 'roundOver',
    label: 'ROUND OVER stamp',
    group: 'In round',
    apply: () => (round('race'), s().showStamp('roundOver')),
  },
  {
    id: 'timeUp',
    label: "TIME'S UP stamp",
    group: 'In round',
    apply: () => (round('survival'), s().showStamp('timeUp')),
  },
  {
    id: 'teamStamps',
    label: 'TEAM WINS / TEAM OUT stamps',
    group: 'In round',
    apply: () => (round('team'), s().showStamp('teamWin'), s().showStamp('teamLose')),
  },
  {
    id: 'captions',
    label: 'Announcer caption',
    group: 'In round',
    apply: () => (
      round('race'),
      s().updateSettings('accessibility', { captions: true }),
      s().setCaption('Halfway there — the hammers are getting grumpy!')
    ),
  },

  {
    id: 'roundResults',
    label: 'Round results grid',
    group: 'End of show',
    apply: () => (
      s().setResults(makeResults(world.winSummary, 0)),
      s().setScreen('roundResults', { transition: 'none' })
    ),
  },
  {
    id: 'roundResultsOut',
    label: 'Round results (you’re out)',
    group: 'End of show',
    apply: () => (
      s().setResults(makeResults(world.loseSummary, 1)),
      s().setScreen('roundResults', { transition: 'none' })
    ),
  },
  {
    id: 'betweenRounds',
    label: 'Between rounds',
    group: 'End of show',
    apply: () => (
      s().setBetweenRounds(makeBetween(0)),
      s().setScreen('betweenRounds', { transition: 'none' })
    ),
  },
  {
    id: 'betweenRoundsFinal',
    label: 'Between rounds (final next)',
    group: 'End of show',
    apply: () => (
      s().setBetweenRounds(makeBetween(2)),
      s().setScreen('betweenRounds', { transition: 'none' })
    ),
  },
  {
    id: 'victory',
    label: 'Victory',
    group: 'End of show',
    apply: () => {
      const winner = world.winSummary.players.find((p) => p.id === world.winSummary.winnerId);
      if (winner)
        s().setVictory({ winner, isLocalWinner: true, crownsBefore: 4, crownsAfter: 5, showName: SHOW_NAME });
      s().setScreen('victory', { transition: 'none' });
    },
  },
  {
    id: 'winnerCam',
    label: 'Winner cam (someone else)',
    group: 'End of show',
    apply: () => {
      const winner = world.loseSummary.players.find((p) => p.id === world.loseSummary.winnerId);
      if (winner)
        s().setVictory({
          winner,
          isLocalWinner: false,
          crownsBefore: 4,
          crownsAfter: 4,
          showName: SHOW_NAME,
        });
      s().setScreen('winnerCam', { transition: 'none' });
    },
  },
  {
    id: 'playerWall',
    label: 'PLAYER WALL (you win)',
    group: 'End of show',
    apply: () => (
      s().setPlayerWall(world.winSummary, { render3D: false, autoContinueMs: 0 }),
      s().setRewards(makeRewards(world.items, true)),
      s().setScreen('playerWall', { transition: 'none' })
    ),
  },
  {
    id: 'playerWallLose',
    label: 'PLAYER WALL (you’re out R2)',
    group: 'End of show',
    apply: () => (
      s().setPlayerWall(world.loseSummary, { render3D: false, autoContinueMs: 0 }),
      s().setRewards(makeRewards(world.items, false, 1)),
      s().setScreen('playerWall', { transition: 'none' })
    ),
  },
  {
    id: 'playerWall3d',
    label: 'PLAYER WALL (overlay only / 3D mode)',
    group: 'End of show',
    apply: () => (
      s().setPlayerWall(world.winSummary, { render3D: true, autoContinueMs: 0 }),
      s().setScreen('playerWall', { transition: 'none' })
    ),
  },
  {
    id: 'rewards',
    label: 'Rewards (won, level up)',
    group: 'End of show',
    apply: () => (
      s().setRewards(makeRewards(world.items, true)),
      s().setScreen('rewards', { transition: 'none' })
    ),
  },
  {
    id: 'rewardsLose',
    label: 'Rewards (no crown)',
    group: 'End of show',
    apply: () => (
      s().setRewards(makeRewards(world.items, false, 1)),
      s().setScreen('rewards', { transition: 'none' })
    ),
  },

  {
    id: 'settings',
    label: 'Settings',
    group: 'Overlays & system',
    apply: () => (menu('play')(), s().setOverlay('settings')),
  },
  {
    id: 'friends',
    label: 'Friends & party',
    group: 'Overlays & system',
    apply: () => (menu('play')(), s().setOverlay('friends')),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    group: 'Overlays & system',
    apply: () => (menu('play')(), s().setOverlay('notifications')),
  },
  {
    id: 'reconnecting',
    label: 'Reconnecting overlay',
    group: 'Overlays & system',
    apply: () => (round('race'), s().setConnection({ status: 'reconnecting', attempt: 2, maxAttempts: 5 })),
  },
  {
    id: 'errorDialog',
    label: 'Error / disconnect dialog',
    group: 'Overlays & system',
    apply: () => {
      menu('play')();
      s().showDialog({
        id: 'disconnect',
        kind: 'error',
        title: 'Connection lost',
        body: 'The show went on without you. Your progress from completed rounds is safe.',
        code: 'E-NET-04',
        buttons: [
          { id: 'menu', label: 'Back to menu', variant: 'secondary' },
          { id: 'retry', label: 'Retry', autofocus: true },
        ],
      });
    },
  },
  {
    id: 'confirmDialog',
    label: 'Confirm dialog',
    group: 'Overlays & system',
    apply: () => (
      menu('play')(),
      s().showDialog({
        id: 'leave',
        kind: 'confirm',
        title: 'Leave the show?',
        body: 'You’ll forfeit this show’s rewards. Your Tumbler will be sad.',
      })
    ),
  },
  {
    id: 'toasts',
    label: 'Toasts',
    group: 'Overlays & system',
    apply: () => {
      menu('play')();
      s().pushToast({
        kind: 'reward',
        title: 'Challenge complete!',
        body: 'Grab 10 Tumblers · +150 Gumballs',
        durationMs: 0,
      });
      s().pushToast({
        kind: 'social',
        title: 'Sir Wobbleton invited you',
        body: 'Join their party?',
        actions: [
          { id: 'accept', label: 'Join' },
          { id: 'decline', label: 'Nah' },
        ],
        durationMs: 0,
      });
      s().pushToast({ kind: 'success', title: 'Back in the show!', durationMs: 8000 });
    },
  },
  {
    id: 'wipe',
    label: 'Tumble Wipe demo',
    group: 'Overlays & system',
    apply: () => (
      menu('play')(),
      window.setTimeout(() => s().setScreen('menu', { transition: 'wipe' }), 200)
    ),
  },
];

/** Applies a preset by id (stops auto-play, resets transient state). */
export function applyPreset(id: string): boolean {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return false;
  stopAutoplay();
  resetTransient();
  if (id !== 'touch') s().setTouch(window.matchMedia('(pointer: coarse)').matches);
  p.apply();
  const url = new URL(location.href);
  url.searchParams.set('screen', id);
  history.replaceState(null, '', url);
  return true;
}
