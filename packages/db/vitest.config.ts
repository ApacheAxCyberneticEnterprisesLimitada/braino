import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: false,
    globalSetup: ["src/__tests__/schema-snapshot.global-setup.ts"],
    // CPU-bound (PGlite): use every core, not vitest's default of all but one.
    maxWorkers: "100%",
    testTimeout: 10_000,
  },
});
