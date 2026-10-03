/**
 * `?debug=1` developer panel (lil-gui) for the real game: quality tier, time
 * scale, round skipping, forced fates, checkpoint teleport, stats and GPU
 * memory readouts.
 */
import GUI from 'lil-gui';
import type { WebGPURenderer } from 'three/webgpu';
import { QUALITY_TIERS, type QualityTier } from '@tumble/render/quality';
import type { StatsOverlay } from '../debug/stats.ts';
import type { QualityManager } from './quality.ts';
import type { ShowSession } from './show/session.ts';

/** What the panel can poke. */
export interface DebugTargets {
  renderer: WebGPURenderer;
  quality: QualityManager;
  stats: StatsOverlay;
  session: () => ShowSession | null;
  timeScale: { value: number };
}

/**
 * Builds the panel.
 *
 * @param t - Targets.
 * @returns The GUI (dispose with `gui.destroy()`).
 */
export function createDebugPanel(t: DebugTargets): GUI {
  const gui = new GUI({ title: 'Tumble debug' });
  const state = {
    tier: t.quality.tier as QualityTier,
    timeScale: t.timeScale.value,
    stats: true,
    memory: '',
    skipRound: (): void => t.session()?.skipRound(),
    qualifyMe: (): void => t.session()?.forceLocalFate(true),
    eliminateMe: (): void => t.session()?.forceLocalFate(false),
    checkpoint: (): void => t.session()?.teleportToCheckpoint(),
    logMemory: (): void => {
      const m = t.renderer.info.memory;
      state.memory = `geo ${m.geometries} · tex ${m.textures}`;
      memCtrl.updateDisplay();
      console.info('[debug] GPU memory', { ...m });
    },
  };
  gui
    .add(state, 'tier', [...QUALITY_TIERS])
    .name('Quality tier')
    .onChange((v: QualityTier) => t.quality.setTier(v));
  gui
    .add(state, 'timeScale', 0.1, 8, 0.1)
    .name('Time scale')
    .onChange((v: number) => {
      t.timeScale.value = v;
    });
  gui
    .add(state, 'stats')
    .name('Stats overlay')
    .onChange((v: boolean) => t.stats.setVisible(v));
  const show = gui.addFolder('Show');
  show.add(state, 'skipRound').name('Skip round (forfeit all)');
  show.add(state, 'qualifyMe').name('Force qualify me');
  show.add(state, 'eliminateMe').name('Force eliminate me');
  show.add(state, 'checkpoint').name('Teleport to checkpoint');
  const mem = gui.addFolder('Memory');
  const memCtrl = mem.add(state, 'memory').name('GPU').disable();
  mem.add(state, 'logMemory').name('Refresh / log');
  return gui;
}
