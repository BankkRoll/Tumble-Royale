/**
 * Replay viewer input mapping: keyboard keys and gamepad button edges to
 * {@link ReplayCommand}s, plus the held free-camera move axes. Pure so the
 * bindings are unit-tested; the controller feeds it DOM and Gamepad state.
 */
import type { ReplayCameraMode, ReplayCommand } from '@tumble/ui';

/** Seconds a seek key / shoulder trigger jumps. */
export const SEEK_STEP = 5;
/** Seconds a fine seek (Shift + arrow, d-pad) jumps. */
export const FINE_STEP = 1;

/** Camera modes in cycle order. */
export const CAMERA_CYCLE: readonly ReplayCameraMode[] = ['follow', 'free', 'pov'];

/**
 * Next camera mode in the cycle, skipping "your view" when the recording has
 * no camera track.
 *
 * @param mode - Current mode.
 * @param povAvailable - Recording carries the local camera.
 */
export function nextCameraMode(mode: ReplayCameraMode, povAvailable: boolean): ReplayCameraMode {
  let i = CAMERA_CYCLE.indexOf(mode);
  for (let k = 0; k < CAMERA_CYCLE.length; k++) {
    i = (i + 1) % CAMERA_CYCLE.length;
    const m = CAMERA_CYCLE[i] as ReplayCameraMode;
    if (m !== 'pov' || povAvailable) return m;
  }
  return mode;
}

/**
 * Keyboard binding for the viewer.
 *
 * @param code - `KeyboardEvent.code`.
 * @param shift - Shift held (fine seek).
 * @returns The command, or null when the key is not a viewer key.
 */
export function keyCommand(code: string, shift: boolean): ReplayCommand | null {
  switch (code) {
    case 'Space':
    case 'KeyK':
    case 'Enter':
      return { type: 'toggle' };
    case 'ArrowLeft':
    case 'KeyJ':
      return { type: 'seekBy', seconds: -(shift ? FINE_STEP : SEEK_STEP) };
    case 'ArrowRight':
    case 'KeyL':
      return { type: 'seekBy', seconds: shift ? FINE_STEP : SEEK_STEP };
    case 'Comma':
      return { type: 'seekBy', seconds: -0.05 };
    case 'Period':
      return { type: 'seekBy', seconds: 0.05 };
    case 'Home':
      return { type: 'seek', t: 0 };
    case 'End':
      return { type: 'seek', t: Infinity };
    case 'ArrowUp':
    case 'Equal':
    case 'NumpadAdd':
      return { type: 'speedStep', dir: 1 };
    case 'ArrowDown':
    case 'Minus':
    case 'NumpadSubtract':
      return { type: 'speedStep', dir: -1 };
    case 'KeyC':
    case 'KeyV':
      return { type: 'camera', mode: 'next' };
    case 'Digit1':
      return { type: 'camera', mode: 'follow' };
    case 'Digit2':
      return { type: 'camera', mode: 'free' };
    case 'Digit3':
      return { type: 'camera', mode: 'pov' };
    case 'KeyQ':
    case 'BracketLeft':
      return { type: 'player', dir: -1 };
    case 'KeyE':
    case 'BracketRight':
    case 'Tab':
      return { type: 'player', dir: 1 };
    case 'Escape':
    case 'Backspace':
      return { type: 'exit' };
    default:
      return null;
  }
}

/** Free-camera pan keys → [x, z] in camera space (x right, z forward). */
const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};

/**
 * Pan axis contribution of a held key.
 *
 * @returns `[x, z]`, or null when the key does not pan.
 */
export function moveKey(code: string): readonly [number, number] | null {
  return MOVE_KEYS[code] ?? null;
}

/** Standard-mapping gamepad buttons the viewer reads. */
const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
} as const;

const PAD_COMMANDS: readonly (readonly [number, ReplayCommand])[] = [
  [PAD.A, { type: 'toggle' }],
  [PAD.Start, { type: 'toggle' }],
  [PAD.B, { type: 'exit' }],
  [PAD.Back, { type: 'exit' }],
  [PAD.X, { type: 'camera', mode: 'next' }],
  [PAD.LB, { type: 'player', dir: -1 }],
  [PAD.RB, { type: 'player', dir: 1 }],
  [PAD.LT, { type: 'seekBy', seconds: -SEEK_STEP }],
  [PAD.RT, { type: 'seekBy', seconds: SEEK_STEP }],
  [PAD.Left, { type: 'seekBy', seconds: -FINE_STEP }],
  [PAD.Right, { type: 'seekBy', seconds: FINE_STEP }],
  [PAD.Up, { type: 'speedStep', dir: 1 }],
  [PAD.Down, { type: 'speedStep', dir: -1 }],
];

/**
 * Turns gamepad button states into commands on the press edge only.
 *
 * @example
 * const pad = new PadCommands();
 * for (const c of pad.update(pressedButtons)) run(c);
 */
export class PadCommands {
  private readonly prev: boolean[] = [];
  private readonly out: ReplayCommand[] = [];
  /** Y held: the right stick zooms instead of looking. */
  zoomHeld = false;

  /**
   * @param pressed - Pressed state per standard button index.
   * @returns Commands for buttons that went down since the last call (reused array).
   */
  update(pressed: readonly boolean[]): readonly ReplayCommand[] {
    this.out.length = 0;
    for (const [index, cmd] of PAD_COMMANDS) {
      const down = pressed[index] ?? false;
      if (down && !this.prev[index]) this.out.push(cmd);
    }
    for (let i = 0; i < pressed.length; i++) this.prev[i] = pressed[i] ?? false;
    this.zoomHeld = pressed[PAD.Y] ?? false;
    return this.out;
  }

  /** Forgets held buttons (so a button held while opening doesn't fire). */
  reset(pressed: readonly boolean[] = []): void {
    this.prev.length = 0;
    for (let i = 0; i < pressed.length; i++) this.prev[i] = pressed[i] ?? false;
  }
}
