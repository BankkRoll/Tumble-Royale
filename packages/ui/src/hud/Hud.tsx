/**
 * In-round HUD composition (docs/design/SCREENS.md §9.6). Layout only; each
 * widget subscribes to its own HUD fields.
 */
import { memo, type JSX } from 'react';
import { Icon } from '../components/icons/index.tsx';
import { openInGameMenu } from '../screens/overlays/InGameMenu.tsx';
import { VoiceRoster } from '../screens/overlays/VoicePanel.tsx';
import { useUI } from '../store/uiStore.ts';
import { tutorialUi, useTutorialUI } from '../tutorial/store.ts';
import { EmoteWheel } from './EmoteWheel.tsx';
import {
  CameraLockHint,
  ControlsHint,
  CountdownNumerals,
  GrabStatus,
  EliminatedSheet,
  HudTimer,
  NetStats,
  ObjectiveChip,
  QualifyCounter,
  RaceProgress,
  ScoreGoal,
  SpectateBanner,
  TeamScores,
} from './widgets.tsx';

/**
 * The HUD gear during Practice Island: its Skip prompt, the same thing Esc and
 * pad Start do there (the show's in-game menu has nothing to offer it).
 */
export function openTutorialSkip(): void {
  if (tutorialUi.getState().ready) return;
  tutorialUi.setState({ skipConfirm: true });
}

/** The HUD layer for the `round` screen. */
export const Hud = memo(function Hud(): JSX.Element {
  const counting = useUI((s) => s.countdown !== null && s.countdown > 0);
  const highContrast = useUI((s) => s.settings.accessibility.highContrastHud);
  const tutorial = useTutorialUI((t) => (t.phase === 'hidden' ? 'off' : t.ready ? 'ready' : 'on'));
  return (
    <div className={`tr-hud${counting ? ' is-countdown' : ''}${highContrast ? ' is-contrast' : ''}`}>
      <div className="tr-hud-top">
        <div className="tr-hud-tl">
          <HudTimer />
          <ObjectiveChip />
        </div>
        <div className="tr-hud-tc">
          <QualifyCounter />
          <ScoreGoal />
          <RaceProgress />
        </div>
        <div className="tr-hud-tr">
          {/* The ready card already offers the way out of Practice Island. */}
          {tutorial !== 'ready' && (
            <button
              type="button"
              className="tr-hud-menu-btn tr-interactive"
              aria-label={tutorial === 'on' ? 'Skip tutorial' : 'Show menu'}
              data-testid="hud-menu"
              onClick={tutorial === 'on' ? openTutorialSkip : openInGameMenu}
            >
              <Icon name="gear" size="1.3em" />
            </button>
          )}
          <NetStats />
          <TeamScores />
          <VoiceRoster />
        </div>
      </div>
      <ControlsHint />
      <CameraLockHint />
      <GrabStatus />
      <SpectateBanner />
      <EmoteWheel />
      <CountdownNumerals />
      <EliminatedSheet />
    </div>
  );
});
