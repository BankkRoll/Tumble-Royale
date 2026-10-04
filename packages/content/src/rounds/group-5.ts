import type { RoundDefinitionInput } from '@tumble/shared';
import colourCauldron from './colour-cauldron/index.ts';
import cometCatch from './comet-catch/index.ts';
import sunbeamSquabble from './sunbeam-squabble/index.ts';
import throneRush from './throne-rush/index.ts';
import trailTracer from './trail-tracer/index.ts';

/**
 * Rounds added after launch: two hunts (Comet Catch, Sunbeam Squabble), two
 * logic rounds (Colour Cauldron, Trail Tracer) and a final (Throne Rush).
 */
export const ROUNDS_GROUP_5: RoundDefinitionInput[] = [
  cometCatch,
  sunbeamSquabble,
  colourCauldron,
  trailTracer,
  throneRush,
];
