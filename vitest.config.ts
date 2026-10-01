import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
