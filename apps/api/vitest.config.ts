import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a WASM Postgres and runs migrations per test file.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
