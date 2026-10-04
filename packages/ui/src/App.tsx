/**
 * Root overlay component: stacks every layer (screen, HUD, stamps, confetti,
 * toasts, sheets, dialogs, connection curtain, wipe) and mirrors accessibility
 * settings onto the root element as data attributes / CSS variables. The
 * touch controls sit between the screens and the HUD so they serve the round,
 * the pre-show platform and menu idle play alike (`data-touch-play` lets the
 * menu chrome step aside while touch players run around).
 */
import { useEffect, useRef, type JSX } from 'react';
import { ConnectionLayer, DialogLayer, ToastLayer } from './components/system.tsx';
import { ChatWidgetLayer } from './hud/ChatWidget.tsx';
import { ShowMenuButton } from './hud/ShowMenuButton.tsx';
import { CaptionChip } from './hud/widgets.tsx';
import { Hud } from './hud/Hud.tsx';
import { TouchControls } from './hud/TouchControls.tsx';
import { touchMode } from './hud/touchMode.ts';
import { SettingsSheet } from './screens/overlays/SettingsSheet.tsx';
import { InGameMenu } from './screens/overlays/InGameMenu.tsx';
import { SocialLayer } from './screens/overlays/PlayerActions.tsx';
import { PhotoModeBar } from './screens/overlays/PhotoMode.tsx';
import { JoinCodeDialog, PrivateShowDialog } from './screens/overlays/PrivateShow.tsx';
import { FriendsSheet, NotificationsPanel } from './screens/overlays/SocialSheets.tsx';
import { WatchChoiceLayer } from './screens/overlays/WatchChoice.tsx';
import { ReplayLayer } from './screens/Replay.tsx';
import { ScreenLayer } from './screens/ScreenLayer.tsx';
import { useUI } from './store/uiStore.ts';
import { installEasingVars } from './theme/motion.ts';
import { ConfettiLayer } from './transitions/Confetti.tsx';
import { StampLayer } from './transitions/StampLayer.tsx';
import { TumbleWipe } from './transitions/TumbleWipe.tsx';

function OverlayLayer(): JSX.Element | null {
  const overlay = useUI((s) => s.overlay);
  switch (overlay) {
    case 'settings':
      return <SettingsSheet />;
    case 'friends':
      return <FriendsSheet />;
    case 'notifications':
      return <NotificationsPanel />;
    case 'privateShow':
      return <PrivateShowDialog />;
    case 'joinCode':
      return <JoinCodeDialog />;
    case 'inGameMenu':
      return <InGameMenu />;
    default:
      return null;
  }
}

function HudLayer(): JSX.Element | null {
  const inRound = useUI((s) => s.screen === 'round');
  return inRound ? <Hud /> : null;
}

/** The whole overlay. Rendered by `mountUI`. */
export function App(): JSX.Element {
  const a = useUI((s) => s.settings.accessibility);
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const screen = useUI((s) => s.screen);
  const overlay = useUI((s) => s.overlay);
  const photo = useUI((s) => s.photo.active);
  const replay = useUI((s) => s.replay !== null);
  const touchContext = useUI((s) => touchMode(s)?.context);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) installEasingVars(ref.current);
  }, []);

  return (
    <div
      ref={ref}
      className="tr-root"
      onScroll={(e) => {
        // Focus changes can scroll even overflow:hidden boxes; the overlay must never drift.
        e.currentTarget.scrollTop = 0;
        e.currentTarget.scrollLeft = 0;
      }}
      data-cb={a.colorBlind}
      data-reduce-motion={String(a.reduceMotion)}
      data-reduce-flashing={String(a.reduceFlashing)}
      data-reduce-shake={String(a.reduceShake)}
      data-streamer={String(streamer)}
      data-screen={screen}
      data-overlay={overlay}
      data-photo={String(photo)}
      data-replay={replay ? 'true' : undefined}
      data-touch-play={touchContext}
      style={{ ['--ui-scale' as string]: String(a.uiScale) }}
    >
      {/* Photo mode hides the UI without unmounting it, so screens don't replay their entrances. */}
      <div className="tr-photo-hidable" aria-hidden={photo || undefined}>
        <div className="tr-stage">
          <ScreenLayer />
          {/* Before the HUD, so every HUD control paints above the touch camera-drag surface. */}
          <TouchControls />
          <HudLayer />
          <ShowMenuButton />
          <ChatWidgetLayer />
          {/* App-level, not in the HUD: the announcer also talks over intros, results and the wall. */}
          <CaptionChip />
          <StampLayer />
        </div>
        <ConfettiLayer />
      </div>
      {!photo && <WatchChoiceLayer />}
      <ToastLayer />
      <ReplayLayer />
      {photo ? <PhotoModeBar /> : <OverlayLayer />}
      {!photo && <SocialLayer />}
      <DialogLayer />
      <ConnectionLayer />
      <TumbleWipe />
    </div>
  );
}
