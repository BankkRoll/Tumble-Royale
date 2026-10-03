/**
 * Client input: devices → fixed-step `CharacterInput` + per-frame camera look.
 */
export { InputSystem, DEFAULT_INPUT_SETTINGS, radialDeadzone } from './inputSystem.ts';
export type { InputDevice, InputSettings, LookDelta } from './inputSystem.ts';
export { DEFAULT_KEYMAP, INPUT_ACTIONS, createKeymap, mouseCode } from './keymap.ts';
export type { InputAction, Keymap } from './keymap.ts';
export { ButtonLatch } from './latch.ts';
export { TouchState, type TouchButton, type TouchSnapshot } from './touchState.ts';
