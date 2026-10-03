/**
 * Hold-to-open radial emote / quick-ping wheel. The game opens it with
 * `setEmoteWheel(true)` on key/button down and closes it on release; the
 * highlighted slot (by pointer angle or stick via `navigate`) is emitted on close.
 */
import { memo, useEffect, useRef, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { uiEvents } from '../store/events.ts';
import { ui, useUI } from '../store/uiStore.ts';
import type { EmoteSlot } from '../store/types.ts';

function emit(slot: EmoteSlot, index: number): void {
  if (slot.id.startsWith('ping:')) uiEvents.emit('quickPing', { kind: slot.id.slice(5) });
  else uiEvents.emit('emote', { slot: index, id: slot.id });
}

/** Radial wheel, centred on screen. */
export const EmoteWheel = memo(function EmoteWheel(): JSX.Element | null {
  const open = useUI((s) => s.emoteWheelOpen);
  const emotes = useUI((s) => s.hud.emotes);
  const [hover, setHover] = useState(-1);
  const hoverRef = useRef(-1);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      hoverRef.current = -1;
      setHover(-1);
      const n = emotes.length;
      const onMove = (e: PointerEvent): void => {
        const dx = e.clientX - window.innerWidth / 2;
        const dy = e.clientY - window.innerHeight / 2;
        if (Math.hypot(dx, dy) < 30) return;
        const ang = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
        const idx = Math.round(ang / ((Math.PI * 2) / n)) % n;
        if (idx !== hoverRef.current) {
          hoverRef.current = idx;
          setHover(idx);
          playCue('ui.hover');
        }
      };
      window.addEventListener('pointermove', onMove);
      return () => window.removeEventListener('pointermove', onMove);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      const slot = emotes[hoverRef.current];
      if (slot) {
        playCue('ui.confirm');
        emit(slot, hoverRef.current);
      }
    }
  }, [open, emotes]);

  if (!open) return null;
  const n = emotes.length;
  return (
    <div className="tr-emote-wheel tr-interactive" role="menu" aria-label="Emotes">
      <div className="tr-emote-ring" />
      {emotes.map((e, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        return (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            className={`tr-emote-slot${i === hover ? ' is-hover' : ''}${e.id.startsWith('ping:') ? ' is-ping' : ''}`}
            style={{
              left: `calc(50% + ${Math.cos(a) * 6.4}em)`,
              top: `calc(50% + ${Math.sin(a) * 6.4}em)`,
              animationDelay: `${i * 25}ms`,
            }}
            onPointerEnter={() => {
              hoverRef.current = i;
              setHover(i);
            }}
            onClick={() => {
              playCue('ui.confirm');
              emit(e, i);
              hoverRef.current = -1;
              ui.getState().setEmoteWheel(false);
            }}
          >
            <span className="tr-emote-icon">{e.icon}</span>
            <span className="tr-emote-label">{e.label}</span>
          </button>
        );
      })}
      <div className="tr-emote-center">{hover >= 0 ? (emotes[hover]?.label ?? '') : 'Emote'}</div>
    </div>
  );
});
