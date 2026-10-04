/**
 * The pre-show platform's controls line, built from the player's real
 * bindings and last-used device instead of a fixed "WASD · Space · 1–4".
 */
import { memo, type JSX } from 'react';
import { controlGlyph, emoteGlyph, movementGlyph } from '../hud/glyphs.ts';
import { useUI } from '../store/uiStore.ts';

const TAIL = 'go bonk someone while you wait!';

/** Pre-show hint: move / jump / emote glyphs per device; touch points at the on-screen controls. */
export const PreShowHint = memo(function PreShowHint(): JSX.Element {
  const device = useUI((s) => s.hud.device);
  const binds = useUI((s) => s.settings.controls.keybinds);
  const padBinds = useUI((s) => s.settings.controls.padBinds);
  if (device === 'touch')
    return (
      <div className="tr-preshow-hint" data-testid="preshow-hint">
        Joystick to move · tap Jump — {TAIL}
      </div>
    );
  return (
    <div className="tr-preshow-hint" data-testid="preshow-hint">
      <kbd>{movementGlyph(device, binds)}</kbd> move ·{' '}
      <kbd>{controlGlyph('jump', device, binds, padBinds)}</kbd> jump ·{' '}
      <kbd>{emoteGlyph(device, binds, padBinds)}</kbd> emote — {TAIL}
    </div>
  );
});
