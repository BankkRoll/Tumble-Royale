/**
 * Push-to-talk input: the `pushToTalk` keyboard/mouse binding and the
 * controller button from Settings → Controls, read outside the gameplay input
 * system so it works in menus, rounds and while spectating alike.
 *
 * A key is ignored while a text field has focus (typing a "v" in chat must
 * not open the mic), and everything is released when the window loses focus,
 * since the key-up would never arrive.
 */
import { keyboardBusy } from '@tumble/ui';

/** Where the bindings come from (read on every event, so rebinding applies at once). */
export interface PushToTalkBindings {
  /** `KeyboardEvent.code` values or `Mouse0`…`Mouse4`. */
  keys(): readonly string[];
  /** Standard-mapping gamepad button indices. */
  pad(): readonly number[];
}

/**
 * Tracks whether push-to-talk is held.
 *
 * @example
 * const ptt = new PushToTalkInput(window, bindings, (held) => voice.setPushToTalk(held));
 * ptt.start();
 * // each frame:
 * ptt.poll(navigator.getGamepads());
 */
export class PushToTalkInput {
  private keyHeld = false;
  private padHeld = false;
  private last = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    private readonly bindings: PushToTalkBindings,
    private readonly onChange: (held: boolean) => void,
  ) {}

  /** Whether push-to-talk is held right now. */
  get held(): boolean {
    return this.last;
  }

  /** Installs the listeners. */
  start(): void {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
      this.target.addEventListener(type, fn as EventListener);
      this.offs.push(() => this.target.removeEventListener(type, fn as EventListener));
    };
    on('keydown', (e) => {
      if (e.repeat || keyboardBusy(e) || !this.bindings.keys().includes(e.code)) return;
      this.keyHeld = true;
      this.emit();
    });
    on('keyup', (e) => {
      if (!this.bindings.keys().includes(e.code)) return;
      this.keyHeld = false;
      this.emit();
    });
    on('mousedown', (e) => {
      if (!this.bindings.keys().includes(`Mouse${e.button}`)) return;
      this.keyHeld = true;
      this.emit();
    });
    on('mouseup', (e) => {
      if (!this.bindings.keys().includes(`Mouse${e.button}`)) return;
      this.keyHeld = false;
      this.emit();
    });
    on('blur', () => {
      this.keyHeld = false;
      this.padHeld = false;
      this.emit();
    });
  }

  /**
   * Reads the controller (call once per frame).
   *
   * @param pads - `navigator.getGamepads()`.
   */
  poll(pads: readonly (Gamepad | null)[]): void {
    const gp = pads.find((p) => p && p.connected && p.mapping === 'standard') ?? null;
    const buttons = this.bindings.pad();
    this.padHeld = !!gp && buttons.some((i) => i >= 0 && !!gp.buttons[i]?.pressed);
    this.emit();
  }

  /** Removes the listeners. */
  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.keyHeld = false;
    this.padHeld = false;
    this.emit();
  }

  private emit(): void {
    const held = this.keyHeld || this.padHeld;
    if (held === this.last) return;
    this.last = held;
    this.onChange(held);
  }
}
