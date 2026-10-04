/**
 * Install-the-app entry points: the Settings rows (install, update ready) and
 * the shared action behind the menu's Install button.
 */
import type { JSX, ReactNode } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button } from '../../components/controls.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';

/** Safari has no install prompt; this is what the player does by hand. */
export const IOS_INSTALL_STEPS =
  'In Safari, tap the Share button, then Add to Home Screen. The game then opens full screen and plays offline against bots.';

/**
 * Install app: the browser's own prompt where there is one, else the
 * Add to Home Screen steps (iOS Safari).
 */
export function requestInstall(): void {
  const { pwa } = ui.getState();
  playCue('ui.click');
  if (pwa.install === 'available') uiEvents.emit('installApp');
  else if (pwa.install === 'ios')
    ui.getState().showDialog({
      id: 'install-ios',
      kind: 'info',
      title: 'Add Tumble Royale to your Home Screen',
      body: IOS_INSTALL_STEPS,
    });
}

/** Whether an Install app button has something to do on this device. */
export function canInstall(install: string): boolean {
  return install === 'available' || install === 'ios';
}

function Row({ label, hint, children }: { label: string; hint: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="tr-settings-row">
      <div className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
        <span>{label}</span>
        <small className="tr-muted">{hint}</small>
      </div>
      {children}
    </div>
  );
}

/** Settings rows for the installable app: install (or how to), installed, update ready. */
export function AppRows(): JSX.Element {
  const pwa = useUI((s) => s.pwa);
  // Restarting mid-show would drop the player out of it; the row waits for the menu.
  const atMenu = useUI((s) => s.screen === 'menu' || s.screen === 'splash');
  return (
    <>
      {pwa.updateReady && atMenu && (
        <Row label="Update ready" hint="A new version downloaded. Restarting takes a few seconds.">
          <Button
            size="sm"
            variant="mint"
            data-testid="settings-apply-update"
            onClick={() => {
              playCue('ui.click');
              uiEvents.emit('applyUpdate');
            }}
          >
            Restart
          </Button>
        </Row>
      )}
      {canInstall(pwa.install) && (
        <Row
          label="Install app"
          hint={
            pwa.install === 'ios'
              ? 'Share, then Add to Home Screen. Plays offline against bots.'
              : 'Full screen, its own icon, and offline play against bots'
          }
        >
          <Button size="sm" variant="secondary" data-testid="settings-install" onClick={requestInstall}>
            {pwa.install === 'ios' ? 'How' : 'Install'}
          </Button>
        </Row>
      )}
      {pwa.install === 'installed' && (
        <Row
          label="App installed"
          hint="Running as an app. Offline shows against bots work without a connection."
        />
      )}
    </>
  );
}
