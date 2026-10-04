/**
 * Settings → Controls → Controller: remaps gamepad buttons.
 *
 * Responsibilities:
 * - "press a button" capture read straight from the Gamepad API, with menu
 *   navigation paused meanwhile (`padCapture`) so the press only binds;
 * - swap-on-conflict and refusals from {@link assignPadButton}, reported as
 *   toasts;
 * - clearing a secondary slot (Delete / Backspace while capturing) and
 *   resetting to defaults.
 */
import { useEffect, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button } from '../../components/controls.tsx';
import { DEFAULT_PAD_BINDS, PAD_BIND_ACTION_LABELS } from '../../store/defaults.ts';
import {
  PadCapture,
  assignPadButton,
  padButtonLabel,
  padSwapMessage,
  type PadButtonsSnapshot,
} from '../../store/padBinds.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { PadBindAction, PadBinds } from '../../store/types.ts';

/** How long the prompt waits for a button before giving up (ms). */
const CAPTURE_TIMEOUT_MS = 6000;

/** The first connected standard-mapping pad, or null. */
function firstPad(): PadButtonsSnapshot | null {
  const nav = globalThis.navigator;
  const pads = nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : [];
  for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
  return null;
}

/**
 * Applies a captured button: binds it (swapping with a clashing action) and
 * tells the player what moved.
 *
 * @param binds - Current controller bindings.
 * @param action - Action being bound.
 * @param slot - 0 primary, 1 secondary.
 * @param button - Pressed button index.
 * @returns The bindings now in effect.
 */
export function bindPadButton(binds: PadBinds, action: PadBindAction, slot: 0 | 1, button: number): PadBinds {
  const r = assignPadButton(binds, action, slot, button);
  const s = ui.getState();
  if (r.rejected) {
    playCue('ui.error');
    s.pushToast({ kind: 'warning', title: 'Button not changed', body: r.rejected });
    return binds;
  }
  if (r.swappedWith) {
    const prev = binds[action][slot];
    s.pushToast({
      kind: 'warning',
      title: padSwapMessage(button, r.swappedWith),
      body:
        prev >= 0
          ? 'Swapped the two bindings.'
          : `Removed it from “${PAD_BIND_ACTION_LABELS[r.swappedWith]}”.`,
    });
  }
  playCue('ui.confirm');
  s.updateSettings('controls', { padBinds: r.binds });
  return r.binds;
}

/** Controller button table with capture, conflict handling and reset. */
export function PadRebinder(): JSX.Element {
  const binds = useUI((s) => s.settings.controls.padBinds);
  const [capture, setCapture] = useState<{ action: PadBindAction; slot: 0 | 1 } | null>(null);
  const [noPad, setNoPad] = useState(false);

  useEffect(() => {
    if (!capture) return;
    ui.setState({ padCapture: true });
    const start = firstPad();
    setNoPad(start === null);
    const cap = new PadCapture(start);
    let raf = 0;
    const done = (): void => setCapture(null);
    const tick = (): void => {
      const pad = firstPad();
      setNoPad(pad === null);
      const b = cap.update(pad);
      if (b !== null) {
        bindPadButton(binds, capture.action, capture.slot, b);
        done();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if ((e.code === 'Delete' || e.code === 'Backspace') && capture.slot === 1) {
        const pair: [number, number] = [binds[capture.action][0], -1];
        playCue('ui.confirm');
        ui.getState().updateSettings('controls', { padBinds: { ...binds, [capture.action]: pair } });
      } else {
        playCue('ui.back');
      }
      done();
    };
    const timeout = window.setTimeout(done, CAPTURE_TIMEOUT_MS);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
      window.removeEventListener('keydown', onKey, true);
      ui.setState({ padCapture: false });
    };
  }, [capture, binds]);

  const prompt = noPad ? 'Connect a controller…' : 'Press a button…';
  return (
    <div className="tr-binds" data-testid="pad-binds">
      <div className="tr-binds-title tr-label">Controller</div>
      <div className="tr-binds-head">
        <span>Action</span>
        <span>Primary</span>
        <span>Secondary</span>
      </div>
      {(Object.keys(PAD_BIND_ACTION_LABELS) as PadBindAction[]).map((a) => (
        <div key={a} className="tr-binds-row">
          <span>{PAD_BIND_ACTION_LABELS[a]}</span>
          {([0, 1] as const).map((slot) => {
            const active = capture?.action === a && capture.slot === slot;
            return (
              <button
                key={slot}
                type="button"
                className={`tr-bind${active ? ' tr-bind-capture' : ''}`}
                data-nav=""
                aria-label={`${PAD_BIND_ACTION_LABELS[a]} ${slot === 0 ? 'primary' : 'secondary'} button`}
                onClick={() => {
                  playCue('ui.click');
                  setCapture({ action: a, slot });
                }}
              >
                {active ? prompt : padButtonLabel(binds[a]?.[slot] ?? -1)}
              </button>
            );
          })}
        </div>
      ))}
      <small className="tr-muted">
        A conflicting button swaps with the action that had it. Delete clears a secondary slot; Esc cancels.
      </small>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setCapture(null);
          ui.getState().updateSettings('controls', { padBinds: DEFAULT_PAD_BINDS });
        }}
      >
        Reset controller to defaults
      </Button>
    </div>
  );
}
