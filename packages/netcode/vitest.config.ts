import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared CI runners are several times slower than a dev machine; the
    // simulation-heavy suites overrun Vitest's 5 s default there.
    testTimeout: 60_000,
  },
});
