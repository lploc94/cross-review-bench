import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Tests run against the packages' sources, so no build is needed first. */
function source(pkg: string): string {
  return fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@sync/shared": source("shared"),
      "@sync/server": source("server"),
      "@sync/client": source("client"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Server and end-to-end suites share one database, emptied before each test.
    fileParallelism: false,
    globalSetup: ["packages/server/test/helpers/globalSetup.ts"],
    setupFiles: ["packages/server/test/helpers/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
