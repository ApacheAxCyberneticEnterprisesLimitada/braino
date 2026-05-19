import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/db-isolation.ts"],
    globals: false,
    testTimeout: 30_000,
  },
});
