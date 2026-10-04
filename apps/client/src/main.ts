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
import { CrashReporter } from './crashReporter.ts';
import { DEV_TOOLS, devParam, ENDPOINTS } from './devTools.ts';
import { loadRuntimeConfig } from './runtimeConfig.ts';
import './game/hooks.ts';

const bootLabel = document.getElementById('boot-label');
const bootBar = document.getElementById('boot-progress');
const setBoot = (pct: number, label: string): void => {
  if (bootBar) bootBar.style.width = `${pct}%`;
  if (bootLabel) bootLabel.textContent = label;
};

const params = new URLSearchParams(location.search);

// Endpoints must be final before readConfig() and the API clients read them.
const runtime = await loadRuntimeConfig();
const reporter =
  runtime.reportErrors !== false && !DEV_TOOLS
    ? new CrashReporter({
        apiUrl: ENDPOINTS.api,
        sentryDsn: runtime.sentryDsn ?? (import.meta.env.VITE_SENTRY_DSN || undefined),
      })
    : null;
reporter?.install(window);

const run =
  devParam(params, 'scene') === 'test'
    ? runTestScene(setBoot)
    : GameApp.boot(readConfig(), setBoot, { errorCount: () => reporter?.captured ?? 0 });

run.catch((err: unknown) => {
  console.error(err);
  // Caught here, so the global handlers never see it.
  reporter?.capture('error', err);
  const msg = err instanceof Error ? err.message : String(err);
  setBoot(100, `Failed to start: ${msg}`);
  void import('@tumble/ui').then(({ ui }) =>
    ui.getState().setBoot({ error: `Something got stuck in the chute: ${msg}` }),
  );
});
