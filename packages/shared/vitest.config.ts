import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/__tests__/**", "src/index.ts"],
      // Low floor — a regression tripwire, not a target (Goodhart's law:
      // a coverage % gamed as a target stops being a useful measure).
      // Ratchet up deliberately over time.
      thresholds: { lines: 55 },
    },
  },
});
