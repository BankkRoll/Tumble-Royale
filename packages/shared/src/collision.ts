/**
 * Collision membership bits. Rapier packs membership in the high 16 bits and the
 * filter in the low 16 bits of a single 32-bit `collisionGroups` value.
 */
export const CollisionGroup = {
  Static: 1 << 0,
  KinematicObstacle: 1 << 1,
  DynamicProp: 1 << 2,
  Player: 1 << 3,
  PlayerGhost: 1 << 4,
  Trigger: 1 << 5,
  Hazard: 1 << 6,
  /** Client-only cosmetic ragdoll limbs. Only collide with world geometry. */
  Ragdoll: 1 << 7,
} as const;

const ALL = 0xffff;

/**
 * Packs membership and filter masks into Rapier's interaction-groups format.
 *
 * @param membership - Groups this collider belongs to.
 * @param filter - Groups this collider may interact with.
 * @returns The packed 32-bit interaction group value.
 * @example
 * collider.setCollisionGroups(groups(CollisionGroup.Player, CollisionGroup.Static));
 */
export function groups(membership: number, filter: number = ALL): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

const G = CollisionGroup;

/** Preset interaction groups for common collider roles. */
export const InteractionGroups = {
  static: groups(G.Static),
  kinematic: groups(G.KinematicObstacle),
  prop: groups(G.DynamicProp, G.Static | G.KinematicObstacle | G.DynamicProp | G.Player | G.Trigger),
  player: groups(G.Player, G.Static | G.KinematicObstacle | G.DynamicProp | G.Player | G.Trigger | G.Hazard),
  /** Ghosts (respawn grace, finished, spectating) ignore other players and props. */
  playerGhost: groups(G.PlayerGhost, G.Static | G.KinematicObstacle | G.Trigger | G.Hazard),
  trigger: groups(G.Trigger, G.Player | G.PlayerGhost | G.DynamicProp),
  hazard: groups(G.Hazard, G.Player | G.PlayerGhost),
  ragdoll: groups(G.Ragdoll, G.Static | G.KinematicObstacle),
  /** Scene queries for "what is the player standing on" — world geometry and props, never players. */
  groundQuery: groups(0xffff, G.Static | G.KinematicObstacle | G.DynamicProp),
} as const;
