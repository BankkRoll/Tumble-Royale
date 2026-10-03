import { defineConfig } from '@playwright/test';

const PORT = 5173;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // NOTE: uses the locally installed Edge/Chrome so CI and dev machines need no browser download.
    channel: process.env.PW_CHANNEL ?? 'msedge',
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=d3d11',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @tumble/game-server start',
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
      command: 'pnpm --filter @tumble/client dev --strictPort',
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
      cwd: '../..',
    },
  ],
});
