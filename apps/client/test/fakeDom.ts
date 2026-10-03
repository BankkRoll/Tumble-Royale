/**
 * Just enough browser globals for the input system under Node: `window` and
 * `document` as plain EventTargets, a scriptable `navigator.getGamepads`, and
 * fake standard-mapping gamepads.
 */
import { vi } from 'vitest';

/** A minimal standard-mapping gamepad whose buttons and axes tests poke directly. */
export interface FakePad {
  index: number;
  id: string;
  connected: boolean;
  mapping: 'standard';
  timestamp: number;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  vibrationActuator?: { playEffect: ReturnType<typeof vi.fn> };
}

/** Creates a resting pad (17 buttons, 4 axes). */
export function fakePad(index = 0): FakePad {
  return {
    index,
    id: 'Fake Pad (STANDARD GAMEPAD)',
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: { playEffect: vi.fn(() => Promise.resolve('complete')) },
  };
}

/** Presses or releases a pad button. */
export function setButton(pad: FakePad, index: number, down: boolean): void {
  const b = pad.buttons[index]!;
  b.pressed = down;
  b.value = down ? 1 : 0;
}

/** Installed fakes; `pads` is what `navigator.getGamepads()` returns. */
export interface FakeDom {
  pads: (FakePad | null)[];
  element: HTMLElement;
  vibrate: ReturnType<typeof vi.fn>;
  /** Dispatches a keyboard-like event on `window`. */
  key(type: 'keydown' | 'keyup', code: string): void;
}

/** Stubs `window`, `document`, `navigator` and `matchMedia`; undo with `vi.unstubAllGlobals()`. */
export function installFakeDom(opts: { coarse?: boolean } = {}): FakeDom {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null,
    hidden: false,
    exitPointerLock: () => undefined,
  });
  const pads: (FakePad | null)[] = [];
  const vibrate = vi.fn(() => true);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { getGamepads: () => pads, maxTouchPoints: opts.coarse ? 5 : 0, vibrate });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !!opts.coarse && q.includes('coarse') }));
  const element = Object.assign(new EventTarget(), {
    requestPointerLock: () => undefined,
  }) as unknown as HTMLElement;
  return {
    pads,
    element,
    vibrate,
    key(type, code) {
      win.dispatchEvent(Object.assign(new Event(type), { code, ctrlKey: false, repeat: false }));
    },
  };
}
