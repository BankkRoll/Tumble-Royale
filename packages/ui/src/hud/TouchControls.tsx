/**
 * Mobile touch layout, the only touch input surface in the game:
 * - a floating virtual joystick on the movement half;
 * - Jump / Dive / Grab buttons and the emote wheel button on the other half
 *   (Settings → Touch buttons side / size);
 * - camera drag anywhere else on screen.
 *
 * Every change is emitted synchronously (`touchInput`, `touchLook`); the
 * client's input system latches the buttons so a tap shorter than a sim step
 * still lands. Multi-touch works because each control tracks its own pointer.
 *
 * Shown only while touch is the last-used device, so a touchscreen laptop
 * played with mouse and keyboard keeps its clicks.
 */
import { memo, useEffect, useRef, useState, type JSX, type PointerEvent as RPointerEvent } from 'react';
import { uiEvents } from '../store/events.ts';
import { Icon } from '../components/icons/index.tsx';
import { ui, useUI } from '../store/uiStore.ts';

/** Joystick travel radius in CSS pixels (before the button-size setting). */
export const STICK_RADIUS = 56;

/** Joystick state: where the base sits and the knob offset from it. */
export interface StickState {
  /** Base centre (client px). Follows the finger once it leaves the radius. */
  ox: number;
  oy: number;
  /** Knob offset from the base (px), length ≤ radius. */
  dx: number;
  dy: number;
}

/**
 * Moves the joystick to a finger position. Past the radius the base is dragged
 * along so reversing direction responds at once instead of crossing the dead
 * travel first.
 *
 * @param s - Current stick (base + knob).
 * @param x - Finger x (client px).
 * @param y - Finger y (client px).
 * @param radius - Travel radius (px).
 * @returns The new stick and its move vector (x right, y forward, length ≤ 1).
 * @example
 * dragStick({ ox: 100, oy: 100, dx: 0, dy: 0 }, 100, 44, 56).move; // { x: 0, y: 1 }
 */
export function dragStick(
  s: StickState,
  x: number,
  y: number,
  radius: number,
): { stick: StickState; move: { x: number; y: number } } {
  let ox = s.ox;
  let oy = s.oy;
  let dx = x - ox;
  let dy = y - oy;
  const len = Math.hypot(dx, dy);
  if (len > radius) {
    ox += (dx / len) * (len - radius);
    oy += (dy / len) * (len - radius);
    dx = (dx / len) * radius;
    dy = (dy / len) * radius;
  }
  return { stick: { ox, oy, dx, dy }, move: { x: dx / radius, y: -dy / radius } };
}

interface Snapshot {
  move: { x: number; y: number };
  jump: boolean;
  dive: boolean;
  grab: boolean;
}

const idle = (): Snapshot => ({ move: { x: 0, y: 0 }, jump: false, dive: false, grab: false });

type ActionKey = 'jump' | 'dive' | 'grab';
const ACTIONS: { key: ActionKey; label: string }[] = [
  { key: 'jump', label: 'Jump' },
  { key: 'dive', label: 'Dive' },
  { key: 'grab', label: 'Grab' },
];

/** A mouse never drives the touch HUD (touchscreen laptops). */
const isTouchPointer = (e: RPointerEvent): boolean => e.pointerType !== 'mouse';

/** Virtual joystick, action buttons and the camera-drag surface. */
export const TouchControls = memo(function TouchControls(): JSX.Element | null {
  const visible = useUI((s) => s.isTouch && s.hud.device === 'touch');
  const layout = useUI((s) => s.settings.controls.touchLayout);
  const scale = useUI((s) => s.settings.controls.touchButtonScale);
  const playing = useUI((s) => s.hud.localStatus === 'playing');
  const wheelOpen = useUI((s) => s.emoteWheelOpen);
  const state = useRef<Snapshot>(idle());
  const [stick, setStick] = useState<StickState | null>(null);
  const [held, setHeld] = useState<Record<ActionKey, boolean>>({ jump: false, dive: false, grab: false });
  const stickId = useRef<number | null>(null);
  const stickRef = useRef<StickState | null>(null);
  const look = useRef<{ id: number; x: number; y: number } | null>(null);
  const controls = visible && playing;

  const emit = (): void => {
    const s = state.current;
    uiEvents.emit('touchInput', { move: { ...s.move }, jump: s.jump, dive: s.dive, grab: s.grab });
  };

  // Hiding the controls (round over, eliminated, switched to a pad) must never leave a button held.
  useEffect(() => {
    if (controls) return;
    const s = state.current;
    if (s.jump || s.dive || s.grab || s.move.x !== 0 || s.move.y !== 0) {
      state.current = idle();
      emit();
    }
    stickId.current = null;
    stickRef.current = null;
    setStick(null);
    setHeld({ jump: false, dive: false, grab: false });
  }, [controls]);
  useEffect(
    () => () => {
      state.current = idle();
      emit();
    },
    [],
  );

  if (!visible) return null;

  const radius = STICK_RADIUS * scale;

  const onStickDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!isTouchPointer(e) || stickId.current !== null) return;
    e.preventDefault();
    e.stopPropagation();
    stickId.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const s = { ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
    stickRef.current = s;
    setStick(s);
  };
  const onStickMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.pointerId !== stickId.current || !stickRef.current) return;
    const r = dragStick(stickRef.current, e.clientX, e.clientY, radius);
    stickRef.current = r.stick;
    setStick(r.stick);
    state.current.move = r.move;
    emit();
  };
  const onStickUp = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.pointerId !== stickId.current) return;
    stickId.current = null;
    stickRef.current = null;
    setStick(null);
    state.current.move = { x: 0, y: 0 };
    emit();
  };

  const onLookDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!isTouchPointer(e) || look.current) return;
    // preventDefault also stops the compatibility mousedown that would try to lock the pointer.
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onLookMove = (e: RPointerEvent<HTMLDivElement>): void => {
    const l = look.current;
    if (!l || e.pointerId !== l.id) return;
    const dx = e.clientX - l.x;
    const dy = e.clientY - l.y;
    l.x = e.clientX;
    l.y = e.clientY;
    if (dx !== 0 || dy !== 0) uiEvents.emit('touchLook', { dx, dy });
  };
  const onLookUp = (e: RPointerEvent<HTMLDivElement>): void => {
    if (look.current?.id === e.pointerId) look.current = null;
  };

  const press = (key: ActionKey, down: boolean): void => {
    if (state.current[key] === down) return;
    state.current[key] = down;
    setHeld((h) => ({ ...h, [key]: down }));
    emit();
  };

  return (
    <div
      className={`tr-touch is-${layout}`}
      style={{ ['--tb' as string]: String(scale) }}
      data-testid="touch"
    >
      <div
        className="tr-touch-look tr-interactive"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />
      {controls && (
        <>
          <div
            className="tr-touch-stick-zone tr-interactive"
            onPointerDown={onStickDown}
            onPointerMove={onStickMove}
            onPointerUp={onStickUp}
            onPointerCancel={onStickUp}
          >
            {stick ? (
              <div className="tr-touch-stick" style={{ left: stick.ox, top: stick.oy }}>
                <div
                  className="tr-touch-knob"
                  style={{ transform: `translate(${stick.dx}px, ${stick.dy}px)` }}
                />
              </div>
            ) : (
              <div className="tr-touch-stick tr-touch-stick--idle">
                <div className="tr-touch-knob" />
              </div>
            )}
          </div>
          <div className="tr-touch-buttons">
            {ACTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`tr-touch-btn tr-touch-btn--${key}${held[key] ? ' is-held' : ''}`}
                aria-label={label}
                aria-pressed={held[key]}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  press(key, true);
                }}
                onPointerUp={() => press(key, false)}
                onPointerCancel={() => press(key, false)}
                onLostPointerCapture={() => press(key, false)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <Icon name={key} size="1.6em" />
                <small>{label}</small>
              </button>
            ))}
            <button
              type="button"
              className={`tr-touch-btn tr-touch-btn--emote${wheelOpen ? ' is-held' : ''}`}
              aria-label="Emote"
              aria-pressed={wheelOpen}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => ui.getState().setEmoteWheel(!ui.getState().emoteWheelOpen)}
            >
              <Icon name="emote" size="1.6em" />
            </button>
          </div>
        </>
      )}
    </div>
  );
});
