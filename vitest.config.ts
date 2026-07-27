import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Every test is mocked; no test may open a socket. A short timeout keeps a
    // stray real network call from hanging CI.
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
