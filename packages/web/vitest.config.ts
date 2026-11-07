import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts", "app/**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
