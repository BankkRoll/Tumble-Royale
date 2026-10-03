/**
 * Resolves the Tumbler visual factory. The real character module
 * (`@tumble/render/character`) is loaded through a glob so the game still
 * boots with the placeholder Tumbler while that package is missing or broken.
 */
import { createPlaceholderTumbler, type CreateTumblerVisual } from '@tumble/render/scenes';

/** The factory plus where it came from (debug overlay). */
export interface ResolvedTumblerFactory {
  create: CreateTumblerVisual;
  name: 'tumbler' | 'placeholder';
}

interface CharacterModule {
  createTumblerVisual?: CreateTumblerVisual;
}

/**
 * Loads the real Tumbler visual if available.
 *
 * @returns The factory to hand to every scene.
 */
export async function resolveTumblerFactory(): Promise<ResolvedTumblerFactory> {
  const mods = import.meta.glob<CharacterModule>('../../../../packages/render/src/character/index.ts');
  const loader = Object.values(mods)[0];
  if (loader) {
    try {
      const m = await loader();
      if (m.createTumblerVisual) {
        // Building one up front surfaces shader/geometry errors here instead of mid-show.
        const probe = m.createTumblerVisual({
          colors: ['#ff6fb5', '#ffd23f', '#7c5cff'],
          pattern: 'solid',
          face: 'face.classic',
          upper: null,
          lower: null,
          headwear: null,
          back: null,
          emotes: ['emote.wave', 'emote.dance', 'emote.laugh', 'emote.flex'],
          celebration: 'celebration.cheer',
          victoryPose: 'victory.superstar',
          nameplate: 'nameplate.classic',
          trail: null,
        });
        probe.dispose();
        return { create: m.createTumblerVisual, name: 'tumbler' };
      }
    } catch (err) {
      console.warn('[game] Tumbler visual failed to load; using the placeholder', err);
    }
  }
  return { create: createPlaceholderTumbler, name: 'placeholder' };
}
