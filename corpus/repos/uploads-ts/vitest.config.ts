import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Every test file shares one database, emptied before each test.
    fileParallelism: false,
    globalSetup: ["test/helpers/globalSetup.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
