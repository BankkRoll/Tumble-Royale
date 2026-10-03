import { defineConfig } from 'vitest/config';

// Playwright specs in e2e/ use their own runner.
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'src/**/*.test.ts'], testTimeout: 60_000 },
});
