import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All test files will share one database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
