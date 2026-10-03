/**
 * Renders the current screen with its entrance animation, emits `screenShown`,
 * requests the screen's music and sets initial focus for gamepad players.
 */
import { useEffect, useRef, type JSX } from 'react';
import { playMusic } from '../audio-cues.ts';
import { focusInitial } from '../nav/navigation.ts';
import { SCREEN_MUSIC } from '../store/defaults.ts';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import type { ScreenId } from '../store/types.ts';
import { CustomLobbyScreen, MatchHistoryScreen } from './CustomLobby.tsx';
import { BootScreen, SplashScreen, TutorialPromptScreen, WelcomeScreen } from './FirstLaunch.tsx';
import { MainMenu } from './menu/MainMenu.tsx';
import { PlayerWallScreen } from './PlayerWall.tsx';
import {
  BetweenRoundsScreen,
  FinalHypeScreen,
  RoundResultsScreen,
  VictoryScreen,
  WinnerCamScreen,
} from './Results.tsx';
import { RewardsScreen } from './Rewards.tsx';
import {
  MatchFoundScreen,
  PreShowScreen,
  RoundIntroScreen,
  RoundLoadingScreen,
  RulesScreen,
  ShowIntroScreen,
} from './ShowFlow.tsx';

/**
 * Maps a screen id to its component. `round` renders nothing here; the HUD
 * layer owns it.
 */
export function renderScreen(screen: ScreenId): JSX.Element | null {
  switch (screen) {
    case 'boot':
      return <BootScreen />;
    case 'splash':
      return <SplashScreen />;
    case 'welcome':
      return <WelcomeScreen />;
    case 'tutorialPrompt':
      return <TutorialPromptScreen />;
    case 'menu':
      return <MainMenu />;
    case 'matchmaking':
      return <MainMenu matchmaking />;
    case 'matchFound':
      return <MatchFoundScreen />;
    case 'preShow':
      return <PreShowScreen />;
    case 'showIntro':
      return <ShowIntroScreen />;
    case 'roundLoading':
      return <RoundLoadingScreen />;
    case 'roundIntro':
      return <RoundIntroScreen />;
    case 'rules':
      return <RulesScreen />;
    case 'round':
      return null;
    case 'roundResults':
      return <RoundResultsScreen />;
    case 'betweenRounds':
      return <BetweenRoundsScreen />;
    case 'finalHype':
      return <FinalHypeScreen />;
    case 'victory':
      return <VictoryScreen />;
    case 'winnerCam':
      return <WinnerCamScreen />;
    case 'playerWall':
      return <PlayerWallScreen />;
    case 'rewards':
      return <RewardsScreen />;
    case 'customLobby':
      return <CustomLobbyScreen />;
    case 'matchHistory':
      return <MatchHistoryScreen />;
  }
}

/** Current screen host. */
export function ScreenLayer(): JSX.Element {
  const screen = useUI((s) => s.screen);
  const seq = useUI((s) => s.screenSeq);
  const transition = useUI((s) => s.screenTransition);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = SCREEN_MUSIC[screen];
    if (track) playMusic(track);
    uiEvents.emit('screenShown', { screen });
    const root = hostRef.current?.closest<HTMLElement>('.tr-root');
    // Let entrance animations place elements before measuring focus targets.
    const id = window.setTimeout(() => root && focusInitial(root), 120);
    return () => window.clearTimeout(id);
  }, [screen, seq]);

  // `matchmaking` and `menu` share a key so entering the queue doesn't remount the menu.
  const key = screen === 'matchmaking' ? 'menu' : screen;
  return (
    <div ref={hostRef} key={key} className={`tr-screen-host is-${transition}`} data-screen={screen}>
      {renderScreen(screen)}
    </div>
  );
}
