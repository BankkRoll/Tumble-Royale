/**
 * Spectator input routing: which key or controller button does what while
 * watching, when those hotkeys are live at all, and the free camera's held
 * fly axes. Pure (no DOM reads), so conflicts with chat, menus, photo mode
 * and the replay viewer are unit-tested.
 *
 * Rules:
 * - hotkeys only fire on the round screen while spectating, with no overlay,
 *   dialog, photo mode, replay or "How you went out" replay open, and never
 *   while a text field or the
 *   chat owns the keyboard (the caller checks `keyboardBusy`);
 * - controller buttons only fire while menu navigation does not own the pad
 *   (`menuOwnsPad`), so A on the eliminated sheet is never also "leader";
 * - in the free camera the spectate previous/next keys (Q/E by default) fly
 *   down/up instead, as players expect from a fly camera; previous/next
 *   stay on the shoulder buttons there.
 */
import type { Keybinds, PadBinds, SpectatorCamMode, UIState } from '@tumble/ui';

/** Something a spectator hotkey or button asks for. */
export type SpectatorAction =
  'prev' | 'next' | 'camera' | 'leader' | 'roster' | 'pin' | 'broadcast' | 'help' | 'chroma';

/** Keyboard binding per action (the free camera's fly keys are read separately). */
const KEY_ACTIONS: readonly [keyof Keybinds, SpectatorAction][] = [
  ['spectatePrev', 'prev'],
  ['spectateNext', 'next'],
  ['spectateCamera', 'camera'],
  ['spectateLeader', 'leader'],
  ['spectateRoster', 'roster'],
  ['spectatePin', 'pin'],
  ['broadcastOverlay', 'broadcast'],
  ['broadcastHelp', 'help'],
  ['broadcastChroma', 'chroma'],
];

/** Controller binding per action. */
const PAD_ACTIONS: readonly [keyof PadBinds, SpectatorAction][] = [
  ['spectatePrev', 'prev'],
  ['spectateNext', 'next'],
  ['spectateCamera', 'camera'],
  ['spectateLeader', 'leader'],
  ['spectateRoster', 'roster'],
  ['spectatePin', 'pin'],
  ['broadcastOverlay', 'broadcast'],
  ['broadcastHelp', 'help'],
];

/** The UI fields that decide whether spectator hotkeys are live. */
export type SpectatorKeyState = Pick<UIState, 'screen' | 'overlay' | 'dialog' | 'photo' | 'replay'> & {
  elimReplay?: UIState['elimReplay'];
};

/**
 * Whether spectator keyboard hotkeys may fire right now.
 *
 * @param s - UI state.
 * @param watching - The local player is spectating (or qualified and waiting).
 */
export function spectatorKeysLive(s: SpectatorKeyState, watching: boolean): boolean {
  return (
    watching &&
    s.screen === 'round' &&
    s.overlay === 'none' &&
    !s.dialog &&
    !s.photo.active &&
    !s.replay &&
    !s.elimReplay
  );
}

/**
 * The spectator action bound to a key.
 *
 * @param code - `KeyboardEvent.code`.
 * @param binds - The player's keyboard bindings.
 * @param mode - Camera mode (the free camera keeps previous/next keys for flying).
 * @returns The action, or null when the key is not a spectator key here.
 * @example
 * spectatorKeyAction('KeyF', binds, 'follow'); // 'camera'
 */
export function spectatorKeyAction(
  code: string,
  binds: Partial<Keybinds>,
  mode: SpectatorCamMode,
): SpectatorAction | null {
  if (!code) return null;
  for (const [bind, action] of KEY_ACTIONS) {
    if (!binds[bind]?.includes(code)) continue;
    if (mode === 'free' && (action === 'prev' || action === 'next')) return null;
    return action;
  }
  return null;
}

/**
 * Controller buttons per spectator action.
 *
 * @param binds - `Settings.controls.padBinds`.
 */
export function spectatorPadButtons(binds: Partial<PadBinds>): [SpectatorAction, number[]][] {
  return PAD_ACTIONS.map(([bind, action]) => [
    action,
    (binds[bind] ?? []).filter((b): b is number => Number.isInteger(b) && b >= 0),
  ]);
}

/**
 * Edge detector for spectator controller buttons: reports each action once
 * per press, and nothing for buttons already held when it (re)starts, so a
 * held A that closed a menu does not also jump to the leader.
 *
 * @example
 * const pad = new SpectatorPadEdges();
 * for (const a of pad.update((i) => gp.buttons[i]?.pressed ?? false, padBinds)) act(a);
 */
export class SpectatorPadEdges {
  private held = new Set<number>();
  private primed = false;

  /**
   * Feeds the current buttons.
   *
   * @param down - Whether a standard-mapping button is pressed.
   * @param binds - Controller bindings.
   * @returns Actions pressed this frame, in binding order.
   */
  update(down: (button: number) => boolean, binds: Partial<PadBinds>): SpectatorAction[] {
    const out: SpectatorAction[] = [];
    const now = new Set<number>();
    for (const [action, buttons] of spectatorPadButtons(binds)) {
      let fired = false;
      for (const b of buttons) {
        if (!down(b)) continue;
        now.add(b);
        if (this.primed && !this.held.has(b) && !fired) {
          out.push(action);
          fired = true;
        }
      }
    }
    this.held = now;
    this.primed = true;
    return out;
  }

  /** Forgets held buttons: the next update only primes (call while the pad belongs to menus). */
  reset(): void {
    this.held.clear();
    this.primed = false;
  }
}

/** Held free-camera axes from the keyboard. */
export interface FlyAxes {
  x: number;
  y: number;
  z: number;
  boost: boolean;
}

/** Codes that rise / boost regardless of bindings. */
const RISE_KEYS = ['Space'];
const BOOST_KEYS = ['ShiftLeft', 'ShiftRight'];

/**
 * Free camera axes from the held keys: the movement bindings (WASD) move,
 * spectate next / Space rise, spectate previous sinks, Shift boosts.
 *
 * @param held - `KeyboardEvent.code`s held now.
 * @param binds - Keyboard bindings.
 */
export function flyAxesFromKeys(held: ReadonlySet<string>, binds: Partial<Keybinds>): FlyAxes {
  const on = (bind: keyof Keybinds): boolean => !!binds[bind]?.some((c) => c !== '' && held.has(c));
  const any = (codes: readonly string[]): boolean => codes.some((c) => held.has(c));
  return {
    x: (on('moveRight') ? 1 : 0) - (on('moveLeft') ? 1 : 0),
    z: (on('moveForward') ? 1 : 0) - (on('moveBack') ? 1 : 0),
    y: (on('spectateNext') || any(RISE_KEYS) ? 1 : 0) - (on('spectatePrev') ? 1 : 0),
    boost: any(BOOST_KEYS),
  };
}

/** Standard-mapping indices the free camera reads raw (sticks and triggers are never remapped). */
export const FLY_PAD = Object.freeze({ LT: 6, RT: 7, L3: 10 });

/**
 * Free camera axes from a standard-mapping gamepad: left stick moves,
 * RT rises, LT sinks, L3 boosts. The right stick looks (through the input
 * layer's look).
 *
 * @param axes - `Gamepad.axes`.
 * @param value - Analog value of a button (0..1).
 * @param deadzone - Radial stick deadzone.
 */
export function flyAxesFromPad(
  axes: readonly number[],
  value: (button: number) => number,
  deadzone = 0.18,
): FlyAxes {
  let x = axes[0] ?? 0;
  let z = -(axes[1] ?? 0);
  const m = Math.hypot(x, z);
  if (m <= deadzone) x = z = 0;
  else {
    const k = Math.min(1, (m - deadzone) / (1 - deadzone)) / m;
    x *= k;
    z *= k;
  }
  const trig = (b: number): number => {
    const v = value(b);
    return v > 0.08 ? v : 0;
  };
  return { x, z, y: trig(FLY_PAD.RT) - trig(FLY_PAD.LT), boost: value(FLY_PAD.L3) > 0.5 };
}

/**
 * Combines keyboard and pad axes: the stronger input wins per axis, so a
 * resting stick never cancels a held key.
 */
export function mergeFlyAxes(a: FlyAxes, b: FlyAxes): FlyAxes {
  const pick = (u: number, v: number): number => (Math.abs(u) >= Math.abs(v) ? u : v);
  return { x: pick(a.x, b.x), y: pick(a.y, b.y), z: pick(a.z, b.z), boost: a.boost || b.boost };
}
