import { defineConfig } from '@playwright/test';

/**
 * `PW_PREVIEW=1` serves a prebuilt sandbox bundle (`build:sandbox`) with
 * `vite preview` instead of the dev server; CI uses it so the run tests what
 * was built and skips dev-server cold starts.
 */
const PREVIEW = process.env.PW_PREVIEW === '1';
const PORT = PREVIEW ? 4173 : 5173;
const WINDOWS = process.platform === 'win32';

// NOTE: locally this drives the installed Edge so dev machines need no browser
// download. `PW_CHANNEL=chromium` uses Playwright's bundled Chromium (CI).
const channelEnv = process.env.PW_CHANNEL ?? 'msedge';
const channel = channelEnv === 'chromium' || channelEnv === '' ? undefined : channelEnv;

export default defineConfig({
  testDir: './e2e',
  // COMPAT: CI's GPU-less runners draw through SwiftShader at a few fps, and
  // every click waits for the element to hold still across two frames. The
  // longest menu specs take ~1 min under SwiftShader on a desktop CPU and over
  // 90 s on a runner.
  timeout: process.env.CI ? 240_000 : 90_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel,
    launchOptions: {
      // COMPAT: the ANGLE/Vulkan flags pick a real GPU on Windows; GPU-less
      // Linux runners have no WebGPU and need SwiftShader for WebGL2.
      args: WINDOWS
        ? [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-angle=d3d11',
            '--ignore-gpu-blocklist',
          ]
        : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: [
    {
      // Runs from source so specs never test a stale dist/ bundle.
      command: 'pnpm --filter @tumble/game-server exec tsx src/main.ts',
      url: 'http://localhost:7350/health',
      reuseExistingServer: true,
      cwd: '../..',
      // Specs join unticketed and standalone, so explicit test secrets let the
      // server boot without a .env.
      env: {
        GAME_TICKET_SECRET: 'test-game-ticket-secret-0123456789',
        INTERNAL_HMAC_SECRET: 'test-internal-hmac-secret-0123456789',
        MATCHMAKER_URL: '',
      },
    },
    {
      command: PREVIEW
        ? `pnpm --filter @tumble/client preview --port ${PORT} --strictPort`
        : 'pnpm --filter @tumble/client dev --strictPort',
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      cwd: '../..',
    },
  ],
});
