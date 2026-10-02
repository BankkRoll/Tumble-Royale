import type { Vec3 } from '@tumble/shared';

/**
 * Gameplay events emitted by the simulation. The server forwards the relevant
 * ones over the reliable channel; the client feeds them to VFX, audio and UI.
 * Positions are copied (not shared references) so sinks may keep them.
 */
export type SimEvent =
  | { type: 'jump'; player: number; pos: Vec3 }
  | { type: 'land'; player: number; pos: Vec3; impact: number }
  | { type: 'dive'; player: number; pos: Vec3 }
  | { type: 'getUp'; player: number }
  | { type: 'stun'; player: number; pos: Vec3; strength: number }
  | { type: 'bounce'; player: number; pos: Vec3; obstacle?: string }
  | { type: 'grabStart'; player: number; target: number; targetKind: 'player' | 'prop' | 'ledge' }
  | { type: 'grabEnd'; player: number; target: number; reason: 'release' | 'broken' | 'stamina' }
  | { type: 'emote'; player: number; emote: number }
  | { type: 'fellOut'; player: number; pos: Vec3 }
  | { type: 'respawn'; player: number; pos: Vec3 }
  | { type: 'checkpoint'; player: number; index: number }
  | { type: 'finish'; player: number; tick: number; subTick: number }
  | { type: 'qualified'; player: number; place: number }
  | { type: 'eliminated'; player: number; place: number }
  | { type: 'tileFell'; obstacle: string; tile: number }
  | { type: 'tileWarn'; obstacle: string; tile: number }
  | { type: 'obstacleCue'; obstacle: string; cue: string; pos: Vec3 }
  | { type: 'teleport'; player: number; from: Vec3; to: Vec3 }
  | { type: 'score'; team: number; player: number; delta: number; total: number }
  | { type: 'propPickup'; player: number; prop: number }
  | { type: 'propDrop'; player: number; prop: number };

/** Event type discriminant. */
export type SimEventType = SimEvent['type'];

/** Append-only per-step event buffer. Consumers drain it after each step. */
export class EventSink {
  readonly events: SimEvent[] = [];

  push(e: SimEvent): void {
    this.events.push(e);
  }

  /** Returns the buffered events and clears the buffer. */
  drain(): SimEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
