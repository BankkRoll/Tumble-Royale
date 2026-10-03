/**
 * Helpers shared by the menu/ceremony views: building `SceneCommonOptions`
 * from the active quality preset, and wrapping a render `MenuScene` as a
 * {@link GameView}.
 */
import type { ThemeDefinition, Weather } from '@tumble/content/themes';
import type { QualityPreset } from '@tumble/render/quality';
import type { CreateTumblerVisual, MenuScene, SceneCommonOptions } from '@tumble/render/scenes';
import type { GameView } from './types.ts';

/**
 * Scene options for a theme at the current quality.
 *
 * @param theme - Theme definition.
 * @param preset - Active quality preset.
 * @param createTumbler - Tumbler factory.
 * @param weather - Optional weather override.
 */
export function sceneOptions(
  theme: ThemeDefinition,
  preset: QualityPreset,
  createTumbler: CreateTumblerVisual,
  weather?: Weather,
): SceneCommonOptions {
  return {
    theme,
    createTumbler,
    detail: preset.environment,
    lighting: {
      shadows: preset.shadows,
      mapSize: preset.shadowMapSize,
      cascades: preset.cascades,
      shadowDistance: preset.shadowDistance,
    },
    ...(weather ? { weather } : {}),
  };
}

/**
 * Adapts a render-package scene to the game's view contract.
 *
 * @param kind - View id.
 * @param scene - The menu/ceremony scene.
 * @param extra - Extra per-frame work and disposal.
 */
export function wrapScene(
  kind: string,
  scene: MenuScene,
  extra: { update?: (dt: number, realDt: number) => void; dispose?: () => void } = {},
): GameView {
  return {
    kind,
    scene: scene.scene,
    camera: scene.camera,
    grade: scene.grade,
    update(dt, realDt) {
      scene.update(dt);
      extra.update?.(dt, realDt);
    },
    resize: (w, h) => scene.resize(w, h),
    dispose() {
      extra.dispose?.();
      scene.dispose();
    },
  };
}
