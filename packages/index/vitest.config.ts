import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: false,
    globalSetup: ["../db/src/__tests__/schema-snapshot.global-setup.ts"],
    testTimeout: 30_000,
  },
});
