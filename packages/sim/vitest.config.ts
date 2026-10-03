import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Whole-round soak tests step 40 bots through Rapier for thousands of
    // ticks; shared CI runners are several times slower than a dev machine.
    testTimeout: 60_000,
  },
});
