/**
 * Root overlay component: stacks every layer (screen, HUD, stamps, confetti,
 * toasts, sheets, dialogs, connection curtain, wipe) and mirrors accessibility
 * settings onto the root element as data attributes / CSS variables.
 */
import { useEffect, useRef, type JSX } from 'react';
import { ConnectionLayer, DialogLayer, ToastLayer } from './components/system.tsx';
import { ShowChatLayer } from './hud/ChatFeed.tsx';
import { Hud } from './hud/Hud.tsx';
import { SettingsSheet } from './screens/overlays/SettingsSheet.tsx';
import { InGameMenu } from './screens/overlays/InGameMenu.tsx';
import { SocialLayer } from './screens/overlays/PlayerActions.tsx';
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
  const replay = useUI((s) => s.replay !== null);
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
      data-replay={replay ? 'true' : undefined}
      style={{ ['--ui-scale' as string]: String(a.uiScale) }}
    >
      <div className="tr-stage">
        <ScreenLayer />
        <HudLayer />
        <ShowChatLayer />
        <StampLayer />
      </div>
      <ConfettiLayer />
      <WatchChoiceLayer />
      <ToastLayer />
      <ReplayLayer />
      <OverlayLayer />
      <SocialLayer />
      <DialogLayer />
      <ConnectionLayer />
      <TumbleWipe />
    </div>
  );
}
