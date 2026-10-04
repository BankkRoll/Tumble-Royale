import type { RoundDefinitionInput } from '@tumble/shared';
import cometCatch from './comet-catch/index.ts';

/**
 * Rounds added after launch: two hunts (Comet Catch, Sunbeam Squabble), two
 * logic rounds (Colour Cauldron, Trail Tracer) and a final (Throne Rush).
 */
export const ROUNDS_GROUP_5: RoundDefinitionInput[] = [
  cometCatch,
];
