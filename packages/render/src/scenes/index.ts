/**
 * Menu & ceremony scenes (main menu stage, pre-show arena, end-of-show player
 * wall, victory podium, results backdrop) plus their shared props. Every scene
 * takes an injected `CreateTumblerVisual` and falls back to a placeholder.
 */
export type { CreateTumblerVisual, TumblerLoadout, TumblerVisual, TumblerAnimInput } from '../character/types.ts';
export * from './common.ts';
export * from './placeholderTumbler.ts';
export * from './nameplates.ts';
export * from './props.ts';
export * from './mainMenuStage.ts';
export * from './preShowArena.ts';
export * from './playerWall.ts';
export * from './victoryPodium.ts';
export * from './resultsBackdrop.ts';
