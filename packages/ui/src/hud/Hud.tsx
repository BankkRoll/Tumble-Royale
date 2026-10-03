/**
 * In-round HUD composition (docs/design/SCREENS.md §9.6). Layout only; each
 * widget subscribes to its own HUD fields.
 */
import { memo, type JSX } from 'react';
import { Icon } from '../components/icons/index.tsx';
import { openInGameMenu } from '../screens/overlays/InGameMenu.tsx';
import { useUI } from '../store/uiStore.ts';
import { EmoteWheel } from './EmoteWheel.tsx';
import { TouchControls } from './TouchControls.tsx';
import {
  CameraLockHint,
  CaptionChip,
  ControlsHint,
  CountdownNumerals,
  GrabStatus,
  EliminatedSheet,
  HudTimer,
  NetStats,
  ObjectiveChip,
  QualifyCounter,
  RaceProgress,
  SpectateBanner,
  TeamScores,
} from './widgets.tsx';

/** The HUD layer for the `round` screen. */
export const Hud = memo(function Hud(): JSX.Element {
  const counting = useUI((s) => s.countdown !== null && s.countdown > 0);
  const highContrast = useUI((s) => s.settings.accessibility.highContrastHud);
  return (
    <div className={`tr-hud${counting ? ' is-countdown' : ''}${highContrast ? ' is-contrast' : ''}`}>
      <div className="tr-hud-top">
        <div className="tr-hud-tl">
          <HudTimer />
          <ObjectiveChip />
        </div>
        <div className="tr-hud-tc">
          <QualifyCounter />
          <RaceProgress />
        </div>
        <div className="tr-hud-tr">
          <button
            type="button"
            className="tr-hud-menu-btn tr-interactive"
            aria-label="Show menu"
            data-testid="hud-menu"
            onClick={openInGameMenu}
          >
            <Icon name="gear" size="1.3em" />
          </button>
          <NetStats />
          <TeamScores />
        </div>
      </div>
      <ControlsHint />
      <CameraLockHint />
      <GrabStatus />
      <SpectateBanner />
      <CaptionChip />
      <TouchControls />
      <EmoteWheel />
      <CountdownNumerals />
      <EliminatedSheet />
    </div>
  );
});
