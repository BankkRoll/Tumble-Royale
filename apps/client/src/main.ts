/**
 * Client entry point.
 *
 * `/` boots the real game ({@link GameApp}); `/?scene=test` keeps the Phase 0
 * renderer/physics test scene reachable for parity and determinism checks.
 */
import './styles.css';
import { runTestScene } from './debug/testSceneMode.ts';
import { GameApp } from './game/app.ts';
import { readConfig } from './game/config.ts';
import { devParam } from './devTools.ts';
import './game/hooks.ts';

const bootLabel = document.getElementById('boot-label');
const bootBar = document.getElementById('boot-progress');
const setBoot = (pct: number, label: string): void => {
  if (bootBar) bootBar.style.width = `${pct}%`;
  if (bootLabel) bootLabel.textContent = label;
};

const params = new URLSearchParams(location.search);

const run =
  devParam(params, 'scene') === 'test' ? runTestScene(setBoot) : GameApp.boot(readConfig(), setBoot);

run.catch((err: unknown) => {
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  setBoot(100, `Failed to start: ${msg}`);
  void import('@tumble/ui').then(({ ui }) =>
    ui.getState().setBoot({ error: `Something got stuck in the chute: ${msg}` }),
  );
});
