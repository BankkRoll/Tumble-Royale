import type { Vec3 } from '@tumble/shared';

/** Gameplay surface kinds. Friction and control response per kind live in character tuning. */
export type SurfaceKind = 'normal' | 'ice' | 'slime' | 'conveyor' | 'sticky' | 'bouncy' | 'slide';

/** Extra gameplay data attached to a collider. */
export interface SurfaceInfo {
  kind: SurfaceKind;
  /** World-space belt velocity for conveyors (m/s). May change over time; owners update it in place. */
  conveyorVelocity?: Vec3;
  /** Ledges and climb walls: grab attaches here. */
  grabbable?: boolean;
  /** Bumpers: impulse magnitude applied along the contact normal. */
  bounceImpulse?: number;
  /**
   * Bounce pads: the authored world-space launch velocity (m/s). Only contacts
   * from above (feet on the pad top) launch, and they leave with exactly this
   * velocity so authored arcs land where designed; side contacts get a soft
   * bump instead of a `bounceImpulse` kick.
   */
  bounceVelocity?: Vec3;
  /** Bounce pads: world-space up axis of the pad top, to tell top contacts from side ones. */
  bounceUp?: Vec3;
  /** Hazards that stun on touch (lasers, cannonballs). */
  stunOnTouch?: boolean;
  /** Touching this eliminates/respawns (void, slime surface). */
  lethal?: boolean;
  /** Owning obstacle instance id, for event attribution. */
  ownerId?: string;
}

/**
 * Maps collider handles to gameplay surface data. Lookups happen every step for
 * every grounded player, so this is a plain Map keyed by Rapier's numeric handle.
 */
export class SurfaceRegistry {
  private readonly map = new Map<number, SurfaceInfo>();

  set(colliderHandle: number, info: SurfaceInfo): void {
    this.map.set(colliderHandle, info);
  }

  get(colliderHandle: number): SurfaceInfo | undefined {
    return this.map.get(colliderHandle);
  }

  delete(colliderHandle: number): void {
    this.map.delete(colliderHandle);
  }

  clear(): void {
    this.map.clear();
  }
}
