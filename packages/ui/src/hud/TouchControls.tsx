/**
 * Mobile touch layout: floating virtual joystick on the movement half and
 * Jump / Dive / Grab / Emote buttons on the other. Emits `touchInput` (rAF
 * coalesced) — the input system merges it with keyboard/gamepad.
 *
 * Camera drag is left to the canvas: the non-joystick half is transparent to
 * pointer events except for the buttons themselves.
 */
import { memo, useEffect, useRef, useState, type JSX, type PointerEvent as RPointerEvent } from 'react';
import { uiEvents } from '../store/events.ts';
import { ui, useUI } from '../store/uiStore.ts';

interface TouchState {
  move: { x: number; y: number };
  jump: boolean;
  dive: boolean;
  grab: boolean;
}

/** Virtual joystick + action buttons. */
export const TouchControls = memo(function TouchControls(): JSX.Element | null {
  const isTouch = useUI((s) => s.isTouch);
  const layout = useUI((s) => s.settings.controls.touchLayout);
  const scale = useUI((s) => s.settings.controls.touchButtonScale);
  const status = useUI((s) => s.hud.localStatus);
  const state = useRef<TouchState>({ move: { x: 0, y: 0 }, jump: false, dive: false, grab: false });
  const raf = useRef(0);
  const [stick, setStick] = useState<{ ox: number; oy: number; x: number; y: number } | null>(null);
  const stickId = useRef<number | null>(null);

  const flush = (): void => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const s = state.current;
      uiEvents.emit('touchInput', { move: { ...s.move }, jump: s.jump, dive: s.dive, grab: s.grab });
    });
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  if (!isTouch || status !== 'playing') return null;

  const radius = 56;
  const onDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (stickId.current !== null) return;
    stickId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setStick({ ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.pointerId !== stickId.current || !stick) return;
    let dx = e.clientX - stick.ox;
    let dy = e.clientY - stick.oy;
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx = (dx / len) * radius;
      dy = (dy / len) * radius;
    }
    setStick({ ...stick, x: dx, y: dy });
    state.current.move = { x: dx / radius, y: -dy / radius };
    flush();
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.pointerId !== stickId.current) return;
    stickId.current = null;
    setStick(null);
    state.current.move = { x: 0, y: 0 };
    flush();
  };

  const btn = (key: 'jump' | 'dive' | 'grab', label: string, icon: string): JSX.Element => (
    <button
      type="button"
      className={`tr-touch-btn tr-touch-btn--${key}`}
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        state.current[key] = true;
        flush();
      }}
      onPointerUp={() => {
        state.current[key] = false;
        flush();
      }}
      onPointerCancel={() => {
        state.current[key] = false;
        flush();
      }}
    >
      <span aria-hidden>{icon}</span>
      <small>{label}</small>
    </button>
  );

  return (
    <div className={`tr-touch is-${layout}`} style={{ ['--tb' as string]: String(scale) }}>
      <div
        className="tr-touch-stick-zone tr-interactive"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {stick ? (
          <div className="tr-touch-stick" style={{ left: stick.ox, top: stick.oy }}>
            <div className="tr-touch-knob" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }} />
          </div>
        ) : (
          <div className="tr-touch-stick tr-touch-stick--idle">
            <div className="tr-touch-knob" />
          </div>
        )}
      </div>
      <div className="tr-touch-buttons tr-interactive">
        {btn('jump', 'Jump', '⤒')}
        {btn('dive', 'Dive', '➶')}
        {btn('grab', 'Grab', '✊')}
        <button
          type="button"
          className="tr-touch-btn tr-touch-btn--emote"
          aria-label="Emote"
          onClick={() => ui.getState().setEmoteWheel(!ui.getState().emoteWheelOpen)}
        >
          <span aria-hidden>😀</span>
        </button>
      </div>
    </div>
  );
});
